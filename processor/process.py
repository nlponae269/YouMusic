#!/usr/bin/env python3
"""Обработчик загрузок supMUSIC (запускается в GitHub Actions по расписанию).

Для каждого трека в очереди:
  1. скачивает оригинал из приватного бакета sup-incoming;
  2. Demucs (нейросеть) разделяет трек на голос и бит;
  3. Whisper (нейросеть) расшифровывает голос пословно, с точным временем;
  4. на месте мата и упоминаний наркотиков голос вырезается — остаётся только бит;
  5. отцензуренная версия публикуется в бакеты audio и covers, оригинал удаляется.

Переменные окружения: SUPABASE_URL, SUPABASE_SERVICE_KEY,
WHISPER_MODEL (по умолчанию medium), MAX_TRACKS (сколько треков за запуск, по умолчанию 5).
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).parent))
from words import VERSION as WORDS_VERSION, banned_in, banned_indices, censor_text  # noqa: E402

RATE = 44100
AI_ALBUM = "Сгенерировано нейросетью"  # так помечены песни из генератора (см. generate.py)
PAD = 0.12      # запас вокруг слова, сек: таймкоды Whisper неточны на десятые доли
FADE = 0.04     # плавный переход голос ↔ бит, сек

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "medium")
MAX_TRACKS = int(os.environ.get("MAX_TRACKS", "5"))


# ---------- Supabase REST ----------

def request(method, path, body=None, headers=None, raw=False):
    data = None
    hdrs = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}", **(headers or {})}
    if body is not None and not isinstance(body, bytes):
        data = json.dumps(body).encode()
        hdrs.setdefault("Content-Type", "application/json")
    elif body is not None:
        data = body
    req = urllib.request.Request(SUPABASE_URL + path, data=data, method=method, headers=hdrs)
    try:
        with urllib.request.urlopen(req, timeout=300) as res:
            payload = res.read()
    except urllib.error.HTTPError as err:
        raise RuntimeError(f"{method} {path.split('?')[0]} → {err.code}: {err.read().decode(errors='replace')[:300]}") from None
    if raw:
        return payload
    return json.loads(payload) if payload else None


def db(method, query, body=None):
    return request(method, f"/rest/v1/{query}", body, {"Prefer": "return=representation"})


def storage_download(bucket, key, dest):
    Path(dest).write_bytes(request("GET", f"/storage/v1/object/{bucket}/{urllib.parse.quote(key)}", raw=True))


def storage_upload(bucket, key, file, content_type):
    request("POST", f"/storage/v1/object/{bucket}/{urllib.parse.quote(key)}", Path(file).read_bytes(),
            {"Content-Type": content_type, "x-upsert": "true", "Cache-Control": "max-age=31536000"})


def storage_delete(bucket, keys):
    if keys:
        request("DELETE", f"/storage/v1/object/{bucket}", {"prefixes": list(keys)})


def storage_list(bucket, prefix=""):
    out, offset = [], 0
    while True:
        page = request("POST", f"/storage/v1/object/list/{bucket}",
                       {"prefix": prefix, "limit": 1000, "offset": offset}) or []
        out += page
        if len(page) < 1000:
            return out
        offset += 1000


# ---------- Аудио ----------

def run(cmd):
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def decode(src, dest):
    run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-vn", "-ac", "2", "-ar", str(RATE), "-c:a", "pcm_s16le", str(dest)])


def separate(wav, workdir):
    """Demucs: голос и бит отдельно. Возвращает (vocals, no_vocals) или None, если не вышло."""
    try:
        subprocess.run([sys.executable, "-m", "demucs.separate", "--two-stems=vocals", "-n", "htdemucs",
                        "-d", "cpu", "-o", str(workdir / "sep"), str(wav)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    except subprocess.CalledProcessError as err:
        print("  Demucs не справился:", err.stderr.decode(errors="replace")[-500:], flush=True)
        return None
    stem = workdir / "sep" / "htdemucs" / Path(wav).stem
    return stem / "vocals.wav", stem / "no_vocals.wav"


_whisper = None


def transcribe_words(path):
    """Пословная расшифровка: ([(начало, конец, слово)], [(начало, фраза)])."""
    global _whisper
    from faster_whisper import WhisperModel

    if _whisper is None:
        print(f"  Загружаю Whisper «{WHISPER_MODEL}»…", flush=True)
        _whisper = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8", cpu_threads=os.cpu_count() or 2)
    # декодируем сами (16 кГц моно): так не зависим от версии PyAV внутри faster-whisper
    pcm = subprocess.run(["ffmpeg", "-v", "quiet", "-i", str(path), "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
                         check=True, capture_output=True).stdout
    samples = np.frombuffer(pcm, dtype=np.float32)
    opts = dict(word_timestamps=True, vad_filter=True, beam_size=5, condition_on_previous_text=False)
    segments, info = _whisper.transcribe(samples, **opts)
    if info.language not in ("ru", "en", "uk"):
        segments, info = _whisper.transcribe(samples, language="ru", **opts)
    words, phrases = [], []
    for seg in segments:
        phrases.append((seg.start, seg.text.strip()))
        for w in seg.words or []:
            words.append((w.start, w.end, w.word.strip()))
    return words, phrases


# ---------- Тексты песен ----------
# Открытая бесплатная база LRCLIB (lrclib.net): тексты с таймкодами, без ключей и регистрации.

LRCLIB = "https://lrclib.net/api"
# типичные «галлюцинации» распознавания речи на музыке — в текст песни не берём
HALLUCINATIONS = re.compile(r"субтитр|продолжение следует|подписывайтесь|dimatorzok|спасибо за просмотр|редактор", re.I)


def lrclib(path, params):
    url = f"{LRCLIB}/{path}?{urllib.parse.urlencode(params)}"
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "supMUSIC (https://github.com/nlponae269/supMUSIC)"})
            with urllib.request.urlopen(req, timeout=20) as res:
                return json.loads(res.read())
        except urllib.error.HTTPError as err:
            if err.code == 404:
                return None
            time.sleep(3 * (attempt + 1))
        except Exception:  # noqa: BLE001
            time.sleep(3 * (attempt + 1))
    return None


def find_lyrics(artist, title, duration):
    """Ищет текст в LRCLIB. Возвращает LRC с таймкодами или обычный текст, либо ''."""
    artist = re.sub(r"\*+", "", artist).strip()
    title = re.sub(r"\*+", "", title).strip()
    if not artist or not title:
        return ""
    found = lrclib("get", {"artist_name": artist, "track_name": title, "duration": int(duration)})
    if not found:
        results = lrclib("search", {"artist_name": artist, "track_name": title}) or []
        # берём совпадение по длительности (±8 с), с таймкодами в приоритете
        close = [r for r in results if not r.get("instrumental") and abs((r.get("duration") or 0) - duration) <= 8]
        close.sort(key=lambda r: (not r.get("syncedLyrics"), abs((r.get("duration") or 0) - duration)))
        found = close[0] if close else None
    if not found or found.get("instrumental"):
        return ""
    return (found.get("syncedLyrics") or found.get("plainLyrics") or "").strip()


def phrases_to_lrc(phrases):
    """Текст песни из распознанных фраз Whisper, с таймкодами."""
    lines = []
    for start, text in phrases:
        if not text or HALLUCINATIONS.search(text):
            continue
        lines.append(f"[{int(start // 60):02d}:{start % 60:05.2f}] {text}")
    return "\n".join(lines)


def lrc_lines(lyrics):
    """Строки LRC с таймкодами: [(начало, конец, текст)]."""
    stamps = []
    for raw in (lyrics or "").splitlines():
        times = re.findall(r"\[(\d{1,2}):(\d{2}(?:[.:]\d{1,3})?)\]", raw)
        text = re.sub(r"\[[^\]]*\]", "", raw).strip()
        for m, s in times:
            stamps.append((int(m) * 60 + float(s.replace(":", ".")), text))
    stamps.sort()
    return [(t, stamps[i + 1][0] if i + 1 < len(stamps) else t + 5, text) for i, (t, text) in enumerate(stamps)]


def merge(intervals):
    out = []
    for s, e in sorted(intervals):
        if out and s <= out[-1][1]:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return out


def censor_mask(length, intervals):
    """Маска 0…1: 1 — играет только бит. С короткими плавными переходами."""
    mask = np.zeros(length, dtype=np.float32)
    fade = int(FADE * RATE)
    for s, e in intervals:
        a, b = max(0, int(s * RATE)), min(length, int(e * RATE))
        if b <= a:
            continue
        mask[a:b] = 1
        lo = max(0, a - fade)
        mask[lo:a] = np.maximum(mask[lo:a], np.linspace(0, 1, a - lo, endpoint=False))
        hi = min(length, b + fade)
        mask[b:hi] = np.maximum(mask[b:hi], np.linspace(1, 0, hi - b, endpoint=False))
    return mask


# ---------- Обложка ----------

def make_cover(src, dest, embedded):
    cmd = ["ffmpeg", "-v", "error", "-y", "-i", str(src)]
    if embedded:
        cmd.append("-an")
    cmd += ["-frames:v", "1", "-vf", "scale=600:600:force_original_aspect_ratio=increase,crop=600:600", "-q:v", "3", str(dest)]
    try:
        run(cmd)
        return Path(dest).exists() and Path(dest).stat().st_size > 0
    except subprocess.CalledProcessError:
        return False


# ---------- Обработка одного трека ----------

def censor_audio(wav, audio, lyrics_src, work):
    """Demucs + Whisper: на месте запрещённых слов оставляет только бит.
    Возвращает (звук, вырезанные интервалы, распознанные фразы)."""
    # 1. голос отдельно от бита
    print("  Разделяю голос и бит (Demucs)…", flush=True)
    stems = separate(wav, work)
    vocals_file = stems[0] if stems else wav

    # 2. пословная расшифровка голоса; запрещены и отдельные слова, и фразы («убью себя»)
    print("  Расшифровываю слова (Whisper)…", flush=True)
    words, phrases = transcribe_words(vocals_file)
    bad = [words[i] for i in sorted(banned_indices([w for _, _, w in words]))]
    intervals = [(s - PAD, e + PAD) for s, e, _ in bad]

    # 3. страховка по тексту LRC: если в строке есть запретное слово, а Whisper его не услышал,
    #    убираем голос на всю строку
    for start, end, text in lrc_lines(lyrics_src):
        if banned_in(text) and not any(s < end and e > start for s, e in intervals):
            intervals.append((start, end))
    intervals = merge(intervals)

    # 4. на месте запретных слов оставляем только бит
    if intervals:
        mask = censor_mask(len(audio), intervals)[:, None]
        if stems:
            inst, _ = sf.read(stems[1], dtype="float32", always_2d=True)
            n = min(len(audio), len(inst))
            audio = audio[:n] * (1 - mask[:n]) + inst[:n] * mask[:n]
        else:
            audio = audio * (1 - mask)  # без разделения можно только заглушить
    print(f"  Найдено запретных слов: {len(bad)}, вырезано фрагментов: {len(intervals)}"
          + (f" ({', '.join(w[0] + '*' * (len(w) - 1) for _, _, w in bad[:10])})" if bad else ""), flush=True)
    return audio, intervals, phrases


def process(track):
    tid = track["id"]
    work = Path(tempfile.mkdtemp(prefix=f"ym-{tid[:8]}-"))
    try:
        src = work / ("source" + Path(track["source_path"]).suffix)
        storage_download("sup-incoming", track["source_path"], src)
        wav = work / "orig.wav"
        try:
            decode(src, wav)
        except subprocess.CalledProcessError:
            raise RuntimeError("Не удалось прочитать аудиофайл — проверьте формат") from None

        audio, _ = sf.read(wav, dtype="float32", always_2d=True)

        # 0. текст песни: свой от пользователя или из базы LRCLIB
        lyrics_src = (track.get("lyrics") or "").strip()
        generated = track.get("album") == AI_ALBUM  # песня нейросети: в базах текстов её нет
        if not lyrics_src and not generated:
            lyrics_src = find_lyrics(track["artist"], track["title"], len(audio) / RATE)
            print(f"  Текст из базы LRCLIB: {'найден' if lyrics_src else 'нет'}", flush=True)

        audio, intervals, phrases = censor_audio(wav, audio, lyrics_src, work)

        out_wav, out_mp3 = work / "out.wav", work / "audio.mp3"
        sf.write(out_wav, audio, RATE)
        run(["ffmpeg", "-v", "error", "-y", "-i", str(out_wav), "-c:a", "libmp3lame", "-b:a", "128k", str(out_mp3)])

        # 5. обложка и цвет
        title, n1 = censor_text(track["title"])
        artist, n2 = censor_text(track["artist"])
        album, n3 = censor_text(track.get("album") or "")
        # текст не нашли (или это песня нейросети без таймкодов) — его с таймкодами записывает Whisper
        if generated or not lyrics_src:
            lyrics_src = phrases_to_lrc(phrases) or lyrics_src
        lyrics, n4 = censor_text(lyrics_src)
        cover_jpg = work / "cover.jpg"
        has_cover = False
        if track.get("cover_source"):
            cover_src = work / ("cover-src" + Path(track["cover_source"]).suffix)
            storage_download("sup-incoming", track["cover_source"], cover_src)
            has_cover = make_cover(cover_src, cover_jpg, False)
        if not has_cover:
            has_cover = make_cover(src, cover_jpg, True)

        # 6. публикация: файлы кладём в папку владельца, чтобы он мог удалить их со своего аккаунта
        owner = track["owner"]
        audio_key, cover_key = f"{owner}/{tid}.mp3", (f"{owner}/{tid}.jpg" if has_cover else None)
        storage_upload("audio", audio_key, out_mp3, "audio/mpeg")
        if has_cover:
            storage_upload("covers", cover_key, cover_jpg, "image/jpeg")
        db("PATCH", f"sup_tracks?id=eq.{tid}", {
            "status": "ready",
            "error": None,
            "title": title,
            "artist": artist,
            "album": album or None,
            "lyrics": lyrics or None,
            "audio_path": audio_key,
            "cover_path": cover_key,
            "duration": round(len(audio) / RATE),
            "censored": len(intervals) + n1 + n2 + n3 + n4,
            "published_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        })
        mark_checked(tid)
        # оригинал без цензуры больше не храним
        storage_delete("sup-incoming", [track["source_path"]] + ([track["cover_source"]] if track.get("cover_source") else []))
    finally:
        shutil.rmtree(work, ignore_errors=True)


def age_hours(obj):
    """Возраст файла в часах по полю created_at из списка Storage."""
    try:
        t = time.mktime(time.strptime(obj["created_at"][:19], "%Y-%m-%dT%H:%M:%S")) - time.timezone
        return (time.time() - t) / 3600
    except Exception:  # noqa: BLE001
        return 0


UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


def cleanup():
    """Удаляет файлы треков, которые пользователи удалили с сайта, и брошенные загрузки."""
    found = {}  # (бакет, путь) → id трека
    for bucket in ("audio", "covers", "sup-incoming"):
        for folder in (o["name"] for o in storage_list(bucket) if o.get("id") is None):
            if not UUID.fullmatch(folder):
                continue  # служебные папки вроде _meta
            for o in storage_list(bucket, folder):
                m = UUID.match(o["name"])
                # свежие файлы не трогаем: браузер сначала загружает файл, а строку в базе создаёт следом
                if m and age_hours(o) > 2:
                    found[(bucket, f"{folder}/{o['name']}")] = m.group(0)
    ids = sorted(set(found.values()))
    alive = set()
    for i in range(0, len(ids), 100):
        chunk = ",".join(ids[i:i + 100])
        alive |= {r["id"] for r in db("GET", f"sup_tracks?select=id&id=in.({chunk})")}
    removed = 0
    for bucket in ("audio", "covers", "sup-incoming"):
        dead = [path for (b, path), tid in found.items() if b == bucket and tid not in alive]
        storage_delete(bucket, dead)
        removed += len(dead)
    if removed:
        print(f"Удалено файлов от удалённых треков и загрузок: {removed}")


def now_iso(offset=0):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + offset))


STATE_KEY = "_meta/state.json"


def load_state():
    try:
        return json.loads(request("GET", f"/storage/v1/object/sup-incoming/{STATE_KEY}", raw=True))
    except RuntimeError:
        return {}


def mark_checked(tid):
    state = load_state()
    if state.get("version") != WORDS_VERSION:
        return  # перепроверка ещё идёт — трек и так попадёт в неё или уже проверен новым словарём
    state["checked"] = sorted(set(state.get("checked", [])) | {tid})
    save_state(state)


def recensor(limit=3):
    """Словарь изменился — перепроверяем уже опубликованные треки: вырезаем новые слова
    из звука и прячем их в названии и тексте."""
    state = load_state()
    done = set(state.get("checked", [])) if state.get("version") == WORDS_VERSION else set()
    rows = db("GET", "sup_tracks?select=id,owner,title,artist,album,lyrics,audio_path,censored&status=eq.ready"
                     "&audio_path=not.is.null&order=published_at.asc") or []
    todo = [t for t in rows if t["id"] not in done][:limit]
    for t in todo:
        print(f"Перепроверка по новому словарю: «{t['artist']} — {t['title']}»", flush=True)
        work = Path(tempfile.mkdtemp(prefix="ym-re-"))
        try:
            mp3, wav = work / "old.mp3", work / "old.wav"
            storage_download("audio", t["audio_path"], mp3)
            decode(mp3, wav)
            audio, _ = sf.read(wav, dtype="float32", always_2d=True)
            title, n1 = censor_text(t["title"])
            artist, n2 = censor_text(t["artist"])
            album, n3 = censor_text(t.get("album") or "")
            lyrics, n4 = censor_text(t.get("lyrics") or "")
            # строки текста с новыми запретными словами тоже идут в страховку по LRC
            audio, intervals, _ = censor_audio(wav, audio, t.get("lyrics") or "", work)
            patch = {"title": title, "artist": artist, "album": album or None, "lyrics": lyrics or None}
            if intervals:
                # новое имя файла, чтобы браузеры не взяли старую версию из кэша
                key = f"{t['owner']}/{t['id']}-v{WORDS_VERSION}.mp3"
                out_wav, out_mp3 = work / "out.wav", work / "audio.mp3"
                sf.write(out_wav, audio, RATE)
                run(["ffmpeg", "-v", "error", "-y", "-i", str(out_wav), "-c:a", "libmp3lame", "-b:a", "128k", str(out_mp3)])
                storage_upload("audio", key, out_mp3, "audio/mpeg")
                patch.update({"audio_path": key, "duration": round(len(audio) / RATE)})
            patch["censored"] = (t.get("censored") or 0) + len(intervals) + n1 + n2 + n3 + n4
            db("PATCH", f"sup_tracks?id=eq.{t['id']}", patch)
            if intervals and t["audio_path"] != patch["audio_path"]:
                storage_delete("audio", [t["audio_path"]])
            print(f"  ✓ готово: вырезано ещё {len(intervals)}, в названии/тексте скрыто {n1 + n2 + n3 + n4}", flush=True)
        except Exception:  # noqa: BLE001
            traceback.print_exc()
        finally:
            shutil.rmtree(work, ignore_errors=True)
        done.add(t["id"])
        save_state({"version": WORDS_VERSION, "checked": sorted(done)})


def save_state(state):
    tmp = Path(tempfile.mkstemp(suffix=".json")[1])
    try:
        tmp.write_text(json.dumps(state), encoding="utf-8")
        storage_upload("sup-incoming", STATE_KEY, tmp, "application/json")
    finally:
        tmp.unlink(missing_ok=True)


def backfill_lyrics(limit=3):
    """Подтягивает тексты к уже опубликованным трекам, у которых их нет."""
    rows = db("GET", f"sup_tracks?select=id,title,artist,duration,audio_path&status=eq.ready"
                     f"&has_lyrics=eq.false&error=is.null&order=published_at.desc&limit={limit}") or []
    for t in rows:
        print(f"Текст для «{t['artist']} — {t['title']}»…", flush=True)
        lyrics = find_lyrics(t["artist"], t["title"], t.get("duration") or 0)
        if not lyrics:
            work = Path(tempfile.mkdtemp(prefix="ym-lyr-"))
            try:
                mp3, wav = work / "a.mp3", work / "a.wav"
                storage_download("audio", t["audio_path"], mp3)
                decode(mp3, wav)
                stems = separate(wav, work)
                lyrics = phrases_to_lrc(transcribe_words(stems[0] if stems else wav)[1])
            finally:
                shutil.rmtree(work, ignore_errors=True)
        text, _ = censor_text(lyrics)
        # пометка «текста нет», чтобы не искать заново при каждом запуске
        db("PATCH", f"sup_tracks?id=eq.{t['id']}", {"lyrics": text} if text.strip() else {"error": "no-lyrics"})
        print(f"  {'добавлен' if text.strip() else 'текста нет (инструментал?)'}", flush=True)


def main():
    if not SUPABASE_URL or not SERVICE_KEY:
        sys.exit("Не заданы SUPABASE_URL и SUPABASE_SERVICE_KEY")

    # загрузки с ошибкой старше трёх дней удаляем сами
    db("DELETE", f"sup_tracks?status=eq.failed&created_at=lt.{now_iso(-3 * 86400)}")

    # треки, «застрявшие» после упавшего запуска, возвращаем в очередь
    db("PATCH", "sup_tracks?status=eq.processing&processing_started=lt."
       + time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 3 * 3600)), {"status": "pending"})

    # заявки на генерацию (*.gen) и на скачивание из каталога (*.imp) обрабатываются отдельно
    queue = db("GET", f"sup_tracks?status=eq.pending&source_path=not.like.*.gen"
                      f"&order=created_at.asc&limit={MAX_TRACKS}") or []
    print(f"В очереди: {len(queue)}", flush=True)
    done = failed = 0
    for track in queue:
        # забираем трек атомарно: если его уже взял другой запуск, пропускаем
        taken = db("PATCH", f"sup_tracks?id=eq.{track['id']}&status=eq.pending",
                   {"status": "processing", "processing_started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
        if not taken:
            continue
        print(f"▶ {track['artist']} — {track['title']}", flush=True)
        try:
            process(track)
            done += 1
            print("  ✓ опубликован", flush=True)
        except Exception as err:  # noqa: BLE001
            failed += 1
            traceback.print_exc()
            db("PATCH", f"sup_tracks?id=eq.{track['id']}", {"status": "failed", "error": str(err)[:500]})
            try:
                storage_delete("sup-incoming", [track["source_path"]] + ([track["cover_source"]] if track.get("cover_source") else []))
            except Exception:  # noqa: BLE001
                pass
    for step in (recensor, backfill_lyrics):
        try:
            step()
        except Exception:  # noqa: BLE001
            traceback.print_exc()
    cleanup()
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(f"## Обработка загрузок\n\nОпубликовано: {done}, ошибок: {failed}\n")


if __name__ == "__main__":
    main()

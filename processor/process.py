#!/usr/bin/env python3
"""Обработчик загрузок YouMusic (запускается в GitHub Actions по расписанию).

Для каждого трека в очереди:
  1. скачивает оригинал из приватного бакета incoming;
  2. Demucs (нейросеть) разделяет трек на голос и бит;
  3. Whisper (нейросеть) расшифровывает голос пословно, с точным временем;
  4. на месте мата и упоминаний наркотиков голос вырезается — остаётся только бит;
  5. отцензуренная версия публикуется в бакет tracks, оригинал удаляется.

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
from words import banned_in, censor_text, is_banned  # noqa: E402

RATE = 44100
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
    """Пословная расшифровка: [(начало, конец, слово)]."""
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
    words = []
    for seg in segments:
        for w in seg.words or []:
            words.append((w.start, w.end, w.word.strip()))
    return words


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


def peaks(mono, count=128):
    block = max(1, len(mono) // count)
    vals = [float(np.sqrt(np.mean(mono[i * block:(i + 1) * block] ** 2))) if i * block < len(mono) else 0.0
            for i in range(count)]
    top = max(vals) or 1
    return [round(v / top, 3) for v in vals]


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


def cover_color(image):
    raw = subprocess.run(["ffmpeg", "-v", "quiet", "-i", str(image), "-vf", "scale=24:24", "-f", "rawvideo",
                          "-pix_fmt", "rgb24", "-"], check=True, capture_output=True).stdout
    px = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).astype(np.float32)
    mx, mn = px.max(axis=1), px.min(axis=1)
    w = ((mx - mn) / 255) ** 2 * (mx / 255) + 0.01
    r, g, b = (px * w[:, None]).sum(axis=0) / w.sum()
    return f"#{int(r):02x}{int(g):02x}{int(b):02x}"


def generated_cover(title, artist):
    h = 0
    for ch in title + artist:
        h = (h * 31 + ord(ch)) % 360
    h2 = (h + 60) % 360
    esc = lambda s: s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")  # noqa: E731
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600">
  <defs><radialGradient id="a" cx="25%" cy="20%" r="95%"><stop offset="0" stop-color="hsl({h} 90% 62%)"/><stop offset=".6" stop-color="hsl({h2} 70% 30%)"/><stop offset="1" stop-color="hsl({h2} 60% 10%)"/></radialGradient></defs>
  <rect width="600" height="600" fill="url(#a)"/>
  <circle cx="440" cy="420" r="190" fill="none" stroke="hsl({(h + 180) % 360} 95% 70%)" stroke-width="22" opacity=".85"/>
  <circle cx="440" cy="420" r="120" fill="none" stroke="#fff" stroke-width="6" opacity=".35"/>
  <text x="44" y="108" font-family="Arial Black, Arial, sans-serif" font-weight="900" font-size="50" fill="#fff">{esc(title[:18])}</text>
  <text x="44" y="158" font-family="Arial, sans-serif" font-weight="700" font-size="30" fill="#fff" opacity=".75">{esc(artist[:28])}</text>
</svg>"""
    import colorsys
    r, g, b = colorsys.hls_to_rgb(h / 360, 0.62, 0.9)
    return svg, f"#{int(r * 255):02x}{int(g * 255):02x}{int(b * 255):02x}"


# ---------- Обработка одного трека ----------

def process(track):
    tid = track["id"]
    work = Path(tempfile.mkdtemp(prefix=f"ym-{tid[:8]}-"))
    try:
        src = work / ("source" + Path(track["source_path"]).suffix)
        storage_download("incoming", track["source_path"], src)
        wav = work / "orig.wav"
        try:
            decode(src, wav)
        except subprocess.CalledProcessError:
            raise RuntimeError("Не удалось прочитать аудиофайл — проверьте формат") from None

        audio, _ = sf.read(wav, dtype="float32", always_2d=True)

        # 1. голос отдельно от бита
        print("  Разделяю голос и бит (Demucs)…", flush=True)
        stems = separate(wav, work)
        vocals_file = stems[0] if stems else wav

        # 2. пословная расшифровка голоса
        print("  Расшифровываю слова (Whisper)…", flush=True)
        words = transcribe_words(vocals_file)
        bad = [(s, e, w) for s, e, w in words if is_banned(w.strip(".,!?…:;\"'«»()-"))]
        intervals = [(s - PAD, e + PAD) for s, e, _ in bad]

        # 3. страховка по тексту LRC: если в строке есть запретное слово, а Whisper его не услышал,
        #    убираем голос на всю строку
        for start, end, text in lrc_lines(track.get("lyrics")):
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

        out_wav, out_mp3 = work / "out.wav", work / "audio.mp3"
        sf.write(out_wav, audio, RATE)
        run(["ffmpeg", "-v", "error", "-y", "-i", str(out_wav), "-c:a", "libmp3lame", "-b:a", "128k", str(out_mp3)])

        # 5. обложка и цвет
        title, n1 = censor_text(track["title"])
        artist, n2 = censor_text(track["artist"])
        album, n3 = censor_text(track.get("album") or "")
        lyrics, n4 = censor_text(track.get("lyrics") or "")
        cover_jpg = work / "cover.jpg"
        has_cover = False
        if track.get("cover_source"):
            cover_src = work / ("cover-src" + Path(track["cover_source"]).suffix)
            storage_download("incoming", track["cover_source"], cover_src)
            has_cover = make_cover(cover_src, cover_jpg, False)
        if not has_cover:
            has_cover = make_cover(src, cover_jpg, True)
        if has_cover:
            cover_key, cover_type, color = f"{tid}/cover.jpg", "image/jpeg", cover_color(cover_jpg)
            cover_file = cover_jpg
        else:
            svg, color = generated_cover(title, artist)
            cover_file = work / "cover.svg"
            cover_file.write_text(svg, encoding="utf-8")
            cover_key, cover_type = f"{tid}/cover.svg", "image/svg+xml"

        # 6. публикация
        storage_upload("tracks", f"{tid}/audio.mp3", out_mp3, "audio/mpeg")
        storage_upload("tracks", cover_key, cover_file, cover_type)
        db("PATCH", f"tracks?id=eq.{tid}", {
            "status": "ready",
            "error": None,
            "title": title,
            "artist": artist,
            "album": album or None,
            "lyrics": lyrics or None,
            "audio_path": f"{tid}/audio.mp3",
            "cover_path": cover_key,
            "duration": round(len(audio) / RATE, 1),
            "color": color,
            "peaks": peaks(audio.mean(axis=1)),
            "censored": len(intervals) + n1 + n2 + n3 + n4,
            "published_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        })
        # оригинал без цензуры больше не храним
        storage_delete("incoming", [track["source_path"]] + ([track["cover_source"]] if track.get("cover_source") else []))
    finally:
        shutil.rmtree(work, ignore_errors=True)


def cleanup():
    """Удаляет файлы треков, которые пользователи удалили с сайта."""
    folders = [o["name"] for o in storage_list("tracks") if o.get("id") is None]
    users = [o["name"] for o in storage_list("incoming") if o.get("id") is None]
    incoming = {f"{u}/{o['name']}": o["name"].split(".")[0] for u in users for o in storage_list("incoming", u)}
    ids = sorted(set(folders) | set(incoming.values()))
    if not ids:
        return
    alive = set()
    for i in range(0, len(ids), 100):
        chunk = ",".join(x for x in ids[i:i + 100] if re.fullmatch(r"[0-9a-f-]{36}", x))
        if chunk:
            alive |= {r["id"] for r in db("GET", f"tracks?select=id&id=in.({chunk})")}
    dead = [f for f in folders if f not in alive]
    for folder in dead:
        storage_delete("tracks", [f"{folder}/{o['name']}" for o in storage_list("tracks", folder)])
    dead_incoming = [k for k, tid in incoming.items() if tid not in alive]
    storage_delete("incoming", dead_incoming)
    if dead or dead_incoming:
        print(f"Удалены файлы {len(dead)} удалённых треков и {len(dead_incoming)} брошенных загрузок")


def main():
    if not SUPABASE_URL or not SERVICE_KEY:
        sys.exit("Не заданы SUPABASE_URL и SUPABASE_SERVICE_KEY")

    # треки, «застрявшие» после упавшего запуска, возвращаем в очередь
    db("PATCH", "tracks?status=eq.processing&processing_started=lt."
       + time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 3 * 3600)), {"status": "pending"})

    queue = db("GET", f"tracks?status=eq.pending&order=created_at.asc&limit={MAX_TRACKS}") or []
    print(f"В очереди: {len(queue)}", flush=True)
    done = failed = 0
    for track in queue:
        # забираем трек атомарно: если его уже взял другой запуск, пропускаем
        taken = db("PATCH", f"tracks?id=eq.{track['id']}&status=eq.pending",
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
            db("PATCH", f"tracks?id=eq.{track['id']}", {"status": "failed", "error": str(err)[:500]})
            try:
                storage_delete("incoming", [track["source_path"]] + ([track["cover_source"]] if track.get("cover_source") else []))
            except Exception:  # noqa: BLE001
                pass
    cleanup()
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(f"## Обработка загрузок\n\nОпубликовано: {done}, ошибок: {failed}\n")


if __name__ == "__main__":
    main()

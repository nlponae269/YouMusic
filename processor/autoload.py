#!/usr/bin/env python3
"""Автозагрузка треков из открытой библиотеки ccMixter (музыка по лицензиям Creative Commons).

За один запуск берёт один новый трек и ставит его в обычную очередь: дальше он проходит ту же
модерацию, что и ручные загрузки (Demucs + Whisper вырезают запрещённые слова), и только потом
публикуется. Владелец таких треков — администратор, загрузчик — «ccmixter:<автор>/<номер>»:
по нему сайт показывает ссылку на оригинал и лицензию (обязательное условие CC BY).

Ещё здесь удаляются остатки SoundCloud: треки с их плеера сайт больше не показывает.

Только стандартная библиотека — запускается при каждой проверке очереди, без нейросетей.
"""
import http.client
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import uuid

# ccMixter дублирует весь ответ в заголовок X-JSON — снимаем ограничение длины строки заголовка
http.client._MAXLINE = 10_000_000

URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
UA = {"User-Agent": "YouMusic (https://github.com/nlponae269/YouMusic)"}

API = "https://ccmixter.org/api/query"
# жанры по кругу; через запятую — трек должен иметь все теги сразу
TAGS = ["hip_hop,male_vocals", "hip_hop,female_vocals", "rap", "trap", "hip_hop", "pop,vocals", "chill,vocals"]
PER_DAY = 6       # сколько треков добавлять в сутки
TOTAL = 150       # потолок, чтобы не забить бесплатный 1 ГБ хранилища
MAX_BYTES = 45 * 1024 * 1024
# лицензии, которые разрешают нам изменять трек (вырезать слова) и показывать его бесплатно
LICENSES = re.compile(r"/licenses/(by|by-sa|by-nc|by-nc-sa)/")
# голые вокальные дорожки и сэмплы для ремиксов — не песни, их не берём
NOT_SONGS = re.compile(r"a_?cc?app?ella|acapella|spoken_word|sample_pack|sound_effects|\bstems?\b", re.I)


def call(method, path, body=None, prefer="return=minimal"):
    headers = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Prefer": prefer}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(URL + path, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=60) as res:
        payload = res.read()
    return json.loads(payload) if payload else None


def count(path):
    req = urllib.request.Request(f"{URL}{path}&limit=1", headers={
        "apikey": KEY, "Authorization": f"Bearer {KEY}", "Prefer": "count=exact"})
    with urllib.request.urlopen(req, timeout=60) as res:
        return int(res.headers.get("Content-Range", "*/0").split("/")[-1])


def remove_soundcloud():
    rows = call("GET", "/rest/v1/tracks?select=id,source_path"
                       "&or=(audio_path.like.soundcloud*,source_path.like.*.sc)") or []
    if not rows:
        return
    call("DELETE", "/rest/v1/tracks?or=(audio_path.like.soundcloud*,source_path.like.*.sc)")
    try:
        call("DELETE", "/storage/v1/object/incoming", {"prefixes": [r["source_path"] for r in rows]})
    except Exception:  # noqa: BLE001 — файлов заявок уже может не быть
        pass
    print(f"SoundCloud: удалено треков: {len(rows)}")


def seconds(ps):
    try:
        m, s = ps.split(":")
        return int(m) * 60 + int(s)
    except (AttributeError, ValueError):
        return 0


def licence_name(url):
    m = re.search(r"/licenses/([a-z-]+)/([\d.]+)", url or "")
    return f"CC {m.group(1).upper()} {m.group(2)}" if m else "CC"


def candidates(tags, offset):
    q = urllib.parse.urlencode({"f": "json", "tags": tags, "type": "all", "sort": "rank",
                                "limit": 20, "offset": offset})
    req = urllib.request.Request(f"{API}?{q}", headers=UA)
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.loads(res.read())


def pick(known, start):
    """Первый подходящий трек, которого у нас ещё нет: жанры по кругу, по 5 страниц на жанр."""
    for i in range(len(TAGS)):
        tags = TAGS[(start + i) % len(TAGS)]
        for page in range(5):
            try:
                batch = candidates(tags, page * 20)
            except Exception as err:  # noqa: BLE001
                print(f"ccMixter недоступен ({tags}): {err}", file=sys.stderr)
                break
            for u in batch:
                key = f"{u.get('user_name')}/{u.get('upload_id')}"
                if key in known or (u.get("upload_extra") or {}).get("nsfw"):
                    continue
                if not LICENSES.search(u.get("license_url") or ""):
                    continue
                if NOT_SONGS.search(f"{u.get('upload_tags') or ''} {u.get('upload_name') or ''}"):
                    continue
                for f in u.get("files") or []:
                    info = f.get("file_format_info") or {}
                    size = re.search(r"([\d.]+)\s*MB", f.get("file_filesize") or "")
                    if (info.get("default-ext") == "mp3" and f.get("download_url")
                            and 60 <= seconds(info.get("ps")) <= 420
                            and (not size or float(size.group(1)) * 1024 * 1024 < MAX_BYTES)):
                        return u, f, key
            if len(batch) < 20:
                break
    return None


def import_one():
    busy = call("GET", "/rest/v1/tracks?select=id&status=in.(pending,processing)"
                       "&source_path=not.like.*.gen&limit=1")
    if busy:
        return  # сначала пусть обработается то, что уже в очереди
    total = count("/rest/v1/tracks?select=id&uploader=like.ccmixter:*")
    day_ago = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 86400))
    today = count(f"/rest/v1/tracks?select=id&uploader=like.ccmixter:*&created_at=gt.{day_ago}")
    if total >= TOTAL or today >= PER_DAY:
        print(f"Автозагрузка: на сегодня хватит ({today}/{PER_DAY}, всего {total}/{TOTAL})")
        return
    admins = call("GET", "/rest/v1/admins?select=user_id&limit=1") or []
    if not admins:
        print("Автозагрузка: нет администратора — треки не на кого записать")
        return
    owner = admins[0]["user_id"]
    # учитываем и удалённые админом треки: заново их не добавляем
    known = {r["uploader"][9:] for r in call("GET", "/rest/v1/tracks?select=uploader&uploader=like.ccmixter:*") or []}
    known |= set(load_skipped())
    found = pick(known, total)
    if not found:
        print("Автозагрузка: новых подходящих треков не нашлось")
        return
    u, f, key = found
    req = urllib.request.Request(f["download_url"], headers=UA)
    with urllib.request.urlopen(req, timeout=300) as res:
        audio = res.read(MAX_BYTES + 1)
    if len(audio) > MAX_BYTES:
        print(f"Автозагрузка: {key} больше лимита, пропускаю")
        save_skipped(key)
        return
    tid = str(uuid.uuid4())
    source = f"{owner}/{tid}.mp3"
    up = urllib.request.Request(f"{URL}/storage/v1/object/incoming/{source}", data=audio, method="POST", headers={
        "apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "audio/mpeg"})
    urllib.request.urlopen(up, timeout=300).read()
    artist = (u.get("user_real_name") or u.get("user_name") or "ccMixter").strip()[:200]
    title = (u.get("upload_name") or "Без названия").strip()[:200]
    call("POST", "/rest/v1/tracks", {
        "id": tid,
        "owner": owner,
        "uploader": f"ccmixter:{key}"[:200],
        "title": title,
        "artist": artist,
        "album": f"ccMixter · {licence_name(u.get('license_url'))}",
        "status": "pending",
        "source_path": source,
    })
    save_skipped(key)  # чтобы не взять тот же трек ещё раз, даже если его удалят
    print(f"Автозагрузка: в очереди на проверку «{artist} — {title}» ({key})")


# Список уже взятых треков (в том числе удалённых администратором) — рядом с состоянием обработчика
SKIPPED = "_meta/ccmixter.json"


def load_skipped():
    try:
        req = urllib.request.Request(f"{URL}/storage/v1/object/tracks/{SKIPPED}",
                                     headers={"apikey": KEY, "Authorization": f"Bearer {KEY}"})
        with urllib.request.urlopen(req, timeout=60) as res:
            return json.loads(res.read())
    except Exception:  # noqa: BLE001 — файла ещё нет
        return []


def save_skipped(key):
    data = json.dumps(sorted(set(load_skipped()) | {key})).encode()
    req = urllib.request.Request(f"{URL}/storage/v1/object/tracks/{SKIPPED}", data=data, method="POST", headers={
        "apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json", "x-upsert": "true"})
    try:
        urllib.request.urlopen(req, timeout=60).read()
    except Exception as err:  # noqa: BLE001
        print(f"Автозагрузка: не удалось сохранить список: {err}", file=sys.stderr)


def main():
    if not URL or not KEY:
        return
    for step in (remove_soundcloud, import_one):
        try:
            step()
        except Exception as err:  # noqa: BLE001
            print(f"::warning::{step.__name__}: {err}", file=sys.stderr)


if __name__ == "__main__":
    main()

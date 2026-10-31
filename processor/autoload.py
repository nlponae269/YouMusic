#!/usr/bin/env python3
"""Автозагрузка треков из Internet Archive (раздел netlabels: релизы сетевых лейблов по лицензиям Creative Commons).

За один запуск берёт один новый трек и ставит его в обычную очередь: дальше он проходит ту же
модерацию, что и ручные загрузки (Demucs + Whisper вырезают запрещённые слова), и только потом
публикуется. Из каждого релиза берётся один трек, чтобы каталог был разнообразным.
Владелец таких треков — администратор, загрузчик — «archive:<релиз>/<файл>»: по нему сайт
показывает ссылку на оригинал и лицензию (обязательное условие лицензий CC).

Ещё здесь удаляются остатки SoundCloud: треки с их плеера сайт больше не показывает.

Только стандартная библиотека — запускается при каждой проверке очереди, без нейросетей.
"""
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import uuid

URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
UA = {"User-Agent": "YouMusic (https://github.com/nlponae269/YouMusic)"}

SEARCH = "https://archive.org/advancedsearch.php"
# Хип-хоп и рэп; лицензии без «nd»: нам нужно право изменять трек (вырезать слова)
QUERY = ('collection:netlabels AND mediatype:audio AND licenseurl:*creativecommons* AND -licenseurl:*nd* '
         'AND (subject:"hip hop" OR subject:"hip-hop" OR subject:hiphop OR subject:rap '
         'OR subject:"рэп" OR subject:"хип-хоп" OR subject:"русский рэп")')
PER_DAY = 6       # сколько треков добавлять в сутки
TOTAL = 150       # потолок, чтобы не забить бесплатный 1 ГБ хранилища
MAX_BYTES = 45 * 1024 * 1024
DEADLINE = time.time() + 240  # если архив тормозит, не задерживаем очередь дольше 4 минут
PREFIX = "archive:"
# интро, скиты, акапеллы и т. п. — не песни, их не берём
NOT_SONGS = re.compile(r"\b(intro|outro|skit|interlude|a ?capp?ella|acapella|instrumental)\b", re.I)


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


def seconds(length):
    """Длительность из метаданных архива: «04:38» или «350.55»."""
    try:
        if ":" in str(length):
            parts = [float(x) for x in str(length).split(":")]
            return sum(v * 60 ** i for i, v in enumerate(reversed(parts)))
        return float(length)
    except (TypeError, ValueError):
        return 0


def licence_name(url):
    m = re.search(r"/(licenses|publicdomain)/([a-z-]+)/([\d.]+)", url or "")
    if not m:
        return "CC"
    return "CC0" if m.group(2) == "zero" else f"CC {m.group(2).upper()} {m.group(3)}"


def get_json(url, timeout=30):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as res:
        return json.loads(res.read())


def releases(page):
    q = urllib.parse.urlencode({"q": QUERY, "fl[]": ["identifier", "creator", "licenseurl"], "rows": 50,
                                "page": page, "sort[]": "downloads desc", "output": "json"}, doseq=True)
    return get_json(f"{SEARCH}?{q}")["response"]["docs"]


def first(value):
    return (value[0] if isinstance(value, list) else value or "").strip()


def track_of(item):
    """Первый подходящий трек релиза: оригинальный MP3 от 1 до 7 минут, не интро и не скит."""
    meta = get_json(f"https://archive.org/metadata/{urllib.parse.quote(item['identifier'])}")
    for f in meta.get("files") or []:
        name = f.get("name") or ""
        if f.get("source") != "original" or not name.lower().endswith(".mp3"):
            continue
        title = (f.get("title") or re.sub(r"^\d+[\s._-]*", "", name.rsplit("/", 1)[-1][:-4]).replace("_", " ")).strip()
        if NOT_SONGS.search(title) or not 60 <= seconds(f.get("length")) <= 420:
            continue
        if int(f.get("size") or 0) > MAX_BYTES:
            continue
        artist = first(f.get("artist") or f.get("creator")) or first(item.get("creator")) or "Неизвестный артист"
        # «Артист - Название» в названии файла — оставляем только название
        title = re.sub(rf"^{re.escape(artist)}\s*[-–—]\s*", "", title, flags=re.I) or title
        title = re.sub(r"^\d{1,2}[\s._-]+", "", title) or title  # номер трека в начале
        return {"file": name, "title": title, "artist": artist}
    return None


def pick(known):
    """Самые скачиваемые релизы, из которых ещё ничего не брали."""
    for page in range(1, 15):
        if time.time() > DEADLINE:
            print("Автозагрузка: архив отвечает слишком долго, попробую в следующий раз")
            return None
        docs = releases(page)
        for item in docs:
            ident = item["identifier"]
            if ident in known:
                continue
            if time.time() > DEADLINE:
                return None
            known.add(ident)
            try:
                track = track_of(item)
            except Exception as err:  # noqa: BLE001
                print(f"Автозагрузка: не удалось прочитать {ident}: {err}", file=sys.stderr)
                continue
            if track:
                return item, track
            save_skipped(ident)  # в релизе нет подходящих треков — больше не смотрим
        if len(docs) < 50:
            break
    return None


def import_one():
    busy = call("GET", "/rest/v1/tracks?select=id&status=in.(pending,processing)"
                       "&source_path=not.like.*.gen&limit=1")
    if busy:
        return  # сначала пусть обработается то, что уже в очереди
    total = count(f"/rest/v1/tracks?select=id&uploader=like.{PREFIX}*")
    day_ago = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 86400))
    today = count(f"/rest/v1/tracks?select=id&uploader=like.{PREFIX}*&created_at=gt.{day_ago}")
    if total >= TOTAL or today >= PER_DAY:
        print(f"Автозагрузка: на сегодня хватит ({today}/{PER_DAY}, всего {total}/{TOTAL})")
        return
    admins = call("GET", "/rest/v1/admins?select=user_id&limit=1") or []
    if not admins:
        print("Автозагрузка: нет администратора — треки не на кого записать")
        return
    owner = admins[0]["user_id"]
    # релизы, из которых уже брали, в том числе если администратор потом удалил трек
    known = set(load_skipped())
    known |= {r["uploader"][len(PREFIX):].split("/")[0]
              for r in call("GET", f"/rest/v1/tracks?select=uploader&uploader=like.{PREFIX}*") or []}
    found = pick(known)
    if not found:
        print("Автозагрузка: новых подходящих треков не нашлось")
        return
    item, track = found
    ident = item["identifier"]
    url = f"https://archive.org/download/{urllib.parse.quote(ident)}/{urllib.parse.quote(track['file'])}"
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=300) as res:
        audio = res.read(MAX_BYTES + 1)
    save_skipped(ident)  # из этого релиза больше не берём
    if len(audio) > MAX_BYTES:
        print(f"Автозагрузка: {ident} больше лимита, пропускаю")
        return
    tid = str(uuid.uuid4())
    source = f"{owner}/{tid}.mp3"
    up = urllib.request.Request(f"{URL}/storage/v1/object/incoming/{source}", data=audio, method="POST", headers={
        "apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "audio/mpeg"})
    urllib.request.urlopen(up, timeout=300).read()
    call("POST", "/rest/v1/tracks", {
        "id": tid,
        "owner": owner,
        "uploader": f"{PREFIX}{ident}/{track['file']}"[:200],
        "title": track["title"][:200] or "Без названия",
        "artist": track["artist"][:200],
        "album": f"Internet Archive · {licence_name(item.get('licenseurl'))}",
        "status": "pending",
        "source_path": source,
    })
    print(f"Автозагрузка: в очереди на проверку «{track['artist']} — {track['title']}» ({ident})")


# Список уже взятых треков (в том числе удалённых администратором) — рядом с состоянием обработчика
SKIPPED = "_meta/autoload.json"


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

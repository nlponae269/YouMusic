#!/usr/bin/env python3
"""Загрузка треков из открытого каталога по заявкам с сайта.

Человек находит трек в поиске (каталог Openverse, музыка Jamendo под лицензиями CC) и нажимает
«Загрузить». Заявка — строка в tracks со source_path «<uid>/<id>.imp» и JSON {url} в бакете incoming.
Здесь файл скачивается и кладётся в incoming как обычная загрузка, после чего трек проходит
ту же модерацию (Demucs + Whisper), что и всё остальное.

Только стандартная библиотека — запускается при каждой проверке очереди, без нейросетей.
"""
import json
import os
import re
import sys
import urllib.parse
import urllib.request

URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
UA = {"User-Agent": "YouMusic (https://github.com/nlponae269/YouMusic)"}
MAX_BYTES = 45 * 1024 * 1024
# откуда разрешено скачивать: только файловые серверы каталога
AUDIO_HOSTS = re.compile(r"(^|\.)storage\.jamendo\.com$")
COVER_HOSTS = re.compile(r"^usercontent\.jamendo\.com$")
MAX_COVER = 5 * 1024 * 1024
EXT = {"audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/ogg": "ogg", "audio/flac": "flac", "audio/wav": "wav",
       "audio/x-wav": "wav", "audio/mp4": "m4a"}


def call(method, path, body=None, raw=False, headers=None):
    h = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Prefer": "return=minimal", **(headers or {})}
    data = body
    if body is not None and not isinstance(body, bytes):
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(URL + path, data=data, method=method, headers=h)
    with urllib.request.urlopen(req, timeout=300) as res:
        payload = res.read()
    if raw:
        return payload
    return json.loads(payload) if payload else None


def fetch(track):
    req = json.loads(call("GET", f"/storage/v1/object/incoming/{urllib.parse.quote(track['source_path'])}", raw=True))
    url = req.get("url") or ""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme != "https" or not AUDIO_HOSTS.search(parts.hostname or ""):
        raise ValueError("Скачивать можно только из открытого каталога")
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=300) as res:
        kind = res.headers.get_content_type()
        audio = res.read(MAX_BYTES + 1)
    if len(audio) > MAX_BYTES:
        raise ValueError("Файл больше 45 МБ")
    if not kind.startswith("audio/"):
        raise ValueError("По ссылке не аудио")
    source = re.sub(r"\.imp$", f".{EXT.get(kind, 'mp3')}", track["source_path"])
    call("POST", f"/storage/v1/object/incoming/{urllib.parse.quote(source)}", audio,
         headers={"Content-Type": kind, "x-upsert": "true"})
    changes = {"source_path": source}
    cover = fetch_cover(req.get("cover"), re.sub(r"\.imp$", ".cover.jpg", track["source_path"]))
    if cover:
        changes["cover_source"] = cover
    # обычная загрузка в очереди: дальше её подхватит модерация
    call("PATCH", f"/rest/v1/tracks?id=eq.{track['id']}", changes)
    print(f"Каталог: скачан «{track['artist']} — {track['title']}», отправлен на модерацию")


def fetch_cover(url, dest):
    """Обложка альбома — необязательна: если не скачалась, обработчик нарисует свою."""
    parts = urllib.parse.urlsplit(url or "")
    if parts.scheme != "https" or not COVER_HOSTS.search(parts.hostname or ""):
        return None
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as res:
            kind = res.headers.get_content_type()
            image = res.read(MAX_COVER + 1)
        if kind not in ("image/jpeg", "image/png", "image/webp") or len(image) > MAX_COVER:
            return None
        dest = re.sub(r"\.jpg$", "." + kind.split("/")[1].replace("jpeg", "jpg"), dest)
        call("POST", f"/storage/v1/object/incoming/{urllib.parse.quote(dest)}", image,
             headers={"Content-Type": kind, "x-upsert": "true"})
        return dest
    except Exception as err:  # noqa: BLE001
        print(f"Каталог: обложка не скачалась: {err}", file=sys.stderr)
        return None


def migrate():
    """Трек, добавленный старой автозагрузкой из Internet Archive: ссылку на оригинал — в новый формат."""
    for t in call("GET", "/rest/v1/tracks?select=id,uploader&uploader=like.archive:*") or []:
        ident = t["uploader"][len("archive:"):].split("/")[0]
        call("PATCH", f"/rest/v1/tracks?id=eq.{t['id']}",
             {"uploader": f"Internet Archive\nhttps://archive.org/details/{urllib.parse.quote(ident)}"})


def remove_autoloaded():
    """Старая автозагрузка из Internet Archive отключена; по просьбе владельца оставлен только один её трек."""
    keep = "OnorezdiLP016"
    rows = call("GET", "/rest/v1/tracks?select=id,title&uploader=like.*archive.org/details/*") or []
    for t in rows:
        if keep not in call("GET", f"/rest/v1/tracks?select=uploader&id=eq.{t['id']}")[0]["uploader"]:
            call("DELETE", f"/rest/v1/tracks?id=eq.{t['id']}")
            print(f"Удалён автотрек «{t['title']}»")


def main():
    if not URL or not KEY:
        return
    for step in (migrate, remove_autoloaded):
        try:
            step()
        except Exception as err:  # noqa: BLE001
            print(f"::warning::{step.__name__}: {err}", file=sys.stderr)
    rows = call("GET", "/rest/v1/tracks?select=id,title,artist,source_path"
                       "&status=eq.pending&source_path=like.*.imp&limit=20") or []
    for t in rows:
        try:
            fetch(t)
        except Exception as err:  # noqa: BLE001
            print(f"Каталог: ошибка для {t['id']}: {err}", file=sys.stderr)
            call("PATCH", f"/rest/v1/tracks?id=eq.{t['id']}", {"status": "failed", "error": str(err)[:300]})
        finally:
            try:
                call("DELETE", "/storage/v1/object/incoming", {"prefixes": [t["source_path"]]})
            except Exception:  # noqa: BLE001
                pass


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Публикация треков SoundCloud по ссылкам из профиля.

Заявка — строка в tracks со source_path «<uid>/<id>.sc» и JSON {url} в бакете incoming.
Название, артиста и обложку берём из официального oEmbed SoundCloud (без ключей).
Сам звук не копируется: на сайте трек играет через официальный плеер SoundCloud,
в audio_path записывается «soundcloud:<ссылка>».

Только стандартная библиотека — запускается при каждой проверке очереди, без нейросетей.
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
UA = {"User-Agent": "YouMusic (https://github.com/nlponae269/YouMusic)"}


def call(method, path, body=None, raw=False):
    headers = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Prefer": "return=minimal"}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(URL + path, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=60) as res:
        payload = res.read()
    if raw:
        return payload
    return json.loads(payload) if payload else None


def canonical(url):
    """Короткие ссылки (on.soundcloud.com, snd.sc) раскрываем; убираем ?si=… и прочие хвосты."""
    req = urllib.request.Request(url, headers=UA, method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            url = res.geturl()
    except urllib.error.HTTPError as err:
        url = err.geturl() or url
    parts = urllib.parse.urlsplit(url)
    host = parts.netloc.lower().replace("m.soundcloud.com", "soundcloud.com").replace("www.", "")
    if host != "soundcloud.com":
        raise ValueError("Ссылка ведёт не на soundcloud.com")
    path = parts.path.rstrip("/")
    if path.count("/") < 2 or "/sets/" in path:
        raise ValueError("Нужна ссылка на один трек (не на профиль и не на плейлист)")
    return f"https://soundcloud.com{path}"


def oembed(url):
    q = urllib.parse.urlencode({"format": "json", "url": url})
    req = urllib.request.Request(f"https://soundcloud.com/oembed?{q}", headers=UA)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.loads(res.read())
    except urllib.error.HTTPError as err:
        if err.code in (403, 404):
            raise ValueError("Трек не найден, приватный или запрещён к встраиванию") from None
        raise


def publish(track):
    req = json.loads(call("GET", f"/storage/v1/object/incoming/{urllib.parse.quote(track['source_path'])}", raw=True))
    url = canonical(req["url"])
    info = oembed(url)
    artist = (info.get("author_name") or "SoundCloud").strip()[:200]
    title = (info.get("title") or "").strip()
    # oEmbed отдаёт «Название by Артист» — отрезаем хвост
    title = re.sub(rf"\s+by\s+{re.escape(artist)}\s*$", "", title, flags=re.I).strip()[:200] or "Без названия"
    cover = info.get("thumbnail_url") or None
    if cover:
        cover = re.sub(r"-(large|t\d+x\d+)\.(jpg|png)$", r"-t500x500.\2", cover)
    call("PATCH", f"/rest/v1/tracks?id=eq.{track['id']}", {
        "status": "ready",
        "title": title,
        "artist": artist,
        "album": "SoundCloud",
        "audio_path": f"soundcloud:{url}",
        "cover_path": cover,
        "color": "#ff5500",
        # пометка для обработчика: тексты и цензура к таким трекам не применяются
        "error": "soundcloud",
        "published_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    })
    print(f"SoundCloud: опубликован «{artist} — {title}»")


def main():
    if not URL or not KEY:
        return
    rows = call("GET", "/rest/v1/tracks?select=id,source_path&status=eq.pending&source_path=like.*.sc&limit=50") or []
    for t in rows:
        try:
            publish(t)
        except Exception as err:  # noqa: BLE001
            print(f"SoundCloud: ошибка для {t['id']}: {err}", file=sys.stderr)
            call("PATCH", f"/rest/v1/tracks?id=eq.{t['id']}", {"status": "failed", "error": str(err)[:300]})
        finally:
            try:
                call("DELETE", "/storage/v1/object/incoming", {"prefixes": [t["source_path"]]})
            except Exception:  # noqa: BLE001
                pass


if __name__ == "__main__":
    main()

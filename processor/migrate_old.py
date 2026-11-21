#!/usr/bin/env python3
"""Переносит опубликованные треки старого YouMusic (таблица tracks, бакет tracks) в supMUSIC.

Старые данные не трогаются: файлы копируются в бакеты audio и covers, строка создаётся
в sup_tracks с тем же id. Уже перенесённые треки пропускаются, поэтому скрипт можно
запускать при каждой проверке очереди. Треки SoundCloud не переносятся.

Только стандартная библиотека.
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
H = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}


def call(method, path, body=None, raw=False, headers=None):
    h = {**H, "Prefer": "return=minimal", **(headers or {})}
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


def copy(src_key, bucket, dest_key, kind):
    data = call("GET", f"/storage/v1/object/tracks/{urllib.parse.quote(src_key)}", raw=True)
    call("POST", f"/storage/v1/object/{bucket}/{urllib.parse.quote(dest_key)}", data,
         headers={"Content-Type": kind, "x-upsert": "true"})


def main():
    if not URL or not KEY:
        return
    try:
        old = call("GET", "/rest/v1/tracks?select=*&status=eq.ready&audio_path=not.like.soundcloud*&order=published_at.asc")
    except urllib.error.HTTPError as err:
        if err.code in (404, 400):
            return  # старой таблицы нет — переносить нечего
        raise
    if not old:
        return
    ids = ",".join(t["id"] for t in old)
    have = {r["id"] for r in call("GET", f"/rest/v1/sup_tracks?select=id&id=in.({ids})") or []}
    for t in old:
        if t["id"] in have:
            continue
        try:
            owner = t["owner"]
            # профиль владельца (у старых аккаунтов его может ещё не быть)
            call("POST", "/rest/v1/sup_profiles", {"id": owner, "name": (t.get("uploader") or "").split("\n")[0][:60] or "user"},
                 headers={"Prefer": "resolution=ignore-duplicates,return=minimal"})
            audio_key = f"{owner}/{t['id']}.mp3"
            copy(t["audio_path"], "audio", audio_key, "audio/mpeg")
            cover_key = None
            if t.get("cover_path"):
                ext = t["cover_path"].rsplit(".", 1)[-1].lower()
                kind = {"svg": "image/svg+xml", "png": "image/png", "webp": "image/webp"}.get(ext, "image/jpeg")
                cover_key = f"{owner}/{t['id']}.{ext}"
                copy(t["cover_path"], "covers", cover_key, kind)
            call("POST", "/rest/v1/sup_tracks", {
                "id": t["id"],
                "owner": owner,
                "title": t["title"],
                "artist": t["artist"],
                "album": t.get("album"),
                "lyrics": t.get("lyrics"),
                "duration": round(t.get("duration") or 0),
                "audio_path": audio_key,
                "cover_path": cover_key,
                "censored": t.get("censored") or 0,
                "status": "ready",
                "created_at": t.get("created_at"),
                "published_at": t.get("published_at") or t.get("created_at"),
            })
            print(f"Перенесён из старого YouMusic: «{t['artist']} — {t['title']}»")
        except Exception as err:  # noqa: BLE001
            print(f"::warning::Не удалось перенести {t['id']}: {err}", file=sys.stderr)


if __name__ == "__main__":
    main()

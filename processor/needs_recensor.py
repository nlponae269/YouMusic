#!/usr/bin/env python3
"""Печатает «yes», если словарь обновился и есть опубликованные треки, не проверенные новым словарём.
Только стандартная библиотека — запускается при каждой проверке очереди."""
import json
import os
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
from words import VERSION  # noqa: E402

URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")


def get(path):
    req = urllib.request.Request(URL + path, headers={"apikey": KEY, "Authorization": f"Bearer {KEY}"})
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.loads(res.read())


try:
    try:
        state = get("/storage/v1/object/tracks/_meta/state.json")
    except urllib.error.HTTPError:
        state = {}
    checked = set(state.get("checked", [])) if state.get("version") == VERSION else set()
    ready = {r["id"] for r in get("/rest/v1/tracks?select=id&status=eq.ready")}
    print("yes" if ready - checked else "no")
except Exception as err:  # noqa: BLE001
    print(f"no  # ошибка проверки: {err}", file=sys.stderr)
    print("no")

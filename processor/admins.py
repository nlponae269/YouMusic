#!/usr/bin/env python3
"""Назначает администраторов сайта по почте владельца.

Почта в открытом виде в репозитории не хранится — только её SHA-256.
Администратором становится аккаунт с такой почтой; остальные снимаются.
Работает только на стандартной библиотеке, поэтому запускается при каждой проверке очереди.
"""
import hashlib
import json
import os
import sys
import time
import urllib.request

# sha256(почта владельца в нижнем регистре)
OWNER_EMAIL_SHA256 = {
    "690d5fbce36bb1fd2b51c0f36a67e59a8f100f0abe8093b0170f58a0c7f34c32",
}

URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")


def call(method, path, body=None):
    req = urllib.request.Request(
        URL + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json",
                 "Prefer": "return=minimal"})
    with urllib.request.urlopen(req, timeout=60) as res:
        data = res.read()
    return json.loads(data) if data else None


def mask(email):
    name, _, domain = (email or "?").partition("@")
    return f"{name[:2]}***@{domain}"


def main():
    if not URL or not KEY:
        return
    users, page = [], 1
    while True:
        batch = (call("GET", f"/auth/v1/admin/users?page={page}&per_page=1000") or {}).get("users", [])
        users += batch
        if len(batch) < 1000:
            break
        page += 1
    # статистика для владельца: сколько людей зарегистрировалось (без почт и имён)
    day_ago = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() - 86400))
    print(f"Пользователей: {len(users)}, новых за сутки: {sum((u.get('created_at') or '') > day_ago for u in users)}")
    owners = {u["id"]: u.get("email") for u in users
              if hashlib.sha256((u.get("email") or "").strip().lower().encode()).hexdigest() in OWNER_EMAIL_SHA256}
    current = {r["user_id"] for r in call("GET", "/rest/v1/admins?select=user_id") or []}

    if not owners:
        print("Аккаунт владельца ещё не зарегистрирован на сайте — администраторы не меняются")
        return
    for uid, email in owners.items():
        if uid not in current:
            call("POST", "/rest/v1/admins", {"user_id": uid})
            print(f"Администратор назначен: {mask(email)}")
    for uid in current - set(owners):
        call("DELETE", f"/rest/v1/admins?user_id=eq.{uid}")
        print(f"Снят администратор: {uid}")
    print(f"Администраторы: {', '.join(mask(e) for e in owners.values())}")


if __name__ == "__main__":
    try:
        main()
    except Exception as err:  # noqa: BLE001
        print(f"::warning::Не удалось обновить администраторов: {err}", file=sys.stderr)

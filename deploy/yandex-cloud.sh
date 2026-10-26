#!/usr/bin/env bash
# Разворачивает YouMusic в Yandex Cloud:
#   Object Storage (музыка) + Managed PostgreSQL (каталог) + Container Registry + Serverless Container (приложение).
# Нужны: yc (авторизованный, с выбранным каталогом), docker, jq, node 20+.
# Повторный запуск безопасен: существующие ресурсы переиспользуются, секреты хранятся в deploy/.state.env.
set -euo pipefail
cd "$(dirname "$0")/.."

NAME="${NAME:-youmusic}"
ZONE="${ZONE:-ru-central1-a}"
STATE=deploy/.state.env
touch "$STATE"
# shellcheck disable=SC1090
set -a; source "$STATE"; set +a

save() { grep -v "^$1=" "$STATE" > "$STATE.tmp" || true; echo "$1=$2" >> "$STATE.tmp"; mv "$STATE.tmp" "$STATE"; export "$1=$2"; }
step() { printf '\n\033[1;35m▶ %s\033[0m\n' "$*"; }

FOLDER_ID="$(yc config get folder-id)"
[ -n "${DB_PASSWORD:-}" ] || save DB_PASSWORD "$(openssl rand -hex 16)"
[ -n "${ADMIN_TOKEN:-}" ] || save ADMIN_TOKEN "$(openssl rand -hex 16)"
[ -n "${BUCKET:-}" ] || save BUCKET "$NAME-$(openssl rand -hex 4)"

step "Сервисный аккаунт"
SA_ID="$(yc iam service-account get "$NAME-sa" --format json 2>/dev/null | jq -r .id || true)"
if [ -z "$SA_ID" ]; then
  SA_ID="$(yc iam service-account create --name "$NAME-sa" --format json | jq -r .id)"
fi
for role in storage.editor container-registry.images.puller; do
  yc resource-manager folder add-access-binding "$FOLDER_ID" --role "$role" \
    --subject "serviceAccount:$SA_ID" >/dev/null 2>&1 || true
done

if [ -z "${S3_ACCESS_KEY_ID:-}" ]; then
  KEY_JSON="$(yc iam access-key create --service-account-id "$SA_ID" --format json)"
  save S3_ACCESS_KEY_ID "$(jq -r .access_key.key_id <<<"$KEY_JSON")"
  save S3_SECRET_ACCESS_KEY "$(jq -r .secret <<<"$KEY_JSON")"
fi

step "Бакет Object Storage: $BUCKET"
yc storage bucket get "$BUCKET" >/dev/null 2>&1 || yc storage bucket create --name "$BUCKET" >/dev/null

step "Managed PostgreSQL (первое создание занимает ~10 минут)"
if ! yc managed-postgresql cluster get "$NAME-pg" >/dev/null 2>&1; then
  yc managed-postgresql cluster create \
    --name "$NAME-pg" \
    --environment production \
    --network-name default \
    --host "zone-id=$ZONE,subnet-name=default-$ZONE,assign-public-ip=true" \
    --resource-preset s2.micro \
    --disk-type network-ssd \
    --disk-size 10 \
    --postgresql-version 16 \
    --user "name=$NAME,password=$DB_PASSWORD" \
    --database "name=$NAME,owner=$NAME"
fi
PG_ID="$(yc managed-postgresql cluster get "$NAME-pg" --format json | jq -r .id)"
DATABASE_URL="postgres://$NAME:$DB_PASSWORD@c-$PG_ID.rw.mdb.yandexcloud.net:6432/$NAME"

step "Container Registry и образ"
REG_ID="$(yc container registry get "$NAME" --format json 2>/dev/null | jq -r .id || true)"
[ -n "$REG_ID" ] || REG_ID="$(yc container registry create --name "$NAME" --format json | jq -r .id)"
yc container registry configure-docker >/dev/null
IMAGE="cr.yandex/$REG_ID/$NAME:$(date +%Y%m%d%H%M%S)"
docker build --platform linux/amd64 -t "$IMAGE" .
docker push "$IMAGE"

step "Serverless Container"
yc serverless container get "$NAME" >/dev/null 2>&1 || yc serverless container create --name "$NAME" >/dev/null
yc serverless container revision deploy \
  --container-name "$NAME" \
  --image "$IMAGE" \
  --service-account-id "$SA_ID" \
  --cores 1 --core-fraction 100 --memory 512MB \
  --concurrency 16 \
  --execution-timeout 60s \
  --environment "DATABASE_URL=$DATABASE_URL,S3_BUCKET=$BUCKET,S3_ACCESS_KEY_ID=$S3_ACCESS_KEY_ID,S3_SECRET_ACCESS_KEY=$S3_SECRET_ACCESS_KEY,ADMIN_TOKEN=$ADMIN_TOKEN" \
  >/dev/null
yc serverless container allow-unauthenticated-invoke "$NAME" >/dev/null
URL="$(yc serverless container get "$NAME" --format json | jq -r .url)"
URL="${URL%/}"

step "CORS бакета (для загрузки из админки)"
[ -d node_modules ] || npm ci --omit=dev
S3_BUCKET="$BUCKET" DATABASE_URL="$DATABASE_URL" node scripts/setup-bucket.js "$URL"

if [ "${SEED:-0}" = "1" ]; then
  step "Демо-треки"
  [ -f deploy/yandex-ca.pem ] || curl -sSfo deploy/yandex-ca.pem https://storage.yandexcloud.net/cloud-certs/CA.pem
  S3_BUCKET="$BUCKET" DATABASE_URL="$DATABASE_URL" PGSSLROOTCERT=deploy/yandex-ca.pem node scripts/seed.js
fi

cat <<EOF

✅ YouMusic развёрнут
   Приложение:  $URL
   Админка:     $URL/admin.html
   ADMIN_TOKEN: $ADMIN_TOKEN
   (все секреты сохранены в $STATE — не коммитьте этот файл)
EOF

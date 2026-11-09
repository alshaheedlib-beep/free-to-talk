#!/usr/bin/env bash
# Build the app image from the GitHub copy and (re)start the container. Messages and photos live in $DATA and survive every update.
set -euo pipefail
SRC=/opt/free-to-talk
DATA=/opt/freetotalk-data
NAME=free-to-talk
PORT=8082

mkdir -p "$DATA/db" "$DATA/uploads"
chown -R 1000:1000 "$DATA"
if [ ! -s "$DATA/admin-password.txt" ]; then
  head -c 24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 14 > "$DATA/admin-password.txt"
  chmod 600 "$DATA/admin-password.txt"
fi

docker build -q -t "$NAME" "$SRC" >/dev/null
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --restart unless-stopped --memory 256m --cpus 0.5 \
  -p $PORT:3000 -v "$DATA":/data \
  -e ADMIN_PASSWORD="$(cat "$DATA/admin-password.txt")" "$NAME" >/dev/null
docker network inspect web >/dev/null 2>&1 && docker network connect web "$NAME" 2>/dev/null || true
docker image prune -f >/dev/null 2>&1 || true

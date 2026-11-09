#!/usr/bin/env bash
# Build the app image from the GitHub copy and (re)start the container. Messages and photos live in $DATA and survive every update.
set -euo pipefail
SRC=/opt/free-to-talk
DATA=/opt/freetotalk-data
NAME=free-to-talk
# First free port from 8090 up (kept in $DATA/port so it never changes between updates).
port_free() { ! (ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1$") && ! docker ps --format '{{.Ports}}' | grep -q ":$1->"; }

mkdir -p "$DATA/db" "$DATA/uploads"
docker rm -f "$NAME" >/dev/null 2>&1 || true
PORT=$(cat "$DATA/port" 2>/dev/null || true)
if [ -z "$PORT" ] || ! port_free "$PORT"; then
  PORT=8090; while ! port_free "$PORT"; do PORT=$((PORT + 1)); done
  echo "$PORT" > "$DATA/port"
fi
chown -R 1000:1000 "$DATA"
if [ ! -s "$DATA/admin-password.txt" ]; then
  head -c 24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 14 > "$DATA/admin-password.txt"
  chmod 600 "$DATA/admin-password.txt"
fi

docker build -q -t "$NAME" "$SRC" >/dev/null
docker run -d --name "$NAME" --restart unless-stopped --memory 256m --cpus 0.5 \
  -p $PORT:3000 -v "$DATA":/data \
  -e ADMIN_PASSWORD="$(cat "$DATA/admin-password.txt")" "$NAME" >/dev/null
docker network inspect web >/dev/null 2>&1 && docker network connect web "$NAME" 2>/dev/null || true
docker image prune -f >/dev/null 2>&1 || true

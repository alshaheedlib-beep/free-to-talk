#!/usr/bin/env bash
# Runs every minute from cron: when GitHub has new commits, pull them and rebuild the app.
set -euo pipefail
SRC=/opt/free-to-talk
cd "$SRC"
git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && exit 0
git reset -q --hard origin/main
echo "$(date -Is) deploying $(git rev-parse --short HEAD)"
bash "$SRC/deploy/run.sh"
echo "$(date -Is) done"

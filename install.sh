#!/usr/bin/env bash
# Free to Talk — تركيب التطبيق على السيرفر (مرة واحدة فقط):
#   curl -fsSL https://raw.githubusercontent.com/alshaheedlib-beep/free-to-talk/main/install.sh | bash
# بعدها أي تعديل يُرفع على GitHub يظهر على السيرفر خلال دقيقة أو دقيقتين، بدون أي خطوة.
set -euo pipefail
REPO=https://github.com/alshaheedlib-beep/free-to-talk.git
SRC=/opt/free-to-talk
NAME=free-to-talk
PORT=8082
DOMAIN=talk.alshaheed.ps

command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh

# 1) نسخة التطبيق من GitHub
if [ -d "$SRC/.git" ]; then git -C "$SRC" fetch -q origin main && git -C "$SRC" reset -q --hard origin/main
else git clone -q "$REPO" "$SRC"; fi

# 2) بناء وتشغيل التطبيق (الرسائل والصور محفوظة في /opt/freetotalk-data)
echo ">> بناء التطبيق وتشغيله… (أول مرة بتاخذ دقيقة أو دقيقتين)"
bash "$SRC/deploy/run.sh"
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow $PORT/tcp >/dev/null; fi

# 3) رابط آمن (https) عن طريق Caddy — ضروري عشان الموبايل يعطي الموقع الحقيقي
DOMAIN_MSG="لم يُعثر على Caddy — التطبيق متاح على المنفذ $PORT فقط"
if docker ps --format '{{.Names}}' | grep -qx caddy; then
  CF=$(docker inspect caddy --format '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}')
  if [ -n "$CF" ]; then
    if ! grep -q "reverse_proxy $NAME:" "$CF"; then
      printf '\n%s {\n\tencode zstd gzip\n\treverse_proxy %s:3000\n}\n' "$DOMAIN" "$NAME" >> "$CF"
    fi
    docker exec caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 \
      && DOMAIN_MSG="https://$DOMAIN  (بيشتغل لما تضيف سجل A للـ talk يأشر على السيرفر)" \
      || DOMAIN_MSG="تمت إضافة الدومين لكن Caddy لم يُعد التحميل — شغّل: docker logs caddy"
  fi
fi

# 4) تحديث تلقائي من GitHub كل دقيقة
echo "* * * * * root flock -n /tmp/$NAME.lock bash $SRC/deploy/update.sh >> /var/log/$NAME-deploy.log 2>&1" > /etc/cron.d/$NAME-deploy
chmod 644 /etc/cron.d/$NAME-deploy

sleep 3
IP=$(curl -4 -s --max-time 5 ifconfig.me || hostname -I | awk '{print $1}')
echo ""
echo "=============================================="
echo " التطبيق:         http://$IP:$PORT"
echo " لوحة التحكم:     http://$IP:$PORT/admin"
echo " كلمة سر اللوحة:  $(cat /opt/freetotalk-data/admin-password.txt)"
echo " الرابط الآمن:    $DOMAIN_MSG"
echo " التحديث التلقائي من GitHub: مفعّل"
echo "=============================================="

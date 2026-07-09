#!/bin/bash
# fix-nginx-ivr.sh
# מתקן את Nginx כך ש-HTTP /ivr יועבר ל-Node במקום להחזיר 404
# הרץ כ: sudo bash fix-nginx-ivr.sh

set -e

# ── מוצא את קובץ ה-nginx ─────────────────────────────────────────────────────
NGINX_CONF=""
for candidate in \
    /etc/nginx/sites-enabled/default \
    /etc/nginx/sites-enabled/donors-system \
    /etc/nginx/conf.d/default.conf \
    /etc/nginx/nginx.conf; do
  if [ -f "$candidate" ]; then
    # בחר את הקובץ הראשון שמכיל listen 80
    if grep -q "listen 80" "$candidate" 2>/dev/null; then
      NGINX_CONF="$candidate"
      break
    fi
  fi
done

if [ -z "$NGINX_CONF" ]; then
  echo "ERROR: לא נמצא קובץ nginx עם listen 80"
  echo "הוסף את הבלוק הבא ידנית לתוך ה-server block של port 80:"
  cat <<'BLOCK'

    location /ivr {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto http;
        proxy_read_timeout 30s;
    }

BLOCK
  exit 1
fi

echo "נמצא קובץ nginx: $NGINX_CONF"

# ── גיבוי ────────────────────────────────────────────────────────────────────
BACKUP="${NGINX_CONF}.bak.$(date +%Y%m%d_%H%M%S)"
cp "$NGINX_CONF" "$BACKUP"
echo "גיבוי נשמר: $BACKUP"

# ── בדוק אם /ivr כבר קיים ב-port 80 ─────────────────────────────────────────
if grep -A5 "listen 80" "$NGINX_CONF" | grep -q "location /ivr"; then
  echo "location /ivr כבר קיים ב-port 80 — אין צורך בשינוי"
  exit 0
fi

# ── הוסף location /ivr לפני return 404 ב-server block של port 80 ────────────
# Python עוזר כי sed לא מתמודד טוב עם multi-line בloops
python3 - "$NGINX_CONF" <<'PYEOF'
import sys, re

path = sys.argv[1]
with open(path) as f:
    text = f.read()

ivr_block = """
    location /ivr {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto http;
        proxy_read_timeout 30s;
    }

"""

# מחפש return 404 בתוך server block של port 80 ומכניס את /ivr לפניו
# גישה פשוטה: מחפש את הביטוי "return 404" ומוסיף לפניו
if "return 404" in text:
    text = text.replace("return 404", ivr_block + "    return 404", 1)
    with open(path, "w") as f:
        f.write(text)
    print("הוספה בוצעה לפני return 404")
else:
    print("WARNING: לא נמצא 'return 404' — עריכה ידנית נדרשת")
    sys.exit(1)
PYEOF

# ── בדיקה ────────────────────────────────────────────────────────────────────
# nginx -t is the condition of this if — under `set -e`, a command tested
# directly as an if-condition is exempt from triggering an immediate exit on
# failure (only running it as its own statement first, then checking $?,
# would abort here before the rollback in the else branch ever ran).
echo ""
echo "בודק תקינות nginx..."
if nginx -t; then
  echo ""
  echo "מטעין nginx מחדש..."
  systemctl reload nginx
  echo ""
  echo "✓ הושלם! nginx reload בוצע."
  echo "  בדוק עם: curl -v 'http://$(hostname -I | awk '{print $1}')/ivr?ivrKey=TEST'"
else
  echo ""
  echo "ERROR: nginx -t נכשל — מחזיר גיבוי"
  cp "$BACKUP" "$NGINX_CONF"
  echo "הגיבוי שוחזר: $BACKUP"
  exit 1
fi

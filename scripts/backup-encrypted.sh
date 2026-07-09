#!/usr/bin/env bash
# backup-encrypted.sh — יוצר גיבוי מוצפן של מסד הנתונים (AES-256-CBC + PBKDF2)
#
# דרישות:
#   BACKUP_PASSPHRASE  — חייב להיות מוגדר כמשתנה סביבה (לא בקוד!)
#   sqlite3            — מותקן בשרת
#   openssl            — מותקן בשרת (ברירת מחדל ב-Ubuntu)
#
# שימוש:
#   BACKUP_PASSPHRASE="סיסמה_חזקה" ./scripts/backup-encrypted.sh
#
# או מ-cron (מומלץ: הגדר ב-/etc/environment או ~/.profile):
#   0 3 * * * BACKUP_PASSPHRASE="..." /var/www/donors-system/scripts/backup-encrypted.sh
#
# ─── שחזור מגיבוי מוצפן ────────────────────────────────────────────────────
#
#   openssl enc -d -aes-256-cbc -pbkdf2 -salt \
#     -pass env:BACKUP_PASSPHRASE \
#     -in /path/to/backup_2025-01-01_03-00.sqlite.enc \
#     -out /tmp/restore.sqlite
#
#   # לאחר מכן שנה את שם הקובץ לשם המקורי והפעל מחדש את השרת:
#   cp /tmp/restore.sqlite /var/www/donors-system/frontend/backend/data.sqlite
#   pm2 restart crm-ivr-server
#
# ─── אימות תקינות ──────────────────────────────────────────────────────────
#
#   # ניתן לאמת שהקובץ המוצפן תקין לפני שחזור אמיתי:
#   openssl enc -d -aes-256-cbc -pbkdf2 -salt \
#     -pass env:BACKUP_PASSPHRASE \
#     -in backup.sqlite.enc | sqlite3 - "SELECT count(*) FROM app_state;"
#
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── הגדרות ────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
DB_PATH="${DB_PATH:-$REPO_ROOT/frontend/backend/data.sqlite}"
BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/frontend/backend/backups}"
KEEP_DAYS="${KEEP_DAYS:-30}"

# ── בדיקות מקדימות ────────────────────────────────────────────────────────────
if [[ -z "${BACKUP_PASSPHRASE:-}" ]]; then
  echo "שגיאה: BACKUP_PASSPHRASE לא מוגדר כמשתנה סביבה." >&2
  echo "  הפעל: BACKUP_PASSPHRASE='...' $0" >&2
  exit 1
fi

if [[ ! -f "$DB_PATH" ]]; then
  echo "שגיאה: לא נמצא קובץ DB: $DB_PATH" >&2
  exit 1
fi

command -v sqlite3 >/dev/null 2>&1 || { echo "שגיאה: sqlite3 לא מותקן" >&2; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "שגיאה: openssl לא מותקן"  >&2; exit 1; }

mkdir -p "$BACKUP_DIR"

# ── גיבוי ─────────────────────────────────────────────────────────────────────
TIMESTAMP=$(date +"%Y-%m-%d_%H-%M")
PLAIN_TMP=$(mktemp /tmp/crm_backup_XXXXXX.sqlite)
ENCRYPTED_OUT="$BACKUP_DIR/backup_${TIMESTAMP}.sqlite.enc"

trap 'rm -f "$PLAIN_TMP"' EXIT   # ניקוי קובץ זמני תמיד
chmod 600 "$PLAIN_TMP"          # DB גולמי לא מוצפן — לוודא שרק הבעלים יכול לקרוא, גם אם umask/TMPDIR משותפים

# SQLite online backup (safe while server is running — no downtime needed)
sqlite3 "$DB_PATH" "VACUUM INTO '$PLAIN_TMP';"

# הצפנה: AES-256-CBC עם PBKDF2 ו-random salt (OpenSSL >= 1.1.1)
openssl enc -aes-256-cbc -pbkdf2 -salt \
  -pass env:BACKUP_PASSPHRASE \
  -in  "$PLAIN_TMP" \
  -out "$ENCRYPTED_OUT"

PLAIN_SIZE=$(stat -c%s "$PLAIN_TMP"  2>/dev/null || stat -f%z "$PLAIN_TMP")
ENC_SIZE=$(  stat -c%s "$ENCRYPTED_OUT" 2>/dev/null || stat -f%z "$ENCRYPTED_OUT")

echo "[$(date '+%Y-%m-%d %H:%M:%S')] גיבוי הושלם: $ENCRYPTED_OUT"
echo "  גודל מקורי: ${PLAIN_SIZE} בייטים | מוצפן: ${ENC_SIZE} בייטים"

# ── ניקוי גיבויים ישנים ───────────────────────────────────────────────────────
if [[ "$KEEP_DAYS" -gt 0 ]]; then
  DELETED=$(find "$BACKUP_DIR" -name "backup_*.sqlite.enc" -mtime +"$KEEP_DAYS" -print -delete | wc -l)
  if [[ "$DELETED" -gt 0 ]]; then
    echo "  נמחקו ${DELETED} גיבויים ישנים (מעל ${KEEP_DAYS} ימים)"
  fi
fi

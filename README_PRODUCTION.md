# מדריך Production — מערכת ניהול תורמים

---

## 1. התחברות למערכת

### דפדפן
פתח את הכתובת:
```
http://<כתובת-שרת>:3000
```

### כניסה ראשונית (מנהל ברירת מחדל)
| שדה    | ערך              |
|--------|------------------|
| מזהה   | `1`              |
| סיסמה  | `1234`           |

> **חשוב:** שנה את הסיסמה מיד לאחר הכניסה הראשונה — המערכת תדרוש זאת אוטומטית.

### גישה מרחוק (SSH Tunnel)
```bash
ssh -L 3000:localhost:3000 user@<כתובת-שרת>
```
לאחר מכן גש ל: `http://localhost:3000`

---

## 2. עדכון קוד (git pull)

```bash
# התחבר לשרת
ssh user@<כתובת-שרת>

# עבור לתיקיית הפרויקט
cd /path/to/project

# משוך שינויים
git pull origin master

# עדכן תלויות אם נוספו
cd frontend/backend
npm install --production

# הפעל מחדש את השרת
pm2 restart donors
```

---

## 3. הפעלה מחדש (Restart)

### עם PM2 (מומלץ)
```bash
pm2 restart donors
pm2 status
pm2 logs donors --lines 50
```

### ידני (בלי PM2)
```bash
cd frontend/backend
node server.js
```

### הגדרת PM2 להפעלה אוטומטית עם boot
```bash
pm2 startup
pm2 save
```

---

## 4. גיבוי

### גיבוי אוטומטי
המערכת מבצעת גיבוי יומי של בסיס הנתונים אוטומטית.
הגיבויים נשמרים ב:
```
frontend/backend/backups/
```
נשמרים 30 הגיבויים האחרונים (כ-30 יום).

### גיבוי ידני של DB
```bash
cp frontend/backend/data.sqlite frontend/backend/backups/manual-$(date +%Y%m%d-%H%M%S).sqlite
```

### שחזור מגיבוי
```bash
# עצור שרת קודם!
pm2 stop donors

# שחזר
cp frontend/backend/backups/data-YYYY-MM-DDTHH-MM-SSZ.sqlite frontend/backend/data.sqlite

# הפעל מחדש
pm2 start donors
```

### גיבוי לענן (מומלץ)
```bash
# דוגמה עם rsync לשרת נוסף:
rsync -av frontend/backend/backups/ user@backup-server:/backups/donors/

# דוגמה עם rclone ל-Google Drive:
rclone copy frontend/backend/backups remote:donors-backups
```

---

## 5. קובץ .env

**מיקום:** `frontend/backend/.env`

```env
PORT=3000
JWT_SECRET=<מפתח-רנדומלי-ארוך>
IVR_KEY=<מפתח-IVR-סודי>
CREDIT_CARD_TERMINAL=<מזהה-טרמינל>
TECHNOLINE_API_KEY=<מפתח-API-טכנוליין>
TECHNOLINE_AGENT_EXTENSION=<שלוחת-מזכיר>
SESSION_TIMEOUT_HOURS=8
NODE_ENV=production
DB_PATH=data.sqlite

# SIP (softphone)
SIP_SERVER=<כתובת-שרת-SIP>
SIP_EXT=<שלוחה>
SIP_USER=<משתמש-SIP>
SIP_PASS=<סיסמת-SIP>
```

### יצירת JWT_SECRET חדש
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

> **אבטחה:** לעולם אל תעלה את קובץ `.env` ל-git. הוא רשום ב-`.gitignore`.

---

## 6. בדיקת IVR (Technoline)

### בדיקת חיבור בסיסי
```bash
curl "http://localhost:3000/ivr?ivrKey=<IVR_KEY>&PBXphone=0521234567&PBXcallId=test-001"
```

### בדיקת health check
```bash
curl http://localhost:3000/health
# תשובה תקינה: {"ok":true,"database":"connected","ts":"..."}
```

### בדיקת IVR שלב אחר שלב
```bash
# שלב 1 — כניסה ראשונה (תפריט ראשי)
curl "http://localhost:3000/ivr?ivrKey=<IVR_KEY>&PBXphone=0521234567&PBXcallId=test-002"

# שלב 2 — בחירה "1" לתשלום
curl "http://localhost:3000/ivr?ivrKey=<IVR_KEY>&PBXphone=0521234567&PBXcallId=test-002&mainChoice=1"

# שלב 3 — בחירה "1" לחוב הראשון
curl "http://localhost:3000/ivr?ivrKey=<IVR_KEY>&PBXphone=0521234567&PBXcallId=test-002&mainChoice=1&debtChoice=1"
```

### בדיקת לוג IVR
```bash
# סשנים אחרונים
curl -H "Authorization: Bearer <TOKEN>" http://localhost:3000/api/ivr/sessions

# לוג IVR מוניטור (מנהל בלבד)
curl -H "Authorization: Bearer <TOKEN>" http://localhost:3000/api/admin/ivr-monitor
```

### מסך IVR מוניטור
גש ב-UI ל: `http://<שרת>:3000/ivr-monitor.html`

---

## 7. בדיקת Audit Trail

```bash
# לוג ביקורת שרת (מנהל בלבד)
curl -H "Authorization: Bearer <TOKEN>" http://localhost:3000/api/admin/audit-log
```

נרשמות האירועים הבאים:
- כניסה למערכת (`login`) / כניסה כושלת (`login_failed`)
- יצירת עובד (`worker_create`) / מחיקת עובד (`worker_delete`)
- שינוי סיסמה עצמי (`password_change`)
- איפוס סיסמה על ידי מנהל (`password_reset`)

---

## 8. פקודות שימושיות נוספות

```bash
# צפה בלוגים חיים
pm2 logs donors

# בדוק שימוש ב-CPU/זיכרון
pm2 monit

# הצג כל התהליכים
pm2 list

# הפעלה ראשונית עם PM2
cd frontend/backend
pm2 start pm2.ecosystem.config.js --env production
```

---

## 9. מבנה הקבצים

```
project/
├── frontend/
│   ├── index.html          # דף הבית (דשבורד)
│   ├── donors.html         # רשימת תורמים
│   ├── payments.html       # תשלומי IVR
│   ├── ivr-monitor.html    # מוניטור IVR
│   ├── softphone.html      # טלפון VoIP
│   ├── css/style.css       # עיצוב
│   ├── js/                 # לוגיקת frontend
│   └── backend/
│       ├── server.js       # שרת Express
│       ├── db.js           # SQLite
│       ├── ivr.service.js  # לוגיקת IVR
│       ├── data.sqlite     # בסיס נתונים
│       ├── backups/        # גיבויים יומיים
│       ├── .env            # הגדרות סביבה
│       └── pm2.ecosystem.config.js
└── README_PRODUCTION.md    # מסמך זה
```

---

_עדכון אחרון: יולי 2026_

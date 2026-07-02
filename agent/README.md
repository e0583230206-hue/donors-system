# סוכן שליחת אלפון — הוראות הפעלה

## איך זה עובד

```
ייצא CSV מהאלפון  →  node send_csv.js alfon.csv  →  מנהל מאשר ב-sync.html
```

השרת **לא מעדכן** שום דבר אוטומטית. הוא שומר את הקובץ כ-"ממתין לאישור".
המנהל רואה Preview מלא (חדשים / עדכון / דלג) ורק אז לוחץ "אשר".

---

## הגדרה ראשונית (פעם אחת)

### 1. ערוך את `send_csv.js`

פתח את הקובץ `agent/send_csv.js` וערוך שתי שורות בראש:

```js
const SERVER_URL = "https://your-server.com";     // ← כתובת השרת שלך
const API_KEY    = "המפתח_הסודי_שלך";            // ← חייב להתאים ל-.env בשרת
```

### 2. הוסף ל-.env בשרת

```
ALFON_SYNC_KEY=המפתח_הסודי_שלך
```

אחרי עריכת `.env` — הפעל מחדש את השרת:
```bash
pm2 restart all
```

### 3. ודא שיש Node.js 18+

```bash
node --version   # חייב להיות v18 ומעלה
```

---

## הפעלה ידנית

```bash
# מתוך תיקיית הפרויקט:
node agent/send_csv.js "C:\path\to\alfon_export.csv"
```

פלט מצופה:
```
שולח alfon_export.csv (45230 תווים) → https://your-server.com/api/sync/alfon-auto
✅ הועלה! pendingId=7
   חדש: 12  עדכון: 34  ללא שינוי: 980  דלג: 2
   → היכנס ל-https://your-server.com/sync.html לאישור הסנכרון
```

---

## הפעלה יומית אוטומטית — Windows Task Scheduler

### א. צור קובץ run_sync.bat

צור קובץ `agent\run_sync.bat` עם התוכן הבא:

```bat
@echo off
cd /d "C:\path\to\project"
node agent\send_csv.js "C:\path\to\alfon_export.csv" >> agent\alfon_sync.log 2>&1
```

> שנה את הנתיבים לפי המחשב שלך.

### ב. הוסף משימה ב-Task Scheduler

1. פתח **Task Scheduler** (חפש בתפריט Start)
2. לחץ **Create Basic Task**
3. **Name:** `Alfon Sync`
4. **Trigger:** Daily → שעה מועדפת (לדוגמה 07:00)
5. **Action:** Start a program → בחר את `run_sync.bat`
6. **Finish**

### ג. בדוק שהמשימה עובדת

לחץ ימני על המשימה → **Run** → בדוק את `agent\alfon_sync.log`

---

## אחרי כל שליחה — אישור מנהל

1. היכנס ל-`https://your-server.com/sync.html`
2. בראש הדף יופיע: **"ממתין לאישורך — סנכרון מהאלפון האוטומטי"**
3. לחץ **"🔍 תצוגה מקדימה"** לראות בדיוק מה ישתנה
4. לחץ **"✅ אשר וסנכרן"** לביצוע
5. או **"❌ דחה"** לביטול

---

## בטיחות

- הסקריפט **לא קורא** את קובץ ה-Access ישירות
- הסקריפט **לא משנה** שום דבר בבסיס הנתונים — רק שולח
- השרת **לא מעדכן** שום תורם ללא אישור מפורש של מנהל
- תרומות, חובות, תשלומים, הערות — **לא נגעים לעולם**
- מספר טלפון ראשי של תורם — **לא משתנה לעולם**

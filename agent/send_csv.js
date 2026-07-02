/**
 * send_csv.js — שולח CSV מיוצא מהאלפון לשרת (ממתין לאישור מנהל)
 *
 * שימוש:
 *   node send_csv.js alfon_export.csv
 *
 * דרישות: Node.js 18+ (fetch מובנה). אין צורך בהתקנות נוספות.
 *
 * אחרי העלאה — היכנס ל-sync.html באתר לאשר את הסנכרון.
 */

// ─── הגדרות ────────────────────────────────────────────────────────────────
const SERVER_URL = "https://your-server.com";        // כתובת השרת (ללא / בסוף)
const API_KEY    = "REPLACE_WITH_ALFON_SYNC_KEY";    // חייב להתאים ל-ALFON_SYNC_KEY ב-.env
// ──────────────────────────────────────────────────────────────────────────

const fs   = require("fs");
const path = require("path");

const csvPath = process.argv[2];
if (!csvPath) {
  console.error("שימוש: node send_csv.js <נתיב-לקובץ-csv>");
  process.exit(1);
}
if (!fs.existsSync(csvPath)) {
  console.error("קובץ לא נמצא:", csvPath);
  process.exit(1);
}
if (API_KEY === "REPLACE_WITH_ALFON_SYNC_KEY") {
  console.error("שגיאה: API_KEY לא הוגדר בסקריפט. ערוך את send_csv.js");
  process.exit(1);
}
if (SERVER_URL === "https://your-server.com") {
  console.error("שגיאה: SERVER_URL לא הוגדר בסקריפט. ערוך את send_csv.js");
  process.exit(1);
}

const content  = fs.readFileSync(csvPath, "utf-8");
const filename = path.basename(csvPath);
const url      = SERVER_URL.replace(/\/$/, "") + "/api/sync/alfon-auto";

console.log(`שולח ${filename} (${content.length} תווים) → ${url}`);

fetch(url, {
  method:  "POST",
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "X-Alfon-Key":  API_KEY,
  },
  body: JSON.stringify({ content, filename }),
})
  .then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (r.status === 401) {
      console.error("שגיאה: מפתח API לא תקין — בדוק ALFON_SYNC_KEY ב-.env");
      process.exit(1);
    }
    if (!r.ok) {
      console.error(`שגיאת שרת ${r.status}:`, data.error || JSON.stringify(data));
      process.exit(1);
    }
    const c = data.counts || {};
    console.log(`✅ הועלה! pendingId=${data.pendingId}`);
    console.log(`   חדש: ${c.create || 0}  עדכון: ${c.update || 0}  ללא שינוי: ${c.unchanged || 0}  דלג: ${c.skip || 0}`);
    console.log(`   → היכנס ל-${SERVER_URL}/sync.html לאישור הסנכרון`);
  })
  .catch((e) => {
    console.error("שגיאת רשת:", e.message);
    process.exit(1);
  });

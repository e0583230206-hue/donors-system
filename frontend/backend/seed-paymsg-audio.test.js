// seed-paymsg-audio.test.js — proves the exact safety properties required
// before wiring this script into the deploy pipeline (deploy.yml):
//   - idempotent (running twice never creates duplicates or errors)
//   - insert-only: never updates/overwrites a row that already exists
//   - never touches audioFile1/2/3 or status on an existing row
//   - newly created rows start with all 3 slots empty and status "חסר"
//     (DB column default — the seed never sets status itself)
//   - produces exactly the 24 PAYMSG-3000..PAYMSG-3023 rows, no gaps/dupes
//   - never deletes any file, never reads/touches IVR_AUDIO_PAYMSG_MODE/.env
//
// Uses a TEMPORARY sqlite file (own os.tmpdir() path, set via DB_PATH before
// requiring db.js) — never opens/touches the real production data.sqlite.
//
// הרצה: node seed-paymsg-audio.test.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "seed-paymsg-it-"));
process.env.DB_PATH = path.join(tmpRoot, "test.sqlite");

const db = require("./db"); // opens the temp DB above — never the real one
const { seed, PAYMSG_RECORDINGS } = require("./seed-paymsg-audio");

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name: name, ok: true });
  } catch (err) {
    results.push({ name: name, ok: false, error: err.stack || err.message });
  }
}

check("[בטיחות] הבדיקה פועלת מול DB זמני, לא מול data.sqlite האמיתי", function () {
  assert.strictEqual(db.DB_PATH, process.env.DB_PATH ? path.resolve(__dirname, process.env.DB_PATH) : null);
  assert.ok(db.DB_PATH.indexOf(tmpRoot) === 0, "DB_PATH חייב להיות תחת תיקיית ה-tmp שיצרנו, לא הנתיב האמיתי");
});

check("PAYMSG_RECORDINGS: בדיוק 24 רשומות, PAYMSG-3000..PAYMSG-3023, ללא חוסרים וללא כפילויות", function () {
  assert.strictEqual(PAYMSG_RECORDINGS.length, 24);
  const ids = PAYMSG_RECORDINGS.map(function (r) { return r.audioId; });
  const expected = [];
  for (let n = 3000; n <= 3023; n++) expected.push("PAYMSG-" + n);
  assert.deepStrictEqual(ids, expected);
  assert.strictEqual(new Set(ids).size, 24, "אין audioId כפול");
  PAYMSG_RECORDINGS.forEach(function (r) {
    assert.strictEqual(r.category, "paymsg");
  });
});

check("[ריצה 1] DB ריק -> נוצרות בדיוק 24 שורות, אף אחת לא הייתה קיימת קודם", function () {
  const report = seed();
  assert.strictEqual(report.total, 24);
  assert.strictEqual(report.created, 24);
  assert.strictEqual(report.alreadyExisted, 0);
  assert.strictEqual(report.createdIds.length, 24);
});

check("אחרי ריצה 1: כל 24 השורות קיימות בפועל ב-DB, עם status ברירת המחדל \"חסר\" ושלושת סלוטי הקובץ ריקים", function () {
  PAYMSG_RECORDINGS.forEach(function (r) {
    const row = db.getIvrAudioRecordingById(r.audioId);
    assert.ok(row, r.audioId + " חייב להיות קיים אחרי הזריעה");
    assert.strictEqual(row.status, "חסר");
    assert.strictEqual(row.audioFile1, "");
    assert.strictEqual(row.audioFile2, "");
    assert.strictEqual(row.audioFile3, "");
    assert.strictEqual(row.category, "paymsg");
    assert.strictEqual(row.sourceTextHe, r.sourceTextHe);
  });
});

check("[אידמפוטנטיות — הליבה] ריצה 2 מיד אחרי ריצה 1 -> 0 נוצרו, 24 כבר קיימות, ללא שגיאה", function () {
  const report = seed();
  assert.strictEqual(report.created, 0);
  assert.strictEqual(report.alreadyExisted, 24);
  assert.deepStrictEqual(report.alreadyExistedIds.sort(), PAYMSG_RECORDINGS.map(function (r) { return r.audioId; }).sort());
});

check("[insert-only — הליבה] שורה שכבר אושרה/הועלה לה קובץ לא נדרסת ולא משתנה בריצה חוזרת", function () {
  // מדמה מצב אמיתי: משתמש כבר העלה+אישר הקלטה ל-PAYMSG-3000 לפני שהרצנו שוב
  db.setIvrAudioRecordingSlots("PAYMSG-3000", {
    audioFile1: "PAYMSG-3000-1-real.wav",
    audioFile2: "",
    audioFile3: "",
    status: "אושר",
  });
  db.updateIvrAudioRecording("PAYMSG-3000", { translation: "יידיש כבר מתורגם", notes: "הערה שהוזנה ידנית" });

  const report = seed();
  assert.strictEqual(report.created, 0, "אסור שהזריעה תיצור מחדש שורה קיימת");
  assert.strictEqual(report.alreadyExisted, 24);

  const row = db.getIvrAudioRecordingById("PAYMSG-3000");
  assert.strictEqual(row.status, "אושר", "status אסור שישתנה");
  assert.strictEqual(row.audioFile1, "PAYMSG-3000-1-real.wav", "audioFile1 אסור שישתנה/יידרס");
  assert.strictEqual(row.translation, "יידיש כבר מתורגם", "translation אסור שישתנה");
  assert.strictEqual(row.notes, "הערה שהוזנה ידנית", "notes אסור שישתנה");
});

check("[קבצים] seed-paymsg-audio.js לא נוגע בכלל במערכת הקבצים (אין fs.unlink/fs.rm בקובץ המקור)", function () {
  const src = fs.readFileSync(path.join(__dirname, "seed-paymsg-audio.js"), "utf8");
  assert.ok(!/fs\.(unlink|rm|rmSync|unlinkSync)/.test(src), "אסור שהזריעה תמחק קבצים");
  assert.ok(!/require\(["']fs["']\)/.test(src), "הזריעה לא אמורה בכלל לייבא fs");
});

check("[.env / מצב הפעלה] seed-paymsg-audio.js לא מזכיר IVR_AUDIO_PAYMSG_MODE ולא נוגע ב-.env", function () {
  const src = fs.readFileSync(path.join(__dirname, "seed-paymsg-audio.js"), "utf8");
  assert.ok(!/IVR_AUDIO_PAYMSG_MODE/.test(src));
  assert.ok(!/\.env/.test(src));
  assert.ok(!/process\.env/.test(src));
});

// ── סיכום ────────────────────────────────────────────────────────────────
const failed = results.filter(function (r) { return !r.ok; });
results.forEach(function (r) {
  console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : " — " + r.error));
});
console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}

process.exitCode = failed.length ? 1 : 0;

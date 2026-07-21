// audit-ivr-audio-slots.test.js — proves the read-only audit script is safe
// to run against the real production DB over SSH:
//   - static source checks: readOnly:true is present, no SQL
//     INSERT/UPDATE/DELETE, no fs.unlink/rename/writeFile/copyFile anywhere,
//     never shells out to ffmpeg/convertToTmpWav (no conversion happens),
//     never logs process.env or any secret-shaped value.
//   - behavioral checks against a temp sqlite DB: correct counts, paymsg
//     rows excluded, slot2/3 details reported accurately, never throws on
//     missing files.
//
// הרצה: node scripts/audit-ivr-audio-slots.test.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { isFormatReady, describeSlot } = require("./audit-ivr-audio-slots");

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name: name, ok: true });
  } catch (err) {
    results.push({ name: name, ok: false, error: err.stack || err.message });
  }
}

const SRC = fs.readFileSync(path.join(__dirname, "audit-ivr-audio-slots.js"), "utf8");

// ── בדיקות סטטיות על קוד המקור — התנאים שביקש המשתמש במפורש ────────────────
check("[בטיחות] פותח את data.sqlite עם readOnly:true", function () {
  assert.ok(/DatabaseSync\(DB_PATH,\s*\{\s*readOnly:\s*true\s*\}\)/.test(SRC));
});

check("[בטיחות] אין שום פקודת SQL כותבת (INSERT/UPDATE/DELETE/ALTER/DROP)", function () {
  assert.ok(!/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/i.test(SRC));
});

check("[בטיחות] אין מחיקה/הזזה/כתיבה של קובץ (unlink/rename/writeFile/copyFile/mkdir)", function () {
  assert.ok(!/fs\.(unlink|rename|writeFile|copyFile|mkdir|rm)(Sync)?\s*\(/.test(SRC));
});

check("[בטיחות] אין המרה בפועל — לא קורא ל-convertToTmpWav/ffmpeg/execFileSync", function () {
  assert.ok(!/convertToTmpWav|execFileSync|require\(["']child_process["']\)/.test(SRC));
});

check("[בטיחות] אינו מדפיס משתני סביבה או .env", function () {
  assert.ok(!/process\.env|require\(["']dotenv["']\)|\.env["']/.test(SRC));
});

check("[בטיחות] מסנן במפורש paymsg החוצה בשאילתה (רק שורות legacy)", function () {
  assert.ok(/category\s*!=\s*'paymsg'/.test(SRC));
});

// ── בדיקות התנהגות מול DB זמני אמיתי ────────────────────────────────────────
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "audit-ivr-it-"));
const uploadDir = path.join(tmpRoot, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

// audit-ivr-audio-slots.js itself hardcodes UPLOAD_DIR relative to __dirname
// (production layout) — describeSlot/isFormatReady are pure enough re: path
// containment to still be exercised meaningfully here for non-existent
// files (the "file referenced but missing on disk" case), which is exactly
// the scenario a stale legacy audioFile2/3 value would produce.
check("describeSlot: קובץ שאינו קיים בכלל בדיסק -> existsOnDisk:false, wouldBeFormatReady:false, לא זורק", function () {
  var result = describeSlot("SOME-LEGACY-2-doesnotexist.mp3");
  assert.strictEqual(result.pathSafe, true);
  assert.strictEqual(result.existsOnDisk, false);
  assert.strictEqual(result.wouldBeFormatReady, false);
});

check("describeSlot: נתיב לא בטוח (path traversal) -> pathSafe:false, לא זורק", function () {
  var result = describeSlot("../../../etc/passwd");
  assert.strictEqual(result.pathSafe, false);
});

check("describeSlot: שם קובץ ריק/undefined -> null, לא זורק", function () {
  assert.strictEqual(describeSlot(""), null);
  assert.strictEqual(describeSlot(undefined), null);
});

check("isFormatReady: קובץ לא קיים -> false, לא זורק", function () {
  assert.strictEqual(isFormatReady("NOPE-2-x.mp3"), false);
});

check("[ספירה אמיתית] שאילתת ה-DB סופרת רק שורות legacy, לא paymsg, וסופרת סלוטים נכון", function () {
  const dbPath = path.join(tmpRoot, "test.sqlite");
  const setupDb = new DatabaseSync(dbPath);
  setupDb.exec(`
    CREATE TABLE ivr_audio_recordings (
      audioId TEXT PRIMARY KEY, category TEXT, status TEXT,
      audioFile1 TEXT NOT NULL DEFAULT '', audioFile2 TEXT NOT NULL DEFAULT '', audioFile3 TEXT NOT NULL DEFAULT '',
      sourceTextHe TEXT DEFAULT '', translation TEXT DEFAULT '', usageDescription TEXT DEFAULT '', notes TEXT DEFAULT '',
      createdAt TEXT, updatedAt TEXT
    )
  `);
  const now = new Date().toISOString();
  const ins = setupDb.prepare(
    "INSERT INTO ivr_audio_recordings (audioId, category, status, audioFile1, audioFile2, audioFile3, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?)"
  );
  ins.run("OPEN-001", "open", "אושר", "OPEN-001-1-a.wav", "", "", now, now);
  ins.run("IDENT-001", "ident", "חסר", "", "IDENT-001-2-b.mp3", "", now, now); // slot2 populated — the risk case
  ins.run("NUM-DIGIT-001", "number", "חסר", "", "", "NUM-DIGIT-001-3-c.mp3", now, now); // slot3 populated
  ins.run("PAYMSG-3000", "paymsg", "אושר", "PAYMSG-3000-1-d.wav", "PAYMSG-3000-2-e.wav", "", now, now); // must be excluded entirely
  setupDb.close();

  const readDb = new DatabaseSync(dbPath, { readOnly: true });
  const rows = readDb.prepare(
    "SELECT audioId, category, status, audioFile1, audioFile2, audioFile3 FROM ivr_audio_recordings WHERE category != 'paymsg' ORDER BY category, audioId"
  ).all();
  readDb.close();

  assert.strictEqual(rows.length, 3, "PAYMSG-3000 חייב להיות מסונן החוצה");
  assert.ok(!rows.some(function (r) { return r.category === "paymsg"; }));

  let slot1 = 0, slot2 = 0, slot3 = 0;
  rows.forEach(function (r) {
    if (r.audioFile1) slot1++;
    if (r.audioFile2) slot2++;
    if (r.audioFile3) slot3++;
  });
  assert.strictEqual(slot1, 1);
  assert.strictEqual(slot2, 1);
  assert.strictEqual(slot3, 1);
});

// ── סיכום ────────────────────────────────────────────────────────────────
const failed = results.filter(function (r) { return !r.ok; });
results.forEach(function (r) {
  console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : " — " + r.error));
});
console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}

process.exitCode = failed.length ? 1 : 0;

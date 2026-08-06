// audit-ivr-audio-slots.test.js — proves the read-only audit script is safe
// to run against the real production DB over SSH:
//   - static source checks: readOnly:true is present, no SQL
//     INSERT/UPDATE/DELETE, no fs.unlink/rename/writeFile/copyFile anywhere,
//     never shells out to ffmpeg/convertToTmpWav (no conversion happens),
//     never logs process.env or any secret-shaped value.
//   - behavioral checks against a temp sqlite DB + temp upload dir: correct
//     counts, paymsg rows excluded, slot2/3 details reported accurately,
//     orphan-file detection, never throws on missing files.
//
// HERMETIC: every behavioral check below — including the --check CLI
// subprocess invocations — runs against ONE shared temporary fixture DB
// (tmpDbPath) and ONE shared temporary fixture upload dir (tmpUploadDir),
// passed explicitly via the script's --db=/--uploadDir= flags (see
// scripts/audit-ivr-audio-slots.js's main()). Nothing here reads, depends
// on, or ever touches the real production data.sqlite or the real
// uploads/ivr-audio directory — the previous version of this file computed
// its "expected" values by first querying the REAL production DB via
// computeReport() with no override, then asserting the CLI subprocess
// (also pointed at the real DB, also with no override) agreed — which
// meant the test's actual pass/fail depended on live production data-
// hygiene state (an orphan slot-2/3 file, or a legacy row with slot2/3
// content) rather than on the script's own logic. That's what changed.
//
// הרצה: node scripts/audit-ivr-audio-slots.test.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const { isFormatReady, describeSlot, computeReport, findOrphanSlotFiles } = require("./audit-ivr-audio-slots");

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
  // Matches both the original literal form and the current
  // `dbPath || DB_PATH` parameterized form — the property being proven
  // (always opens read-only) is unchanged; only the source text shape is.
  assert.ok(/DatabaseSync\([^,]*DB_PATH,\s*\{\s*readOnly:\s*true\s*\}\)/.test(SRC));
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

// ── תשתית: DB זמני + תיקיית העלאה זמנית, משותפים לכל שאר הבדיקות ───────────
// Never the real data.sqlite, never the real uploads/ivr-audio — this is
// the ONLY DB/filesystem state every check below (including the CLI
// subprocess ones) reads.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "audit-ivr-hermetic-"));
const tmpUploadDir = path.join(tmpRoot, "uploads");
const tmpDbPath = path.join(tmpRoot, "test.sqlite");
fs.mkdirSync(tmpUploadDir, { recursive: true });

function setupFixtureDb() {
  const setupDb = new DatabaseSync(tmpDbPath);
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
}
setupFixtureDb();

// One genuine orphan file on disk, matching NUM-DIGIT-001's own slot-3
// reference — proves slotFilesAbsent's DB-independent disk scan actually
// finds a real match deterministically, not by accident of production state.
fs.writeFileSync(path.join(tmpUploadDir, "NUM-DIGIT-001-3-c.mp3"), "test-fixture-not-real-audio");

check("describeSlot: קובץ שאינו קיים בכלל בדיסק -> existsOnDisk:false, wouldBeFormatReady:false, לא זורק", function () {
  var result = describeSlot("SOME-LEGACY-2-doesnotexist.mp3", tmpUploadDir);
  assert.strictEqual(result.pathSafe, true);
  assert.strictEqual(result.existsOnDisk, false);
  assert.strictEqual(result.wouldBeFormatReady, false);
});

check("describeSlot: קובץ שקיים בדיסק (אך אינו קובץ אודיו תקין) -> existsOnDisk:true, wouldBeFormatReady:false, לא זורק", function () {
  var result = describeSlot("NUM-DIGIT-001-3-c.mp3", tmpUploadDir);
  assert.strictEqual(result.existsOnDisk, true);
  assert.strictEqual(result.wouldBeFormatReady, false, "קובץ הטקסט הפיקטיבי לא אמור לעבור כ-audio תקין");
});

check("describeSlot: נתיב לא בטוח (path traversal) -> pathSafe:false, לא זורק", function () {
  var result = describeSlot("../../../etc/passwd", tmpUploadDir);
  assert.strictEqual(result.pathSafe, false);
});

check("describeSlot: שם קובץ ריק/undefined -> null, לא זורק", function () {
  assert.strictEqual(describeSlot("", tmpUploadDir), null);
  assert.strictEqual(describeSlot(undefined, tmpUploadDir), null);
});

check("isFormatReady: קובץ לא קיים -> false, לא זורק", function () {
  assert.strictEqual(isFormatReady("NOPE-2-x.mp3", tmpUploadDir), false);
});

// ── computeReport — ספירה נכונה מול ה-fixture הזמני ─────────────────────────
check("computeReport: סופר רק שורות legacy (לא paymsg), וסופר סלוטים נכון, מול DB זמני בלבד", function () {
  const report = computeReport(tmpDbPath, tmpUploadDir);
  assert.strictEqual(report.rows.length, 3, "PAYMSG-3000 חייב להיות מסונן החוצה");
  assert.ok(!report.rows.some(function (r) { return r.category === "paymsg"; }));
  assert.strictEqual(report.slot1Count, 1);
  assert.strictEqual(report.slot2Count, 1);
  assert.strictEqual(report.slot3Count, 1);
  assert.strictEqual(report.slot2Details.length, 1);
  assert.strictEqual(report.slot2Details[0].audioId, "IDENT-001");
  assert.strictEqual(report.slot3Details.length, 1);
  assert.strictEqual(report.slot3Details[0].audioId, "NUM-DIGIT-001");
});

// ── findOrphanSlotFiles — DB-independent disk scan, מול תיקייה זמנית ────────
check("findOrphanSlotFiles: מזהה קובץ יתום שתואם <audioId>-2-/-3- ולא קובץ בסלוט 1 או של audioId אחר", function () {
  const marker2 = "ZZZ-TEST-AUDIT-FAKE-001-2-marker.mp3";
  const marker3 = "ZZZ-TEST-AUDIT-FAKE-001-3-marker.mp3";
  const notOrphan1 = "ZZZ-TEST-AUDIT-FAKE-001-1-marker.mp3"; // slot 1 — must NOT be reported
  const otherIdOrphan = "ZZZ-TEST-AUDIT-FAKE-OTHER-2-marker.mp3"; // different audioId — must NOT be reported when not asked for
  [marker2, marker3, notOrphan1, otherIdOrphan].forEach(function (name) {
    fs.writeFileSync(path.join(tmpUploadDir, name), "test-fixture-not-real-audio");
  });
  const found = findOrphanSlotFiles(["ZZZ-TEST-AUDIT-FAKE-001"], tmpUploadDir);
  assert.ok(found.indexOf(marker2) !== -1, "צריך למצוא את קובץ סלוט 2");
  assert.ok(found.indexOf(marker3) !== -1, "צריך למצוא את קובץ סלוט 3");
  assert.ok(found.indexOf(notOrphan1) === -1, "אסור למצוא קובץ סלוט 1");
  assert.ok(found.indexOf(otherIdOrphan) === -1, "אסור למצוא audioId שלא ביקשנו עליו");
});

check("findOrphanSlotFiles: תיקייה ריקה/לא קיימת -> מערך ריק, לא זורק", function () {
  assert.deepStrictEqual(findOrphanSlotFiles(["NO-SUCH-ID"], path.join(tmpRoot, "does-not-exist")), []);
});

check("findOrphanSlotFiles: audioId בלי שום קובץ יתום -> מערך ריק (מוכיח שה-fixture עצמו נקי מלבד מה שהוזרק בכוונה)", function () {
  assert.deepStrictEqual(findOrphanSlotFiles(["OPEN-001"], tmpUploadDir), []);
});

// ── מצב --check דרך CLI אמיתי — מול אותו DB/תיקייה זמניים, לא הפרודקשן ─────
const SCRIPT_PATH = path.join(__dirname, "audit-ivr-audio-slots.js");

function runCli(args) {
  const fullArgs = args.concat(["--db=" + tmpDbPath, "--uploadDir=" + tmpUploadDir]);
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT_PATH].concat(fullArgs), { encoding: "utf8" });
    return { code: 0, stdout: stdout };
  } catch (err) {
    return { code: err.status, stdout: (err.stdout || "").toString() };
  }
}

check("[--check] legacyCount עם ה-expect הנכון (3, מה-fixture) -> קוד יציאה 0, PASS", function () {
  const result = runCli(["--check=legacyCount", "--expect=3"]);
  assert.strictEqual(result.code, 0, result.stdout);
  assert.ok(/^PASS/.test(result.stdout));
});

check("[--check] legacyCount עם expect שגוי במכוון -> קוד יציאה שונה מ-0, FAIL — מוכיח שהצלחה אינה מונחת כברירת מחדל", function () {
  const result = runCli(["--check=legacyCount", "--expect=4"]);
  assert.notStrictEqual(result.code, 0);
  assert.ok(/^FAIL/.test(result.stdout));
});

check("[--check] audioFile2Count -> PASS מול הערך הידוע מה-fixture (1)", function () {
  const r = runCli(["--check=audioFile2Count", "--expect=1"]);
  assert.strictEqual(r.code, 0, r.stdout);
});

check("[--check] audioFile3Count -> PASS מול הערך הידוע מה-fixture (1)", function () {
  const r = runCli(["--check=audioFile3Count", "--expect=1"]);
  assert.strictEqual(r.code, 0, r.stdout);
});

check("[--check] slotFilesAbsent -> FAIL באופן דטרמיניסטי, כי ה-fixture מכיל בכוונה קובץ יתום אחד (NUM-DIGIT-001-3-c.mp3)", function () {
  const r = runCli(["--check=slotFilesAbsent"]);
  assert.strictEqual(r.code, 1, "עם fixture שמכיל קובץ סלוט-3 אמיתי על הדיסק, הבדיקה חייבת להיכשל — זו בדיוק ההתנהגות שהיא אמורה לזהות");
  assert.ok(/^FAIL/.test(r.stdout));
});

check("[--check] slotFilesAbsent -> PASS מול fixture נקי (DB/תיקייה זמניים נפרדים, בלי אף קובץ יתום)", function () {
  const cleanRoot = fs.mkdtempSync(path.join(os.tmpdir(), "audit-ivr-hermetic-clean-"));
  const cleanUploadDir = path.join(cleanRoot, "uploads");
  const cleanDbPath = path.join(cleanRoot, "test.sqlite");
  fs.mkdirSync(cleanUploadDir, { recursive: true });
  const setupDb = new DatabaseSync(cleanDbPath);
  setupDb.exec(`CREATE TABLE ivr_audio_recordings (
    audioId TEXT PRIMARY KEY, category TEXT, status TEXT,
    audioFile1 TEXT NOT NULL DEFAULT '', audioFile2 TEXT NOT NULL DEFAULT '', audioFile3 TEXT NOT NULL DEFAULT '',
    createdAt TEXT, updatedAt TEXT
  )`);
  const now = new Date().toISOString();
  setupDb.prepare("INSERT INTO ivr_audio_recordings (audioId, category, status, audioFile1, createdAt, updatedAt) VALUES (?,?,?,?,?,?)")
    .run("CLEAN-001", "open", "אושר", "CLEAN-001-1-a.wav", now, now);
  setupDb.close();

  const stdout = execFileSync(process.execPath, [SCRIPT_PATH, "--check=slotFilesAbsent", "--db=" + cleanDbPath, "--uploadDir=" + cleanUploadDir], { encoding: "utf8" });
  assert.ok(/^PASS/.test(stdout), stdout);
  fs.rmSync(cleanRoot, { recursive: true, force: true });
});

check("[--check] הפלט של מצב --check לעולם לא מכיל שם קובץ (.wav/.mp3/...) — רק PASS/FAIL ומספר", function () {
  const result = runCli(["--check=legacyCount", "--expect=999999"]); // deliberately wrong, forces FAIL path
  assert.ok(!/\.(wav|mp3|m4a|ogg|aac|flac)/i.test(result.stdout), "אסור ששם קובץ ידלוף לפלט הבדיקה: " + result.stdout);
});

check("[--check] ערך --check לא מוכר -> FAIL, קוד יציאה שונה מ-0", function () {
  const result = runCli(["--check=notARealCheck"]);
  assert.notStrictEqual(result.code, 0);
});

// ── סיכום ────────────────────────────────────────────────────────────────
const failed = results.filter(function (r) { return !r.ok; });
results.forEach(function (r) {
  console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : " — " + r.error));
});
console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}

process.exitCode = failed.length ? 1 : 0;

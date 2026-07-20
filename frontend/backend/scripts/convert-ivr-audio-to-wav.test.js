// convert-ivr-audio-to-wav.test.js — בדיקות ללוגיקה הטהורה של סקריפט ההמרה.
// לא נוגע ב-DB/ffmpeg/ffprobe/דיסק בפועל — בודק רק את פונקציות ההחלטה
// החשופות מהמודול (module.exports). אין test framework בפרויקט — assert רגיל.
// הרצה: node scripts/convert-ivr-audio-to-wav.test.js

const assert = require("assert");
const path = require("path");
const {
  computeDerivedFilename,
  computeTmpFilename,
  isPathContained,
  isReadyAsIs,
  isValidDerivedProbe,
  decideAction,
  buildFfmpegArgs,
} = require("./convert-ivr-audio-to-wav");

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name: name, ok: true });
  } catch (err) {
    results.push({ name: name, ok: false, error: err.message });
  }
}

// ── computeDerivedFilename ───────────────────────────────────────────────────
check("שם נגזרת: מסיר סיומת מקורית (MP3) ומוסיף -pcm8k.wav", function () {
  assert.strictEqual(
    computeDerivedFilename("DEBT-001-1-1e99e92b65be9e6e.MP3"),
    "DEBT-001-1-1e99e92b65be9e6e-pcm8k.wav"
  );
});

check("שם נגזרת: קובץ עם נקודות מרובות בשם — רק הסיומת האחרונה מוסרת", function () {
  assert.strictEqual(computeDerivedFilename("OPEN-001.v2.mp3"), "OPEN-001.v2-pcm8k.wav");
});

check("שם נגזרת: גם קובץ מקור .wav מקבל שם נגזרת (החלטה אם צריך המרה נעשית בנפרד)", function () {
  assert.strictEqual(computeDerivedFilename("DEBT-002-1-abc.wav"), "DEBT-002-1-abc-pcm8k.wav");
});

// ── computeTmpFilename ───────────────────────────────────────────────────────
check('שם קובץ זמני: מחליף סיומת .wav ב-.tmp.wav (לא הצמדה)', function () {
  assert.strictEqual(
    computeTmpFilename("DEBT-001-1-1e99e92b65be9e6e-pcm8k.wav"),
    "DEBT-001-1-1e99e92b65be9e6e-pcm8k.tmp.wav"
  );
});

check("שם קובץ זמני: case-insensitive על סיומת .WAV", function () {
  assert.strictEqual(
    computeTmpFilename("DEBT-003-1-abc-pcm8k.WAV"),
    "DEBT-003-1-abc-pcm8k.tmp.wav"
  );
});

// ── isPathContained ───────────────────────────────────────────────────────────
const UPLOAD_DIR = path.resolve("/var/www/donors-system/frontend/backend/uploads/ivr-audio");

check("path containment: שם קובץ תקין בתוך התיקייה → ok=true, resolvedPath נכון", function () {
  const res = isPathContained(UPLOAD_DIR, "DEBT-002-1-abc.wav");
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.resolvedPath, path.join(UPLOAD_DIR, "DEBT-002-1-abc.wav"));
});

check("path containment: ניסיון traversal (../../) → ok=false", function () {
  assert.strictEqual(isPathContained(UPLOAD_DIR, "../../etc/passwd").ok, false);
});

check("path containment: נתיב מוחלט זר → ok=false", function () {
  assert.strictEqual(isPathContained(UPLOAD_DIR, "/etc/passwd").ok, false);
});

check("path containment: שם קובץ ריק/undefined → ok=false, לא זורק שגיאה", function () {
  assert.strictEqual(isPathContained(UPLOAD_DIR, "").ok, false);
  assert.strictEqual(isPathContained(UPLOAD_DIR, undefined).ok, false);
});

// ── isReadyAsIs ────────────────────────────────────────────────────────────────
check("isReadyAsIs: pcm_s16le/8000/mono + סיומת .wav → true", function () {
  assert.strictEqual(
    isReadyAsIs("DEBT-002-1-abc.wav", { codec_name: "pcm_s16le", sample_rate: "8000", channels: "1" }),
    true
  );
});

check("isReadyAsIs: מקרה DEBT-001 — תוכן PCM תקין אך סיומת .MP3 שגויה → false (חייב נגזרת)", function () {
  assert.strictEqual(
    isReadyAsIs("DEBT-001-1-abc.MP3", { codec_name: "pcm_s16le", sample_rate: "8000", channels: "1" }),
    false
  );
});

check("isReadyAsIs: סיומת .WAV באותיות גדולות → עדיין true (case-insensitive)", function () {
  assert.strictEqual(
    isReadyAsIs("DEBT-003-1-abc.WAV", { codec_name: "pcm_s16le", sample_rate: "8000", channels: "1" }),
    true
  );
});

check("isReadyAsIs: MP3 mono 8000Hz (78 מתוך ה-83) → false, דורש המרה", function () {
  assert.strictEqual(
    isReadyAsIs("OPEN-005-1-abc.mp3", { codec_name: "mp3", sample_rate: "8000", channels: "1" }),
    false
  );
});

check("isReadyAsIs: MP3 stereo 48000Hz (2 מתוך ה-83) → false", function () {
  assert.strictEqual(
    isReadyAsIs("OPEN-006-1-abc.mp3", { codec_name: "mp3", sample_rate: "48000", channels: "2" }),
    false
  );
});

check("isReadyAsIs: probeResult חסר (null, ffprobe נכשל) → false", function () {
  assert.strictEqual(isReadyAsIs("x.wav", null), false);
});

// ── isValidDerivedProbe ──────────────────────────────────────────────────────
check("isValidDerivedProbe: pcm_s16le/8000/mono → true", function () {
  assert.strictEqual(isValidDerivedProbe({ codec_name: "pcm_s16le", sample_rate: "8000", channels: "1" }), true);
});

check("isValidDerivedProbe: ערוץ שגוי (stereo) → false", function () {
  assert.strictEqual(isValidDerivedProbe({ codec_name: "pcm_s16le", sample_rate: "8000", channels: "2" }), false);
});

check("isValidDerivedProbe: null → false", function () {
  assert.strictEqual(isValidDerivedProbe(null), false);
});

// ── decideAction — כאן נבדקת התנהגות dry-run מול apply ────────────────────────
check("decideAction: מקור כבר מוכן → ready-original, בלי תלות ב-dryRun", function () {
  assert.strictEqual(
    decideAction({ isSourceReady: true, derivedExists: false, derivedValid: false, dryRun: true }),
    "ready-original"
  );
  assert.strictEqual(
    decideAction({ isSourceReady: true, derivedExists: false, derivedValid: false, dryRun: false }),
    "ready-original"
  );
});

check("decideAction: נגזרת תקינה כבר קיימת → already-derived, לא ממיר מחדש (גם ב---apply)", function () {
  assert.strictEqual(
    decideAction({ isSourceReady: false, derivedExists: true, derivedValid: true, dryRun: false }),
    "already-derived"
  );
});

check("decideAction: נגזרת קיימת אך לא תקינה → לא נחסם כ-already-derived", function () {
  assert.notStrictEqual(
    decideAction({ isSourceReady: false, derivedExists: true, derivedValid: false, dryRun: false }),
    "already-derived"
  );
});

check('decideAction: dryRun=true (ברירת מחדל, בלי --apply) → "would-convert", לא ממיר בפועל', function () {
  assert.strictEqual(
    decideAction({ isSourceReady: false, derivedExists: false, derivedValid: false, dryRun: true }),
    "would-convert"
  );
});

check('decideAction: dryRun=false (--apply) → "convert"', function () {
  assert.strictEqual(
    decideAction({ isSourceReady: false, derivedExists: false, derivedValid: false, dryRun: false }),
    "convert"
  );
});

// ── buildFfmpegArgs ────────────────────────────────────────────────────────────
check("buildFfmpegArgs: מערך ארגומנטים מדויק ל-execFileSync (mono/8000Hz/pcm_s16le)", function () {
  assert.deepStrictEqual(buildFfmpegArgs("/x/source.mp3", "/x/derived-pcm8k.tmp.wav"), [
    "-y",
    "-i", "/x/source.mp3",
    "-ac", "1",
    "-ar", "8000",
    "-sample_fmt", "s16",
    "-c:a", "pcm_s16le",
    "/x/derived-pcm8k.tmp.wav",
  ]);
});

check("buildFfmpegArgs: כל איבר הוא string בודד — בטוח ל-execFileSync, אין הזרקת shell", function () {
  const args = buildFfmpegArgs("/x/a b.mp3", "/x/out-pcm8k.tmp.wav");
  args.forEach(function (a) { assert.strictEqual(typeof a, "string"); });
  assert.ok(args.includes("/x/a b.mp3"), "נתיב עם רווח נשאר איבר יחיד במערך, לא מפוצל ע'י shell");
});

// ── סיכום ────────────────────────────────────────────────────────────────────
const failed = results.filter(function (r) { return !r.ok; });
results.forEach(function (r) {
  console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : " — " + r.error));
});
console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");
process.exit(failed.length ? 1 : 0);

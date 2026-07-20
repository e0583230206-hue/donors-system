// ivr-audio-resolver.service.test.js — בדיקות ל-createAudioResolver() בלבד,
// עם dependency injection מלא (getRecordByAudioId/fileExists מדומים). לא
// נוגע ב-DB/דיסק/ffprobe אמיתיים בכלל — resolveAudioForProduction (החיווט
// האמיתי) לא נבדק כאן ולא נקרא כלל, כדי שהטעינה תישאר טהורה.
//
// resolveAudio(audioId, fallbackText) — fallbackText הוא הפרמטר השני, נדרש
// בפועל בכל אתר קריאה חי: הוא הטקסט המקורי המלא שהיה מושמע לפני שהיה שמע
// מוקלט בכלל. כשל בפתרון אף פעם לא מחזיר {text:""} — ראו הבדיקות בסוף.
//
// הרצה: node ivr-audio-resolver.service.test.js

const assert = require("assert");
const path = require("path");
const {
  createAudioResolver,
  stripExtension,
  DEFAULT_BASE_URL,
  GENERIC_FALLBACK_TEXT,
} = require("./ivr-audio-resolver.service");

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name: name, ok: true });
  } catch (err) {
    results.push({ name: name, ok: false, error: err.message });
  }
}

const UPLOAD_DIR = path.resolve("/var/www/donors-system/frontend/backend/uploads/ivr-audio");
const OPEN_001_FALLBACK = "שלום וברכה, הגעתם למערכת תשלומים של א בלאט גמרא.";

function makeDeps(overrides) {
  const base = {
    getRecordByAudioId: function () { return null; },
    fileExists: function () { return false; },
    uploadDir: UPLOAD_DIR,
    baseUrl: "https://30206.co.il/uploads/ivr-audio",
    fallbackTextByAudioId: { "OPEN-001": OPEN_001_FALLBACK },
  };
  return Object.assign({}, base, overrides || {});
}

// ── מקרה 1: approved + נגזרת קיימת ────────────────────────────────────────────
check("approved + נגזרת קיימת פיזית → מעדיף את הנגזרת (fileLink/fileName)", function () {
  const derivedFilename = "OPEN-001-1-abc123-pcm8k.wav";
  const deps = makeDeps({
    getRecordByAudioId: function (id) {
      return id === "OPEN-001" ? { status: "אושר", audioFile1: "OPEN-001-1-abc123.mp3" } : null;
    },
    fileExists: function (p) { return p === path.join(UPLOAD_DIR, derivedFilename); },
  });
  const resolve = createAudioResolver(deps);
  const result = resolve("OPEN-001", OPEN_001_FALLBACK);
  assert.deepStrictEqual(result, {
    fileLink: "https://30206.co.il/uploads/ivr-audio/" + derivedFilename,
    fileName: "OPEN-001-1-abc123-pcm8k",
  });
});

// ── מקרה 2: approved + מקור עצמו כבר WAV תקין (אין נגזרת) ───────────────────
check("approved + מקור .wav ואין נגזרת → משתמש במקור עצמו", function () {
  const sourceFilename = "DEBT-002-1-1e99e92b65be9e6e.wav";
  const deps = makeDeps({
    getRecordByAudioId: function (id) {
      return id === "DEBT-002" ? { status: "אושר", audioFile1: sourceFilename } : null;
    },
    fileExists: function (p) { return p === path.join(UPLOAD_DIR, sourceFilename); },
  });
  const resolve = createAudioResolver(deps);
  const result = resolve("DEBT-002", "שקלים עבור");
  assert.deepStrictEqual(result, {
    fileLink: "https://30206.co.il/uploads/ivr-audio/" + sourceFilename,
    fileName: "DEBT-002-1-1e99e92b65be9e6e",
  });
});

// ── מקרה 3: מקור לא-wav ואין נגזרת → fallback (טקסט הקורא, לא תוכן לא-מאומת) ─
check("approved + מקור .mp3 קיים פיזית אך אין נגזרת → {text: fallbackText שהקורא סיפק}", function () {
  const mp3Path = path.join(UPLOAD_DIR, "OPEN-001-1-abc.mp3");
  const deps = makeDeps({
    getRecordByAudioId: function (id) {
      return id === "OPEN-001" ? { status: "אושר", audioFile1: "OPEN-001-1-abc.mp3" } : null;
    },
    fileExists: function (p) { return p === mp3Path; },
  });
  const resolve = createAudioResolver(deps);
  assert.deepStrictEqual(resolve("OPEN-001", OPEN_001_FALLBACK), { text: OPEN_001_FALLBACK });
});

// ── מקרה 4: רשומה חסרה ─────────────────────────────────────────────────────
check("רשומה לא קיימת (getRecordByAudioId מחזיר null) → {text: fallbackText}", function () {
  const deps = makeDeps({ getRecordByAudioId: function () { return null; } });
  const resolve = createAudioResolver(deps);
  assert.deepStrictEqual(resolve("OPEN-001", OPEN_001_FALLBACK), { text: OPEN_001_FALLBACK });
});

// ── מקרה 5: סטטוס לא מאושר ────────────────────────────────────────────────
check('סטטוס שונה מ-"אושר" → fallback, גם אם יש audioFile1 ונגזרת קיימת', function () {
  const deps = makeDeps({
    getRecordByAudioId: function () { return { status: "ממתין", audioFile1: "OPEN-001-1-abc.wav" }; },
    fileExists: function () { return true; },
  });
  const resolve = createAudioResolver(deps);
  assert.deepStrictEqual(resolve("OPEN-001", OPEN_001_FALLBACK), { text: OPEN_001_FALLBACK });
});

// ── מקרה 6: קובץ פיזי חסר (גם נגזרת וגם מקור) ────────────────────────────────
check("approved אך שום קובץ לא קיים פיזית (לא נגזרת, לא מקור) → fallback", function () {
  const deps = makeDeps({
    getRecordByAudioId: function () { return { status: "אושר", audioFile1: "OPEN-001-1-abc.wav" }; },
    fileExists: function () { return false; },
  });
  const resolve = createAudioResolver(deps);
  assert.deepStrictEqual(resolve("OPEN-001", OPEN_001_FALLBACK), { text: OPEN_001_FALLBACK });
});

// ── מקרה 7: נתיב לא בטוח (traversal) ──────────────────────────────────────
check("audioFile1 עם ניסיון path traversal → fallback, לעולם לא בונה fileLink מחוץ לתיקייה", function () {
  const deps = makeDeps({
    getRecordByAudioId: function () { return { status: "אושר", audioFile1: "../../etc/passwd" }; },
    fileExists: function () { return true; },
  });
  const resolve = createAudioResolver(deps);
  assert.deepStrictEqual(resolve("OPEN-001", OPEN_001_FALLBACK), { text: OPEN_001_FALLBACK });
});

// ── מקרה 8: fallback גם כשקורית חריגה בלתי צפויה ────────────────────────────
check("getRecordByAudioId זורק חריגה → fallback, לא קורס ולא מפיל את השיחה", function () {
  const deps = makeDeps({
    getRecordByAudioId: function () { throw new Error("DB בלתי זמין"); },
  });
  const resolve = createAudioResolver(deps);
  assert.deepStrictEqual(resolve("OPEN-001", OPEN_001_FALLBACK), { text: OPEN_001_FALLBACK });
});

// ── מקרים 9-11: לעולם לא {text:""} — שלוש שכבות בטיחות ──────────────────────
check("fallbackText מפורש תמיד מנצח, גם אם קיימת גם מפת fallback סטטית", function () {
  const deps = makeDeps({
    getRecordByAudioId: function () { return null; },
    fallbackTextByAudioId: { "OPEN-001": "טקסט קנוני אחר" },
  });
  const resolve = createAudioResolver(deps);
  assert.deepStrictEqual(resolve("OPEN-001", "טקסט שהקורא סיפק"), { text: "טקסט שהקורא סיפק" });
});

check("אין fallbackText מהקורא, אבל יש במפה הסטטית → משתמש במפה (שכבה שנייה)", function () {
  const deps = makeDeps({
    getRecordByAudioId: function () { return null; },
    fallbackTextByAudioId: { "OPEN-001": "טקסט קנוני מהמפה" },
  });
  const resolve = createAudioResolver(deps);
  assert.deepStrictEqual(resolve("OPEN-001"), { text: "טקסט קנוני מהמפה" });
  assert.deepStrictEqual(resolve("OPEN-001", ""), { text: "טקסט קנוני מהמפה" });
  assert.deepStrictEqual(resolve("OPEN-001", undefined), { text: "טקסט קנוני מהמפה" });
});

check("לא fallbackText ולא מפה סטטית (audioId זר לגמרי) → GENERIC_FALLBACK_TEXT, לעולם לא ריק", function () {
  const deps = makeDeps({ getRecordByAudioId: function () { return null; } });
  const resolve = createAudioResolver(deps);
  const result = resolve("NON-EXISTENT-999");
  assert.deepStrictEqual(result, { text: GENERIC_FALLBACK_TEXT });
  assert.notStrictEqual(result.text, "");
  assert.ok(result.text.length > 0);
});

check("GENERIC_FALLBACK_TEXT תואם בדיוק לטקסט המאושר של SYS-002 (לא טקסט מומצא)", function () {
  assert.strictEqual(GENERIC_FALLBACK_TEXT, "אירעה שגיאה. אנא נסו שוב מאוחר יותר.");
});

// ── fileName תמיד ללא סיומת ─────────────────────────────────────────────────
check("stripExtension: מסיר סיומת בודדת בלבד", function () {
  assert.strictEqual(stripExtension("DEBT-002-1-abc-pcm8k.wav"), "DEBT-002-1-abc-pcm8k");
  assert.strictEqual(stripExtension("OPEN-001-1-abc.MP3"), "OPEN-001-1-abc");
});

check("fileName בתוצאה אמיתית מה-resolver אף פעם לא מכיל נקודה", function () {
  const deps = makeDeps({
    getRecordByAudioId: function () { return { status: "אושר", audioFile1: "OPEN-001-1-abc.wav" }; },
    fileExists: function (p) { return p === path.join(UPLOAD_DIR, "OPEN-001-1-abc.wav"); },
  });
  const resolve = createAudioResolver(deps);
  const result = resolve("OPEN-001", OPEN_001_FALLBACK);
  assert.ok(!("text" in result));
  assert.ok(!result.fileName.includes("."));
});

// ── baseUrl: קו נטוי סוגר מיותר מוסר ──────────────────────────────────────────
check("baseUrl עם קו נטוי סוגר מיותר לא יוצר // כפול ב-fileLink", function () {
  const deps = makeDeps({
    baseUrl: "https://30206.co.il/uploads/ivr-audio/",
    getRecordByAudioId: function () { return { status: "אושר", audioFile1: "OPEN-001-1-abc.wav" }; },
    fileExists: function (p) { return p === path.join(UPLOAD_DIR, "OPEN-001-1-abc.wav"); },
  });
  const resolve = createAudioResolver(deps);
  assert.strictEqual(resolve("OPEN-001", OPEN_001_FALLBACK).fileLink, "https://30206.co.il/uploads/ivr-audio/OPEN-001-1-abc.wav");
});

check("DEFAULT_BASE_URL מיוצא ותואם את הדומיין הציבורי הידוע", function () {
  assert.strictEqual(DEFAULT_BASE_URL, "https://30206.co.il/uploads/ivr-audio");
});

// ── סיכום ────────────────────────────────────────────────────────────────────
const failed = results.filter(function (r) { return !r.ok; });
results.forEach(function (r) {
  console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : " — " + r.error));
});
console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");
process.exit(failed.length ? 1 : 0);

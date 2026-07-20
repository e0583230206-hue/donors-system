// ivr-audio-resolver.service.test.js — בדיקות ל-createAudioResolver() בלבד,
// עם dependency injection מלא (getRecordByAudioId/fileExists מדומים). לא
// נוגע ב-DB/דיסק/ffprobe אמיתיים בכלל — resolveAudioForProduction (החיווט
// האמיתי) לא נבדק כאן ולא נקרא כלל, כדי שהטעינה תישאר טהורה.
// הרצה: node ivr-audio-resolver.service.test.js

const assert = require("assert");
const path = require("path");
const { createAudioResolver, stripExtension, DEFAULT_BASE_URL } = require("./ivr-audio-resolver.service");

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

function makeDeps(overrides) {
  const base = {
    getRecordByAudioId: function () { return null; },
    fileExists: function () { return false; },
    uploadDir: UPLOAD_DIR,
    baseUrl: "https://30206.co.il/uploads/ivr-audio",
    fallbackTextByAudioId: { "OPEN-001": "שלום וברכה, הגעתם למערכת תשלומים של א בלאט גמרא." },
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
  const result = resolve("OPEN-001");
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
    // הנגזרת (DEBT-002-1-1e99e92b65be9e6e-pcm8k.wav) לא קיימת; המקור כן.
    fileExists: function (p) { return p === path.join(UPLOAD_DIR, sourceFilename); },
  });
  const resolve = createAudioResolver(deps);
  const result = resolve("DEBT-002");
  assert.deepStrictEqual(result, {
    fileLink: "https://30206.co.il/uploads/ivr-audio/" + sourceFilename,
    fileName: "DEBT-002-1-1e99e92b65be9e6e",
  });
});

// ── מקרה 3: מקור לא-wav ואין נגזרת → fallback (לא סומכים על תוכן לא-מאומת) ──
check("approved + מקור .mp3 קיים פיזית אך אין נגזרת → fallback (הסיומת קובעת, לא רק הקיום)", function () {
  const mp3Path = path.join(UPLOAD_DIR, "OPEN-001-1-abc.mp3");
  const deps = makeDeps({
    getRecordByAudioId: function (id) {
      return id === "OPEN-001" ? { status: "אושר", audioFile1: "OPEN-001-1-abc.mp3" } : null;
    },
    // ה-mp3 עצמו כן קיים בדיסק — עדיין לא ישמש, כי תוכנו מעולם לא אומת.
    fileExists: function (p) { return p === mp3Path; },
  });
  const resolve = createAudioResolver(deps);
  assert.deepStrictEqual(resolve("OPEN-001"), { text: "שלום וברכה, הגעתם למערכת תשלומים של א בלאט גמרא." });
});

// ── מקרה 4: רשומה חסרה ─────────────────────────────────────────────────────
check("רשומה לא קיימת (getRecordByAudioId מחזיר null) → fallback", function () {
  const deps = makeDeps({ getRecordByAudioId: function () { return null; } });
  const resolve = createAudioResolver(deps);
  assert.deepStrictEqual(resolve("OPEN-001"), { text: "שלום וברכה, הגעתם למערכת תשלומים של א בלאט גמרא." });
});

// ── מקרה 5: סטטוס לא מאושר ────────────────────────────────────────────────
check('סטטוס שונה מ-"אושר" → fallback, גם אם יש audioFile1 ונגזרת קיימת', function () {
  const deps = makeDeps({
    getRecordByAudioId: function () { return { status: "ממתין", audioFile1: "OPEN-001-1-abc.wav" }; },
    fileExists: function () { return true; },
  });
  const resolve = createAudioResolver(deps);
  assert.deepStrictEqual(resolve("OPEN-001"), { text: "שלום וברכה, הגעתם למערכת תשלומים של א בלאט גמרא." });
});

// ── מקרה 6: קובץ פיזי חסר (גם נגזרת וגם מקור) ────────────────────────────────
check("approved אך שום קובץ לא קיים פיזית (לא נגזרת, לא מקור) → fallback", function () {
  const deps = makeDeps({
    getRecordByAudioId: function () { return { status: "אושר", audioFile1: "OPEN-001-1-abc.wav" }; },
    fileExists: function () { return false; },
  });
  const resolve = createAudioResolver(deps);
  assert.deepStrictEqual(resolve("OPEN-001"), { text: "שלום וברכה, הגעתם למערכת תשלומים של א בלאט גמרא." });
});

// ── מקרה 7: נתיב לא בטוח (traversal) ──────────────────────────────────────
check("audioFile1 עם ניסיון path traversal → fallback, לעולם לא בונה fileLink מחוץ לתיקייה", function () {
  const deps = makeDeps({
    getRecordByAudioId: function () { return { status: "אושר", audioFile1: "../../etc/passwd" }; },
    fileExists: function () { return true; }, // גם אם "קיים" — containment חוסם קודם
  });
  const resolve = createAudioResolver(deps);
  assert.deepStrictEqual(resolve("OPEN-001"), { text: "שלום וברכה, הגעתם למערכת תשלומים של א בלאט גמרא." });
});

// ── מקרה 8: fallback גם כשמעיפה חריגה בלתי צפויה ────────────────────────────
check("getRecordByAudioId זורק חריגה → fallback, לא קורס ולא מפיל את השיחה", function () {
  const deps = makeDeps({
    getRecordByAudioId: function () { throw new Error("DB בלתי זמין"); },
  });
  const resolve = createAudioResolver(deps);
  assert.deepStrictEqual(resolve("OPEN-001"), { text: "שלום וברכה, הגעתם למערכת תשלומים של א בלאט גמרא." });
});

// ── מקרה 9: audioId לא מוכר גם ל-fallbackTextByAudioId → טקסט ריק, לא נכשל ──
check("audioId לא קיים כלל במפת ה-fallback → מחזיר {text:\"\"} ולא זורק", function () {
  const deps = makeDeps({ getRecordByAudioId: function () { return null; } });
  const resolve = createAudioResolver(deps);
  assert.deepStrictEqual(resolve("NON-EXISTENT-999"), { text: "" });
});

// ── מקרה 10: fileName תמיד ללא סיומת ─────────────────────────────────────────
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
  const result = resolve("OPEN-001");
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
  assert.strictEqual(resolve("OPEN-001").fileLink, "https://30206.co.il/uploads/ivr-audio/OPEN-001-1-abc.wav");
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

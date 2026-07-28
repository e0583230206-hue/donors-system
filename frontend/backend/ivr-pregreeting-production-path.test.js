// ivr-pregreeting-production-path.test.js — proves the pre-greeting message
// actually plays through the REAL production entry point, not just through
// ivr.js/ivr-audio-context.service.js in isolation with injected fakes.
//
// This is exactly the level of test that would have caught the real
// production bug reported after this feature shipped: handleIvrQuery()
// (ivr.service.js — the same function server.js's real /ivr route calls)
// reassigns `audio = wrapAudioForDiagnosticLog(audio)` before ever handing
// it to ivr.js. That wrapper rebuilt a plain {resolveOrText, resolveAudioId}
// object and silently dropped getPregreetingFiles — so even with the row
// enabled/approved/in-schedule and IVR_AUDIO_MODE fully decoupled (see
// ivr-audio-context.service.js), the pre-greeting could never reach a real
// call, because ivr.js's `audio.getPregreetingFiles()` call was hitting a
// missing method (caught -> []) on every single request. Every earlier test
// for this feature injected `audio` directly into ivr.js/buildAudioContext
// and never exercised this wrapper, so the gap went unnoticed. This file
// calls the actual exported handleIvrQuery() with no mocking of
// buildAudioContext/wrapAudioForDiagnosticLog/the resolver at all — only the
// DB is a disposable temp file, and only one real (harmless, non-audio)
// dummy file is written under the real uploads/ivr-audio directory (cleaned
// up in `finally`) so the resolver's on-disk existence check has something
// real to find, exactly like a real approved upload would.
//
// הרצה: node ivr-pregreeting-production-path.test.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pregreeting-prod-path-test-"));
process.env.DB_PATH = path.join(tmpRoot, "test.sqlite");
delete process.env.NODE_ENV;
delete process.env.IVR_AUDIO_MODE; // explicitly unset -> "off", same as production's current default
delete process.env.IVR_AUDIO_TRIAL_CALLER_PHONE;

const db = require("./db");
const ivrService = require("./ivr.service");

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
  assert.ok(db.DB_PATH.indexOf(tmpRoot) === 0, "DB_PATH חייב להיות תחת תיקיית ה-tmp, לא הנתיב האמיתי");
});

// ivr-pregreeting.service.js's production wiring hardcodes this exact path
// (mirrors ivr-audio-resolver.service.js) — not injectable, by design, so a
// true end-to-end proof needs a real (but disposable, uniquely-named,
// cleaned-up-in-finally) file here. Content is irrelevant: the resolver only
// checks physical existence at request time, not audio validity (format was
// already verified once at approval time — see its own header comment).
const REAL_UPLOAD_DIR = path.join(__dirname, "uploads", "ivr-audio");
const TEST_FILENAME = "__test-pregreeting-production-path-" + Date.now() + ".wav";
const TEST_FILE_PATH = path.join(REAL_UPLOAD_DIR, TEST_FILENAME);

function callFirstTurn(phone, callId) {
  return ivrService.handleIvrQuery({ PBXphone: phone, PBXcallId: callId });
}

try {
  if (!fs.existsSync(REAL_UPLOAD_DIR)) fs.mkdirSync(REAL_UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(TEST_FILE_PATH, "RIFF-not-real-audio-but-existence-is-all-the-resolver-checks");

  check("handleIvrQuery (מסלול /ivr האמיתי): הודעה זמנית לא מופעלת -> אינה בתגובה, OPEN-001 בלבד כרגיל", function () {
    db.setIvrAudioRecordingSlots(db.PREGREETING_AUDIO_ID, {
      audioFile1: TEST_FILENAME, audioFile2: "", audioFile3: "", status: "אושר",
    });
    // enabled left at its default (0) — matches "upload alone never activates".
    const result = callFirstTurn("0501111111", "prod-path-call-1");
    const files = result.response.files;
    files.forEach(function (f) { assert.notStrictEqual(f.fileName, path.parse(TEST_FILENAME).name); });
  });

  check("handleIvrQuery (מסלול /ivr האמיתי): הודעה זמנית מופעלת + IVR_AUDIO_MODE לא מוגדר (=off) -> מושמעת ראשונה, לפני OPEN-001", function () {
    db.setPregreetingEnabled(true);
    const result = callFirstTurn("0502222222", "prod-path-call-2");
    const files = result.response.files;
    assert.ok(files.length >= 1, "התגובה חייבת להכיל לפחות פריט אחד");
    assert.strictEqual(files[0].fileName, path.parse(TEST_FILENAME).name, "הפריט הראשון בתגובה חייב להיות ההודעה הזמנית — זה בדיוק התיקון");
    assert.ok(files[0].fileLink, "הפריט הראשון חייב להיות fileLink אמיתי, לא {text}");
  });

  check("אותה תגובה: שאר ההקלטות (כולל OPEN-001) נשארות TTS — IVR_AUDIO_MODE=off עדיין שולט בהן במלואו", function () {
    const result = callFirstTurn("0502222223", "prod-path-call-2b");
    const files = result.response.files;
    files.slice(1).forEach(function (f) {
      assert.strictEqual(f.fileLink, undefined, "רק ההודעה הזמנית מותרת כ-fileLink כש-IVR_AUDIO_MODE=off");
      assert.strictEqual(typeof f.text, "string");
    });
  });

  check("handleIvrQuery: אותו callId, בקשה שנייה (לא תור ראשון) -> ההודעה הזמנית לא חוזרת", function () {
    // Second request of the SAME call: Technoline resends the accumulated
    // selfIdentInput param — no longer isFirstTurn.
    const result = ivrService.handleIvrQuery({
      PBXphone: "0502222222", PBXcallId: "prod-path-call-2", selfIdentInput: "0500000000",
    });
    const files = (result.response && result.response.files) || [];
    files.forEach(function (f) { assert.notStrictEqual(f.fileName, path.parse(TEST_FILENAME).name); });
  });

  check("handleIvrQuery: לאחר כיבוי ידני, אותו קובץ עדיין קיים בדיסק -> ההודעה שוב לא מופיעה בתגובה", function () {
    db.setPregreetingEnabled(false);
    const result = callFirstTurn("0503333333", "prod-path-call-3");
    const files = result.response.files;
    files.forEach(function (f) { assert.notStrictEqual(f.fileName, path.parse(TEST_FILENAME).name); });
    assert.ok(fs.existsSync(TEST_FILE_PATH), "כיבוי לא מוחק את הקובץ מהדיסק");
  });
} finally {
  try { if (fs.existsSync(TEST_FILE_PATH)) fs.unlinkSync(TEST_FILE_PATH); } catch (_) {}
}

// ── סיכום ────────────────────────────────────────────────────────────────
const failed = results.filter(function (r) { return !r.ok; });
results.forEach(function (r) {
  console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : " — " + r.error));
});
console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");
process.exitCode = failed.length ? 1 : 0;

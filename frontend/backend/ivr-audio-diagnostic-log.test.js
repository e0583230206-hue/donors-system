// ivr-audio-diagnostic-log.test.js — proves the TEMPORARY diagnostic
// wrapper added to ivr.service.js (wrapAudioForDiagnosticLog, see
// handleIvrQuery) never logs a phone number, callId, query, or donor name —
// only a fixed marker plus an audioId or the literal "(text-match)". No
// DB/disk touched; the wrapped "realAudio" is a hand-built fake.
//
// הרצה: node ivr-audio-diagnostic-log.test.js

const assert = require("assert");
const { wrapAudioForDiagnosticLog } = require("./ivr.service");

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name: name, ok: true });
  } catch (err) {
    results.push({ name: name, ok: false, error: err.message });
  }
}

function captureConsole(fn) {
  const captured = [];
  const originalLog = console.log;
  console.log = function () { captured.push(Array.from(arguments).join(" ")); };
  try {
    fn();
  } finally {
    console.log = originalLog;
  }
  return captured;
}

const FAKE_PHONE = "0509999999";
const FAKE_CALL_ID = "fake-call-id-should-never-appear";
const FAKE_DONOR_NAME = "תורם בדיוני שלא אמור להופיע";

check("resolveAudioId עם fileLink → לוג יחיד עם audioId בלבד, בלי שום נתון אחר", function () {
  const realAudio = {
    resolveOrText: function (text) { return { text: text }; },
    resolveAudioId: function (id, fb) { return { fileLink: "https://x/" + id + ".wav", fileName: id }; },
  };
  const wrapped = wrapAudioForDiagnosticLog(realAudio);
  const logs = captureConsole(function () {
    wrapped.resolveAudioId("OPEN-001", FAKE_PHONE + " " + FAKE_CALL_ID);
  });
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(logs[0], "[IVR-DIAG] audio_selected=OPEN-001");
  assert.ok(!logs[0].includes(FAKE_PHONE));
  assert.ok(!logs[0].includes(FAKE_CALL_ID));
});

check("resolveAudioId עם fallback {text} (לא הצליח) → אין שום לוג בכלל", function () {
  const realAudio = {
    resolveOrText: function (text) { return { text: text }; },
    resolveAudioId: function (id, fb) { return { text: fb }; },
  };
  const wrapped = wrapAudioForDiagnosticLog(realAudio);
  const logs = captureConsole(function () {
    wrapped.resolveAudioId("IDENT-002", FAKE_PHONE);
  });
  assert.deepStrictEqual(logs, []);
});

check('resolveOrText עם fileLink → לוג "(text-match)" קבוע, לעולם לא הטקסט עצמו (עלול להכיל שם תורם/מטרה)', function () {
  const realAudio = {
    resolveOrText: function (text) { return { fileLink: "https://x/y.wav", fileName: "y" }; },
    resolveAudioId: function (id, fb) { return { text: fb }; },
  };
  const wrapped = wrapAudioForDiagnosticLog(realAudio);
  const logs = captureConsole(function () {
    wrapped.resolveOrText(FAKE_DONOR_NAME);
  });
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(logs[0], "[IVR-DIAG] audio_selected=(text-match)");
  assert.ok(!logs[0].includes(FAKE_DONOR_NAME));
});

check("resolveOrText עם {text} (לא הצליח) → אין שום לוג", function () {
  const realAudio = {
    resolveOrText: function (text) { return { text: text }; },
    resolveAudioId: function (id, fb) { return { text: fb }; },
  };
  const wrapped = wrapAudioForDiagnosticLog(realAudio);
  const logs = captureConsole(function () {
    wrapped.resolveOrText(FAKE_DONOR_NAME);
  });
  assert.deepStrictEqual(logs, []);
});

// ── getPregreetingFiles ─────────────────────────────────────────────────────
// Regression coverage for the real production bug: this wrapper used to
// rebuild a plain {resolveOrText, resolveAudioId} object, silently dropping
// getPregreetingFiles — since handleIvrQuery() reassigns `audio` to this
// wrapper's return value before ever calling ivr.js, the pre-greeting could
// never play in production no matter its enabled/schedule state. See
// ivr-pregreeting-production-path.test.js for the full end-to-end proof
// through the real handleIvrQuery() entry point.

check("wrapAudioForDiagnosticLog מחזיר עטיפה שכוללת getPregreetingFiles כפונקציה (לא undefined)", function () {
  const realAudio = {
    resolveOrText: function (text) { return { text: text }; },
    resolveAudioId: function (id, fb) { return { text: fb }; },
    getPregreetingFiles: function () { return []; },
  };
  const wrapped = wrapAudioForDiagnosticLog(realAudio);
  assert.strictEqual(typeof wrapped.getPregreetingFiles, "function", "זו בדיוק התקלה שקרתה בפרודקשן — getPregreetingFiles חייב להישאר פונקציה אחרי העטיפה");
});

check("getPregreetingFiles: מעביר את התוצאה האמיתית של realAudio, כולל fileLink", function () {
  const item = { fileLink: "https://x/PREGREETING-001.wav", fileName: "PREGREETING-001" };
  const realAudio = {
    resolveOrText: function (text) { return { text: text }; },
    resolveAudioId: function (id, fb) { return { text: fb }; },
    getPregreetingFiles: function () { return [item]; },
  };
  const wrapped = wrapAudioForDiagnosticLog(realAudio);
  assert.deepStrictEqual(wrapped.getPregreetingFiles(), [item]);
});

check("getPregreetingFiles עם תוצאה לא ריקה → לוג יחיד עם מספר פריטים בלבד, בלי תוכן ה-fileLink", function () {
  const item = { fileLink: "https://x/PREGREETING-001.wav", fileName: "PREGREETING-001" };
  const realAudio = {
    resolveOrText: function (text) { return { text: text }; },
    resolveAudioId: function (id, fb) { return { text: fb }; },
    getPregreetingFiles: function () { return [item]; },
  };
  const wrapped = wrapAudioForDiagnosticLog(realAudio);
  const logs = captureConsole(function () { wrapped.getPregreetingFiles(); });
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(logs[0], "[IVR-DIAG] pregreeting_selected=1 item(s)");
  assert.ok(!logs[0].includes("fileLink"));
  assert.ok(!logs[0].includes(item.fileLink));
});

check("getPregreetingFiles עם [] (כבויה/לא בטווח) → אין שום לוג", function () {
  const realAudio = {
    resolveOrText: function (text) { return { text: text }; },
    resolveAudioId: function (id, fb) { return { text: fb }; },
    getPregreetingFiles: function () { return []; },
  };
  const wrapped = wrapAudioForDiagnosticLog(realAudio);
  const logs = captureConsole(function () { wrapped.getPregreetingFiles(); });
  assert.deepStrictEqual(logs, []);
});

check("getPregreetingFiles: אם realAudio לא מספק אותה בכלל (בדיקות ישנות) → [] בבטחה, לא זורק", function () {
  const realAudio = {
    resolveOrText: function (text) { return { text: text }; },
    resolveAudioId: function (id, fb) { return { text: fb }; },
  };
  const wrapped = wrapAudioForDiagnosticLog(realAudio);
  assert.deepStrictEqual(wrapped.getPregreetingFiles(), []);
});

check("הערך המוחזר מהעטיפה זהה בדיוק לערך שהוחזר מ-realAudio — העטיפה לא משנה התנהגות", function () {
  const realAudio = {
    resolveOrText: function (text) { return { text: text }; },
    resolveAudioId: function (id, fb) { return { fileLink: "https://x/" + id + ".wav", fileName: id }; },
  };
  const wrapped = wrapAudioForDiagnosticLog(realAudio);
  assert.deepStrictEqual(wrapped.resolveOrText("כלשהו"), { text: "כלשהו" });
  assert.deepStrictEqual(wrapped.resolveAudioId("PAY-006", "x"), { fileLink: "https://x/PAY-006.wav", fileName: "PAY-006" });
});

// ── סיכום ────────────────────────────────────────────────────────────────
const failed = results.filter(function (r) { return !r.ok; });
results.forEach(function (r) {
  console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : " — " + r.error));
});
console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");
process.exit(failed.length ? 1 : 0);

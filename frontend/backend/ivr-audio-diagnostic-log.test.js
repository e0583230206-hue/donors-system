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

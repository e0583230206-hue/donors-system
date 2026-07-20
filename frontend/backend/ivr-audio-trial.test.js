// ivr-audio-trial.test.js — standalone verification for ivr-audio-trial.route.js.
// No test framework (the project has none — see package.json) — plain Node
// with the built-in `assert` module. Run: node ivr-audio-trial.test.js
//
// Sets IVR_AUDIO_TRIAL_KEY / TECHNOLINE_IVR_TRIAL_EXTENSION in-process only —
// never touches the real .env file. Calls trialHandler() directly with mock
// req/res objects — never boots Express, never opens the real DB, never
// touches donors/payments/ivr.js/ivr.service.js.

const assert = require("assert");

process.env.IVR_AUDIO_TRIAL_KEY = "test-trial-key-value";
process.env.TECHNOLINE_IVR_TRIAL_EXTENSION = "8888";

const { trialHandler } = require("./ivr-audio-trial.route");

function mockRes() {
  return {
    statusCode: null,
    body: null,
    status: function (code) { this.statusCode = code; return this; },
    json: function (obj) { this.body = obj; return this; },
  };
}

function run(query) {
  const req = { query: query };
  const res = mockRes();
  trialHandler(req, res);
  return res;
}

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name: name, ok: true });
  } catch (err) {
    results.push({ name: name, ok: false, error: err.message });
  }
}

// ── מפתח חסר ──────────────────────────────────────────────────────────────
check("מפתח חסר (אין trialKey בבקשה) → 403, ללא JSON של מודול IVR", function () {
  const res = run({ scenario: "open001", PBXextensionId: "8888" });
  assert.strictEqual(res.statusCode, 403);
  assert.deepStrictEqual(res.body, { error: "trial_auth_failed" });
});

// ── מפתח שגוי ─────────────────────────────────────────────────────────────
check("מפתח שגוי → 403", function () {
  const res = run({ scenario: "open001", PBXextensionId: "8888", trialKey: "wrong-key" });
  assert.strictEqual(res.statusCode, 403);
  assert.deepStrictEqual(res.body, { error: "trial_auth_failed" });
});

// ── שלוחה שגויה ───────────────────────────────────────────────────────────
check("שלוחה שגויה (PBXextensionId לא תואם) → 403", function () {
  const res = run({ scenario: "open001", PBXextensionId: "9263", trialKey: "test-trial-key-value" });
  assert.strictEqual(res.statusCode, 403);
  assert.deepStrictEqual(res.body, { error: "trial_auth_failed" });
});

// ── מפתח נכון + שלוחה נכונה, אבל scenario לא מאושר ──────────────────────────
check("scenario לא מאושר (אחרי אימות תקין) → 200 hangup, לא שגיאה", function () {
  const res = run({ scenario: "does-not-exist", PBXextensionId: "8888", trialKey: "test-trial-key-value" });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body, { type: "hangup" });
});

check("scenario חסר לגמרי (אחרי אימות תקין) → 200 hangup", function () {
  const res = run({ PBXextensionId: "8888", trialKey: "test-trial-key-value" });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body, { type: "hangup" });
});

// ── בקשות תקינות — 4 התרחישים ─────────────────────────────────────────────
check("בקשה תקינה — open001", function () {
  const res = run({ scenario: "open001", PBXextensionId: "8888", trialKey: "test-trial-key-value" });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.type, "simpleMessage");
  assert.strictEqual(res.body.files.length, 1);
  assert.strictEqual(res.body.files[0].fileLink, "https://30206.co.il/uploads/ivr-audio/TRIAL-open001-v1.mp3");
  assert.strictEqual(res.body.files[0].fileName, "TRIAL-open001-v1");
});

check("בקשה תקינה — sequence (הקלטה + TTS שם + הקלטה)", function () {
  const res = run({ scenario: "sequence", PBXextensionId: "8888", trialKey: "test-trial-key-value" });
  assert.strictEqual(res.body.files.length, 3);
  assert.ok(res.body.files[0].fileLink, "איבר 1 צריך fileLink");
  assert.strictEqual(res.body.files[1].text, "שם בדיקה", "איבר 2 צריך TTS text");
  assert.ok(!res.body.files[1].fileLink, "איבר 2 (TTS) לא אמור לכלול fileLink");
  assert.ok(res.body.files[2].fileLink, "איבר 3 צריך fileLink");
});

check("בקשה תקינה — multi (כמה fileLink ברצף, בדיקת הרכבה)", function () {
  const res = run({ scenario: "multi", PBXextensionId: "8888", trialKey: "test-trial-key-value" });
  assert.strictEqual(res.body.files.length, 3);
  res.body.files.forEach(function (f) { assert.ok(f.fileLink && f.fileName); });
});

check("בקשה תקינה — notfound (קישור שלא קיים בפועל בדיסק)", function () {
  const res = run({ scenario: "notfound", PBXextensionId: "8888", trialKey: "test-trial-key-value" });
  assert.strictEqual(res.body.files[0].fileName, "TRIAL-notfound-v1");
  assert.notStrictEqual(res.body.files[0].fileName, "TRIAL-open001-v1");
});

// ── משתני סביבה לא מוגדרים בכלל → fail closed ───────────────────────────────
check("IVR_AUDIO_TRIAL_KEY לא מוגדר בסביבה → fail closed (403), גם עם ערכים נכונים אחרת", function () {
  const saved = process.env.IVR_AUDIO_TRIAL_KEY;
  delete process.env.IVR_AUDIO_TRIAL_KEY;
  try {
    const res = run({ scenario: "open001", PBXextensionId: "8888", trialKey: "anything" });
    assert.strictEqual(res.statusCode, 403);
  } finally {
    process.env.IVR_AUDIO_TRIAL_KEY = saved;
  }
});

check("TECHNOLINE_IVR_TRIAL_EXTENSION לא מוגדר בסביבה → fail closed (403)", function () {
  const saved = process.env.TECHNOLINE_IVR_TRIAL_EXTENSION;
  delete process.env.TECHNOLINE_IVR_TRIAL_EXTENSION;
  try {
    const res = run({ scenario: "open001", PBXextensionId: "8888", trialKey: "test-trial-key-value" });
    assert.strictEqual(res.statusCode, 403);
  } finally {
    process.env.TECHNOLINE_IVR_TRIAL_EXTENSION = saved;
  }
});

// ── סיכום ────────────────────────────────────────────────────────────────
const failed = results.filter(function (r) { return !r.ok; });
results.forEach(function (r) {
  console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : " — " + r.error));
});
console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");
process.exit(failed.length ? 1 : 0);

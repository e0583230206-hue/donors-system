// ivr-audio-mode.service.test.js — בדיקות טהורות ל-parseAudioMode /
// shouldUseAudioForCall. לא נוגע ב-DB/דיסק/env אמיתי. הרצה:
//   node ivr-audio-mode.service.test.js

const assert = require("assert");
const { parseAudioMode, shouldUseAudioForCall, VALID_MODES } = require("./ivr-audio-mode.service");

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name: name, ok: true });
  } catch (err) {
    results.push({ name: name, ok: false, error: err.message });
  }
}

// ── parseAudioMode ───────────────────────────────────────────────────────────
check('parseAudioMode("off") → "off"', function () {
  assert.strictEqual(parseAudioMode("off"), "off");
});

check('parseAudioMode("trial") → "trial"', function () {
  assert.strictEqual(parseAudioMode("trial"), "trial");
});

check('parseAudioMode("on") → "on"', function () {
  assert.strictEqual(parseAudioMode("on"), "on");
});

check('parseAudioMode("TRIAL") (אותיות גדולות) → "trial" (case-insensitive)', function () {
  assert.strictEqual(parseAudioMode("TRIAL"), "trial");
});

check('parseAudioMode(" on ") (רווחים) → "on"', function () {
  assert.strictEqual(parseAudioMode(" on "), "on");
});

check("parseAudioMode(undefined) → \"off\"", function () {
  assert.strictEqual(parseAudioMode(undefined), "off");
});

check("parseAudioMode(null) → \"off\"", function () {
  assert.strictEqual(parseAudioMode(null), "off");
});

check('parseAudioMode("") (ריק) → "off"', function () {
  assert.strictEqual(parseAudioMode(""), "off");
});

check('parseAudioMode("banana") (ערך לא חוקי) → "off" (fail closed)', function () {
  assert.strictEqual(parseAudioMode("banana"), "off");
});

check("VALID_MODES מכיל בדיוק את שלוש האפשרויות", function () {
  assert.deepStrictEqual(VALID_MODES, ["off", "trial", "on"]);
});

// ── shouldUseAudioForCall ────────────────────────────────────────────────────
check('mode="off" → false, גם אם הטלפון תואם', function () {
  assert.strictEqual(
    shouldUseAudioForCall({ mode: "off", phone: "0500000001", trialPhone: "0500000001" }),
    false
  );
});

check('mode="on" → true לכל שיחה, בלי תלות בטלפון', function () {
  assert.strictEqual(shouldUseAudioForCall({ mode: "on", phone: "0501111111", trialPhone: "" }), true);
  assert.strictEqual(shouldUseAudioForCall({ mode: "on" }), true);
});

check('mode="trial" + טלפון תואם ל-trialPhone → true', function () {
  assert.strictEqual(
    shouldUseAudioForCall({ mode: "trial", phone: "0500000001", trialPhone: "0500000001" }),
    true
  );
});

check('mode="trial" + טלפון שונה → false', function () {
  assert.strictEqual(
    shouldUseAudioForCall({ mode: "trial", phone: "0509999999", trialPhone: "0500000001" }),
    false
  );
});

check('mode="trial" + trialPhone ריק (לא הוגדר) → false, גם אם phone לא ריק', function () {
  assert.strictEqual(shouldUseAudioForCall({ mode: "trial", phone: "0500000001", trialPhone: "" }), false);
});

check('mode="trial" + phone ריק → false', function () {
  assert.strictEqual(shouldUseAudioForCall({ mode: "trial", phone: "", trialPhone: "0500000001" }), false);
});

check("ערך mode לא חוקי מתנהג כמו off ב-shouldUseAudioForCall", function () {
  assert.strictEqual(
    shouldUseAudioForCall({ mode: "banana", phone: "0500000001", trialPhone: "0500000001" }),
    false
  );
});

check("קריאה בלי opts בכלל לא זורקת (mode לא חוקי → off → false)", function () {
  assert.strictEqual(shouldUseAudioForCall(undefined), false);
  assert.strictEqual(shouldUseAudioForCall({}), false);
});

// ── סיכום ────────────────────────────────────────────────────────────────────
const failed = results.filter(function (r) { return !r.ok; });
results.forEach(function (r) {
  console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : " — " + r.error));
});
console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");
process.exit(failed.length ? 1 : 0);

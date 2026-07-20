// ivr-audio-bypass-removed.test.js — replaces ivr-trial-transfer.test.js
// (deleted). That file tested shouldTriggerTrialTransfer()/
// buildTrialTransferResponse() — the temporary direct-DEBT-002-WAV bypass
// used to validate the fileLink/fileName mechanism against the real
// Technoline PBX before the real audio-resolver wiring existed. Both
// functions have now been removed from ivr.service.js entirely (superseded
// by the real per-call audio context — see ivr-audio-context.service.js).
// This file positively proves the bypass and its log marker are gone, and
// stay gone — a regression here means someone re-added it.
//
// הרצה: node ivr-audio-bypass-removed.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ivrService = require("./ivr.service");

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name: name, ok: true });
  } catch (err) {
    results.push({ name: name, ok: false, error: err.message });
  }
}

check("shouldTriggerTrialTransfer אינה קיימת יותר ב-module.exports של ivr.service", function () {
  assert.strictEqual(ivrService.shouldTriggerTrialTransfer, undefined);
});

check("buildTrialTransferResponse אינה קיימת יותר ב-module.exports של ivr.service", function () {
  assert.strictEqual(ivrService.buildTrialTransferResponse, undefined);
});

const ivrServiceSource = fs.readFileSync(path.join(__dirname, "ivr.service.js"), "utf8");

check('קוד המקור של ivr.service.js לא מכיל את הסמן "trial_audio_direct_triggered"', function () {
  assert.ok(!ivrServiceSource.includes("trial_audio_direct_triggered"));
});

check('קוד המקור של ivr.service.js לא מכיל את שם הפונקציה "shouldTriggerTrialTransfer"', function () {
  assert.ok(!ivrServiceSource.includes("shouldTriggerTrialTransfer"));
});

check('קוד המקור של ivr.service.js לא מכיל את שם הפונקציה "buildTrialTransferResponse"', function () {
  assert.ok(!ivrServiceSource.includes("buildTrialTransferResponse"));
});

check('קוד המקור של ivr.service.js לא מכיל את קובץ ה-WAV הקשיח של DEBT-002 (TRIAL-debt002-pcm-v1)', function () {
  assert.ok(!ivrServiceSource.includes("DEBT-002-1-1e99e92b65be9e6e.wav"));
  assert.ok(!ivrServiceSource.includes("TRIAL-debt002-pcm-v1"));
});

check("מספר הניסוי עצמו (IVR_AUDIO_TRIAL_CALLER_PHONE) עדיין קיים בקוד — רק כשער mode=trial, לא כבייפס נפרד", function () {
  // הדרישה הייתה להסיר את הבייפס הישיר, לא את מנגנון ה-mode=trial עצמו —
  // המשתנה נשאר, אבל עכשיו הוא נצרך רק דרך ivr-audio-context.service.js.
  assert.ok(ivrServiceSource.includes("buildAudioContext"));
  const audioContextSource = fs.readFileSync(path.join(__dirname, "ivr-audio-context.service.js"), "utf8");
  assert.ok(audioContextSource.includes("IVR_AUDIO_TRIAL_CALLER_PHONE"));
});

// ── סיכום ────────────────────────────────────────────────────────────────────
const failed = results.filter(function (r) { return !r.ok; });
results.forEach(function (r) {
  console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : " — " + r.error));
});
console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");
process.exit(failed.length ? 1 : 0);

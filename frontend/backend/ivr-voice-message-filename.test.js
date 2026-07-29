// ivr-voice-message-filename.test.js — covers buildVoiceMessageFileName()
// (ivr.js) and its wiring into both places the "record" module is built:
// mainChoice="3" (buildResponse) and the max_attempts identification
// fallback (buildIdentificationResponse). This name is what the download
// side (server.js's /api/ivr/voice-messages/:id/audio -> Technoline
// fileDownload?fileName=...) looks the recording up by, so it MUST be
// deterministic and reconstructible from the same query on the ivr.service.js
// side without depending on Technoline's echoed-back FILE_<name> value.
//
// הרצה: node ivr-voice-message-filename.test.js

const assert = require("assert");
const ivr = require("./ivr");

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name: name, ok: true });
  } catch (err) {
    results.push({ name: name, ok: false, error: err.stack || err.message });
  }
}

// Passthrough audio fake — identical in effect to IVR_AUDIO_MODE=off.
function makePassthroughAudio() {
  return {
    resolveOrText: function (text) { return { text: text }; },
    resolveAudioId: function (id, fallbackText) { return { text: fallbackText }; },
  };
}

// ── buildVoiceMessageFileName() ───────────────────────────────────────────────

check("buildVoiceMessageFileName: דטרמיניסטי — אותו PBXcallId => אותו שם קובץ", function () {
  var q = { PBXcallId: "CALL-ABC-123", PBXphone: "0501234567" };
  assert.strictEqual(ivr.buildVoiceMessageFileName(q), ivr.buildVoiceMessageFileName(q));
});

check("buildVoiceMessageFileName: שני callId שונים => שני שמות קובץ שונים", function () {
  var a = ivr.buildVoiceMessageFileName({ PBXcallId: "CALL-1", PBXphone: "0501111111" });
  var b = ivr.buildVoiceMessageFileName({ PBXcallId: "CALL-2", PBXphone: "0501111111" });
  assert.notStrictEqual(a, b, "שתי שיחות שונות מאותו מספר טלפון חייבות לקבל שמות קובץ נבדלים (לא רק לפי טלפון)");
});

check("buildVoiceMessageFileName: אותו PBXphone בשתי שיחות נפרדות עדיין נבדל", function () {
  // מדמה "שתי הודעות שונות מאותו מספר" — כל שיחה מקבלת callId משלה.
  var first  = ivr.buildVoiceMessageFileName({ PBXcallId: "CALL-SAME-PHONE-1", PBXphone: "0509999999" });
  var second = ivr.buildVoiceMessageFileName({ PBXcallId: "CALL-SAME-PHONE-2", PBXphone: "0509999999" });
  assert.notStrictEqual(first, second);
});

check("buildVoiceMessageFileName: PBXcallId חסר => נופל בחזרה לשם מבוסס-טלפון, דטרמיניסטי", function () {
  var q = { PBXphone: "0521112222" };
  assert.strictEqual(ivr.buildVoiceMessageFileName(q), ivr.buildVoiceMessageFileName(q));
  assert.ok(ivr.buildVoiceMessageFileName(q).indexOf("vm_") === 0);
});

check("buildVoiceMessageFileName: מנקה תווים לא-בטוחים ל-fileName", function () {
  var name = ivr.buildVoiceMessageFileName({ PBXcallId: "call/with spaces&chars?#" });
  assert.ok(/^vm_[A-Za-z0-9_-]+$/.test(name), "השם חייב להכיל רק תווים בטוחים: " + name);
});

check("buildVoiceMessageFileName: PBXcallId ו-PBXphone חסרים לגמרי => עדיין לא זורק, מחזיר משהו סביר", function () {
  assert.doesNotThrow(function () {
    var name = ivr.buildVoiceMessageFileName({});
    assert.ok(name.indexOf("vm_") === 0);
  });
});

// ── mainChoice="3" -> record module מקבל fileName, שאר השדות לא משתנים ───────

check("buildResponse mainChoice=3: מודול ה-record מקבל fileName תואם ל-buildVoiceMessageFileName, ושאר השדות זהים למקור", function () {
  var q = { mainChoice: "3", PBXcallId: "CALL-REC-1", PBXphone: "0501234567" };
  var res = ivr.buildResponse(q, null, makePassthroughAudio());
  var recordModule = res[1];

  assert.strictEqual(recordModule.type, "record");
  assert.strictEqual(recordModule.name, "voiceMessage");
  assert.strictEqual(recordModule.max, 60);
  assert.strictEqual(recordModule.min, 1);
  assert.strictEqual(recordModule.confirm, false);
  assert.strictEqual(recordModule.fileName, ivr.buildVoiceMessageFileName(q));
});

check("buildResponse mainChoice=3: allowCallback=false עדיין חוסם את ההקלטה (לא נגעתי בהתנהגות הקיימת)", function () {
  var q = { mainChoice: "3", PBXcallId: "CALL-REC-2", PBXphone: "0501234567" };
  var donor = { settings: { allowPayment: true, allowPreviousDebts: true, allowCallback: false } };
  var res = ivr.buildResponse(q, donor, makePassthroughAudio());
  assert.strictEqual(res[1].type, "hangup", "כשההקלטה חסומה למתקשר הזה, אין record() בכלל");
});

// ── max_attempts (identification fallback) -> אותו mechanism, גם עם fileName ─

check("buildIdentificationResponse max_attempts: מודול ה-record מקבל fileName תואם", function () {
  var q = { PBXcallId: "CALL-MAXATT-1", PBXphone: "0507654321" };
  var identState = { kind: "max_attempts" };
  var res = ivr.buildIdentificationResponse(q, identState, makePassthroughAudio());
  var recordModule = res[1];

  assert.strictEqual(recordModule.type, "record");
  assert.strictEqual(recordModule.name, "voiceMessage");
  assert.strictEqual(recordModule.fileName, ivr.buildVoiceMessageFileName(q));
});

check("buildVoiceMessageFileName: תואם בין buildResponse ל-buildIdentificationResponse עבור אותה שיחה בדיוק", function () {
  // מוודא שה-fileName שהתקבל לשיחה שהגיעה למקסימום ניסיונות (max_attempts)
  // זהה לשם שהיה מתקבל אילו הזדהתה בהצלחה והגיעה ל-mainChoice=3 — כי
  // ivr.service.js משחזר את השם פעם אחת בלבד, בלי לדעת דרך איזה מסלול הגיע.
  var q = { PBXcallId: "CALL-SAME-1", PBXphone: "0501231234" };
  var viaMainMenu = ivr.buildResponse(Object.assign({ mainChoice: "3" }, q), null, makePassthroughAudio())[1].fileName;
  var viaMaxAttempts = ivr.buildIdentificationResponse(q, { kind: "max_attempts" }, makePassthroughAudio())[1].fileName;
  assert.strictEqual(viaMainMenu, viaMaxAttempts);
});

// ═══ סיכום ═══════════════════════════════════════════════════════════════════
const failed = results.filter(function (r) { return !r.ok; });
results.forEach(function (r) {
  console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : " — " + r.error));
});
console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");
process.exit(failed.length ? 1 : 0);

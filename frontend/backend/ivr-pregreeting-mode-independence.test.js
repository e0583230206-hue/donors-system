// ivr-pregreeting-mode-independence.test.js — proves the fix for the gap
// reported after the pre-greeting feature shipped: PREGREETING-001 was
// wired through the SAME useAudio decision as the other 83 catalog
// recordings, so IVR_AUDIO_MODE=off (the default — no audio at all in
// production today) silently silenced the pre-greeting too, even when it
// was enabled/approved/in-schedule. Turning the pre-greeting on must never
// require turning on audio for the rest of the catalog, and IVR_AUDIO_MODE
// being off must never silence it either.
//
// Integration-level, at the exact seam that matters: buildAudioContext()
// (ivr-audio-context.service.js) feeding the real ivr.js. The pre-greeting
// resolver itself is injected via buildAudioContext(phone, deps) — added
// specifically for this fix — so this file never touches the real DB/disk,
// matching every other test in this area. The resolver's OWN gating logic
// (enabled/approved/schedule) is already fully covered by
// ivr-pregreeting.service.test.js; this file only proves the MODE
// independence and the injection-point behavior together, end to end.
//
// הרצה: node ivr-pregreeting-mode-independence.test.js

// Safety: the last check below deliberately calls buildAudioContext() with
// NO injected deps, exercising the real production pregreeting wiring
// (ivr-pregreeting.service.js's buildPregreetingFilesForProduction), which
// lazily require("./db") on first call — DB_PATH must be a disposable temp
// file BEFORE anything here ever requires db.js (directly or transitively),
// same as every other test file that touches real production wiring.
const fs = require("fs");
const os = require("os");
const path = require("path");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pregreeting-mode-independence-test-"));
process.env.DB_PATH = path.join(tmpRoot, "test.sqlite");
delete process.env.NODE_ENV;

const assert = require("assert");
const ivr = require("./ivr");
const { buildAudioContext } = require("./ivr-audio-context.service");
const db = require("./db");

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name: name, ok: true });
  } catch (err) {
    results.push({ name: name, ok: false, error: err.stack || err.message });
  }
}

function withEnv(vars, fn) {
  const saved = {};
  Object.keys(vars).forEach(function (k) { saved[k] = process.env[k]; process.env[k] = vars[k]; });
  try {
    fn();
  } finally {
    Object.keys(saved).forEach(function (k) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    });
  }
}

check("[בטיחות] הבדיקה פועלת מול DB זמני, לא מול data.sqlite האמיתי", function () {
  assert.ok(db.DB_PATH.indexOf(tmpRoot) === 0, "DB_PATH חייב להיות תחת תיקיית ה-tmp, לא הנתיב האמיתי");
});

const PREGREETING_ITEM = { fileLink: "https://fake/PREGREETING-001.wav", fileName: "PREGREETING-001" };
const FIRST_TURN_QUERY = {};
const LATER_TURN_QUERY = { identChoice: "1" };
const IDENT_STATE = { kind: "self_input" }; // uses ENTER_PHONE_OR_ID_SELF (IDENT-004) — a real T_AUDIO_ID entry

check('IVR_AUDIO_MODE="off" (ברירת המחדל היום) + הודעה זמנית פעילה -> מושמעת ראשונה, לפני OPEN-001', function () {
  withEnv({ IVR_AUDIO_MODE: "off", IVR_AUDIO_TRIAL_CALLER_PHONE: "" }, function () {
    const audio = buildAudioContext("0501234567", {
      getPregreetingFiles: function () { return [PREGREETING_ITEM]; },
    });
    const res = ivr.buildIdentificationResponse(FIRST_TURN_QUERY, IDENT_STATE, audio);
    const files = res.files;
    assert.deepStrictEqual(files[0], PREGREETING_ITEM, "ההודעה הזמנית חייבת להופיע ראשונה גם כש-IVR_AUDIO_MODE=off");
    assert.strictEqual(files[1].text, "שלום וברכה, הגעתם למערכת תשלומים של א בלאט גמרא.", "מיד אחריה, הפתיח הקבוע (כטקסט — ראו הבדיקה הבאה)");
  });
});

check('IVR_AUDIO_MODE="off" + הודעה זמנית כבויה (מחזירה []) -> אינה מושמעת כלל', function () {
  withEnv({ IVR_AUDIO_MODE: "off", IVR_AUDIO_TRIAL_CALLER_PHONE: "" }, function () {
    const audio = buildAudioContext("0501234567", {
      getPregreetingFiles: function () { return []; },
    });
    const res = ivr.buildIdentificationResponse(FIRST_TURN_QUERY, IDENT_STATE, audio);
    const files = res.files;
    assert.strictEqual(files.length, 3, "OPENING + IDENT_UNKNOWN_ANI + ENTER_PHONE_OR_ID_SELF — בדיוק כמו לפני התכונה, בלי ההודעה הזמנית");
    files.forEach(function (f) { assert.notStrictEqual(f.fileName, "PREGREETING-001"); });
  });
});

check('IVR_AUDIO_MODE="off" + הודעה זמנית פעילה -> ה-83 ההקלטות הרגילות עדיין לא מופעלות (OPEN-001/IDENT-004 עדיין TTS, לא fileLink)', function () {
  withEnv({ IVR_AUDIO_MODE: "off", IVR_AUDIO_TRIAL_CALLER_PHONE: "" }, function () {
    const audio = buildAudioContext("0501234567", {
      getPregreetingFiles: function () { return [PREGREETING_ITEM]; },
    });
    const res = ivr.buildIdentificationResponse(FIRST_TURN_QUERY, IDENT_STATE, audio);
    const files = res.files;
    // files[0] is the injected pre-greeting fileLink (expected — that's the
    // feature); everything else must remain plain {text}, exactly as when
    // IVR_AUDIO_MODE is off with no pre-greeting at all.
    files.slice(1).forEach(function (f) {
      assert.strictEqual(typeof f.text, "string", "כל שאר הפריטים חייבים TTS, לא fileLink");
      assert.strictEqual(f.fileLink, undefined);
    });
  });
});

check('IVR_AUDIO_MODE="off" + הודעה זמנית פעילה -> מושמעת פעם אחת בלבד, לא בתור שאינו הראשון', function () {
  withEnv({ IVR_AUDIO_MODE: "off", IVR_AUDIO_TRIAL_CALLER_PHONE: "" }, function () {
    const audio = buildAudioContext("0501234567", {
      getPregreetingFiles: function () { return [PREGREETING_ITEM]; },
    });
    const first = ivr.buildIdentificationResponse(FIRST_TURN_QUERY, IDENT_STATE, audio);
    assert.deepStrictEqual(first.files[0], PREGREETING_ITEM, "בתור הראשון — מופיעה");

    const later = ivr.buildIdentificationResponse(LATER_TURN_QUERY, { kind: "self_input_retry", reason: "not_found" }, audio);
    later.files.forEach(function (f) { assert.notStrictEqual(f.fileName, "PREGREETING-001"); });
  });
});

check('mode="on" (הקלטות רגילות פעילות) — ההודעה הזמנית עדיין נשלטת רק ע"י deps.getPregreetingFiles שהוזרק, לא ע"י buildAudioContext', function () {
  withEnv({ IVR_AUDIO_MODE: "on", IVR_AUDIO_TRIAL_CALLER_PHONE: "" }, function () {
    const audio = buildAudioContext("0501234567", {
      getPregreetingFiles: function () { return []; },
    });
    const res = ivr.buildIdentificationResponse(FIRST_TURN_QUERY, IDENT_STATE, audio);
    res.files.forEach(function (f) { assert.notStrictEqual(f.fileName, "PREGREETING-001"); });
  });
});

check("buildAudioContext בלי deps כלל (חיווט הפרודקשן האמיתי, מול DB זמני) -> resolveOrText/resolveAudioId/getPregreetingFiles תקינים, לא זורק, ומחזיר [] כי ההודעה הזמנית עדיין לא הופעלה", function () {
  withEnv({ IVR_AUDIO_MODE: "off", IVR_AUDIO_TRIAL_CALLER_PHONE: "" }, function () {
    const audio = buildAudioContext("0501234567");
    assert.strictEqual(typeof audio.resolveOrText, "function");
    assert.strictEqual(typeof audio.resolveAudioId, "function");
    assert.strictEqual(typeof audio.getPregreetingFiles, "function");
    assert.deepStrictEqual(audio.getPregreetingFiles(), [], "שורת ה-seed טרייה, enabled=0 כברירת מחדל -> []");
  });
});

// ── סיכום ────────────────────────────────────────────────────────────────────
const failed = results.filter(function (r) { return !r.ok; });
results.forEach(function (r) {
  console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : " — " + r.error));
});
console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");
process.exitCode = failed.length ? 1 : 0;

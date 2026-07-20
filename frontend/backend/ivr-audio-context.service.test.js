// ivr-audio-context.service.test.js — בדיקות ל-createAudioContext (DI טהור,
// לא נוגע ב-DB/דיסק) ול-textToAudioIdFrom/passthroughAudioContext. גם
// buildAudioContext נבדק, אך רק במקרים שלא דורשים בדיקת קובץ פיזי בפועל —
// כשאין audioId תואם לטקסט הנבדק, resolveAudio האמיתי אף פעם לא נקרא, כך
// שהבדיקה נשארת דטרמיניסטית ולא תלויה במצב השרת המקומי. הרצה:
//   node ivr-audio-context.service.test.js

const assert = require("assert");
const {
  createAudioContext,
  passthroughAudioContext,
  textToAudioIdFrom,
  buildAudioContext,
} = require("./ivr-audio-context.service");

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name: name, ok: true });
  } catch (err) {
    results.push({ name: name, ok: false, error: err.message });
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

// ── textToAudioIdFrom ────────────────────────────────────────────────────────
check("textToAudioIdFrom: ממפה sourceTextHe (אחרי trim) → audioId", function () {
  const map = textToAudioIdFrom([{ audioId: "OPEN-001", sourceTextHe: "  שלום.  " }]);
  assert.strictEqual(map["שלום."], "OPEN-001");
});

check("textToAudioIdFrom: התנגשות טקסט זהה → הראשון מנצח, לא האחרון", function () {
  const map = textToAudioIdFrom([
    { audioId: "FIRST-001", sourceTextHe: "טקסט זהה" },
    { audioId: "SECOND-002", sourceTextHe: "טקסט זהה" },
  ]);
  assert.strictEqual(map["טקסט זהה"], "FIRST-001");
});

check("textToAudioIdFrom: טקסט ריק לא נכנס למפה", function () {
  const map = textToAudioIdFrom([{ audioId: "X", sourceTextHe: "" }, { audioId: "Y", sourceTextHe: "   " }]);
  assert.deepStrictEqual(map, {});
});

// ── passthroughAudioContext ──────────────────────────────────────────────────
check("passthroughAudioContext.resolveOrText: זהות מוחלטת, לעולם לא fileLink", function () {
  const ctx = passthroughAudioContext();
  assert.deepStrictEqual(ctx.resolveOrText("כל טקסט שהוא"), { text: "כל טקסט שהוא" });
});

check("passthroughAudioContext.resolveAudioId: מחזיר את fallbackText כמו שהוא", function () {
  const ctx = passthroughAudioContext();
  assert.deepStrictEqual(ctx.resolveAudioId("OPEN-001", "טקסט גיבוי"), { text: "טקסט גיבוי" });
});

// ── createAudioContext (DI מלא) ──────────────────────────────────────────────
check("resolveOrText: טקסט קיים במפה → קורא ל-resolveAudio עם (id, הטקסט המקורי)", function () {
  let capturedArgs = null;
  const ctx = createAudioContext({
    textToAudioId: { "שלום.": "OPEN-001" },
    resolveAudio: function (id, fallbackText) {
      capturedArgs = [id, fallbackText];
      return { fileLink: "https://x/y.wav", fileName: "y" };
    },
  });
  const result = ctx.resolveOrText("שלום.");
  assert.deepStrictEqual(capturedArgs, ["OPEN-001", "שלום."]);
  assert.deepStrictEqual(result, { fileLink: "https://x/y.wav", fileName: "y" });
});

check("resolveOrText: טקסט לא קיים במפה → {text} מקורי, resolveAudio אף פעם לא נקרא", function () {
  let called = false;
  const ctx = createAudioContext({
    textToAudioId: { "שלום.": "OPEN-001" },
    resolveAudio: function () { called = true; return { fileLink: "x", fileName: "y" }; },
  });
  const result = ctx.resolveOrText("שלום " + "דונור כלשהו" + ".");
  assert.strictEqual(called, false);
  assert.deepStrictEqual(result, { text: "שלום דונור כלשהו." });
});

check("resolveOrText: מנרמל (trim) לפני חיפוש במפה, אבל מחזיר טקסט מקורי (לא נחתך) בכשל", function () {
  const ctx = createAudioContext({
    textToAudioId: { "שלום.": "OPEN-001" },
    resolveAudio: function () { throw new Error("should not be called"); },
  });
  const result = ctx.resolveOrText("   שלום עם רווחים לא קיים במפה   ");
  assert.deepStrictEqual(result, { text: "   שלום עם רווחים לא קיים במפה   " });
});

check("resolveAudioId: תמיד קורא ישירות ל-resolveAudio עם audioId+fallbackText", function () {
  let capturedArgs = null;
  const ctx = createAudioContext({
    textToAudioId: {},
    resolveAudio: function (id, fallbackText) {
      capturedArgs = [id, fallbackText];
      return { text: fallbackText };
    },
  });
  const result = ctx.resolveAudioId("NUM-DIGIT-005", "חמישה");
  assert.deepStrictEqual(capturedArgs, ["NUM-DIGIT-005", "חמישה"]);
  assert.deepStrictEqual(result, { text: "חמישה" });
});

// ── buildAudioContext: ניתוב לפי מצב/טלפון (בלי לגעת ב-DB/דיסק בפועל — ראו הערה למעלה) ─
const TRIAL_PHONE = "0500000001";
const NO_MATCH_TEXT = "טקסט-בדיקה-שלא-קיים-באף-הקלטה-מאושרת-12345";

check('mode="off" → passthrough תמיד, גם עם טלפון תואם', function () {
  withEnv({ IVR_AUDIO_MODE: "off", IVR_AUDIO_TRIAL_CALLER_PHONE: TRIAL_PHONE }, function () {
    const ctx = buildAudioContext(TRIAL_PHONE);
    assert.deepStrictEqual(ctx.resolveOrText("תודה על התקשרותך. להתראות."), { text: "תודה על התקשרותך. להתראות." });
  });
});

check("IVR_AUDIO_MODE חסר לגמרי → off (passthrough)", function () {
  withEnv({ IVR_AUDIO_MODE: "", IVR_AUDIO_TRIAL_CALLER_PHONE: TRIAL_PHONE }, function () {
    const ctx = buildAudioContext(TRIAL_PHONE);
    assert.deepStrictEqual(ctx.resolveOrText("כל טקסט"), { text: "כל טקסט" });
  });
});

check('mode="trial" + מספר לא תואם → passthrough (כמו off)', function () {
  withEnv({ IVR_AUDIO_MODE: "trial", IVR_AUDIO_TRIAL_CALLER_PHONE: TRIAL_PHONE }, function () {
    const ctx = buildAudioContext("0509999999");
    assert.deepStrictEqual(ctx.resolveOrText(NO_MATCH_TEXT), { text: NO_MATCH_TEXT });
  });
});

check('mode="trial" + מספר תואם (אחרי נורמליזציה) → context אמיתי (טקסט לא-קיים עדיין {text} תקין, בלי לגעת בדיסק)', function () {
  withEnv({ IVR_AUDIO_MODE: "trial", IVR_AUDIO_TRIAL_CALLER_PHONE: TRIAL_PHONE }, function () {
    const ctx = buildAudioContext("050-000-0001"); // פורמט שונה, אותו מספר אחרי normalizePhone
    assert.deepStrictEqual(ctx.resolveOrText(NO_MATCH_TEXT), { text: NO_MATCH_TEXT });
  });
});

check('mode="on" → context אמיתי לכל טלפון', function () {
  withEnv({ IVR_AUDIO_MODE: "on", IVR_AUDIO_TRIAL_CALLER_PHONE: "" }, function () {
    const ctx = buildAudioContext("0501111111");
    assert.deepStrictEqual(ctx.resolveOrText(NO_MATCH_TEXT), { text: NO_MATCH_TEXT });
  });
});

check('mode="banana" (לא חוקי) → off (passthrough)', function () {
  withEnv({ IVR_AUDIO_MODE: "banana", IVR_AUDIO_TRIAL_CALLER_PHONE: TRIAL_PHONE }, function () {
    const ctx = buildAudioContext(TRIAL_PHONE);
    assert.deepStrictEqual(ctx.resolveOrText("כל טקסט"), { text: "כל טקסט" });
  });
});

// ── סיכום ────────────────────────────────────────────────────────────────────
const failed = results.filter(function (r) { return !r.ok; });
results.forEach(function (r) {
  console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : " — " + r.error));
});
console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");
process.exit(failed.length ? 1 : 0);

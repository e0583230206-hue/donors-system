// ivr-trial-transfer.test.js — standalone verification for the hidden
// trial-extension transfer added to ivr.service.js (shouldTriggerTrialTransfer
// / buildTrialTransferResponse). No test framework (the project has none) —
// plain Node with the built-in `assert` module. Run: node ivr-trial-transfer.test.js
//
// Sets env vars in-process only — never touches the real .env file. Tests
// call the two exported PURE functions directly (no DB writes). The
// no-phone-in-logs test simulates the exact call-site sequence used in
// handleIvrQuery (predicate → fixed marker log → builder) without invoking
// the rest of handleIvrQuery, so it never touches donors/payments/call logs.

const assert = require("assert");

// A fake, obviously-not-real test phone — never a real donor/personal number.
const TEST_TRIAL_PHONE = "0500000001";
const TEST_TRIAL_EXT   = "9999";

process.env.IVR_AUDIO_TRIAL_CALLER_PHONE = TEST_TRIAL_PHONE;
process.env.TECHNOLINE_IVR_TRIAL_EXTENSION = TEST_TRIAL_EXT;

const { shouldTriggerTrialTransfer, buildTrialTransferResponse } = require("./ivr.service");

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

// ── 1. משתנה לא מוגדר → הזרימה הקיימת אינה משתנה ────────────────────────────
check("שני המשתנים לא מוגדרים → false (בלי שינוי התנהגות)", function () {
  withEnv({ IVR_AUDIO_TRIAL_CALLER_PHONE: "", TECHNOLINE_IVR_TRIAL_EXTENSION: "" }, function () {
    assert.strictEqual(shouldTriggerTrialTransfer({}, TEST_TRIAL_PHONE, true), false);
  });
});

check("רק IVR_AUDIO_TRIAL_CALLER_PHONE מוגדר (השני חסר) → false", function () {
  withEnv({ IVR_AUDIO_TRIAL_CALLER_PHONE: TEST_TRIAL_PHONE, TECHNOLINE_IVR_TRIAL_EXTENSION: "" }, function () {
    assert.strictEqual(shouldTriggerTrialTransfer({}, TEST_TRIAL_PHONE, true), false);
  });
});

check("רק TECHNOLINE_IVR_TRIAL_EXTENSION מוגדר (השני חסר) → false", function () {
  withEnv({ IVR_AUDIO_TRIAL_CALLER_PHONE: "", TECHNOLINE_IVR_TRIAL_EXTENSION: TEST_TRIAL_EXT }, function () {
    assert.strictEqual(shouldTriggerTrialTransfer({}, TEST_TRIAL_PHONE, true), false);
  });
});

// ── 2. מספר אחר → הזרימה הקיימת אינה משתנה ──────────────────────────────────
check("מספר מתקשר שונה מהמספר המוגדר → false", function () {
  assert.strictEqual(shouldTriggerTrialTransfer({}, "0509999999", true), false);
});

// ── 3. בקשה שאינה ראשונה → אין מעבר ─────────────────────────────────────────
check("isFirstRequest=false (גם עם מספר תואם) → false", function () {
  assert.strictEqual(shouldTriggerTrialTransfer({}, TEST_TRIAL_PHONE, false), false);
});

// ── 4. HANGUP → אין מעבר ────────────────────────────────────────────────────
check("PBXcallStatus=HANGUP (גם עם מספר תואם + ראשונה) → false", function () {
  assert.strictEqual(shouldTriggerTrialTransfer({ PBXcallStatus: "HANGUP" }, TEST_TRIAL_PHONE, true), false);
});

// ── 5. מספר תואם בבקשה ראשונה → השמעה ישירה (עוקף goTo זמנית) ────────────────
check("כל התנאים מתקיימים → true", function () {
  assert.strictEqual(shouldTriggerTrialTransfer({}, TEST_TRIAL_PHONE, true), true);
});

check("result.response אינו Array (אותו עיקרון כמו בתיקון הקודם — מודול בודד = אובייקט חשוף)", function () {
  const res = buildTrialTransferResponse();
  assert.strictEqual(Array.isArray(res.response), false, "result.response לא אמור להיות מערך");
});

check('type הוא "simpleMessage" (עוקף goTo זמנית לצורך בדיקת ההקלטה ישירות)', function () {
  const res = buildTrialTransferResponse();
  assert.strictEqual(res.response.type, "simpleMessage");
});

check("files מכיל בדיוק איבר אחד עם fileLink ו-fileName הנדרשים", function () {
  const res = buildTrialTransferResponse();
  assert.deepStrictEqual(res, {
    response: {
      type: "simpleMessage",
      files: [
        {
          fileLink: "https://30206.co.il/uploads/ivr-audio/TRIAL-open001-v1.mp3",
          fileName: "TRIAL-open001-v1",
        },
      ],
    },
  });
});

check('גוף ה-HTTP הסופי אחרי res.json(result.response) הוא בדיוק המבנה הנדרש', function () {
  // server.js:2021 עושה res.json(result.response) — Express's res.json()
  // ללא "json spaces"/"json replacer" מוגדרים (נבדק ב-server.js) שקול
  // ל-JSON.stringify(obj) פשוט. מדמים את זה בדיוק, בלי לגעת ב-Express/רשת.
  const res = buildTrialTransferResponse();
  const httpBody = JSON.stringify(res.response);
  assert.strictEqual(
    httpBody,
    '{"type":"simpleMessage","files":[{"fileLink":"https://30206.co.il/uploads/ivr-audio/TRIAL-open001-v1.mp3","fileName":"TRIAL-open001-v1"}]}'
  );
});

// ── 6. פורמטים ישראליים שונים מנורמלים נכון (אותו מספר, ייצוגים שונים) ──────
check("פורמט 05XXXXXXXX (כפי שמוגדר) → תואם", function () {
  assert.strictEqual(shouldTriggerTrialTransfer({}, TEST_TRIAL_PHONE, true), true);
});

check("פורמט +972 (בינלאומי עם 972) → מנורמל ותואם", function () {
  withEnv({ IVR_AUDIO_TRIAL_CALLER_PHONE: "+972500000001" }, function () {
    // ה-phone שמגיע כבר מנורמל ע"י הקוד הקורא (כמו בזרימה האמיתית) — הבדיקה
    // מוודאת שגם ה-env value עצמו (שיכול היה להיות מוזן בפורמטים שונים)
    // עובר נורמליזציה זהה בתוך shouldTriggerTrialTransfer.
    assert.strictEqual(shouldTriggerTrialTransfer({}, TEST_TRIAL_PHONE, true), true);
  });
});

check("פורמט 00972 (בינלאומי עם קידומת יציאה) → מנורמל ותואם", function () {
  withEnv({ IVR_AUDIO_TRIAL_CALLER_PHONE: "00972500000001" }, function () {
    assert.strictEqual(shouldTriggerTrialTransfer({}, TEST_TRIAL_PHONE, true), true);
  });
});

check("פורמט ללא 0 מוביל (9 ספרות) → מנורמל ותואם", function () {
  withEnv({ IVR_AUDIO_TRIAL_CALLER_PHONE: "500000001" }, function () {
    assert.strictEqual(shouldTriggerTrialTransfer({}, TEST_TRIAL_PHONE, true), true);
  });
});

check("מספר עם מקפים/רווחים → מנורמל ותואם", function () {
  withEnv({ IVR_AUDIO_TRIAL_CALLER_PHONE: "050-000-0001" }, function () {
    assert.strictEqual(shouldTriggerTrialTransfer({}, TEST_TRIAL_PHONE, true), true);
  });
});

// ── 7. הקוד החדש לא מוסיף שום לוג שחושף את המספר ────────────────────────────
// דיוק חשוב: handleIvrQuery האמיתי קורא ל-logCallStart(callId, phone) *לפני*
// מנגנון המעבר הזה (ivr.service.js:458, שורה קיימת, לא נוגעים בה) — מנגנון
// הלוגים הקיים של כל שיחת IVR (ivr_call_sessions / ivr_call_logs) כבר שומר
// את הטלפון היום, לכל שיחה, ללא שום קשר לשינוי הזה. הבדיקה הזו לא טוענת
// ולא בודקת "המספר אף פעם לא נשמר בשום מקום" — זו טענה שגויה. היא מוכיחה
// טענה מצומצמת ומדויקת יותר: הקוד *החדש* שנוסף (predicate + buildTrialTransferResponse
// + שורת הלוג הקבועה trial_audio_direct_triggered ב-call site) לא מוסיף אף לוג
// נוסף שמכיל מספר טלפון, callId או query — בדיוק כפי שהוא כתוב בפועל.
// מנגנון הלוג הקיים (logCallStart) אינו נבדק כאן ואינו משתנה — ראו ה-diff.
check("trial_audio_direct_triggered אינו מכיל מספר טלפון/callId/query — הקוד לא מוסיף חשיפה", function () {
  const captured = [];
  const originalLog = console.log, originalWarn = console.warn, originalError = console.error;
  console.log = function () { captured.push(Array.from(arguments).join(" ")); };
  console.warn = function () { captured.push(Array.from(arguments).join(" ")); };
  console.error = function () { captured.push(Array.from(arguments).join(" ")); };
  try {
    const q = { PBXcallId: "fake-call-id-should-never-appear", someOtherParam: "x" };
    // מדמה בדיוק את רצף הקריאה מה-call site האמיתי ב-handleIvrQuery
    // (ivr.service.js) — predicate → לוג הסמן הקבוע → builder — בלי להפעיל
    // את שאר handleIvrQuery (logCallStart/DB) שאינו חלק מהשינוי הזה.
    if (shouldTriggerTrialTransfer(q, TEST_TRIAL_PHONE, true)) {
      console.log("[IVR] trial_audio_direct_triggered"); // בדיוק כמו ב-call site האמיתי — אין ארגומנט נוסף
      buildTrialTransferResponse();
    }
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
  // בדיקה מדויקת, לא רק "includes": בדיוק לוג אחד, בדיוק המחרוזת הקבועה —
  // בלי מספר טלפון, בלי callId, בלי שום נתון מ-q.
  assert.strictEqual(captured.length, 1, "אמור להיות בדיוק לוג אחד (הסמן הקבוע), לא יותר");
  assert.strictEqual(captured[0], "[IVR] trial_audio_direct_triggered");
  assert.ok(!captured[0].includes(TEST_TRIAL_PHONE));
  assert.ok(!captured[0].includes("fake-call-id-should-never-appear"));
});

// ── סיכום ────────────────────────────────────────────────────────────────
const failed = results.filter(function (r) { return !r.ok; });
results.forEach(function (r) {
  console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : " — " + r.error));
});
console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");
process.exit(failed.length ? 1 : 0);

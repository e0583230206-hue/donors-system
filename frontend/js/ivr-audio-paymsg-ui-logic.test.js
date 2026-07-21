// ivr-audio-paymsg-ui-logic.test.js — proves the "אשר והפעל" button logic
// is unconditional on the row's CURRENT status (the exact bug class: a
// status <select> left on "אושר" doesn't reliably fire "change" when
// re-selected, so relying on it would silently no-op when approving a
// replacement on an already-approved row). No DOM/browser needed — this
// module is dual-environment specifically so it CAN run under plain Node
// (see header of ivr-audio-paymsg-ui-logic.js for why).
//
// הרצה: node frontend/js/ivr-audio-paymsg-ui-logic.test.js

const assert = require("assert");
const {
  shouldShowApproveButton,
  buildApproveRequest,
  verifyPostApproveState,
  decideApproveOutcome,
} = require("./ivr-audio-paymsg-ui-logic");

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name: name, ok: true });
  } catch (err) {
    results.push({ name: name, ok: false, error: err.stack || err.message });
  }
}

// ── shouldShowApproveButton ───────────────────────────────────────────────
check("[הממצא הראשי] כפתור מוצג כש-audioFile3 קיים, גם אם status כבר \"אושר\"", function () {
  assert.strictEqual(
    shouldShowApproveButton({ category: "paymsg", audioFile3: "PAYMSG-3000-3-x.wav", status: "אושר" }),
    true
  );
});

check("כפתור לא מוצג כשאין audioFile3 בכלל", function () {
  assert.strictEqual(shouldShowApproveButton({ category: "paymsg", audioFile3: "", status: "אושר" }), false);
  assert.strictEqual(shouldShowApproveButton({ category: "paymsg", status: "אושר" }), false);
});

check("כפתור מוצג גם לשורות שאינן paymsg כשיש audioFile3 — כל הקטגוריות משתמשות באותו מנגנון 3 סלוטים", function () {
  assert.strictEqual(shouldShowApproveButton({ category: "open", audioFile3: "x.wav" }), true);
});

check("קלט חסר/undefined לא זורק שגיאה", function () {
  assert.strictEqual(shouldShowApproveButton(undefined), false);
  assert.strictEqual(shouldShowApproveButton(null), false);
});

// ── buildApproveRequest ───────────────────────────────────────────────────
check("[הממצא הראשי] buildApproveRequest אינו מקבל/תלוי בסטטוס הנוכחי בכלל — רק audioId", function () {
  assert.strictEqual(buildApproveRequest.length, 1, "הפונקציה מקבלת רק פרמטר אחד — audioId, לא status");
});

check("buildApproveRequest: שולח תמיד PUT עם status:\"אושר\" בלבד, לא שדות אחרים", function () {
  var req = buildApproveRequest("PAYMSG-3000");
  assert.strictEqual(req.method, "PUT");
  assert.strictEqual(req.url, "/api/admin/ivr-audio/PAYMSG-3000");
  assert.deepStrictEqual(req.body, { status: "אושר" });
});

check("buildApproveRequest: תוצאה זהה בדיוק בכל קריאה לאותו audioId — לא מושפעת משום state חיצוני", function () {
  var req1 = buildApproveRequest("PAYMSG-3014");
  var req2 = buildApproveRequest("PAYMSG-3014");
  assert.deepStrictEqual(req1, req2);
});

check("buildApproveRequest: מקודד audioId בבטחה ב-URL", function () {
  var req = buildApproveRequest("PAYMSG 3000/weird");
  assert.strictEqual(req.url, "/api/admin/ivr-audio/" + encodeURIComponent("PAYMSG 3000/weird"));
});

// ── verifyPostApproveState — מוודא את התוצאה בפועל, לא רק ok:true ──────────
check("[תרחיש מלא] status=\"אושר\"+audioFile3 קיים -> אחרי אישור: audioFile3 מתרוקן, הממתין הופך לפעיל, הפעיל הישן הופך לקודם", function () {
  var before = { audioId: "PAYMSG-3000", audioFile1: "PAYMSG-3000-1-old.wav", audioFile2: "", audioFile3: "PAYMSG-3000-3-new.wav", status: "אושר" };
  var after  = { audioId: "PAYMSG-3000", audioFile1: "PAYMSG-3000-3-new.wav", audioFile2: "PAYMSG-3000-1-old.wav", audioFile3: "", status: "אושר" };
  var verification = verifyPostApproveState(before, after);
  assert.strictEqual(verification.ok, true, verification.reason);
});

check("verifyPostApproveState: מזהה תשובת שרת שגויה — audioFile3 לא התרוקן", function () {
  var before = { audioFile1: "old.wav", audioFile3: "new.wav" };
  var after  = { audioFile1: "new.wav", audioFile2: "old.wav", audioFile3: "new.wav" }; // עדיין לא ריק — בעיה
  var verification = verifyPostApproveState(before, after);
  assert.strictEqual(verification.ok, false);
});

check("verifyPostApproveState: מזהה תשובת שרת שגויה — הפעיל אחרי האישור אינו הממתין הקודם", function () {
  var before = { audioFile1: "old.wav", audioFile3: "new.wav" };
  var after  = { audioFile1: "old.wav", audioFile2: "", audioFile3: "" }; // לא הוחלף בפועל
  var verification = verifyPostApproveState(before, after);
  assert.strictEqual(verification.ok, false);
});

check("verifyPostApproveState: תשובה חסרה (undefined) מטופלת בבטחה", function () {
  assert.strictEqual(verifyPostApproveState({ audioFile1: "a", audioFile3: "b" }, undefined).ok, false);
});

// ── decideApproveOutcome — הממצא השני: הודעת הצלחה שקרית ────────────────
check("[הממצא השני] verifyPostApproveState מהתשובה הצליח -> showSuccess=true, applyLocalUpdate='response'", function () {
  var outcome = decideApproveOutcome({ ok: true }, null);
  assert.deepStrictEqual(outcome, { applyLocalUpdate: "response", showSuccess: true });
});

check("[הממצא השני] תשובת ה-PUT נכשלה באימות, אך re-fetch הוכיח הצלחה -> showSuccess=true, applyLocalUpdate='refetch'", function () {
  var outcome = decideApproveOutcome({ ok: false, reason: "לא תואם" }, { ok: true });
  assert.deepStrictEqual(outcome, { applyLocalUpdate: "refetch", showSuccess: true });
});

check("[הממצא הראשי של הבאג] שני האימותים נכשלו -> showSuccess=false, applyLocalUpdate=false — אין עדכון מקומי ואין הודעת הצלחה", function () {
  var outcome = decideApproveOutcome({ ok: false, reason: "סיבה מהתשובה" }, { ok: false, reason: "סיבה מה-refetch" });
  assert.strictEqual(outcome.showSuccess, false);
  assert.strictEqual(outcome.applyLocalUpdate, false);
  assert.strictEqual(outcome.errorReason, "סיבה מה-refetch", "מעדיף את סיבת ה-refetch (האחרונה/המדויקת יותר) כשקיימת");
});

check("decideApproveOutcome: אין freshVerification בכלל (לא נדרש re-fetch) ותשובת ה-PUT נכשלה -> נופל לסיבת התשובה", function () {
  var outcome = decideApproveOutcome({ ok: false, reason: "סיבה מהתשובה" }, null);
  assert.strictEqual(outcome.showSuccess, false);
  assert.strictEqual(outcome.errorReason, "סיבה מהתשובה");
});

check("decideApproveOutcome: קלט חסר לגמרי לא זורק שגיאה, ומחזיר showSuccess=false", function () {
  var outcome = decideApproveOutcome(undefined, undefined);
  assert.strictEqual(outcome.showSuccess, false);
  assert.strictEqual(outcome.errorReason, "לא ידוע");
});

// ── סיכום ────────────────────────────────────────────────────────────────
const failed = results.filter(function (r) { return !r.ok; });
results.forEach(function (r) {
  console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : " — " + r.error));
});
console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");
process.exit(failed.length ? 1 : 0);

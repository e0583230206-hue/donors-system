// donor.service.test.js — בדיקות ל-purposeType שנוסף ל-openDebts
// (buildIvrDonorFromAppRecord). כמו כל שאר הקוד ב-donor.service.js, הפונקציה
// קוראת ל-findDonorByPhone האמיתי מ-db.js (אותה תלות קיימת כבר בפרודקשן —
// לא הוכנסה כאן) — משתמשים במספר טלפון בדוי שלא אמור להתאים לאף תורם אמיתי,
// כדי שהבדיקה תישאר דטרמיניסטית; זה לא משפיע על openDebts/purposeType בכלל,
// ששניהם נגזרים אך ורק מ-appDonor.donations שמוזרם ישירות לבדיקה.
// הרצה: node donor.service.test.js

const assert = require("assert");
const { buildIvrDonorFromAppRecord } = require("./donor.service");

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name: name, ok: true });
  } catch (err) {
    results.push({ name: name, ok: false, error: err.message });
  }
}

const FAKE_PHONE = "0500009999"; // לא אמור להתאים לאף תורם אמיתי

function donorWith(donations) {
  return { phone: FAKE_PHONE, fullName: "בדיקה בלבד", donations: donations };
}

check('purposeType="גליון מתאחדת" מועבר כמו שהוא ל-currentDebt', function () {
  const donor = buildIvrDonorFromAppRecord(
    donorWith([{ remainingDebt: 100, paid: false, finalPurpose: "גליון מתאחדת", purposeType: "גליון מתאחדת" }])
  );
  assert.strictEqual(donor.currentDebt.purposeType, "גליון מתאחדת");
});

check('purposeType="פרנס" מועבר', function () {
  const donor = buildIvrDonorFromAppRecord(
    donorWith([{ remainingDebt: 50, paid: false, finalPurpose: "פרנס", purposeType: "פרנס" }])
  );
  assert.strictEqual(donor.currentDebt.purposeType, "פרנס");
});

check('purposeType="אחר" מועבר (גם כשה-purpose החופשי שונה)', function () {
  const donor = buildIvrDonorFromAppRecord(
    donorWith([{ remainingDebt: 75, paid: false, finalPurpose: "תרומה מיוחדת", purposeType: "אחר" }])
  );
  assert.strictEqual(donor.currentDebt.purposeType, "אחר");
  assert.strictEqual(donor.currentDebt.purpose, "תרומה מיוחדת");
});

check("purposeType חסר בתרומה → מחרוזת ריקה, לא undefined ולא זריקה", function () {
  const donor = buildIvrDonorFromAppRecord(
    donorWith([{ remainingDebt: 30, paid: false, finalPurpose: "כללי" }])
  );
  assert.strictEqual(donor.currentDebt.purposeType, "");
});

check("purposeType מועבר גם עבור previousDebts, לא רק currentDebt הראשון", function () {
  const donor = buildIvrDonorFromAppRecord(
    donorWith([
      { remainingDebt: 200, paid: false, purposeType: "גליון מתאחדת", date: "2026-06-01" },
      { remainingDebt: 80, paid: false, purposeType: "פרנס", date: "2026-01-01" },
    ])
  );
  assert.strictEqual(donor.currentDebt.purposeType, "גליון מתאחדת");
  assert.strictEqual(donor.previousDebts.length, 1);
  assert.strictEqual(donor.previousDebts[0].purposeType, "פרנס");
});

check("תאימות לאחור: amount ו-purpose ממשיכים להתנהג בדיוק כמו לפני התוספת", function () {
  const donor = buildIvrDonorFromAppRecord(
    donorWith([{ remainingDebt: 123.456, paid: false, finalPurpose: "בדיקה", purposeType: "אחר" }])
  );
  assert.strictEqual(donor.currentDebt.amount, 123.46);
  assert.strictEqual(donor.currentDebt.purpose, "בדיקה");
});

check("אין חובות פתוחים → currentDebt=null, אין קריסה על purposeType", function () {
  const donor = buildIvrDonorFromAppRecord(donorWith([]));
  assert.strictEqual(donor.currentDebt, null);
  assert.deepStrictEqual(donor.previousDebts, []);
});

check("purposeType עם רווחים מיותרים נחתך (trim), כמו purpose", function () {
  const donor = buildIvrDonorFromAppRecord(
    donorWith([{ remainingDebt: 40, paid: false, purposeType: "  פרנס  " }])
  );
  assert.strictEqual(donor.currentDebt.purposeType, "פרנס");
});

// ── סיכום ────────────────────────────────────────────────────────────────────
const failed = results.filter(function (r) { return !r.ok; });
results.forEach(function (r) {
  console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : " — " + r.error));
});
console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");
process.exit(failed.length ? 1 : 0);

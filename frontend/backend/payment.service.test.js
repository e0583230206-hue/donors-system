// payment.service.test.js — covers the actual double-payment-prevention path
// used by every real IVR payment (payment.service.js -> db.js
// savePaymentInTransaction, called from ivr.service.js's payment=OK branch).
// Neither payment.service.js nor this path in db.js had any dedicated test
// before this file — see production audit ("things that actually move money
// ... have none").
//
// Uses a TEMPORARY sqlite file (own os.tmpdir() path, set via DB_PATH before
// requiring db.js) — same pattern as seed-paymsg-audio.test.js. Never opens
// the real data.sqlite.
//
// הרצה: node payment.service.test.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "payment-service-test-"));
process.env.DB_PATH = path.join(tmpRoot, "test.sqlite");

const db = require("./db");
const { parsePositiveAmount, saveIvrPaymentOnce } = require("./payment.service");

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name: name, ok: true });
  } catch (err) {
    results.push({ name: name, ok: false, error: err.stack || err.message });
  }
}

check("[בטיחות] הבדיקה פועלת מול DB זמני, לא מול data.sqlite האמיתי", function () {
  assert.ok(db.DB_PATH.indexOf(tmpRoot) === 0, "DB_PATH חייב להיות תחת תיקיית ה-tmp, לא הנתיב האמיתי");
});

// ── parsePositiveAmount ──────────────────────────────────────────────────────

check("parsePositiveAmount: מספר חיובי תקין", function () {
  assert.strictEqual(parsePositiveAmount("150.5"), 150.5);
  assert.strictEqual(parsePositiveAmount(200), 200);
});

check("parsePositiveAmount: אפס, שלילי, לא-מספר, ריק, undefined -> null", function () {
  assert.strictEqual(parsePositiveAmount("0"), null);
  assert.strictEqual(parsePositiveAmount("-50"), null);
  assert.strictEqual(parsePositiveAmount("abc"), null);
  assert.strictEqual(parsePositiveAmount(""), null);
  assert.strictEqual(parsePositiveAmount(undefined), null);
  assert.strictEqual(parsePositiveAmount(null), null);
});

check("parsePositiveAmount: רווחים סביב המספר מנוקים", function () {
  assert.strictEqual(parsePositiveAmount("  75  "), 75);
});

// ── saveIvrPaymentOnce / savePaymentInTransaction (מניעת תשלום כפול) ─────────

check("saveIvrPaymentOnce: קריאה ראשונה יוצרת בדיוק רשומת payment אחת + ivr_donation אחת", function () {
  const callId = "CALL-DEDUP-001";
  const result = saveIvrPaymentOnce({ callId: callId, phone: "0501111111", amount: 100, donorId: null });

  assert.strictEqual(result.duplicate, false);

  const payment = db.findPaymentByCallId(callId);
  assert.ok(payment, "payment row should exist");
  assert.strictEqual(Number(payment.amount), 100);
  assert.strictEqual(payment.status, "success");

  const donation = db.findIvrDonationByCallId(callId);
  assert.ok(donation, "ivr_donation row should exist");
});

check("saveIvrPaymentOnce: קריאה שנייה עם אותו callId -> duplicate:true, בלי רשומה כפולה", function () {
  const callId = "CALL-DEDUP-002";
  const first  = saveIvrPaymentOnce({ callId: callId, phone: "0502222222", amount: 250, donorId: null });
  const second = saveIvrPaymentOnce({ callId: callId, phone: "0502222222", amount: 250, donorId: null });

  assert.strictEqual(first.duplicate, false);
  assert.strictEqual(second.duplicate, true);

  const stats = db.getPayments({ callId: callId });
  const matching = stats.filter(function (p) { return p.callId === callId; });
  assert.strictEqual(matching.length, 1, "double-submitting the same callId must never create a second payment row");
});

check("saveIvrPaymentOnce: callId זהה אך סכום שונה בקריאה השנייה עדיין נחסם (ה-callId הוא מפתח הייחודיות, לא הסכום)", function () {
  const callId = "CALL-DEDUP-003";
  saveIvrPaymentOnce({ callId: callId, phone: "0503333333", amount: 100, donorId: null });
  const second = saveIvrPaymentOnce({ callId: callId, phone: "0503333333", amount: 999999, donorId: null });

  assert.strictEqual(second.duplicate, true);
  const payment = db.findPaymentByCallId(callId);
  assert.strictEqual(Number(payment.amount), 100, "the original amount must be preserved — a resent confirmation must never overwrite it");
});

check("saveIvrPaymentOnce: שני callId שונים -> שתי רשומות נפרדות (לא נחסם באופן שגוי)", function () {
  const r1 = saveIvrPaymentOnce({ callId: "CALL-DEDUP-004A", phone: "0504444444", amount: 50, donorId: null });
  const r2 = saveIvrPaymentOnce({ callId: "CALL-DEDUP-004B", phone: "0504444444", amount: 50, donorId: null });

  assert.strictEqual(r1.duplicate, false);
  assert.strictEqual(r2.duplicate, false);
  assert.ok(db.findPaymentByCallId("CALL-DEDUP-004A"));
  assert.ok(db.findPaymentByCallId("CALL-DEDUP-004B"));
});

check("saveIvrPaymentOnce: שדות מזהה משלם (payer) שונים מהמוטב (donorId) נשמרים כראוי", function () {
  db.upsertDonor("0505555555", "המוטב (בעל החוב)");
  db.upsertDonor("0505550000", "המשלם בפועל");
  const beneficiary = db.findDonorByPhone("0505555555");
  const payer       = db.findDonorByPhone("0505550000");

  const callId = "CALL-DEDUP-005";
  saveIvrPaymentOnce({
    callId: callId,
    phone: "0505555555",
    amount: 300,
    donorId: beneficiary.id,
    payerDonorId: payer.id,
    payerPhone: "0505550000",
    identificationMethod: "manual",
    isSelfPayment: false,
    confirmationNumber: "CONF-123",
  });

  const payment = db.findPaymentByCallId(callId);
  assert.strictEqual(payment.donorId, beneficiary.id);

  // findPaymentByCallId's SELECT list doesn't include confirmationNumber —
  // verify it through getPayments(), which does.
  const full = db.getPayments({ limit: 2000 }).find(function (p) { return p.callId === callId; });
  assert.strictEqual(full.confirmationNumber, "CONF-123");
});

// ── סיכום ─────────────────────────────────────────────────────────────────────
const failed = results.filter(function (r) { return !r.ok; });
results.forEach(function (r) {
  console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : " — " + r.error));
});
console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");
process.exit(failed.length ? 1 : 0);

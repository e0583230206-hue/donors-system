// payments-donor-link.test.js — regression test for the "donor.html?id=...
// -> לא נמצא תורם" bug on the IVR payments screen.
//
// Root cause: getPayments()/getPaymentById() in db.js returned p.donorId,
// which is the SQL `donors` table's own row id (a phone-keyed identity table
// used for IVR matching) — NOT the same id space as app_state.donors[].id,
// which is what donor.html?id= actually looks up. The two ids are unrelated
// numbers that essentially never coincide, so the "view donor" link almost
// always 404'd into "לא נמצא תורם" even for a payment that really is tied to
// a real donor card.
//
// Fix: db.js now resolves each payment's phone against app_state.donors[]
// (the same phone/phone2/phone3/phone4/phones[]/ivrApprovedPhones[] fields
// used elsewhere in this file, e.g. updateDonorDebtAfterPayment) and attaches
// the result as row.appDonorId — null when the phone matches no donor, or
// matches more than one (ambiguous, must not guess). payments.js then links
// using appDonorId exclusively, never the SQL donorId.
//
// Uses a TEMPORARY sqlite file (own os.tmpdir() path, set via DB_PATH before
// requiring db.js) — same pattern as payment.service.test.js. Never opens
// the real data.sqlite. No production data is read or written by this file.
//
// הרצה: node payments-donor-link.test.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "payments-donor-link-test-"));
process.env.DB_PATH = path.join(tmpRoot, "test.sqlite");

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

check("[בטיחות] הבדיקה פועלת מול DB זמני, לא מול data.sqlite האמיתי", function () {
  assert.ok(db.DB_PATH.indexOf(tmpRoot) === 0, "DB_PATH חייב להיות תחת תיקיית ה-tmp, לא הנתיב האמיתי");
});

// ── Seed app_state donors (the CRM's own id space — what donor.html?id= reads) ──
const APP_DONOR_A = { id: 555001, fullName: "אברהם כהן", phone: "0501112222", phone2: "", phone3: "", phone4: "", donations: [] };
const APP_DONOR_B = { id: 555002, fullName: "בנימין לוי", phone: "", phone2: "0502223333", phone3: "", phone4: "", donations: [] };
// C and D deliberately share the SAME phone — the "shared/ambiguous phone" case.
const APP_DONOR_C = { id: 555003, fullName: "גד ישראלי",  phone: "0503334444", phone2: "", phone3: "", phone4: "", donations: [] };
const APP_DONOR_D = { id: 555004, fullName: "דוד מזרחי",  phone: "0503334444", phone2: "", phone3: "", phone4: "", donations: [] };
// legacy-shaped record with id stored as a STRING — donor.html compares with
// strict === against Number(params.get("id")), so this must still resolve
// to a real number, never "555005" (rule 9).
const APP_DONOR_STR_ID = { id: "555005", fullName: "הדס שלום", phone: "0505556666", phone2: "", phone3: "", phone4: "", donations: [] };
db.setAppState("donors", [APP_DONOR_A, APP_DONOR_B, APP_DONOR_C, APP_DONOR_D, APP_DONOR_STR_ID]);

// ── Seed the SQL identity table (used only for donorName / the old donorId column) ──
db.upsertDonor("0501112222", "אברהם כהן (זהות טלפונית)");
const sqlDonorA = db.findDonorByPhone("0501112222");
db.upsertDonor("0509990000", "איש לא-קשור בזהות הטלפונית"); // phone with NO app_state match at all
const sqlDonorUnrelated = db.findDonorByPhone("0509990000");

// ── Real payments, inserted exactly like a live IVR call would ──────────────

// 1) Straightforward case: payment's phone matches exactly one app donor (A) directly.
db.savePaymentInTransaction({ callId: "CALL-LINKED-A", phone: "0501112222", amount: 100, donorId: sqlDonorA.id });

// 2) Phone matches an app donor only through phone2 (B) — and the SQL identity table
//    has NO row for this phone at all (donorId: null). Proves resolution is driven
//    purely by phone against app_state, independent of the SQL donorId column.
db.savePaymentInTransaction({ callId: "CALL-LINKED-B-VIA-PHONE2", phone: "0502223333", amount: 50, donorId: null });

// 3) Old payment, phone matches nobody anywhere — must resolve to "not linked", not a guess.
db.savePaymentInTransaction({ callId: "CALL-UNLINKED", phone: "0508887777", amount: 75, donorId: null });

// 4) Phone shared by two different app donors (C, D) — ambiguous, must not guess either one.
db.savePaymentInTransaction({ callId: "CALL-AMBIGUOUS", phone: "0503334444", amount: 200, donorId: null });

// 5) "Payment recorded for someone else": donor A is the actual beneficiary (phone A,
//    donorId=sqlDonorA), but payerDonorId points at a completely different SQL identity
//    (the "unrelated" one seeded above) — simulates a self-payment made on behalf of
//    donor A by someone else. The link must still follow the BENEFICIARY (A), never the payer.
db.savePaymentInTransaction({
  callId: "CALL-PAID-BY-SOMEONE-ELSE", phone: "0501112222", amount: 300,
  donorId: sqlDonorA.id, payerDonorId: sqlDonorUnrelated.id, payerPhone: "0509990000",
  identificationMethod: "id_number", isSelfPayment: 0,
});

// 6) donor id stored as a string in app_state — must still resolve to a real number.
db.savePaymentInTransaction({ callId: "CALL-STRING-ID-DONOR", phone: "0505556666", amount: 40, donorId: null });

const allPayments = db.getPayments({ limit: 100 });
function byCallId(cid) { return allPayments.find(function (p) { return p.callId === cid; }); }

check("getPayments: straightforward phone match -> appDonorId is the REAL app_state id (not the SQL donors.id)", function () {
  const p = byCallId("CALL-LINKED-A");
  assert.ok(p, "payment row missing");
  assert.strictEqual(p.appDonorId, 555001);
  assert.notStrictEqual(p.appDonorId, p.donorId, "appDonorId must differ from the SQL identity-table donorId — that mismatch was exactly the bug");
});

check("getPayments: match via phone2 only, with no SQL donorId at all -> still resolves correctly", function () {
  const p = byCallId("CALL-LINKED-B-VIA-PHONE2");
  assert.ok(p, "payment row missing");
  assert.strictEqual(p.donorId, null, "this payment intentionally has no SQL donorId");
  assert.strictEqual(p.appDonorId, 555002, "resolution must work via phone2, independent of the SQL donorId column");
});

check("getPayments: phone matches no donor anywhere -> appDonorId null (rule: no broken link, show 'not linked')", function () {
  const p = byCallId("CALL-UNLINKED");
  assert.ok(p, "payment row missing");
  assert.strictEqual(p.appDonorId, null);
});

check("getPayments: phone shared by 2 different app donors -> appDonorId null, never guesses one", function () {
  const p = byCallId("CALL-AMBIGUOUS");
  assert.ok(p, "payment row missing");
  assert.strictEqual(p.appDonorId, null, "an ambiguous phone must resolve to null, not silently pick donor C or D");
});

check("getPayments: payment made 'for someone else' -> link follows the BENEFICIARY's phone, never payerDonorId/payerPhone", function () {
  const p = byCallId("CALL-PAID-BY-SOMEONE-ELSE");
  assert.ok(p, "payment row missing");
  assert.strictEqual(p.appDonorId, 555001, "must resolve to donor A (the beneficiary), not whoever paid");
});

check("rule 9: donor id stored as a string in app_state resolves to a real number, not the string", function () {
  const p = byCallId("CALL-STRING-ID-DONOR");
  assert.ok(p, "payment row missing");
  assert.strictEqual(p.appDonorId, 555005);
  assert.strictEqual(typeof p.appDonorId, "number", "must be a number so donor.html's strict === Number(id) comparison actually matches");
});

check("getPaymentById: single-row lookup resolves appDonorId the same way as the list endpoint", function () {
  const listRow = byCallId("CALL-LINKED-A");
  const single = db.getPaymentById(listRow.id);
  assert.ok(single, "getPaymentById returned nothing");
  assert.strictEqual(single.appDonorId, 555001);
});

check("getPayments(donorId filter): the SQL donorId filter param still works exactly as before (unrelated to appDonorId)", function () {
  const filtered = db.getPayments({ donorId: sqlDonorA.id, limit: 100 });
  assert.ok(filtered.some(function (p) { return p.callId === "CALL-LINKED-A"; }));
  assert.ok(filtered.every(function (p) { return p.donorId === sqlDonorA.id; }));
});

console.log("\n── תוצאות ──");
let failed = 0;
results.forEach(function (r) {
  console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : "\n    " + r.error));
  if (!r.ok) failed++;
});
console.log("\n" + (results.length - failed) + "/" + results.length + " עברו");
process.exit(failed ? 1 : 0);

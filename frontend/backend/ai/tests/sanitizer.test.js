// ai/tests/sanitizer.test.js — Privacy: OpenAI sanitizer allow-list.
// Proves excluded fields (phone, notes, address, idNumber, internalStaffNote,
// raw per-donor arrays in the global context, etc.) can never reach the
// object that gets serialized into the OpenAI prompt — by allow-list, not
// by remembering to strip each dangerous field one at a time.
//
// הרצה: node frontend/backend/ai/tests/sanitizer.test.js

const assert = require("assert");
const {
  sanitizeContextForOpenAI,
  DONOR_ALLOWED_FIELDS,
  GLOBAL_SUMMARY_ALLOWED_FIELDS,
} = require("../engines/sanitizer");

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, error: err.stack || err.message });
  }
}

const FORBIDDEN_DONOR_FIELDS = [
  "phone", "phone2", "phone3", "phone4", "ivrApprovedPhones",
  "notes", "internalNotes", "internalStaffNote", "publicNotes", "publicPhoneNote",
  "idNumber", "address", "fatherName", "externalId", "alfonSerial", "donations",
];

check("donor context: only allow-listed fields survive", () => {
  const raw = {
    type: "donor",
    donor: {
      id: 42, fullName: "פלוני אלמוני", city: "בני ברק", tags: ["VIP"], status: "פעיל",
      phone: "0501111111", phone2: "0502222222", phone3: "", phone4: "",
      ivrApprovedPhones: ["0501111111"],
      notes: "הערה פרטית שאסור לשלוח", internalNotes: "עוד הערה",
      internalStaffNote: "הערת צוות פנימית", publicNotes: "משהו",
      publicPhoneNote: "אל תתקשר בשבת", idNumber: "123456789",
      address: "רחוב הדוגמה 5", fatherName: "אבא", externalId: "ext-1", alfonSerial: "A1",
      donations: [{ amount: 500, purpose: "פרנס" }],
    },
    stats: { totalDonations: 5, totalPaid: 2500, totalDebt: 300, openDebtsCount: 1,
      avgAmount: 500, maxAmount: 800, lastDonationFmt: "01/01/2026", daysSinceLastDonation: 10, paidCount: 4 },
    fmtMoney: (n) => "₪" + n,
    fmtDate:  (d) => String(d),
  };

  const clean = sanitizeContextForOpenAI(raw);
  const serialized = JSON.stringify(clean);

  FORBIDDEN_DONOR_FIELDS.forEach((f) => {
    assert.ok(!(f in clean.donor), "שדה אסור עדיין קיים באובייקט: " + f);
  });
  assert.ok(serialized.indexOf("0501111111") === -1, "מספר טלפון דלף ל-JSON המסונן");
  assert.ok(serialized.indexOf("הערה פרטית") === -1, "הערה פרטית דלפה ל-JSON המסונן");
  assert.ok(serialized.indexOf("123456789") === -1, "תעודת זהות דלפה ל-JSON המסונן");
  assert.ok(serialized.indexOf("רחוב הדוגמה") === -1, "כתובת דלפה ל-JSON המסונן");

  DONOR_ALLOWED_FIELDS.forEach((f) => {
    assert.ok(f in clean.donor, "שדה מותר חסר מהאובייקט המסונן: " + f);
  });
  assert.strictEqual(clean.donor.fullName, "פלוני אלמוני");
  assert.strictEqual(clean.stats.totalPaid, 2500);
});

check("donor context: original object is never mutated", () => {
  const raw = { type: "donor", donor: { fullName: "א", phone: "0501111111" }, stats: {} };
  const before = JSON.stringify(raw);
  sanitizeContextForOpenAI(raw);
  assert.strictEqual(JSON.stringify(raw), before, "sanitizeContextForOpenAI מוטט על האובייקט המקורי");
  assert.ok("phone" in raw.donor, "הטלפון עדיין אמור להיות בעותק המקורי (לא סוננן שם)");
});

check("global context: per-donor raw arrays never reach the sanitized object", () => {
  const raw = {
    type: "global",
    allDonors: [{ id: 1, fullName: "תורם", phone: "0509999999", notes: "סוד" }],
    statsPerDonor: [{ donor: { phone: "0508888888" }, stats: {} }],
    tasks: [{ title: "משימה", description: "תיאור פרטי" }],
    reminders: [{ text: "תזכורת פרטית" }],
    summary: {
      totalDonors: 100, activeDonors: 90, withDebt: 20, totalDebt: 5000, totalPaid: 20000,
      dormant90: 5, dormant180: 3, dormant365: 1, neverGiven: 2,
      openTasksCount: 4, urgentCount: 1, campaignReady: 80, noPhone: 2,
    },
    fmtMoney: (n) => "₪" + n,
    fmtDate:  (d) => String(d),
  };

  const clean = sanitizeContextForOpenAI(raw);
  const serialized = JSON.stringify(clean);

  assert.strictEqual(clean.allDonors, undefined, "allDonors (רשומות מלאות עם PII) עדיין קיים באובייקט המסונן");
  assert.strictEqual(clean.statsPerDonor, undefined);
  assert.strictEqual(clean.tasks, undefined);
  assert.strictEqual(clean.reminders, undefined);
  assert.ok(serialized.indexOf("0509999999") === -1);
  assert.ok(serialized.indexOf("סוד") === -1);
  assert.ok(serialized.indexOf("תיאור פרטי") === -1);

  GLOBAL_SUMMARY_ALLOWED_FIELDS.forEach((f) => {
    assert.ok(f in clean.summary, "שדה סיכום מותר חסר: " + f);
  });
  assert.strictEqual(clean.summary.totalDonors, 100);
});

check("unknown/future context type: fails closed (only type marker forwarded)", () => {
  const raw = { type: "some_future_type", secretField: "should never leave the server" };
  const clean = sanitizeContextForOpenAI(raw);
  assert.strictEqual(JSON.stringify(clean), JSON.stringify({ type: "some_future_type" }));
});

check("null/undefined context: passthrough, no throw", () => {
  assert.strictEqual(sanitizeContextForOpenAI(null), null);
  assert.strictEqual(sanitizeContextForOpenAI(undefined), undefined);
});

// ── סיכום ────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
results.forEach((r) => {
  console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : "\n    " + r.error));
});
console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");
process.exitCode = failed.length ? 1 : 0;

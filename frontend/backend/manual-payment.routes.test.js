// manual-payment.routes.test.js — REAL HTTP-level tests of the atomic
// "mark donation as paid manually" / "cancel that manual payment" flow:
//   POST /api/donors/:donorId/donations/:donationId/mark-paid
//   POST /api/donors/:donorId/donations/:donationId/cancel-manual-payment
// (server.js -> db.js markDonationPaidManually/cancelManualDonationPayment).
//
// These replace the earlier single-request /api/donors/:id/manual-payment,
// which created a payments row and then relied on the client to separately
// (and non-atomically) push the donation update via fire-and-forget
// Database.save — see donor.js saveDonationEdit(). This file exists to prove,
// over real HTTP against the real server + a temporary sqlite file, that:
//   - the payments-table write and the donation's paidPartial/remainingDebt/
//     paid update happen as one all-or-nothing transaction (rollback test),
//   - a repeated request with the same idempotencyKey never double-charges,
//   - two concurrent requests for the same donation never double-charge,
//   - cancelling restores the donation to its exact pre-payment state
//     (including the partial-donation-completed-then-reversed case),
//   - a cancelled payment is never deleted, and never counted in
//     getPaymentStats() totals, and
//   - only the specific manual payment this donation's own mark-paid call
//     created can ever be reversed — never an IVR payment, never a payment
//     belonging to a different donation.
//
// Same harness pattern as server.routes.test.js: real Express app + a
// temporary sqlite file, real login flow, no mocks.
//
// הרצה: node frontend/backend/manual-payment.routes.test.js

const assert = require("assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "manual-payment-test-"));
process.env.DB_PATH = path.join(tmpRoot, "test.sqlite");
delete process.env.NODE_ENV;

const app = require("./server");
const db = require("./db");

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name: name, ok: true });
  } catch (err) {
    results.push({ name: name, ok: false, error: err.stack || err.message });
  }
}

let server, baseUrl;

async function jsonFetch(method, urlPath, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(baseUrl + urlPath, {
    method: method,
    headers: headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, headers: res.headers, body: data };
}

function uniqueKey(label) {
  return label + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
}

// Seeds one donor (with one donation) into app_state via the existing,
// already-tested /api/data/donors endpoint — the same write path the real
// app uses — rather than poking the sqlite file directly. POST /api/data/donors
// replaces the whole array, so this reads the current one first and merges,
// the same way a real client (which always holds the full array in memory)
// would — otherwise each seedDonor call would silently wipe every donor
// seeded before it.
async function seedDonor(token, donorId, donation) {
  const current = await jsonFetch("GET", "/api/data/donors", undefined, token);
  const existing = Array.isArray(current.body) ? current.body : [];
  const others = existing.filter(function (d) { return d.id !== donorId; });
  const merged = others.concat([{
    id: donorId,
    fullName: "תורם בדיקה " + donorId,
    phone: "05" + String(donorId).padStart(8, "0"),
    donations: [donation],
  }]);
  const res = await jsonFetch("POST", "/api/data/donors", merged, token);
  assert.strictEqual(res.status, 200, "seedDonor failed: " + JSON.stringify(res.body));
}

async function getDonor(token, donorId) {
  const res = await jsonFetch("GET", "/api/data/donors", undefined, token);
  return res.body.find(function (d) { return d.id === donorId; });
}

async function main() {
  server = http.createServer(app);
  await new Promise(function (resolve) { server.listen(0, "127.0.0.1", resolve); });
  baseUrl = "http://127.0.0.1:" + server.address().port;

  await check("[בטיחות] הבדיקה פועלת מול DB זמני, לא מול data.sqlite האמיתי", async function () {
    assert.ok(db.DB_PATH.indexOf(tmpRoot) === 0);
  });

  let adminToken;
  await check("התחברות מנהל + שינוי סיסמה חובה", async function () {
    const login = await jsonFetch("POST", "/api/login", { workerId: 1, password: "1234" });
    adminToken = login.body.token;
    await jsonFetch("PUT", "/api/workers/me/password", { newPassword: "AdminPass1!" }, adminToken);
    const relogin = await jsonFetch("POST", "/api/login", { workerId: 1, password: "AdminPass1!" });
    adminToken = relogin.body.token;
    assert.ok(adminToken);
  });

  let secretaryToken;
  await check("יצירת מזכיר + התחברות", async function () {
    const created = await jsonFetch("POST", "/api/workers", { name: "מזכיר בדיקה", role: "מזכיר", password: "SecretPass1!" }, adminToken);
    const secretaryId = created.body.id;
    const login = await jsonFetch("POST", "/api/login", { workerId: secretaryId, password: "SecretPass1!" });
    await jsonFetch("PUT", "/api/workers/me/password", { newPassword: "SecretPass2!" }, login.body.token);
    const relogin = await jsonFetch("POST", "/api/login", { workerId: secretaryId, password: "SecretPass2!" });
    secretaryToken = relogin.body.token;
    assert.ok(secretaryToken);
  });

  // ── הרשאות ──────────────────────────────────────────────────────────────

  await check("mark-paid בלי Authorization -> 401", async function () {
    const res = await jsonFetch("POST", "/api/donors/1/donations/1/mark-paid", { amount: 100, idempotencyKey: uniqueKey("a") });
    assert.strictEqual(res.status, 401);
  });

  // ── ולידציה ─────────────────────────────────────────────────────────────

  await check("mark-paid בלי idempotencyKey -> 400", async function () {
    await seedDonor(adminToken, 601, { id: 1, amount: 500, paidPartial: 0, remainingDebt: 500, paid: false });
    const res = await jsonFetch("POST", "/api/donors/601/donations/1/mark-paid", { amount: 500 }, adminToken);
    assert.strictEqual(res.status, 400);
  });

  await check("mark-paid עם סכום 0/שלילי/לא מספרי -> 400", async function () {
    const bad = [0, -50, "abc", 999999999];
    for (const amount of bad) {
      const res = await jsonFetch("POST", "/api/donors/601/donations/1/mark-paid", { amount: amount, idempotencyKey: uniqueKey("bad") }, adminToken);
      assert.strictEqual(res.status, 400, "amount=" + amount + " should be rejected");
    }
  });

  await check("mark-paid עבור תורם/תרומה שלא קיימים -> 404", async function () {
    const res1 = await jsonFetch("POST", "/api/donors/999999/donations/1/mark-paid", { amount: 100, idempotencyKey: uniqueKey("x") }, adminToken);
    assert.strictEqual(res1.status, 404);
    const res2 = await jsonFetch("POST", "/api/donors/601/donations/999999/mark-paid", { amount: 100, idempotencyKey: uniqueKey("y") }, adminToken);
    assert.strictEqual(res2.status, 404);
  });

  // ── תרומה שלא שולמה -> תשלום מלא (מזומן) ─────────────────────────────────

  await check("[תרחיש] תרומה שלא שולמה -> mark-paid יוצר תשלום מלא ומעדכן את התרומה אטומית", async function () {
    const paymentsBefore = db.getPayments({ limit: 1000 }).length;
    const res = await jsonFetch(
      "POST", "/api/donors/601/donations/1/mark-paid",
      { amount: 500, phone: "0501112222", donorName: "תורם בדיקה 601", paymentMethod: "מזומן", idempotencyKey: uniqueKey("pay601") },
      adminToken,
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.donation.paidPartial, 500);
    assert.strictEqual(res.body.donation.remainingDebt, 0);
    assert.strictEqual(res.body.donation.paid, true);
    assert.strictEqual(res.body.donation.paymentMethod, "מזומן");
    assert.strictEqual(res.body.payment.amount, 500);
    assert.strictEqual(res.body.payment.source, "manual");
    assert.strictEqual(res.body.payment.status, "success");

    assert.strictEqual(db.getPayments({ limit: 1000 }).length, paymentsBefore + 1, "רשומת תשלום אחת בדיוק");

    const donor = await getDonor(adminToken, 601);
    const donation = donor.donations.find(function (d) { return d.id === 1; });
    assert.strictEqual(donation.paidPartial, 500, "app_state עודכן אטומית יחד עם התשלום");
    assert.strictEqual(donation.lastPaymentId, res.body.payment.id);
  });

  // ── תרומה ששולמה חלקית -> השלמת יתרה בלבד ────────────────────────────────

  await check("[תרחיש] תרומה ששולמה חלקית -> mark-paid גובה רק את היתרה שנותרה, לא את הסכום המלא", async function () {
    await seedDonor(adminToken, 602, { id: 1, amount: 1000, paidPartial: 400, remainingDebt: 600, paid: false });
    const res = await jsonFetch(
      "POST", "/api/donors/602/donations/1/mark-paid",
      { amount: 1000, phone: "0502223333", donorName: "תורם בדיקה 602", paymentMethod: "מזומן", idempotencyKey: uniqueKey("pay602") },
      adminToken,
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.payment.amount, 600, "רק היתרה — לא 1000 ולא 400 שכבר שולמו קודם");
    assert.strictEqual(res.body.donation.paidPartial, 1000);
    assert.strictEqual(res.body.donation.remainingDebt, 0);
  });

  // ── ניסיון כפול עם אותו idempotency key ───────────────────────────────────

  await check("[ניסיון חוזר] אותו idempotencyKey פעמיים -> לא נוצר תשלום כפול, מוחזרת אותה תוצאה", async function () {
    await seedDonor(adminToken, 603, { id: 1, amount: 300, paidPartial: 0, remainingDebt: 300, paid: false });
    const key = uniqueKey("retry603");
    const paymentsBefore = db.getPayments({ limit: 1000 }).length;

    const first = await jsonFetch("POST", "/api/donors/603/donations/1/mark-paid", { amount: 300, phone: "0503334444", donorName: "תורם 603", idempotencyKey: key }, adminToken);
    assert.strictEqual(first.status, 200);
    assert.strictEqual(first.body.idempotent, false);

    const second = await jsonFetch("POST", "/api/donors/603/donations/1/mark-paid", { amount: 300, phone: "0503334444", donorName: "תורם 603", idempotencyKey: key }, adminToken);
    assert.strictEqual(second.status, 200);
    assert.strictEqual(second.body.idempotent, true, "בקשה שנייה עם אותו מפתח מזוהה כניסיון חוזר");
    assert.strictEqual(second.body.payment.id, first.body.payment.id, "אותה רשומת תשלום בדיוק, לא חדשה");

    assert.strictEqual(db.getPayments({ limit: 1000 }).length, paymentsBefore + 1, "רשומת תשלום אחת בדיוק, לא שתיים");

    const donor = await getDonor(adminToken, 603);
    const donation = donor.donations.find(function (d) { return d.id === 1; });
    assert.strictEqual(donation.paidPartial, 300, "התרומה לא עודכנה פעמיים (לא הפכה ל-600)");
  });

  // ── rollback: כשל בין יצירת התשלום לעדכון התרומה ──────────────────────────

  await check("[Rollback] כשל שנכפה בין יצירת התשלום לעדכון התרומה -> אין רשומת תשלום, אין שינוי בתרומה", async function () {
    await seedDonor(adminToken, 604, { id: 1, amount: 700, paidPartial: 0, remainingDebt: 700, paid: false });
    const paymentsBefore = db.getPayments({ limit: 1000 }).length;

    process.env.TEST_FORCE_MANUAL_PAYMENT_FAILURE = "1";
    let res;
    try {
      res = await jsonFetch("POST", "/api/donors/604/donations/1/mark-paid", { amount: 700, phone: "0504445555", donorName: "תורם 604", idempotencyKey: uniqueKey("rollback604") }, adminToken);
    } finally {
      delete process.env.TEST_FORCE_MANUAL_PAYMENT_FAILURE;
    }

    assert.strictEqual(res.status, 500, "הכשל שנכפה חייב להישבר החוצה כשגיאת שרת, לא להיבלע");
    assert.strictEqual(db.getPayments({ limit: 1000 }).length, paymentsBefore, "אסור שתיווצר רשומת תשלום כשה-rollback קרה");

    const donor = await getDonor(adminToken, 604);
    const donation = donor.donations.find(function (d) { return d.id === 1; });
    assert.strictEqual(donation.paidPartial, 0, "התרומה חייבת להישאר בדיוק כפי שהייתה — לא 'חצי מעודכנת'");
    assert.strictEqual(donation.remainingDebt, 700);
    assert.strictEqual(donation.paid, false);
  });

  // ── שני משתמשים במקביל על אותה תרומה ──────────────────────────────────────

  await check("[מקביליות] שתי בקשות מקבילות (idempotencyKey שונה) על אותה תרומה -> רק אחת מצליחה, נוצרת רשומת תשלום אחת בלבד", async function () {
    await seedDonor(adminToken, 605, { id: 1, amount: 800, paidPartial: 0, remainingDebt: 800, paid: false });
    const paymentsBefore = db.getPayments({ limit: 1000 }).length;

    const [resA, resB] = await Promise.all([
      jsonFetch("POST", "/api/donors/605/donations/1/mark-paid", { amount: 800, phone: "0505556666", donorName: "תורם 605", idempotencyKey: uniqueKey("raceA") }, adminToken),
      jsonFetch("POST", "/api/donors/605/donations/1/mark-paid", { amount: 800, phone: "0505556666", donorName: "תורם 605", idempotencyKey: uniqueKey("raceB") }, secretaryToken),
    ]);

    const statuses = [resA.status, resB.status].sort();
    assert.deepStrictEqual(statuses, [200, 409], "בדיוק בקשה אחת מצליחה, השנייה נדחית — לא שתיים מצליחות");

    assert.strictEqual(db.getPayments({ limit: 1000 }).length, paymentsBefore + 1, "רשומת תשלום אחת בדיוק, לא כפולה, גם בתרחיש מקביל");

    const donor = await getDonor(adminToken, 605);
    const donation = donor.donations.find(function (d) { return d.id === 1; });
    assert.strictEqual(donation.paidPartial, 800, "לא הוכפל ל-1600");
    assert.strictEqual(donation.remainingDebt, 0);
  });

  // ── ביטול תשלום ────────────────────────────────────────────────────────

  await check("[ביטול] אין תשלום מקושר לביטול -> 400", async function () {
    await seedDonor(adminToken, 606, { id: 1, amount: 100, paidPartial: 0, remainingDebt: 100, paid: false });
    const res = await jsonFetch("POST", "/api/donors/606/donations/1/cancel-manual-payment", {}, adminToken);
    assert.strictEqual(res.status, 400);
  });

  await check("[ביטול] תרומה שלא שולמה כלל ואז שולמה במלואה -> ביטול מחזיר אותה בדיוק למצב הקודם (לא שולם), התשלום נשאר בהיסטוריה עם status=cancelled", async function () {
    await seedDonor(adminToken, 607, { id: 1, amount: 250, paidPartial: 0, remainingDebt: 250, paid: false });
    const markRes = await jsonFetch("POST", "/api/donors/607/donations/1/mark-paid", { amount: 250, phone: "0507778888", donorName: "תורם 607", idempotencyKey: uniqueKey("cancel607") }, adminToken);
    assert.strictEqual(markRes.status, 200);
    const paymentId = markRes.body.payment.id;

    const cancelRes = await jsonFetch("POST", "/api/donors/607/donations/1/cancel-manual-payment", {}, adminToken);
    assert.strictEqual(cancelRes.status, 200);
    assert.strictEqual(cancelRes.body.donation.paidPartial, 0);
    assert.strictEqual(cancelRes.body.donation.remainingDebt, 250);
    assert.strictEqual(cancelRes.body.donation.paid, false);
    assert.strictEqual(cancelRes.body.donation.lastPaymentId, null);

    const cancelledPayment = db.getPaymentById(paymentId);
    assert.strictEqual(cancelledPayment.status, "cancelled");
    assert.ok(cancelledPayment.cancelledAt, "לא נמחקה — רק סומנה כמבוטלת, עם חותמת זמן");

    const donor = await getDonor(adminToken, 607);
    const donation = donor.donations.find(function (d) { return d.id === 1; });
    assert.strictEqual(donation.paidPartial, 0, "app_state תואם למה שהשרת החזיר");
  });

  await check("[ביטול] תרומה ששולמה חלקית והושלמה ידנית -> ביטול מבטל רק את יתרת ההשלמה ומחזיר למצב החלקי המקורי", async function () {
    await seedDonor(adminToken, 608, { id: 1, amount: 1000, paidPartial: 400, remainingDebt: 600, paid: false });
    const markRes = await jsonFetch("POST", "/api/donors/608/donations/1/mark-paid", { amount: 1000, phone: "0508889999", donorName: "תורם 608", idempotencyKey: uniqueKey("cancel608") }, adminToken);
    assert.strictEqual(markRes.status, 200);
    assert.strictEqual(markRes.body.payment.amount, 600, "רק היתרה חויבה");

    const cancelRes = await jsonFetch("POST", "/api/donors/608/donations/1/cancel-manual-payment", {}, adminToken);
    assert.strictEqual(cancelRes.status, 200);
    assert.strictEqual(cancelRes.body.donation.paidPartial, 400, "חוזר בדיוק ל-400 שהיו משולמים קודם — לא ל-0");
    assert.strictEqual(cancelRes.body.donation.remainingDebt, 600);
    assert.strictEqual(cancelRes.body.donation.paid, false);
  });

  await check("[ביטול] ביטול פעמיים על אותו תשלום -> הפעם השנייה נדחית (409), לא נעשה כלום פעמיים", async function () {
    await seedDonor(adminToken, 609, { id: 1, amount: 150, paidPartial: 0, remainingDebt: 150, paid: false });
    await jsonFetch("POST", "/api/donors/609/donations/1/mark-paid", { amount: 150, phone: "0509990000", donorName: "תורם 609", idempotencyKey: uniqueKey("dbl609") }, adminToken);

    const first = await jsonFetch("POST", "/api/donors/609/donations/1/cancel-manual-payment", {}, adminToken);
    assert.strictEqual(first.status, 200);

    const second = await jsonFetch("POST", "/api/donors/609/donations/1/cancel-manual-payment", {}, adminToken);
    assert.strictEqual(second.status, 400, "אין כבר lastPaymentId מקושר — לא ניתן לבטל שוב");
  });

  await check("[הגנה] לא ניתן לבטל תשלום IVR (source != manual) גם אם lastPaymentId מצביע עליו", async function () {
    await seedDonor(adminToken, 610, { id: 1, amount: 400, paidPartial: 400, remainingDebt: 0, paid: true });

    // Simulate an IVR payment that happens to be linked via lastPaymentId —
    // this must never be reachable in practice (only mark-paid sets
    // lastPaymentId, and it always creates a source:"manual" row), but the
    // server must defend the invariant explicitly, not just by convention.
    const ivrResult = db.recordPayment({ callId: uniqueKey("ivr-guard"), phone: "0500001111", donorId: null, amount: 400, status: "success", source: "ivr", confirmationNumber: "CONF-1" });
    const ivrPaymentId = ivrResult.lastInsertRowid;
    const donors = db.getAppState("donors");
    const donor610 = donors.find(function (d) { return d.id === 610; });
    donor610.donations[0].lastPaymentId = ivrPaymentId;
    db.setAppState("donors", donors);

    const res = await jsonFetch("POST", "/api/donors/610/donations/1/cancel-manual-payment", {}, adminToken);
    assert.strictEqual(res.status, 400);

    const ivrPaymentAfter = db.getPaymentById(ivrPaymentId);
    assert.strictEqual(ivrPaymentAfter.status, "success", "תשלום IVR לא נגע בו כלל");
  });

  await check("[הגנה] ביטול על תרומה אחת לא משפיע על תרומה/תשלום של תורם אחר", async function () {
    await seedDonor(adminToken, 611, { id: 1, amount: 200, paidPartial: 0, remainingDebt: 200, paid: false });
    await seedDonor(adminToken, 612, { id: 1, amount: 300, paidPartial: 0, remainingDebt: 300, paid: false });

    const mark611 = await jsonFetch("POST", "/api/donors/611/donations/1/mark-paid", { amount: 200, phone: "0501110000", donorName: "תורם 611", idempotencyKey: uniqueKey("iso611") }, adminToken);
    assert.strictEqual(mark611.status, 200);
    const mark612 = await jsonFetch("POST", "/api/donors/612/donations/1/mark-paid", { amount: 300, phone: "0502220000", donorName: "תורם 612", idempotencyKey: uniqueKey("iso612") }, adminToken);
    assert.strictEqual(mark612.status, 200);

    const cancel611 = await jsonFetch("POST", "/api/donors/611/donations/1/cancel-manual-payment", {}, adminToken);
    assert.strictEqual(cancel611.status, 200);

    const donor612 = await getDonor(adminToken, 612);
    const donation612 = donor612.donations.find(function (d) { return d.id === 1; });
    assert.strictEqual(donation612.paidPartial, 300, "תורם 612 לא הושפע מביטול אצל תורם 611");
    assert.strictEqual(donation612.paid, true);

    const donor611 = await getDonor(adminToken, 611);
    const donation611 = donor611.donations.find(function (d) { return d.id === 1; });
    assert.strictEqual(donation611.paidPartial, 0, "תורם 611 עצמו כן בוטל כמצופה");
  });

  // ── עקביות: getPaymentStats לא סופר תשלום מבוטל ──────────────────────────

  await check("[עקביות] getPaymentStats לא כוללת תשלום שבוטל בסכום ששולם", async function () {
    await seedDonor(adminToken, 613, { id: 1, amount: 90, paidPartial: 0, remainingDebt: 90, paid: false });
    const statsBefore = db.getPaymentStats().today.total;

    await jsonFetch("POST", "/api/donors/613/donations/1/mark-paid", { amount: 90, phone: "0503330000", donorName: "תורם 613", idempotencyKey: uniqueKey("stats613") }, adminToken);
    const statsAfterPay = db.getPaymentStats().today.total;
    assert.strictEqual(statsAfterPay, statsBefore + 90, "התשלום נספר בזמן שהוא פעיל");

    await jsonFetch("POST", "/api/donors/613/donations/1/cancel-manual-payment", {}, adminToken);
    const statsAfterCancel = db.getPaymentStats().today.total;
    assert.strictEqual(statsAfterCancel, statsBefore, "אחרי ביטול — כאילו לא היה, לא נשאר בסכום ששולם");
  });

  // ── סיכום ────────────────────────────────────────────────────────────────
  const failed = results.filter(function (r) { return !r.ok; });
  results.forEach(function (r) {
    console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : "\n    " + r.error));
  });
  console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");

  await new Promise(function (resolve) { server.close(resolve); });
  process.exitCode = failed.length ? 1 : 0;
}

main();

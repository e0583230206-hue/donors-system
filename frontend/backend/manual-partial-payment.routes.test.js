// manual-partial-payment.routes.test.js — REAL HTTP-level tests of the
// atomic "genuine partial payment" flow:
//   POST /api/donors/:donorId/donations/:donationId/partial-payment
// (server.js -> db.js recordManualPartialPayment).
//
// This exists because the donor-card "add donation already paid" and
// "register a partial payment across several open debts" actions used to
// mutate paid/paidPartial/remainingDebt directly on the client and rely on
// the generic fire-and-forget Database.save("donors", ...) — no payments
// row was ever created, so that money was invisible on the Payments screen
// and could never be reverted through the UI. Both now go through this
// endpoint (or the sibling mark-paid endpoint, for the "fully paid at
// creation" case), one real payments row per affected donation, same
// atomic/idempotent contract as mark-paid.
//
// Same harness pattern as manual-payment.routes.test.js: real Express app +
// a temporary sqlite file, real login flow, no mocks.
//
// הרצה: node frontend/backend/manual-partial-payment.routes.test.js

const assert = require("assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "manual-partial-payment-test-"));
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

  await check("ללא טוקן -> 401, אין חיוב", async function () {
    const res = await jsonFetch("POST", "/api/donors/700/donations/1/partial-payment", { amount: 10, idempotencyKey: uniqueKey("noauth") });
    assert.strictEqual(res.status, 401);
  });

  await check("תשלום חלקי אמיתי: מקטין remainingDebt, יוצר רשומת payments אמיתית, לא מסמן שולם במלואה", async function () {
    await seedDonor(adminToken, 701, { id: 1, amount: 500, paidPartial: 0, remainingDebt: 500, paid: false });
    const statsBefore = db.getPaymentStats().today.total;

    const res = await jsonFetch("POST", "/api/donors/701/donations/1/partial-payment", {
      amount: 150, phone: "0507010000", donorName: "תורם 701", paymentMethod: "מזומן",
      idempotencyKey: uniqueKey("partial701"),
    }, adminToken);

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.donation.paidPartial, 150);
    assert.strictEqual(res.body.donation.remainingDebt, 350);
    assert.strictEqual(res.body.donation.paid, false);
    assert.ok(res.body.payment && res.body.payment.id, "צריך רשומת תשלום אמיתית עם id");
    assert.strictEqual(res.body.payment.source, "manual");

    const statsAfter = db.getPaymentStats().today.total;
    assert.strictEqual(statsAfter, statsBefore + 150, "הסכום החלקי נכנס לסטטיסטיקת תשלומים אמיתית");

    const donor = await getDonor(adminToken, 701);
    const donation = donor.donations.find(function (d) { return d.id === 1; });
    assert.strictEqual(donation.lastPaymentId, res.body.payment.id);
  });

  await check("תשלום חלקי שני על אותה תרומה מצטבר נכון על גבי הראשון", async function () {
    const res2 = await jsonFetch("POST", "/api/donors/701/donations/1/partial-payment", {
      amount: 100, phone: "0507010000", donorName: "תורם 701",
      idempotencyKey: uniqueKey("partial701b"),
    }, adminToken);
    assert.strictEqual(res2.status, 200);
    assert.strictEqual(res2.body.donation.paidPartial, 250);
    assert.strictEqual(res2.body.donation.remainingDebt, 250);
    assert.strictEqual(res2.body.donation.paid, false);
  });

  await check("תשלום חלקי שסוגר בדיוק את היתרה -> paid=true, remainingDebt=0", async function () {
    const res3 = await jsonFetch("POST", "/api/donors/701/donations/1/partial-payment", {
      amount: 250, phone: "0507010000", donorName: "תורם 701",
      idempotencyKey: uniqueKey("partial701c"),
    }, adminToken);
    assert.strictEqual(res3.status, 200);
    assert.strictEqual(res3.body.donation.paidPartial, 500);
    assert.strictEqual(res3.body.donation.remainingDebt, 0);
    assert.strictEqual(res3.body.donation.paid, true);
  });

  await check("סכום גדול מיתרת החוב הנוכחית -> 409, שום דבר לא משתנה", async function () {
    await seedDonor(adminToken, 702, { id: 1, amount: 200, paidPartial: 0, remainingDebt: 200, paid: false });
    const res = await jsonFetch("POST", "/api/donors/702/donations/1/partial-payment", {
      amount: 250, phone: "0507020000", donorName: "תורם 702",
      idempotencyKey: uniqueKey("overpay702"),
    }, adminToken);
    assert.strictEqual(res.status, 409);
    const donor = await getDonor(adminToken, 702);
    assert.strictEqual(donor.donations[0].remainingDebt, 200, "לא נגעו ביתרה אחרי דחייה");
  });

  await check("[אידמפוטנטיות] אותו idempotencyKey פעמיים -> תשלום אחד בלבד, אותה תוצאה", async function () {
    await seedDonor(adminToken, 703, { id: 1, amount: 400, paidPartial: 0, remainingDebt: 400, paid: false });
    const key = uniqueKey("idem703");
    const first = await jsonFetch("POST", "/api/donors/703/donations/1/partial-payment", { amount: 100, phone: "0507030000", donorName: "תורם 703", idempotencyKey: key }, adminToken);
    const second = await jsonFetch("POST", "/api/donors/703/donations/1/partial-payment", { amount: 100, phone: "0507030000", donorName: "תורם 703", idempotencyKey: key }, adminToken);
    assert.strictEqual(first.status, 200);
    assert.strictEqual(second.status, 200);
    assert.strictEqual(second.body.idempotent, true);
    assert.strictEqual(second.body.payment.id, first.body.payment.id);

    const donor = await getDonor(adminToken, 703);
    assert.strictEqual(donor.donations[0].remainingDebt, 300, "רק חיוב אחד בפועל, לא שניים");
  });

  await check("ביטול תשלום חלקי (cancel-manual-payment הקיים) מחזיר בדיוק ליתרה הקודמת, לא לאפס", async function () {
    await seedDonor(adminToken, 704, { id: 1, amount: 300, paidPartial: 50, remainingDebt: 250, paid: false });
    // First bring it via a partial payment tracked by lastPaymentId, then cancel that specific payment.
    const pay = await jsonFetch("POST", "/api/donors/704/donations/1/partial-payment", { amount: 100, phone: "0507040000", donorName: "תורם 704", idempotencyKey: uniqueKey("cancelprep704") }, adminToken);
    assert.strictEqual(pay.status, 200);
    assert.strictEqual(pay.body.donation.paidPartial, 150);
    assert.strictEqual(pay.body.donation.remainingDebt, 150);

    const cancel = await jsonFetch("POST", "/api/donors/704/donations/1/cancel-manual-payment", {}, adminToken);
    assert.strictEqual(cancel.status, 200);
    assert.strictEqual(cancel.body.donation.paidPartial, 50, "חוזר בדיוק לחלקי הקודם, לא ל-0");
    assert.strictEqual(cancel.body.donation.remainingDebt, 250);
    assert.strictEqual(cancel.body.donation.paid, false);
  });

  await check("[יומן ביקורת] ביטול תשלום ידני נרשם כ-action='payment_cancel' (לא 'update' הכללי)", async function () {
    await seedDonor(adminToken, 705, { id: 1, amount: 80, paidPartial: 0, remainingDebt: 80, paid: false });
    await jsonFetch("POST", "/api/donors/705/donations/1/partial-payment", { amount: 80, phone: "0507050000", donorName: "תורם 705", idempotencyKey: uniqueKey("audit705") }, adminToken);
    await jsonFetch("POST", "/api/donors/705/donations/1/cancel-manual-payment", {}, adminToken);

    const logs = db.getAuditLogs(50);
    const cancelLog = logs.find(function (l) { return l.action === "payment_cancel" && String(l.entityId) === "705"; });
    assert.ok(cancelLog, "צריך רשומת יומן ביקורת עם action='payment_cancel' עבור תורם 705");
  });

  await check("[עקביות] getPaymentStats לא כוללת תשלום חלקי שבוטל", async function () {
    await seedDonor(adminToken, 706, { id: 1, amount: 60, paidPartial: 0, remainingDebt: 60, paid: false });
    const statsBefore = db.getPaymentStats().today.total;
    await jsonFetch("POST", "/api/donors/706/donations/1/partial-payment", { amount: 60, phone: "0507060000", donorName: "תורם 706", idempotencyKey: uniqueKey("stats706") }, adminToken);
    await jsonFetch("POST", "/api/donors/706/donations/1/cancel-manual-payment", {}, adminToken);
    const statsAfter = db.getPaymentStats().today.total;
    assert.strictEqual(statsAfter, statsBefore, "אחרי ביטול — כאילו לא היה");
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

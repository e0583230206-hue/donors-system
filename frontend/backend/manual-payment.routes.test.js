// manual-payment.routes.test.js — REAL HTTP-level test of
// POST /api/donors/:id/manual-payment (server.js), added so that marking a
// donation "שולם" manually in donor.html creates a real row in the same
// `payments` table used by the payments screen/reports/receipts/Timeline —
// see donor.js saveDonationEdit(). Same harness pattern as
// server.routes.test.js: real Express app + temporary sqlite file, real
// login flow, no mocks.
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

  await check("POST /api/donors/:id/manual-payment בלי Authorization -> 401", async function () {
    const res = await jsonFetch("POST", "/api/donors/1/manual-payment", { amount: 100 });
    assert.strictEqual(res.status, 401);
  });

  await check("[הרשאות] מנהל: תשלום ידני תקין -> 200, נוצרת בדיוק רשומה אחת עם source=manual", async function () {
    const before = db.getPayments({ limit: 1000 }).length;
    const res = await jsonFetch("POST", "/api/donors/501/manual-payment", { amount: 500, phone: "0501112222", donorName: "תורם לבדיקה 501", paymentMethod: "מזומן" }, adminToken);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.payment.amount, 500);
    assert.strictEqual(res.body.payment.source, "manual");
    assert.strictEqual(res.body.payment.status, "success");
    assert.strictEqual(res.body.payment.donorName, "תורם לבדיקה 501", "donorId נפתר דרך הטלפון אל טבלת donors ה-SQL, ומחזיר את השם דרך ה-JOIN");
    const after = db.getPayments({ limit: 1000 }).length;
    assert.strictEqual(after, before + 1, "בדיוק רשומת תשלום אחת נוצרה — לא כפולה");
  });

  await check("[הרשאות] מזכיר: תשלום ידני תקין -> 200 (מזכיר מורשה בדיוק כמו מנהל)", async function () {
    const res = await jsonFetch("POST", "/api/donors/502/manual-payment", { amount: 250, phone: "0503334444", donorName: "תורם לבדיקה 502" }, secretaryToken);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.payment.phone, "0503334444");
  });

  await check("תשלום ידני בלי טלפון בכלל -> נשמר בהצלחה עם donorId ריק (לא קורס)", async function () {
    const res = await jsonFetch("POST", "/api/donors/509/manual-payment", { amount: 40 }, adminToken);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.payment.donorId, null);
  });

  await check("סכום 0 -> 400, ולא נוצרת רשומה", async function () {
    const before = db.getPayments({ limit: 1000 }).length;
    const res = await jsonFetch("POST", "/api/donors/501/manual-payment", { amount: 0 }, adminToken);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(db.getPayments({ limit: 1000 }).length, before, "כשל ולידציה לא אמור ליצור רשומה");
  });

  await check("סכום שלילי -> 400", async function () {
    const res = await jsonFetch("POST", "/api/donors/501/manual-payment", { amount: -50 }, adminToken);
    assert.strictEqual(res.status, 400);
  });

  await check("סכום לא מספרי -> 400", async function () {
    const res = await jsonFetch("POST", "/api/donors/501/manual-payment", { amount: "abc" }, adminToken);
    assert.strictEqual(res.status, 400);
  });

  await check("סכום מעל התקרה הסבירה -> 400", async function () {
    const res = await jsonFetch("POST", "/api/donors/501/manual-payment", { amount: 999999999 }, adminToken);
    assert.strictEqual(res.status, 400);
  });

  await check("מזהה תורם לא תקין -> 400", async function () {
    const res = await jsonFetch("POST", "/api/donors/not-a-number/manual-payment", { amount: 100 }, adminToken);
    assert.strictEqual(res.status, 400);
  });

  await check("GET /api/payments?phone=0501112222 מחזיר את התשלום שנוצר פעם אחת בלבד — כך שגם donor.html (המסונן לפי טלפון) ימצא אותו", async function () {
    const res = await jsonFetch("GET", "/api/payments?phone=0501112222", undefined, adminToken);
    assert.strictEqual(res.status, 200);
    const matches = res.body.filter(function (p) { return p.amount === 500 && p.source === "manual"; });
    assert.strictEqual(matches.length, 1, "התשלום מופיע פעם אחת בדיוק בהיסטוריית התשלומים");
  });

  await check("GET /api/payments עם phone ריק לא מוחזר כ'הכל' בטעות — none-match, לא כל הרשומות", async function () {
    const res = await jsonFetch("GET", "/api/payments?phone=0000000000", undefined, adminToken);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.length, 0);
  });

  await check("שתי פעולות תשלום ידני נפרדות ותקינות יוצרות שתי רשומות נפרדות (לא נחסמות כ'כפולות')", async function () {
    const before = db.getPayments({ limit: 1000 }).length;
    await jsonFetch("POST", "/api/donors/501/manual-payment", { amount: 10, phone: "0501112222", donorName: "תורם לבדיקה 501" }, adminToken);
    await jsonFetch("POST", "/api/donors/501/manual-payment", { amount: 20, phone: "0501112222", donorName: "תורם לבדיקה 501" }, adminToken);
    const after = db.getPayments({ limit: 1000 }).length;
    assert.strictEqual(after, before + 2, "שתי פעולות אמיתיות ונפרדות = שתי רשומות, זה לא כשל דה-דופ");
  });

  await check("Audit Log: נוצרת רשומת server_audit_log עבור כל תשלום ידני", async function () {
    const before = db.getAuditLogs(1000).length;
    const res = await jsonFetch("POST", "/api/donors/503/manual-payment", { amount: 77, paymentMethod: "אשראי" }, adminToken);
    assert.strictEqual(res.status, 200);
    const logs = db.getAuditLogs(1000);
    assert.strictEqual(logs.length, before + 1);
    const row = logs[0];
    assert.strictEqual(row.action, "create");
    assert.strictEqual(row.entityType, "payment");
    assert.strictEqual(String(row.entityId), "503");
    assert.strictEqual(row.workerName, "מנהל מערכת", "מזוהה מה-JWT, לא מהבקשה");
    assert.ok(row.details.indexOf("77") !== -1);
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

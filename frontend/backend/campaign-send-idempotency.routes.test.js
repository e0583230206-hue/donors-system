// campaign-send-idempotency.routes.test.js — REAL HTTP-level tests for the
// duplicate-send protection on POST /api/technoline/send (server.js).
//
// Before this, only the client-side confirm() dialog + button-disable
// guarded against a repeated submission — a second tab, a fast double-click
// before disabled took effect, or a retried request after a perceived
// timeout could still trigger a real duplicate send to donors server-side.
//
// This deliberately does NOT block two independent requests that merely
// share the same recipientFilter (e.g. two separate, legitimate "debt:200"
// sends sent hours apart, or the existing technoline-campaign-debt-filter
// test file's own pattern of calling this route repeatedly with the same
// filter to probe different recipient-resolution edge cases) — a blanket
// same-filter-within-N-seconds lock would incorrectly block those too.
// Instead it follows the same client-supplied idempotencyKey pattern
// already used by the manual-payment endpoints: a request that reuses a key
// already completed successfully gets back the original result instead of
// sending again; a request with no key, or a never-before-seen key, is
// completely unaffected.
//
// הרצה: node frontend/backend/campaign-send-idempotency.routes.test.js

const assert = require("assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "campaign-send-idempotency-test-"));
process.env.DB_PATH = path.join(tmpRoot, "test.sqlite");
delete process.env.NODE_ENV;
process.env.TECHNOLINE_API_KEY = "test-api-key";

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

async function apiRequest(method, urlPath, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(baseUrl + urlPath, {
    method: method,
    headers: headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, body: data };
}

async function withMockedFetch(technolineMockFn, fn) {
  const original = global.fetch;
  const calls = [];
  global.fetch = function (url, opts) {
    if (String(url).indexOf("ipsales.co.il") !== -1) {
      calls.push({ url: String(url), body: opts && opts.body });
      return technolineMockFn(url, opts);
    }
    return original(url, opts);
  };
  try {
    await fn(calls);
  } finally {
    global.fetch = original;
  }
}

let _campaignIdCounter = 5000;
function fakeOkCampaignResponse() {
  const payload = JSON.stringify({ status: "OK", campaignId: ++_campaignIdCounter, phones: 1, errorPhones: 0, blockedPhones: 0 });
  return Promise.resolve({ status: 200, text: () => Promise.resolve(payload), json: () => Promise.resolve(JSON.parse(payload)) });
}

function uniqueKey(label) {
  return label + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
}

async function main() {
  server = http.createServer(app);
  await new Promise(function (resolve) { server.listen(0, "127.0.0.1", resolve); });
  baseUrl = "http://127.0.0.1:" + server.address().port;

  await check("[בטיחות] הבדיקה פועלת מול DB זמני, לא מול data.sqlite האמיתי", async function () {
    assert.ok(db.DB_PATH.indexOf(tmpRoot) === 0);
  });

  let adminToken;
  await check("[הכנה] התחברות כמנהל + שינוי סיסמה חובה", async function () {
    const login = await apiRequest("POST", "/api/login", { workerId: 1, password: "1234" });
    adminToken = login.body.token;
    await apiRequest("PUT", "/api/workers/me/password", { newPassword: "NewStr0ngPass!" }, adminToken);
    const relogin = await apiRequest("POST", "/api/login", { workerId: 1, password: "NewStr0ngPass!" });
    adminToken = relogin.body.token;
    assert.ok(adminToken);
  });

  db.setAppState("donors", [
    { id: 1, fullName: "תורם בדיקה 1", phone: "0501111111", donations: [{ remainingDebt: 100, paid: false }] },
  ]);

  await check("אותו idempotencyKey פעמיים -> בקשה אחת בלבד נשלחת בפועל לטכנוליין, השנייה מסומנת idempotent", async function () {
    const key = uniqueKey("dupsend");
    await withMockedFetch(fakeOkCampaignResponse, async function (calls) {
      const first = await apiRequest("POST", "/api/technoline/send", {
        recipientFilter: "debt", messageKind: "text", messageText: "בדיקה", idempotencyKey: key,
      }, adminToken);
      assert.strictEqual(first.status, 200, JSON.stringify(first.body));
      assert.ok(!first.body.idempotent);

      const second = await apiRequest("POST", "/api/technoline/send", {
        recipientFilter: "debt", messageKind: "text", messageText: "בדיקה", idempotencyKey: key,
      }, adminToken);
      assert.strictEqual(second.status, 200, JSON.stringify(second.body));
      assert.strictEqual(second.body.idempotent, true);
      assert.strictEqual(second.body.campaignId, first.body.campaignId, "אותה תוצאה בדיוק מוחזרת, לא קמפיין חדש");

      assert.strictEqual(calls.length, 1, "רק בקשה אחת בפועל הגיעה לטכנוליין, למרות שתי קריאות ל-API");
    });
  });

  await check("ללא idempotencyKey כלל -> שתי הבקשות עוברות בנפרד (התנהגות קודמת, ללא שינוי)", async function () {
    await withMockedFetch(fakeOkCampaignResponse, async function (calls) {
      const first = await apiRequest("POST", "/api/technoline/send", {
        recipientFilter: "debt", messageKind: "text", messageText: "בדיקה ללא מפתח",
      }, adminToken);
      const second = await apiRequest("POST", "/api/technoline/send", {
        recipientFilter: "debt", messageKind: "text", messageText: "בדיקה ללא מפתח",
      }, adminToken);
      assert.strictEqual(first.status, 200);
      assert.strictEqual(second.status, 200);
      assert.strictEqual(calls.length, 2, "בלי מפתח, שתי הבקשות מגיעות בפועל לטכנוליין — אין חסימה חדשה למי שלא שולח מפתח");
    });
  });

  await check("שני idempotencyKey שונים עם אותו פילטר -> שתי שליחות אמיתיות, נפרדות ולגיטימיות עוברות", async function () {
    await withMockedFetch(fakeOkCampaignResponse, async function (calls) {
      const first = await apiRequest("POST", "/api/technoline/send", {
        recipientFilter: "debt", messageKind: "text", messageText: "קמפיין א", idempotencyKey: uniqueKey("distinctA"),
      }, adminToken);
      const second = await apiRequest("POST", "/api/technoline/send", {
        recipientFilter: "debt", messageKind: "text", messageText: "קמפיין ב", idempotencyKey: uniqueKey("distinctB"),
      }, adminToken);
      assert.strictEqual(first.status, 200);
      assert.strictEqual(second.status, 200);
      assert.ok(!first.body.idempotent);
      assert.ok(!second.body.idempotent);
      assert.strictEqual(calls.length, 2, "שני מפתחות שונים -> שתי שליחות אמיתיות ונפרדות, גם עם אותו פילטר קהל");
    });
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

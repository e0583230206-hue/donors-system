// technoline-click2call-callerid.routes.test.js — REAL HTTP-level tests
// proving that TECHNOLINE_CLICK2CALL_CALLER_ID is sent as the `callerId`
// request param ONLY on the "התקשר לתורם" click2call route
// (POST /api/technoline/click2call — see donor.js:1630 -> server.js:1470),
// that it is a DISTINCT parameter from the tzintuk campaign's `callId`
// (TECHNOLINE_TZINTUK_CALLER_ID must keep working, unaffected), and that a
// malformed configured value fails safely (500, no request ever sent to
// Technoline) instead of silently sending a bad/wrong caller id.
//
// No real network call ever reaches Technoline — global.fetch is intercepted
// for the ipsales.co.il host only (same pattern as
// ivr-voice-messages.routes.test.js / technoline-tzintuk-callerid.routes.test.js).
// No real call is ever placed.
//
// הרצה: node technoline-click2call-callerid.routes.test.js

const assert = require("assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "technoline-click2call-callerid-test-"));
process.env.DB_PATH = path.join(tmpRoot, "test.sqlite");
delete process.env.NODE_ENV;
process.env.TECHNOLINE_API_KEY = "test-api-key";
process.env.TECHNOLINE_AGENT_EXTENSION = "101";
process.env.TECHNOLINE_CLICK2CALL_CALLER_ID = "025378787";
// Deliberately a DIFFERENT value than the click2call one, to prove the two
// env vars/params never leak into each other's requests.
process.env.TECHNOLINE_TZINTUK_CALLER_ID = "023766193";

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

function fakeOkClick2CallResponse() {
  const payload = JSON.stringify({ status: "OK", errorCode: 0, callId: "fake-call-uuid" });
  return Promise.resolve({ status: 200, text: () => Promise.resolve(payload), json: () => Promise.resolve(JSON.parse(payload)) });
}

function fakeOkCampaignResponse() {
  const payload = JSON.stringify({ status: "OK", campaignId: 999, phones: 1, errorPhones: 0, blockedPhones: 0 });
  return Promise.resolve({ status: 200, text: () => Promise.resolve(payload), json: () => Promise.resolve(JSON.parse(payload)) });
}

function fakeOkGenericResponse() {
  const payload = JSON.stringify({ status: "OK" });
  return Promise.resolve({ status: 200, text: () => Promise.resolve(payload), json: () => Promise.resolve(JSON.parse(payload)) });
}

async function main() {
  server = http.createServer(app);
  await new Promise(function (resolve) { server.listen(0, "127.0.0.1", resolve); });
  baseUrl = "http://127.0.0.1:" + server.address().port;

  await check("[בטיחות] הבדיקה פועלת מול DB זמני, לא מול data.sqlite האמיתי", async function () {
    assert.ok(db.DB_PATH.indexOf(tmpRoot) === 0, "DB_PATH חייב להיות תחת תיקיית ה-tmp, לא הנתיב האמיתי");
  });

  let adminToken;
  await check("[הכנה] התחברות כמנהל + שינוי סיסמה חובה", async function () {
    const login = await apiRequest("POST", "/api/login", { workerId: 1, password: "1234" });
    assert.strictEqual(login.status, 200);
    adminToken = login.body.token;
    const pw = await apiRequest("PUT", "/api/workers/me/password", { newPassword: "NewStr0ngPass!" }, adminToken);
    assert.strictEqual(pw.status, 200);
  });

  // ── "התקשר לתורם" -> POST /api/technoline/click2call -> callerId=025378787 ──

  await check("POST /api/technoline/click2call (\"התקשר לתורם\") -> הבקשה לטכנוליין כוללת callerId=025378787", async function () {
    await withMockedFetch(fakeOkClick2CallResponse, async function (calls) {
      const res = await apiRequest("POST", "/api/technoline/click2call", {
        phone: "0501234567", donorName: "תורם בדיקה", donorId: 1,
      }, adminToken);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(calls.length, 1);
      const sentParams = new URLSearchParams(calls[0].body);
      assert.strictEqual(sentParams.get("action"), "click2call");
      assert.strictEqual(sentParams.get("callerId"), "025378787");
      // Must NOT be confused with campaignRun's distinct `callId` param.
      assert.strictEqual(sentParams.get("callId"), null);
    });
  });

  await check("click2call: כאשר TECHNOLINE_CLICK2CALL_CALLER_ID אינו מוגדר -> אין callerId בבקשה (ברירת המחדל של השלוחה)", async function () {
    const original = process.env.TECHNOLINE_CLICK2CALL_CALLER_ID;
    delete process.env.TECHNOLINE_CLICK2CALL_CALLER_ID;
    try {
      await withMockedFetch(fakeOkClick2CallResponse, async function (calls) {
        const res = await apiRequest("POST", "/api/technoline/click2call", {
          phone: "0501234567", donorName: "תורם בדיקה", donorId: 1,
        }, adminToken);
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        const sentParams = new URLSearchParams(calls[0].body);
        assert.strictEqual(sentParams.get("callerId"), null);
      });
    } finally {
      process.env.TECHNOLINE_CLICK2CALL_CALLER_ID = original;
    }
  });

  await check("click2call: כאשר TECHNOLINE_CLICK2CALL_CALLER_ID אינו תקין -> 500, ואף בקשה לא נשלחת לטכנוליין (כשל בטוח)", async function () {
    const original = process.env.TECHNOLINE_CLICK2CALL_CALLER_ID;
    process.env.TECHNOLINE_CLICK2CALL_CALLER_ID = "not-a-phone-number";
    try {
      await withMockedFetch(fakeOkClick2CallResponse, async function (calls) {
        const res = await apiRequest("POST", "/api/technoline/click2call", {
          phone: "0501234567", donorName: "תורם בדיקה", donorId: 1,
        }, adminToken);
        assert.strictEqual(res.status, 500, JSON.stringify(res.body));
        assert.ok(res.body && res.body.error && res.body.error.indexOf("TECHNOLINE_CLICK2CALL_CALLER_ID") !== -1);
        assert.strictEqual(calls.length, 0, "כשהערך שגוי, אסור שתישלח בקשה כלשהי לטכנוליין — אין להתקשר בפועל");
      });
    } finally {
      process.env.TECHNOLINE_CLICK2CALL_CALLER_ID = original;
    }
  });

  // ── רגרסיה: קמפייני צינתוק ממשיכים לקבל callId (התואם ל-TECHNOLINE_TZINTUK_CALLER_ID),
  //    בלי שום השפעה של משתנה ה-click2call ────────────────────────────────────

  await check("רגרסיה: POST /api/technoline/send/manual (צינתוק) ממשיך לשלוח callId=023766193, ללא callerId", async function () {
    await withMockedFetch(fakeOkCampaignResponse, async function (calls) {
      const res = await apiRequest("POST", "/api/technoline/send/manual", {
        phone: "0501234567", messageKind: "text", messageText: "בדיקה",
      }, adminToken);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      const sentParams = new URLSearchParams(calls[0].body);
      assert.strictEqual(sentParams.get("action"), "campaignRun");
      assert.strictEqual(sentParams.get("callId"), "023766193");
      assert.strictEqual(sentParams.get("callerId"), null, "צינתוק לא אמור לקבל callerId");
    });
  });

  await check("רגרסיה: POST /api/technoline/send (קמפיין) ממשיך לשלוח callId=023766193, ללא callerId", async function () {
    await withMockedFetch(fakeOkCampaignResponse, async function (calls) {
      const res = await apiRequest("POST", "/api/technoline/send", {
        messageKind: "text", messageText: "בדיקה", phones: ["0501234567"],
      }, adminToken);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      const sentParams = new URLSearchParams(calls[0].body);
      assert.strictEqual(sentParams.get("callId"), "023766193");
      assert.strictEqual(sentParams.get("callerId"), null);
    });
  });

  await check("לא קשור: GET /api/technoline/campaign/:id/report -> ללא callId וללא callerId", async function () {
    await withMockedFetch(fakeOkGenericResponse, async function (calls) {
      const res = await apiRequest("GET", "/api/technoline/campaign/123/report", undefined, adminToken);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      const sentParams = new URLSearchParams(calls[0].body);
      assert.strictEqual(sentParams.get("action"), "campaignReport");
      assert.strictEqual(sentParams.get("callId"), null);
      assert.strictEqual(sentParams.get("callerId"), null);
    });
  });

  // ── סיכום ─────────────────────────────────────────────────────────────────────
  const failed = results.filter(function (r) { return !r.ok; });
  results.forEach(function (r) {
    console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : " — " + r.error));
  });
  console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");
  server.close();
  process.exit(failed.length ? 1 : 0);
}

main();

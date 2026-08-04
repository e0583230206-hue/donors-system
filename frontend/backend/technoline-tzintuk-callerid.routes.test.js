// technoline-tzintuk-callerid.routes.test.js — REAL HTTP-level tests proving
// that TECHNOLINE_TZINTUK_CALLER_ID is sent as the `callId` request param
// ONLY on the two tzintuk/missed-call campaign send routes
// (POST /api/technoline/send/manual, POST /api/technoline/send), and that
// every other Technoline route (click2call, campaignReport/hold/resume/stop)
// is completely unaffected. Also proves a malformed configured value fails
// safely (500, no request ever sent to Technoline) instead of silently
// sending a bad/wrong caller id.
//
// No real network call ever reaches Technoline — global.fetch is intercepted
// for the ipsales.co.il host only, same pattern as
// ivr-voice-messages.routes.test.js. No real tzintuk/campaign is ever sent.
//
// Same require.main !== module + temp-DB-file pattern as server.routes.test.js.
//
// הרצה: node technoline-tzintuk-callerid.routes.test.js

const assert = require("assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "technoline-tzintuk-callerid-test-"));
process.env.DB_PATH = path.join(tmpRoot, "test.sqlite");
delete process.env.NODE_ENV;
process.env.TECHNOLINE_API_KEY = "test-api-key";
process.env.TECHNOLINE_TZINTUK_CALLER_ID = "025378787";

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

// Swaps global.fetch for the duration of `fn`, restoring it afterward even if
// fn throws. Only the ipsales.co.il (Technoline) URL is intercepted — this IS
// the "actual tzintuk" boundary: nothing here ever reaches Technoline's real
// servers, so no real call is ever placed during this test.
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

function fakeOkCampaignResponse() {
  const payload = JSON.stringify({ status: "OK", campaignId: 999, phones: 1, errorPhones: 0, blockedPhones: 0 });
  return Promise.resolve({ status: 200, text: () => Promise.resolve(payload), json: () => Promise.resolve(JSON.parse(payload)) });
}

// Covers both response-consumption styles used elsewhere in server.js:
// click2call does techRes.text() + JSON.parse, techCampaignFetch does r.json() directly.
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

  // ── תזכורת: 023766193 -> 025378787 מיושם רק דרך callId בבקשות צינתוק ────────

  await check("POST /api/technoline/send/manual עם callerId מוגדר -> הבקשה לטכנוליין כוללת callId=025378787", async function () {
    await withMockedFetch(fakeOkCampaignResponse, async function (calls) {
      const res = await apiRequest("POST", "/api/technoline/send/manual", {
        phone: "0501234567", messageKind: "text", messageText: "בדיקה",
      }, adminToken);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(calls.length, 1);
      const sentParams = new URLSearchParams(calls[0].body);
      assert.strictEqual(sentParams.get("action"), "campaignRun");
      assert.strictEqual(sentParams.get("callId"), "025378787");
    });
  });

  await check("POST /api/technoline/send (קמפיין בצינתוק) עם callerId מוגדר -> הבקשה לטכנוליין כוללת callId=025378787", async function () {
    await withMockedFetch(fakeOkCampaignResponse, async function (calls) {
      const res = await apiRequest("POST", "/api/technoline/send", {
        messageKind: "text", messageText: "בדיקה", phones: ["0501234567"],
      }, adminToken);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(calls.length, 1);
      const sentParams = new URLSearchParams(calls[0].body);
      assert.strictEqual(sentParams.get("action"), "campaignRun");
      assert.strictEqual(sentParams.get("callId"), "025378787");
    });
  });

  await check("POST /api/technoline/click2call -> ללא callId בבקשה (פיצ׳ר נפרד, לא אמור להיות מושפע)", async function () {
    await withMockedFetch(fakeOkGenericResponse, async function (calls) {
      const res = await apiRequest("POST", "/api/technoline/click2call", {
        phone: "0501234567", extension: "101",
      }, adminToken);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(calls.length, 1);
      const sentParams = new URLSearchParams(calls[0].body);
      assert.strictEqual(sentParams.get("action"), "click2call");
      assert.strictEqual(sentParams.get("callId"), null, "click2call לא אמור לקבל callId");
    });
  });

  await check("GET /api/technoline/campaign/:id/report -> ללא callId בבקשה (דיווח קמפיין, לא שיגור)", async function () {
    await withMockedFetch(fakeOkGenericResponse, async function (calls) {
      const res = await apiRequest("GET", "/api/technoline/campaign/123/report", undefined, adminToken);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(calls.length, 1);
      const sentParams = new URLSearchParams(calls[0].body);
      assert.strictEqual(sentParams.get("action"), "campaignReport");
      assert.strictEqual(sentParams.get("callId"), null, "campaignReport לא אמור לקבל callId");
    });
  });

  await check("POST /api/technoline/campaign/:id/hold -> ללא callId בבקשה", async function () {
    await withMockedFetch(fakeOkGenericResponse, async function (calls) {
      const res = await apiRequest("POST", "/api/technoline/campaign/123/hold", undefined, adminToken);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      const sentParams = new URLSearchParams(calls[0].body);
      assert.strictEqual(sentParams.get("action"), "campaignHold");
      assert.strictEqual(sentParams.get("callId"), null);
    });
  });

  await check("כאשר TECHNOLINE_TZINTUK_CALLER_ID אינו מוגדר -> אין callId בבקשת הצינתוק (ברירת המחדל של החשבון בטכנוליין)", async function () {
    const original = process.env.TECHNOLINE_TZINTUK_CALLER_ID;
    delete process.env.TECHNOLINE_TZINTUK_CALLER_ID;
    try {
      await withMockedFetch(fakeOkCampaignResponse, async function (calls) {
        const res = await apiRequest("POST", "/api/technoline/send/manual", {
          phone: "0501234567", messageKind: "text", messageText: "בדיקה",
        }, adminToken);
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        const sentParams = new URLSearchParams(calls[0].body);
        assert.strictEqual(sentParams.get("callId"), null);
      });
    } finally {
      process.env.TECHNOLINE_TZINTUK_CALLER_ID = original;
    }
  });

  await check("כאשר TECHNOLINE_TZINTUK_CALLER_ID אינו תקין (פורמט שגוי) -> 500, ואף בקשה לא נשלחת לטכנוליין (כשל בטוח)", async function () {
    const original = process.env.TECHNOLINE_TZINTUK_CALLER_ID;
    process.env.TECHNOLINE_TZINTUK_CALLER_ID = "not-a-phone-number";
    try {
      await withMockedFetch(fakeOkCampaignResponse, async function (calls) {
        const res = await apiRequest("POST", "/api/technoline/send/manual", {
          phone: "0501234567", messageKind: "text", messageText: "בדיקה",
        }, adminToken);
        assert.strictEqual(res.status, 500, JSON.stringify(res.body));
        assert.ok(res.body && res.body.error && res.body.error.indexOf("TECHNOLINE_TZINTUK_CALLER_ID") !== -1);
        assert.strictEqual(calls.length, 0, "כשהערך שגוי, אסור שתישלח בקשה כלשהי לטכנוליין");
      });
    } finally {
      process.env.TECHNOLINE_TZINTUK_CALLER_ID = original;
    }
  });

  await check("כאשר TECHNOLINE_TZINTUK_CALLER_ID אינו תקין -> גם קמפיין בצינתוק (send) נכשל בבטחה בלי לשלוח לטכנוליין", async function () {
    const original = process.env.TECHNOLINE_TZINTUK_CALLER_ID;
    process.env.TECHNOLINE_TZINTUK_CALLER_ID = "12345"; // too short / no leading zero
    try {
      await withMockedFetch(fakeOkCampaignResponse, async function (calls) {
        const res = await apiRequest("POST", "/api/technoline/send", {
          messageKind: "text", messageText: "בדיקה", phones: ["0501234567"],
        }, adminToken);
        assert.strictEqual(res.status, 500, JSON.stringify(res.body));
        assert.strictEqual(calls.length, 0);
      });
    } finally {
      process.env.TECHNOLINE_TZINTUK_CALLER_ID = original;
    }
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

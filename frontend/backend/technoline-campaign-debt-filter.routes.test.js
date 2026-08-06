// technoline-campaign-debt-filter.routes.test.js — REAL HTTP-level tests for
// the new bounded debt-range campaign audience filter ("debt:<maxDebt>",
// e.g. "debt:200") in buildPhoneList() (frontend/backend/server.js).
//
// Covers:
//   - only donors with 0 < totalDebt <= maxDebt are included (totalDebt =
//     sum of remainingDebt across ALL donations — same formula as
//     frontend/js/donors.js getDonorDebt() / frontend/js/donor.js getDebtTotal()).
//   - donors over the cap, at exactly 0, or with no open debt are excluded.
//   - inactive ("לא פעיל") donors are excluded even if their debt qualifies.
//   - invalid phone numbers are excluded (strict mode, bounded filter only).
//   - duplicate destination numbers across donors are de-duplicated.
//   - the LEGACY uncapped "debt" filter (no colon) is completely unchanged:
//     still includes inactive donors and any debt > 0 with no cap — proves
//     no regression for any existing integration using plain "debt".
//   - GET recipient-count (Preview) and POST send (mocked Technoline call)
//     return the exact same phone count/list for "debt:200" — the specific
//     "Preview says X, Send says none" contradiction must not reproduce.
//
// Deliberately verified via /recipient-count + the actual send payload only
// (NOT /recipient-debug, which is a separate admin diagnostic endpoint with
// its own independent, undedup'd, unnormalized filter logic that does not
// call buildPhoneList — extending it is out of scope for this focused fix).
//
// No real call is ever placed — global.fetch is intercepted for the
// ipsales.co.il host only, same pattern as the other technoline-*.test.js
// files in this directory.
//
// הרצה: node technoline-campaign-debt-filter.routes.test.js

const assert = require("assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "technoline-debt-filter-test-"));
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

function fakeOkCampaignResponse() {
  const payload = JSON.stringify({ status: "OK", campaignId: 4242, phones: 999, errorPhones: 0, blockedPhones: 0 });
  return Promise.resolve({ status: 200, text: () => Promise.resolve(payload), json: () => Promise.resolve(JSON.parse(payload)) });
}

function donation(remainingDebt, paid) {
  return { remainingDebt: remainingDebt, paid: !!paid };
}

async function sentPhonesFor(recipientFilter, adminToken) {
  let sent = null;
  await withMockedFetch(fakeOkCampaignResponse, async function (calls) {
    const r = await apiRequest("POST", "/api/technoline/send", {
      recipientFilter: recipientFilter, messageKind: "text", messageText: "בדיקה",
    }, adminToken);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(calls.length, 1);
    const sentParams = new URLSearchParams(calls[0].body);
    sent = JSON.parse(sentParams.get("phones"));
  });
  return sent;
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

  // ── Fixture donors covering every edge case ──────────────────────────────────
  db.setAppState("donors", [
    { id: 1, fullName: "בדיוק על התקרה",       phone: "0501111111", donations: [donation(200)] },
    { id: 2, fullName: "מתחת לתקרה",            phone: "0502222222", donations: [donation(150)] },
    { id: 3, fullName: "מעל התקרה",             phone: "0503333333", donations: [donation(201)] },
    { id: 4, fullName: "שני חובות בסכום",        phone: "0504444444", donations: [donation(100), donation(90)] },
    { id: 5, fullName: "חוב אפס",               phone: "0505555555", donations: [donation(0)] },
    { id: 6, fullName: "אין חוב פתוח כלל",       phone: "0506666666", donations: [] },
    { id: 7, fullName: "לא פעיל אך בטווח החוב",  phone: "0507777777", donations: [donation(100)], status: "לא פעיל" },
    { id: 8, fullName: "פעיל מפורש",            phone: "0508888888", donations: [donation(100)], status: "פעיל" },
    { id: 9, fullName: "טלפון לא תקין",          phone: "123",        donations: [donation(100)] },
    { id: 10, fullName: "מספר כפול עם #2",       phone: "0502222222", donations: [donation(120)] }, // same phone as donor #2
    { id: 11, fullName: "חוב ששולם — נספר כאפס", phone: "0509999999", donations: [donation(0, true)] },
  ]);

  const EXPECTED_PHONES = ["0501111111", "0502222222", "0504444444", "0508888888"];

  // ── Bounded filter correctness — via Preview (recipient-count) ──────────────

  await check("Preview (recipient-count) עם debt:200 מחזיר בדיוק 4 מספרים ייחודיים", async function () {
    const r = await apiRequest("GET", "/api/technoline/send/recipient-count?filter=" + encodeURIComponent("debt:200"), undefined, adminToken);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.count, 4, JSON.stringify(r.body));
  });

  // ── Bounded filter correctness — via actual Send (mocked Technoline) ─────────

  await check("Send (POST /api/technoline/send) עם debt:200 שולח בדיוק לאותם 4 מספרים כמו ה-Preview — לא 'אין מספרים תואמים'", async function () {
    const sent = await sentPhonesFor("debt:200", adminToken);
    assert.strictEqual(sent.length, 4, "השיגור חייב לכלול בדיוק 4 מספרים, זהה למספר שה-Preview הציג");
    assert.deepStrictEqual(sent.slice().sort(), EXPECTED_PHONES.slice().sort());
  });

  await check("תורם עם חוב 201 (מעל התקרה) אינו מקבל שיחה", async function () {
    const sent = await sentPhonesFor("debt:200", adminToken);
    assert.ok(sent.indexOf("0503333333") === -1, "תורם #3 עם חוב 201 חייב להיות מוחרג — מעל התקרה");
  });

  await check("תורם עם חוב אפס, או ללא תרומות, או עם חוב ששולם — אינו מקבל שיחה", async function () {
    const sent = await sentPhonesFor("debt:200", adminToken);
    assert.ok(sent.indexOf("0505555555") === -1, "תורם #5 (חוב אפס) חייב להיות מוחרג");
    assert.ok(sent.indexOf("0506666666") === -1, "תורם #6 (אין תרומות) חייב להיות מוחרג");
    assert.ok(sent.indexOf("0509999999") === -1, "תורם #11 (חוב ששולם, remainingDebt=0) חייב להיות מוחרג");
  });

  await check("תורם לא-פעיל מוחרג גם אם החוב שלו בטווח (₪100 <= ₪200)", async function () {
    const sent = await sentPhonesFor("debt:200", adminToken);
    assert.ok(sent.indexOf("0507777777") === -1, "תורם #7 (לא פעיל) חייב להיות מוחרג למרות חוב בטווח");
  });

  await check("טלפון לא תקין (\"123\") מוחרג — אף שהתורם עומד בכל שאר הקריטריונים", async function () {
    const sent = await sentPhonesFor("debt:200", adminToken);
    assert.ok(sent.indexOf("123") === -1, "מספר לא תקין לעולם לא אמור להישלח לטכנוליין");
  });

  await check("חוב מחושב כסכום כל התרומות (לא תרומה בודדת) — תורם #4 עם 100+90=190 נכלל", async function () {
    const sent = await sentPhonesFor("debt:200", adminToken);
    assert.ok(sent.indexOf("0504444444") !== -1, "תורם #4 עם סה\"כ חוב 190 (100+90, לא בדיקת תרומה בודדת) אמור להיכלל");
  });

  await check("מספר טלפון זהה בין שני תורמים (#2 ו-#10) נשלח פעם אחת בלבד", async function () {
    const sent = await sentPhonesFor("debt:200", adminToken);
    const occurrences = sent.filter(function (p) { return p === "0502222222"; }).length;
    assert.strictEqual(occurrences, 1, "מספר משותף לשני תורמים חייב להישלח פעם אחת בלבד, לא פעמיים");
  });

  // ── Legacy uncapped "debt" filter — must stay byte-for-byte unchanged ────────

  await check("רגרסיה: הפילטר הישן debt (ללא תקרה) ממשיך לכלול תורם לא-פעיל וכל חוב מעל 0, ללא הגבלת פורמט טלפון", async function () {
    const sent = await sentPhonesFor("debt", adminToken);
    assert.ok(sent.indexOf("0507777777") !== -1, "debt הישן (בלי תקרה) חייב עדיין לכלול תורם לא-פעיל — אסור לשנות התנהגות קיימת");
    assert.ok(sent.indexOf("0503333333") !== -1, "debt הישן חייב עדיין לכלול חוב מעל 200 — אין תקרה בו");
    assert.ok(sent.indexOf("123") !== -1, "debt הישן חייב עדיין לכלול טלפון לא תקין — אין החמרת פורמט בו (רגרסיה)");
  });

  // ── Permissions (unchanged route protection) ─────────────────────────────────

  await check("GET recipient-count עם debt:200 ללא טוקן -> 401", async function () {
    const r = await apiRequest("GET", "/api/technoline/send/recipient-count?filter=" + encodeURIComponent("debt:200"), undefined, undefined);
    assert.strictEqual(r.status, 401);
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

// ai/tests/search.test.js — Phase C: global donor search + disambiguation.
//
// הרצה: node frontend/backend/ai/tests/search.test.js

const assert = require("assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-search-test-"));
process.env.DB_PATH = path.join(tmpRoot, "test.sqlite");
delete process.env.NODE_ENV;

const app = require("../../server");
const db = require("../../db");
const { searchDonors } = require("../search");

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, error: err.stack || err.message });
  }
}

const DONORS = [
  { id: 1, fullName: "יעקב כהן", city: "ירושלים", phone: "0501111111", idNumber: "111111118", tags: [] },
  { id: 2, fullName: "יעקב לוי",  city: "בני ברק",  phone: "0502222222", idNumber: "222222226", tags: [] },
  { id: 3, fullName: "שרה כהן",   city: "ירושלים", phone: "0503333333", idNumber: "333333334", tags: ["VIP"] },
];

async function main() {
  db.setAppState("donors", DONORS);

  // ─── Unit-level (pure function) ─────────────────────────────────────────────

  await check("חיפוש שם ייחודי -> status=unique עם donorId נכון", async () => {
    const r = searchDonors("שרה", { field: "name" });
    assert.strictEqual(r.status, "unique");
    assert.strictEqual(r.donorId, 3);
  });

  await check("חיפוש שם עמום (יעקב) -> status=ambiguous עם 2 תוצאות + שאלת הבהרה בעברית", async () => {
    const r = searchDonors("יעקב", { field: "name" });
    assert.strictEqual(r.status, "ambiguous");
    assert.strictEqual(r.total, 2);
    assert.ok(typeof r.clarifyQ === "string" && r.clarifyQ.length > 0);
    assert.ok(r.matches.every((m) => !("phone" in m)), "רשימת ההבהרה לא אמורה לכלול מספר טלפון מלא");
  });

  await check("חיפוש שאינו קיים -> status=none", async () => {
    const r = searchDonors("לא קיים בכלל", { field: "name" });
    assert.strictEqual(r.status, "none");
    assert.strictEqual(r.total, 0);
  });

  await check("חיפוש לפי טלפון עם מקפים -> מתעלם מהמקפים (digits-only match)", async () => {
    const r = searchDonors("050-222-2222", { field: "phone" });
    assert.strictEqual(r.status, "unique");
    assert.strictEqual(r.donorId, 2);
  });

  await check("חיפוש לפי עיר -> מוצא את כל התורמים בעיר (ambiguous אם יותר מאחד)", async () => {
    const r = searchDonors("ירושלים", { field: "city" });
    assert.strictEqual(r.status, "ambiguous");
    assert.strictEqual(r.total, 2);
  });

  await check("שדה לא נתמך -> נופל בחזרה ל-any בלי לזרוק שגיאה", async () => {
    const r = searchDonors("כהן", { field: "not_a_real_field" });
    assert.strictEqual(r.field, "any");
    assert.strictEqual(r.total, 2);
  });

  await check("שאילתה ריקה -> status=none, לא זורק", async () => {
    const r = searchDonors("");
    assert.strictEqual(r.status, "none");
  });

  // ─── HTTP-level ──────────────────────────────────────────────────────────────

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = "http://127.0.0.1:" + server.address().port;

  async function apiRequest(method, urlPath, token) {
    const headers = {};
    if (token) headers.Authorization = "Bearer " + token;
    const res = await fetch(baseUrl + urlPath, { method, headers });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    return { status: res.status, body: data };
  }

  await check("[בטיחות] הבדיקה פועלת מול DB זמני, לא מול data.sqlite האמיתי", async () => {
    assert.ok(db.DB_PATH.indexOf(tmpRoot) === 0);
  });

  let adminToken;
  await check("[הכנה] התחברות כמנהל + שינוי סיסמה חובה", async () => {
    const headers = { "Content-Type": "application/json" };
    const res = await fetch(baseUrl + "/api/login", { method: "POST", headers, body: JSON.stringify({ workerId: 1, password: "1234" }) });
    const body = await res.json();
    const t1 = body.token;
    await fetch(baseUrl + "/api/workers/me/password", { method: "PUT", headers: { ...headers, Authorization: "Bearer " + t1 }, body: JSON.stringify({ newPassword: "NewStr0ngPass!" }) });
    const res2 = await fetch(baseUrl + "/api/login", { method: "POST", headers, body: JSON.stringify({ workerId: 1, password: "NewStr0ngPass!" }) });
    adminToken = (await res2.json()).token;
    assert.ok(adminToken);
  });

  await check("GET /api/ai/search?q=כהן -> 200, ambiguous", async () => {
    const r = await apiRequest("GET", "/api/ai/search?q=" + encodeURIComponent("כהן"), adminToken);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.status, "ambiguous");
  });

  await check("GET /api/ai/search בלי q -> 400", async () => {
    const r = await apiRequest("GET", "/api/ai/search", adminToken);
    assert.strictEqual(r.status, 400);
  });

  await check("GET /api/ai/search בלי טוקן -> 401", async () => {
    const r = await apiRequest("GET", "/api/ai/search?q=כהן");
    assert.strictEqual(r.status, 401);
  });

  // ── סיכום ────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  results.forEach((r) => {
    console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : "\n    " + r.error));
  });
  console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");

  await new Promise((resolve) => server.close(resolve));
  process.exitCode = failed.length ? 1 : 0;
}

main();

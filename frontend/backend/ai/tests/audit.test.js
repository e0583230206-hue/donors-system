// ai/tests/audit.test.js — AI audit logging (Phase A): every /api/ai/query
// call must produce a server_audit_log row, and that row must never contain
// the raw question text (privacy-preserving logging — see ai/audit.js).
//
// הרצה: node frontend/backend/ai/tests/audit.test.js

const assert = require("assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-audit-test-"));
process.env.DB_PATH = path.join(tmpRoot, "test.sqlite");
delete process.env.NODE_ENV;

const app = require("../../server");
const db = require("../../db");

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, error: err.stack || err.message });
  }
}

let server, baseUrl;

async function apiRequest(method, urlPath, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, body: data };
}

async function main() {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = "http://127.0.0.1:" + server.address().port;

  await check("[בטיחות] הבדיקה פועלת מול DB זמני, לא מול data.sqlite האמיתי", async () => {
    assert.ok(db.DB_PATH.indexOf(tmpRoot) === 0);
  });

  let adminToken;
  await check("[הכנה] התחברות כמנהל + שינוי סיסמה חובה", async () => {
    const login = await apiRequest("POST", "/api/login", { workerId: 1, password: "1234" });
    adminToken = login.body.token;
    await apiRequest("PUT", "/api/workers/me/password", { newPassword: "NewStr0ngPass!" }, adminToken);
    const relogin = await apiRequest("POST", "/api/login", { workerId: 1, password: "NewStr0ngPass!" });
    adminToken = relogin.body.token;
    assert.ok(adminToken, JSON.stringify(relogin.body));
  });

  const secretPhone = "0501234567"; // stand-in for a real phone the worker might paste in
  await check("שאלה עם מספר טלפון מוטמע -> נשמרת רשומת AI_QUERY, אך בלי תוכן השאלה עצמה", async () => {
    const r = await apiRequest("POST", "/api/ai/query", {
      question: "מה קורה עם " + secretPhone + "?",
      donorId: null,
      history: [],
      pageContext: "global",
    }, adminToken);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));

    const logs = db.getAuditLogs(50);
    const row = logs.find((l) => l.action === "AI_QUERY");
    assert.ok(row, "לא נמצאה רשומת AI_QUERY בלוג");
    assert.ok(row.details.indexOf(secretPhone) === -1, "מספר הטלפון דלף ללוג: " + row.details);
    assert.ok(row.details.indexOf("intent=") !== -1, "חסר intent בפירוט הלוג: " + row.details);
    assert.ok(row.details.indexOf("qlen=") !== -1, "חסר qlen בפירוט הלוג: " + row.details);
    assert.strictEqual(row.workerId, 1);
    assert.strictEqual(row.workerName, "מנהל מערכת");
  });

  await check("שאלה עם donorId -> entityId נשמר כ-donorId (עקבי עם שאר המערכת)", async () => {
    db.setAppState("donors", [
      { id: 777, fullName: "תורם בדיקה", phone: "0509999999", donations: [] },
    ]);
    const r = await apiRequest("POST", "/api/ai/query", {
      question: "מה מצב התורם?",
      donorId: 777,
      history: [],
      pageContext: "donor",
    }, adminToken);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));

    const logs = db.getAuditLogs(50);
    const row = logs.find((l) => l.action === "AI_QUERY" && l.entityId === "777");
    assert.ok(row, "לא נמצאה רשומת AI_QUERY עם entityId=777");
  });

  await check("ללא הרשאה (בלי טוקן) -> 401, ואין רשומת לוג חדשה", async () => {
    const before = db.getAuditLogs(200).length;
    const r = await apiRequest("POST", "/api/ai/query", { question: "מה קורה?" });
    assert.strictEqual(r.status, 401);
    const after = db.getAuditLogs(200).length;
    assert.strictEqual(after, before, "לא אמורה להיווצר רשומת לוג לבקשה לא מאומתת");
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

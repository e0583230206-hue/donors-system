// ai/tests/capabilities.test.js — Phase B: capability registry + permission
// map. Unit-level (registry mechanics) + one HTTP-level check that
// GET /api/ai/capabilities actually filters by the caller's role.
//
// הרצה: node frontend/backend/ai/tests/capabilities.test.js

const assert = require("assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-capabilities-test-"));
process.env.DB_PATH = path.join(tmpRoot, "test.sqlite");
delete process.env.NODE_ENV;

const app = require("../../server");
const db = require("../../db");
const caps = require("../capabilities");

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
  // ─── Registry mechanics (pure, no server needed) ────────────────────────────

  await check("registerCapability: read intents from detector.js are pre-registered", async () => {
    const reads = caps.listCapabilities({ category: "read" });
    assert.ok(reads.length > 20, "מצפה לעשרות יכולות קריאה מוכנות מראש, נמצאו " + reads.length);
    assert.ok(reads.every((c) => c.category === "read"));
  });

  await check("registerCapability: duplicate id is rejected", async () => {
    assert.throws(() => {
      caps.registerCapability({ id: "read.donor_summary", category: "read" });
    }, /duplicate capability id/);
  });

  await check("registerCapability: ADMIN-only capability is invisible to SECRETARY via listCapabilities", async () => {
    caps.registerCapability({
      id: "test.admin_only_probe",
      category: "action",
      domain: "test",
      roles: [caps.ROLES.ADMIN],
      riskTier: "high",
      status: "enabled",
    });
    const forAdmin = caps.listCapabilities({ role: caps.ROLES.ADMIN });
    const forSecretary = caps.listCapabilities({ role: caps.ROLES.SECRETARY });
    assert.ok(forAdmin.some((c) => c.id === "test.admin_only_probe"));
    assert.ok(!forSecretary.some((c) => c.id === "test.admin_only_probe"), "יכולת ADMIN-only דלפה לרשימה של מזכיר/ה");
  });

  await check("isAllowed: respects role AND status (disabled beats role match)", async () => {
    caps.registerCapability({
      id: "test.disabled_probe",
      category: "action",
      domain: "test",
      roles: [caps.ROLES.ADMIN, caps.ROLES.SECRETARY],
      status: "disabled",
    });
    assert.strictEqual(caps.isAllowed("test.disabled_probe", caps.ROLES.ADMIN), false, "יכולת disabled לא אמורה להיות מותרת גם למנהל");
    assert.strictEqual(caps.isAllowed("test.admin_only_probe", caps.ROLES.SECRETARY), false);
    assert.strictEqual(caps.isAllowed("test.admin_only_probe", caps.ROLES.ADMIN), true);
  });

  await check("buildMatrix: every row has the columns the report needs", async () => {
    const matrix = caps.buildMatrix();
    const row = matrix.find((r) => r.id === "test.admin_only_probe");
    assert.ok(row);
    ["id", "category", "domain", "roles", "riskTier", "requiresConfirmation", "implemented", "status", "testCoverage"]
      .forEach((col) => assert.ok(col in row, "חסרה עמודה " + col + " במטריצה"));
  });

  // ─── HTTP-level: role filtering enforced server-side ────────────────────────

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = "http://127.0.0.1:" + server.address().port;

  await check("[בטיחות] הבדיקה פועלת מול DB זמני, לא מול data.sqlite האמיתי", async () => {
    assert.ok(db.DB_PATH.indexOf(tmpRoot) === 0);
  });

  let adminToken, secretaryToken;
  await check("[הכנה] התחברות כמנהל + יצירת מזכיר/ה", async () => {
    const login = await apiRequest("POST", "/api/login", { workerId: 1, password: "1234" });
    adminToken = login.body.token;
    await apiRequest("PUT", "/api/workers/me/password", { newPassword: "NewStr0ngPass!" }, adminToken);
    const relogin = await apiRequest("POST", "/api/login", { workerId: 1, password: "NewStr0ngPass!" });
    adminToken = relogin.body.token;

    const created = await apiRequest("POST", "/api/workers", { name: "מזכיר בדיקה", role: "מזכיר" }, adminToken);
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const secLogin = await apiRequest("POST", "/api/login", { workerId: created.body.id, password: "1111" });
    assert.ok(secLogin.body && secLogin.body.token, JSON.stringify(secLogin.body));
    await apiRequest("PUT", "/api/workers/me/password", { newPassword: "SecStr0ngPass!" }, secLogin.body.token);
    const secRelogin = await apiRequest("POST", "/api/login", { workerId: created.body.id, password: "SecStr0ngPass!" });
    secretaryToken = secRelogin.body.token;
    assert.ok(secretaryToken, JSON.stringify(secRelogin.body));
  });

  await check("GET /api/ai/capabilities כמנהל -> כולל test.admin_only_probe", async () => {
    const r = await apiRequest("GET", "/api/ai/capabilities", undefined, adminToken);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.capabilities.some((c) => c.id === "test.admin_only_probe"));
  });

  await check("GET /api/ai/capabilities כמזכיר/ה -> לא כולל test.admin_only_probe", async () => {
    const r = await apiRequest("GET", "/api/ai/capabilities", undefined, secretaryToken);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(!r.body.capabilities.some((c) => c.id === "test.admin_only_probe"), "יכולת ADMIN-only הוחזרה למזכיר/ה");
    assert.ok(r.body.capabilities.length > 20, "אמור לקבל את כל יכולות הקריאה הרגילות");
  });

  await check("GET /api/ai/capabilities בלי טוקן -> 401", async () => {
    const r = await apiRequest("GET", "/api/ai/capabilities");
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

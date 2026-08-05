// ai/tests/highrisk.test.js — Phase G: high-risk actions must be provably
// impossible to execute while AI_ACTIONS_HIGH_RISK_ENABLED is not exactly
// "true" — checked at every stage (prepare/confirm/execute), not just
// documented as a convention.
//
// הרצה: node frontend/backend/ai/tests/highrisk.test.js

const assert = require("assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-highrisk-test-"));
process.env.DB_PATH = path.join(tmpRoot, "test.sqlite");
delete process.env.NODE_ENV;
delete process.env.AI_ACTIONS_HIGH_RISK_ENABLED; // explicit: default/absent must mean disabled

const app = require("../../server");
const db = require("../../db");
const caps = require("../capabilities");
const highrisk = require("../actions/highrisk");

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, error: err.stack || err.message });
  }
}

const HIGH_RISK_IDS = [
  "process_payment", "cancel_donation", "issue_refund", "modify_debt",
  "bulk_donor_edit", "initiate_call", "send_sms_message", "send_campaign",
  "delete_recording", "send_email",
];

async function main() {
  await check("HIGH_RISK_ENABLED מחושב כ-false כשהמשתנה לא מוגדר", async () => {
    assert.strictEqual(highrisk.HIGH_RISK_ENABLED, false);
  });

  await check("כל 10 פעולות ה-Phase G רשומות ברישום עם status=disabled, riskTier=high", async () => {
    HIGH_RISK_IDS.forEach((id) => {
      const cap = caps.getCapability("action." + id);
      assert.ok(cap, "חסרה יכולת: " + id);
      assert.strictEqual(cap.status, "disabled", id + " אמור להיות disabled");
      assert.strictEqual(cap.riskTier, "high");
      assert.strictEqual(cap.implemented, false, id + " אמור להיות מסומן implemented:false");
    });
  });

  await check("isAllowed מחזיר false לכל פעולת Phase G, גם למנהל", async () => {
    HIGH_RISK_IDS.forEach((id) => {
      assert.strictEqual(caps.isAllowed("action." + id, caps.ROLES.ADMIN), false, id);
    });
  });

  // ─── HTTP-level: even an authenticated ADMIN cannot reach prepare/confirm/execute ──

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = "http://127.0.0.1:" + server.address().port;

  async function apiRequest(method, urlPath, body, token) {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = "Bearer " + token;
    const res = await fetch(baseUrl + urlPath, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    return { status: res.status, body: data };
  }

  await check("[בטיחות] הבדיקה פועלת מול DB זמני, לא מול data.sqlite האמיתי", async () => {
    assert.ok(db.DB_PATH.indexOf(tmpRoot) === 0);
  });

  let adminToken;
  await check("[הכנה] התחברות כמנהל", async () => {
    const login = await apiRequest("POST", "/api/login", { workerId: 1, password: "1234" });
    adminToken = login.body.token;
    await apiRequest("PUT", "/api/workers/me/password", { newPassword: "NewStr0ngPass!" }, adminToken);
    const relogin = await apiRequest("POST", "/api/login", { workerId: 1, password: "NewStr0ngPass!" });
    adminToken = relogin.body.token;
    assert.ok(adminToken);
  });

  for (const id of HIGH_RISK_IDS) {
    await check("prepare חסום עבור " + id + " (ADMIN, capability disabled)", async () => {
      const r = await apiRequest("POST", "/api/ai/actions/prepare", { actionId: id, params: {} }, adminToken);
      assert.strictEqual(r.status, 400, JSON.stringify(r.body));
      assert.strictEqual(r.body.code, "forbidden");
    });
  }

  await check("אין דרך לדלג ישר ל-execute בלי prepare/confirm תקינים — Phase G או לא", async () => {
    const r = await apiRequest("POST", "/api/ai/actions/execute", { token: "not-a-real-token" }, adminToken);
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.code, "malformed");
  });

  await check("GET /api/ai/capabilities לא חושף אף פעולת Phase G כ-enabled", async () => {
    const r = await apiRequest("GET", "/api/ai/capabilities", undefined, adminToken);
    HIGH_RISK_IDS.forEach((id) => {
      const cap = r.body.capabilities.find((c) => c.id === "action." + id);
      if (cap) assert.strictEqual(cap.status, "disabled", id);
    });
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

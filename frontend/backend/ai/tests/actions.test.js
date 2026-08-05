// ai/tests/actions.test.js — Phase F: action framework (prepare/confirm/
// execute) + the low-risk actions built on it. Covers: confirmation
// fingerprints, stale payloads, confirm-without-preview rejection,
// idempotency, partial-failure reporting, audit redaction, permissions.
//
// הרצה: node frontend/backend/ai/tests/actions.test.js

const assert = require("assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-actions-test-"));
process.env.DB_PATH = path.join(tmpRoot, "test.sqlite");
delete process.env.NODE_ENV;

const app = require("../../server");
const db = require("../../db");
const aiActions = require("../actions");

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
    method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, body: data };
}

function uniqueKey(label) {
  return label + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
}

async function main() {
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
    const secLogin = await apiRequest("POST", "/api/login", { workerId: created.body.id, password: "1111" });
    await apiRequest("PUT", "/api/workers/me/password", { newPassword: "SecStr0ngPass!" }, secLogin.body.token);
    const secRelogin = await apiRequest("POST", "/api/login", { workerId: created.body.id, password: "SecStr0ngPass!" });
    secretaryToken = secRelogin.body.token;
    assert.ok(adminToken && secretaryToken);
  });

  db.setAppState("donors", [
    { id: 501, fullName: "תורם לבדיקת פעולות", phone: "0501112222", notes: "", donations: [] },
  ]);

  // ─── Happy path: full prepare -> confirm -> execute for create_task ──────────

  let happyTaskId;
  await check("create_task: prepare -> preview בעברית עם היעד המדויק", async () => {
    const r = await apiRequest("POST", "/api/ai/actions/prepare", {
      actionId: "create_task",
      params: { title: "לבדוק חוב", workerName: "מנהל מערכת", donorId: 501 },
    }, adminToken);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.token);
    assert.ok(r.body.preview.effectHebrew.includes("לבדוק חוב"));
    assert.ok(r.body.preview.effectHebrew.includes("תורם לבדיקת פעולות"));
    happyTaskId = r; // stash for next step
  });

  await check("create_task: confirm -> executionToken נפרד מאסימון ה-preview", async () => {
    const r = await apiRequest("POST", "/api/ai/actions/confirm", { token: happyTaskId.body.token }, adminToken);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.executionToken);
    assert.notStrictEqual(r.body.executionToken, happyTaskId.body.token, "אסימון הביצוע חייב להיות שונה מאסימון התצוגה המקדימה");
    happyTaskId.confirmBody = r.body;
  });

  await check("create_task: execute -> המשימה נוצרת בפועל ב-app_state.tasks", async () => {
    const r = await apiRequest("POST", "/api/ai/actions/execute", { token: happyTaskId.confirmBody.executionToken }, adminToken);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.ok, true);
    const tasks = db.getAppState("tasks") || [];
    assert.ok(tasks.some((t) => t.title === "לבדוק חוב" && t.donorId === 501), "המשימה לא נמצאה ב-app_state.tasks");
  });

  // ─── Confirmation fingerprint / tamper resistance ─────────────────────────────

  await check("אסימון מזויף (fingerprint שונה) נדחה ב-confirm", async () => {
    const prep = await apiRequest("POST", "/api/ai/actions/prepare", {
      actionId: "create_task", params: { title: "משימה 2", workerName: "מנהל מערכת" },
    }, adminToken);
    const [b64] = prep.body.token.split(".");
    const tampered = b64 + ".0000000000000000000000000000000000000000000000000000000000000000";
    const r = await apiRequest("POST", "/api/ai/actions/confirm", { token: tampered }, adminToken);
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.code, "bad_signature");
  });

  await check("אסימון עם payload שהשתנה (אותה חתימה, payload אחר) נדחה", async () => {
    const prep = await apiRequest("POST", "/api/ai/actions/prepare", {
      actionId: "create_task", params: { title: "משימה 3", workerName: "מנהל מערכת" },
    }, adminToken);
    const [, fp] = prep.body.token.split(".");
    const tamperedPayload = Buffer.from(JSON.stringify({ actionId: "create_task", workerId: 1, stage: "prepared", expiresAt: Date.now() + 999999, canonicalParams: { title: "הוחלף!", workerName: "מנהל מערכת" } })).toString("base64url");
    const r = await apiRequest("POST", "/api/ai/actions/confirm", { token: tamperedPayload + "." + fp }, adminToken);
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.code, "bad_signature");
  });

  // ─── Stale / expired payloads ──────────────────────────────────────────────────

  await check("אסימון פג תוקף נדחה (stale payload)", async () => {
    const expiredToken = aiActions._internal.sign({
      actionId: "create_task", workerId: 1, stage: "prepared",
      canonicalParams: { title: "פג תוקף", workerName: "מנהל מערכת" },
      expiresAt: Date.now() - 1000, // already expired
    });
    const r = await apiRequest("POST", "/api/ai/actions/confirm", { token: expiredToken }, adminToken);
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.code, "expired");
  });

  // ─── confirm-without-preview rejection ─────────────────────────────────────────

  await check("execute עם אסימון prepare (לא confirm) נדחה — 'אישור בלי תצוגה מקדימה'", async () => {
    const prep = await apiRequest("POST", "/api/ai/actions/prepare", {
      actionId: "create_task", params: { title: "ניסיון עקיפה", workerName: "מנהל מערכת" },
    }, adminToken);
    const r = await apiRequest("POST", "/api/ai/actions/execute", { token: prep.body.token }, adminToken);
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.code, "confirm_without_preview");
    const tasks = db.getAppState("tasks") || [];
    assert.ok(!tasks.some((t) => t.title === "ניסיון עקיפה"), "המשימה לא הייתה אמורה להיווצר!");
  });

  // ─── worker binding ─────────────────────────────────────────────────────────────

  await check("אישור ששייך למשתמש אחר נדחה (worker_mismatch)", async () => {
    const prep = await apiRequest("POST", "/api/ai/actions/prepare", {
      actionId: "create_task", params: { title: "שייך למנהל", workerName: "מנהל מערכת" },
    }, adminToken); // prepared by admin (worker id 1)
    const r = await apiRequest("POST", "/api/ai/actions/confirm", { token: prep.body.token }, secretaryToken); // confirmed by secretary
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.code, "worker_mismatch");
  });

  // ─── idempotency ────────────────────────────────────────────────────────────────

  await check("idempotencyKey זהה -> execute שני מוחזר כ-idempotent, לא נוצרת משימה כפולה", async () => {
    const key = uniqueKey("task");
    const prep = await apiRequest("POST", "/api/ai/actions/prepare", {
      actionId: "create_task", params: { title: "משימה עם אידמפוטנטיות", workerName: "מנהל מערכת" }, idempotencyKey: key,
    }, adminToken);
    const conf = await apiRequest("POST", "/api/ai/actions/confirm", { token: prep.body.token }, adminToken);

    const exec1 = await apiRequest("POST", "/api/ai/actions/execute", { token: conf.body.executionToken }, adminToken);
    assert.strictEqual(exec1.status, 200);
    assert.ok(!exec1.body.idempotent);

    const exec2 = await apiRequest("POST", "/api/ai/actions/execute", { token: conf.body.executionToken }, adminToken);
    assert.strictEqual(exec2.status, 200, JSON.stringify(exec2.body));
    assert.strictEqual(exec2.body.idempotent, true);
    assert.strictEqual(exec2.body.task.id, exec1.body.task.id, "התוצאה השנייה חייבת להיות זהה לראשונה, לא ביצוע כפול");

    const tasks = db.getAppState("tasks") || [];
    const matching = tasks.filter((t) => t.title === "משימה עם אידמפוטנטיות");
    assert.strictEqual(matching.length, 1, "אמורה להיווצר משימה אחת בלבד, נוצרו " + matching.length);
  });

  // ─── permissions ────────────────────────────────────────────────────────────────

  await check("SECRETARY מורשה ל-create_task (roles=[ADMIN,SECRETARY])", async () => {
    const prep = await apiRequest("POST", "/api/ai/actions/prepare", {
      actionId: "create_task", params: { title: "משימת מזכיר", workerName: "מזכיר בדיקה" },
    }, secretaryToken);
    assert.strictEqual(prep.status, 200, JSON.stringify(prep.body));
  });

  await check("פעולה לא קיימת נדחית עם unknown_action", async () => {
    const r = await apiRequest("POST", "/api/ai/actions/prepare", { actionId: "no_such_action", params: {} }, adminToken);
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.code, "unknown_action");
  });

  await check("בלי טוקן התחברות -> 401 בכל שלושת השלבים", async () => {
    const p = await apiRequest("POST", "/api/ai/actions/prepare", { actionId: "create_task", params: {} });
    const c = await apiRequest("POST", "/api/ai/actions/confirm", { token: "x" });
    const e = await apiRequest("POST", "/api/ai/actions/execute", { token: "x" });
    assert.strictEqual(p.status, 401);
    assert.strictEqual(c.status, 401);
    assert.strictEqual(e.status, 401);
  });

  // ─── add_donor_note ─────────────────────────────────────────────────────────────

  await check("add_donor_note: מוסיף לטקסט קיים, לא דורס אותו", async () => {
    const donors0 = db.getAppState("donors");
    donors0[0].notes = "הערה ראשונה";
    db.setAppState("donors", donors0);

    const prep = await apiRequest("POST", "/api/ai/actions/prepare", {
      actionId: "add_donor_note", params: { donorId: 501, text: "הערה שנייה" },
    }, adminToken);
    assert.strictEqual(prep.status, 200, JSON.stringify(prep.body));
    const conf = await apiRequest("POST", "/api/ai/actions/confirm", { token: prep.body.token }, adminToken);
    const exec = await apiRequest("POST", "/api/ai/actions/execute", { token: conf.body.executionToken }, adminToken);
    assert.strictEqual(exec.status, 200, JSON.stringify(exec.body));

    const donor = db.getAppState("donors").find((d) => d.id === 501);
    assert.ok(donor.notes.includes("הערה ראשונה"), "ההערה הקודמת נמחקה!");
    assert.ok(donor.notes.includes("הערה שנייה"));
  });

  await check("add_donor_note: donorId שלא קיים נדחה כבר בשלב ה-prepare", async () => {
    const r = await apiRequest("POST", "/api/ai/actions/prepare", {
      actionId: "add_donor_note", params: { donorId: 999999, text: "כלשהו" },
    }, adminToken);
    assert.strictEqual(r.status, 400);
  });

  // ─── prepare_campaign_recipients (read-only, no send) ──────────────────────────

  await check("prepare_campaign_recipients: מחזיר ספירה נכונה בלי לשלוח כלום", async () => {
    const prep = await apiRequest("POST", "/api/ai/actions/prepare", {
      actionId: "prepare_campaign_recipients", params: { recipientFilter: "all" },
    }, adminToken);
    assert.strictEqual(prep.status, 200, JSON.stringify(prep.body));
    assert.ok(prep.body.preview.effectHebrew.includes("ללא שליחה"));
    const conf = await apiRequest("POST", "/api/ai/actions/confirm", { token: prep.body.token }, adminToken);
    const exec = await apiRequest("POST", "/api/ai/actions/execute", { token: conf.body.executionToken }, adminToken);
    assert.strictEqual(exec.status, 200, JSON.stringify(exec.body));
    assert.ok(exec.body.recipientList);
    assert.strictEqual(typeof exec.body.recipientList.donorCount, "number");
  });

  // ─── audit trail sanity: every stage produced a redacted log row ──────────────

  await check("audit: כל שלב (prepare/confirm/execute) נרשם, בלי טקסט ההערה הגולמי בפירוט", async () => {
    const logs = db.getAuditLogs(500);
    const prepareRows = logs.filter((l) => l.action === "AI_ACTION_PREPARE");
    const confirmRows = logs.filter((l) => l.action === "AI_ACTION_CONFIRM");
    const executeRows = logs.filter((l) => l.action === "AI_ACTION_EXECUTE");
    assert.ok(prepareRows.length > 0 && confirmRows.length > 0 && executeRows.length > 0);
    logs.forEach((l) => {
      if (l.action.startsWith("AI_ACTION_") && l.details) {
        assert.ok(l.details.indexOf("הערה שנייה") === -1, "תוכן ההערה דלף ללוג: " + l.details);
      }
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

// ai/tests/idempotency.test.js — Phase F: durable, restart-surviving
// idempotency (ai/actions/idempotency.js). Covers the claim/resolve/replay
// mechanics directly, an in-progress-collision case, stale-claim recovery,
// and — the actual "survives a restart" proof — two independent subprocess
// runs sharing only a DB file on disk.
//
// הרצה: node frontend/backend/ai/tests/idempotency.test.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, error: err.stack || err.message });
  }
}

async function main() {
  // ─── Unit-level: claim/resolve/replay mechanics ───────────────────────────

  const tmpRoot1 = fs.mkdtempSync(path.join(os.tmpdir(), "ai-idem-unit-"));
  process.env.DB_PATH = path.join(tmpRoot1, "test.sqlite");
  delete process.env.NODE_ENV;
  const db = require("../../db");
  const { claimOrReplay, resolveClaim } = require("../actions/idempotency");

  await check("[בטיחות] הבדיקה פועלת מול DB זמני, לא מול data.sqlite האמיתי", async () => {
    assert.ok(db.DB_PATH.indexOf(tmpRoot1) === 0);
  });

  await check("ללא idempotencyKey -> outcome=no_key, תמיד ממשיך", async () => {
    const r = claimOrReplay({ actionId: "create_task", idempotencyKey: null });
    assert.strictEqual(r.outcome, "no_key");
  });

  await check("מפתח חדש -> outcome=claimed, ונרשמת שורת claim ב-server_audit_log", async () => {
    const r = claimOrReplay({ actionId: "create_task", idempotencyKey: "key-A" });
    assert.strictEqual(r.outcome, "claimed");
    const logs = db.getAuditLogsByEntity("ai_idempotency_claim", "key-A", 10);
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0].action, "AI_IDEM_CLAIM");
  });

  await check("אותו מפתח שוב, לפני resolve -> outcome=in_progress (לא claimed בשנית)", async () => {
    const r = claimOrReplay({ actionId: "create_task", idempotencyKey: "key-A" });
    assert.strictEqual(r.outcome, "in_progress");
  });

  await check("אחרי resolveClaim(status=success, ref=42) -> outcome=replay עם אותו ref", async () => {
    resolveClaim({ actionId: "create_task", idempotencyKey: "key-A", status: "success", ref: "42" });
    const r = claimOrReplay({ actionId: "create_task", idempotencyKey: "key-A" });
    assert.strictEqual(r.outcome, "replay");
    assert.strictEqual(r.status, "success");
    assert.strictEqual(r.ref, "42");
  });

  await check("resolveClaim(status=failed) -> מפתח פנוי לניסיון חוזר (claimed מחדש, לא replay)", async () => {
    claimOrReplay({ actionId: "create_task", idempotencyKey: "key-B" });
    resolveClaim({ actionId: "create_task", idempotencyKey: "key-B", status: "failed" });
    const r = claimOrReplay({ actionId: "create_task", idempotencyKey: "key-B" });
    assert.strictEqual(r.outcome, "claimed", "כשל לא אמור לחסום ניסיון חוזר לצמיתות");
  });

  await check("אותו מפתח אך actionId שונה -> לא מתנגש (התאמה היא לפי actionId+key ביחד)", async () => {
    resolveClaim({ actionId: "create_task", idempotencyKey: "key-C", status: "success", ref: "1" });
    const r = claimOrReplay({ actionId: "add_donor_note", idempotencyKey: "key-C" });
    assert.strictEqual(r.outcome, "claimed", "מפתח זהה אך פעולה אחרת לא אמור להיחסם/להיות מוחזר");
  });

  await check("claim ישן (מדומה כ-stale, מעל הסף) -> נתפס מחדש (claimed), לא נשאר תקוע לנצח", async () => {
    // Simulate an abandoned claim (process crashed between claim and
    // resolve): insert the claim now (real createdAt), then advance the
    // clock forward past STALE_CLAIM_MS ONLY for the staleness check —
    // simpler and less invasive than reaching into the DB to rewrite a
    // timestamp, and exercises the exact same Date.now()-based comparison
    // claimOrReplay actually uses.
    claimOrReplay({ actionId: "create_task", idempotencyKey: "key-stale" });

    const RealDateNow = Date.now;
    Date.now = () => RealDateNow() + 5 * 60 * 1000; // +5 minutes, past the 2-minute staleness threshold
    let r;
    try {
      r = claimOrReplay({ actionId: "create_task", idempotencyKey: "key-stale" });
    } finally {
      Date.now = RealDateNow;
    }
    assert.strictEqual(r.outcome, "claimed", "claim ישן מדי היה אמור להיחשב כננטש ולהיתפס מחדש");
  });

  // ─── Full framework integration (single process) ───────────────────────────

  await check("אינטגרציה מלאה: idempotencyKey זהה -> execute שני מוחזר עם ref זהה, ok:true, בלי ליצור משימה שנייה", async () => {
    process.env.AI_ACTIONS_WRITE_ENABLED = "true";
    const app = require("../../server");
    const http = require("http");
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

    const login = await apiRequest("POST", "/api/login", { workerId: 1, password: "1234" });
    let token = login.body.token;
    await apiRequest("PUT", "/api/workers/me/password", { newPassword: "NewStr0ngPass!" }, token);
    token = (await apiRequest("POST", "/api/login", { workerId: 1, password: "NewStr0ngPass!" })).body.token;

    const key = "http-idem-" + Date.now();
    const prep = await apiRequest("POST", "/api/ai/actions/prepare", {
      actionId: "create_task", params: { title: "בדיקת idempotency דרך HTTP", workerName: "מנהל מערכת" }, idempotencyKey: key,
    }, token);
    const conf = await apiRequest("POST", "/api/ai/actions/confirm", { token: prep.body.token }, token);
    const exec1 = await apiRequest("POST", "/api/ai/actions/execute", { token: conf.body.executionToken }, token);
    assert.ok(!exec1.body.idempotent, JSON.stringify(exec1.body));

    // Second prepare/confirm mint a NEW pair of tokens (simulating the
    // client retrying the whole flow after a perceived timeout) but reuse
    // the SAME idempotencyKey.
    const prep2 = await apiRequest("POST", "/api/ai/actions/prepare", {
      actionId: "create_task", params: { title: "בדיקת idempotency דרך HTTP", workerName: "מנהל מערכת" }, idempotencyKey: key,
    }, token);
    const conf2 = await apiRequest("POST", "/api/ai/actions/confirm", { token: prep2.body.token }, token);
    const exec2 = await apiRequest("POST", "/api/ai/actions/execute", { token: conf2.body.executionToken }, token);

    assert.strictEqual(exec2.body.idempotent, true, JSON.stringify(exec2.body));
    assert.strictEqual(exec2.body.task.id, exec1.body.task.id, "אמור להחזיר בדיוק את אותה משימה, לא ליצור שנייה");

    const db2 = require("../../db");
    const matching = (db2.getAppState("tasks") || []).filter((t) => t.title === "בדיקת idempotency דרך HTTP");
    assert.strictEqual(matching.length, 1, "אמורה להיווצר משימה אחת בלבד");

    await new Promise((resolve) => server.close(resolve));
  });

  // ─── The actual "survives a restart" proof — two independent subprocesses ──

  await check("אתחול מדומה: תהליך B (עצמאי לגמרי) מזהה מפתח idempotency שנוצר בתהליך A, לא יוצר משימה כפולה", async () => {
    const tmpRoot2 = fs.mkdtempSync(path.join(os.tmpdir(), "ai-idem-restart-"));
    const dbPath = path.join(tmpRoot2, "test.sqlite");
    const key = "restart-sim-" + Date.now();
    const helper = path.join(__dirname, "idempotency-restart.helper.js");
    const baseEnv = Object.assign({}, process.env, { DB_PATH: dbPath });
    delete baseEnv.NODE_ENV;

    // Process A — the "before restart" run.
    const runA = spawnSync(process.execPath, [helper, key], { env: baseEnv, encoding: "utf8", cwd: path.join(__dirname, "..", "..") });
    if (runA.status !== 0) throw new Error("process A failed: " + runA.stdout + "\n" + runA.stderr);
    const resultA = JSON.parse(runA.stdout.trim().split("\n").pop());
    assert.strictEqual(resultA.ok, true, JSON.stringify(resultA));
    assert.strictEqual(resultA.idempotent, false, "הריצה הראשונה לא אמורה להיות מזוהה כ-idempotent replay");
    assert.strictEqual(resultA.taskCountInDb, 1);

    // Process B — a COMPLETELY FRESH node process (simulates `pm2 restart`:
    // brand new module cache, brand new in-memory state, zero carryover)
    // pointed at the exact same DB file on disk, same idempotencyKey.
    const runB = spawnSync(process.execPath, [helper, key], { env: baseEnv, encoding: "utf8", cwd: path.join(__dirname, "..", "..") });
    if (runB.status !== 0) throw new Error("process B failed: " + runB.stdout + "\n" + runB.stderr);
    const resultB = JSON.parse(runB.stdout.trim().split("\n").pop());

    assert.strictEqual(resultB.ok, true, JSON.stringify(resultB));
    assert.strictEqual(resultB.idempotent, true, "תהליך B (אחרי 'אתחול') היה אמור לזהות את המפתח כבר נפתר — לא ליצור עוד משימה");
    assert.strictEqual(resultB.taskId, resultA.taskId, "אמור להחזיר בדיוק את אותו מזהה משימה");
    assert.strictEqual(resultB.taskCountInDb, 1, "אחרי 'אתחול', עדיין אמורה להיות רק משימה אחת בקובץ ה-DB המשותף");
  });

  // ── סיכום ────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  results.forEach((r) => {
    console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : "\n    " + r.error));
  });
  console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");
  process.exitCode = failed.length ? 1 : 0;
}

main();

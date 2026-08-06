// ai/tests/partial-failure.test.js — Phase F: partial-failure reporting.
// Registers a throwaway multi-target test action (not part of the real
// low-risk/high-risk registries) purely to exercise the framework's
// partial-failure contract end-to-end: execute() may return
// { partialFailure: true, succeeded: [...], failed: [...], summary }
// instead of a hard success/failure, and the framework must surface that
// distinctly (outcome recorded as 'partial_failure', not 'success' or
// 'failed'; response still ok:true since the call itself completed).
//
// הרצה: node frontend/backend/ai/tests/partial-failure.test.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-partial-failure-test-"));
process.env.DB_PATH = path.join(tmpRoot, "test.sqlite");
delete process.env.NODE_ENV;

const db = require("../../db");
const aiActions = require("../actions");
const { ROLES } = require("../capabilities");

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, error: err.stack || err.message });
  }
}

// A deliberately synthetic action: "tag N donors", where donor #2 always
// fails (simulates e.g. a donor deleted between prepare and execute).
aiActions.registerAction({
  id:          "test_bulk_tag_probe",
  domain:      "test",
  description: "בדיקה בלבד — לא פעולה אמיתית",
  roles:       [ROLES.ADMIN],
  riskTier:    "low",
  async prepare(params) {
    return {
      targetType: "test_batch",
      targetId: null,
      targetLabel: "בדיקה",
      previewHebrew: "בדיקת דיווח כשל חלקי",
      canonicalParams: { ids: params.ids || [] },
    };
  },
  async execute(p) {
    const succeeded = [];
    const failed = [];
    p.ids.forEach((id) => {
      if (id === 2) failed.push({ id, reason: "תורם לא נמצא (סימולציה)" });
      else succeeded.push({ id });
    });
    if (failed.length && succeeded.length) {
      return { partialFailure: true, succeeded, failed, summary: "partial: " + succeeded.length + " ok, " + failed.length + " failed" };
    }
    if (failed.length) return { ok: false, summary: "all_failed" };
    return { ok: true, summary: "all_succeeded", succeeded };
  },
});

async function main() {
  await check("[בטיחות] הבדיקה פועלת מול DB זמני, לא מול data.sqlite האמיתי", async () => {
    assert.ok(db.DB_PATH.indexOf(tmpRoot) === 0);
  });

  const worker = { id: 1, name: "מנהל בדיקה", role: "ADMIN" };
  // findWorkerById inside the framework needs a real active worker row —
  // seed one matching id 1 (default admin seed already provides this).

  let execResult;
  await check("execute עם כשל חלקי -> partialFailure:true, ok:true (השיחה עצמה הצליחה), succeeded/failed מפורטים", async () => {
    const prep = await aiActions.prepareAction({ actionId: "test_bulk_tag_probe", params: { ids: [1, 2, 3] }, worker, ip: "127.0.0.1" });
    assert.ok(prep.token, JSON.stringify(prep));
    const conf = aiActions.confirmAction({ token: prep.token, worker, ip: "127.0.0.1" });
    assert.ok(conf.executionToken, JSON.stringify(conf));
    execResult = await aiActions.executeAction({ token: conf.executionToken, worker, ip: "127.0.0.1" });

    assert.strictEqual(execResult.partialFailure, true);
    assert.strictEqual(execResult.ok, true, "כשל חלקי עדיין נחשב 'הקריאה עצמה בוצעה', לא כשל מוחלט");
    assert.strictEqual(execResult.succeeded.length, 2);
    assert.strictEqual(execResult.failed.length, 1);
    assert.strictEqual(execResult.failed[0].id, 2);
  });

  await check("audit: השלב execute נרשם עם outcome=partial_failure, לא success ולא failed", async () => {
    const logs = db.getAuditLogs(50);
    const row = logs.find((l) => l.action === "AI_ACTION_EXECUTE" && l.details.indexOf("test_bulk_tag_probe") !== -1);
    assert.ok(row, "לא נמצאה רשומת audit לביצוע");
    assert.ok(row.details.indexOf("outcome=partial_failure") !== -1, row.details);
  });

  await check("כשל מלא (כל היעדים נכשלים) -> ok:false, לא partialFailure", async () => {
    const prep = await aiActions.prepareAction({ actionId: "test_bulk_tag_probe", params: { ids: [2] }, worker, ip: "127.0.0.1" });
    const conf = aiActions.confirmAction({ token: prep.token, worker, ip: "127.0.0.1" });
    const exec = await aiActions.executeAction({ token: conf.executionToken, worker, ip: "127.0.0.1" });
    assert.strictEqual(exec.ok, false);
    assert.ok(!exec.partialFailure);
  });

  await check("הצלחה מלאה -> ok:true, אין partialFailure", async () => {
    const prep = await aiActions.prepareAction({ actionId: "test_bulk_tag_probe", params: { ids: [1, 3] }, worker, ip: "127.0.0.1" });
    const conf = aiActions.confirmAction({ token: prep.token, worker, ip: "127.0.0.1" });
    const exec = await aiActions.executeAction({ token: conf.executionToken, worker, ip: "127.0.0.1" });
    assert.strictEqual(exec.ok, true);
    assert.ok(!exec.partialFailure);
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

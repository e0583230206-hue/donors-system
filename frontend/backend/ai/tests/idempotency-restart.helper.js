// ai/tests/idempotency-restart.helper.js — NOT a *.test.js file (deliberately
// — spawned as a subprocess by ai/tests/idempotency.test.js, one process per
// simulated "run", each with a completely fresh require cache/module state,
// sharing only the DB_PATH file on disk. This is what actually proves
// idempotency survives a process restart — an in-process re-require can't
// prove that, since Node caches modules within one process regardless.
//
// Usage: DB_PATH=<path> node idempotency-restart.helper.js <idempotencyKey>
// Prints one JSON line: the full execute() result for create_task.

const idempotencyKey = process.argv[2];
if (!idempotencyKey) { console.error("usage: node idempotency-restart.helper.js <idempotencyKey>"); process.exit(2); }
if (!process.env.DB_PATH) { console.error("DB_PATH env var required"); process.exit(2); }

delete process.env.NODE_ENV;
process.env.AI_ACTIONS_WRITE_ENABLED = "true";

require("../../server"); // wires up lowrisk.js (create_task) exactly like a real deployment
const aiActions = require("../actions");

async function main() {
  const worker = { id: 1, name: "מנהל מערכת", role: "ADMIN" };
  const prep = await aiActions.prepareAction({
    actionId: "create_task",
    params: { title: "משימת בדיקת עמידות לאתחול", workerName: "מנהל מערכת" },
    worker, ip: "127.0.0.1",
    idempotencyKey,
  });
  if (prep.error) { console.log(JSON.stringify({ stage: "prepare", error: prep.error, code: prep.code })); return; }

  const conf = aiActions.confirmAction({ token: prep.token, worker, ip: "127.0.0.1" });
  if (conf.error) { console.log(JSON.stringify({ stage: "confirm", error: conf.error, code: conf.code })); return; }

  const exec = await aiActions.executeAction({ token: conf.executionToken, worker, ip: "127.0.0.1" });
  const db = require("../../db");
  const tasks = db.getAppState("tasks") || [];
  console.log(JSON.stringify({
    stage: "execute",
    ok: exec.ok, idempotent: !!exec.idempotent,
    taskId: exec.task ? exec.task.id : null,
    taskCountInDb: tasks.length,
  }));
}

main();

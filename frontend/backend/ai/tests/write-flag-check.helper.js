// ai/tests/write-flag-check.helper.js — NOT a *.test.js file (deliberately,
// so scripts/run-tests.js never tries to run it standalone). A small
// subprocess helper spawned by ai/tests/write-flag.test.js once per
// AI_ACTIONS_WRITE_ENABLED value, since that flag is read once at module
// load time — testing "missing/false/true" in a single process would
// require clearing the require cache for a whole tree of interdependent
// singleton registries (capabilities.js, ai/actions/index.js, detector.js's
// bootstrap...), which is fragile. A fresh process per env value is the
// same pattern the codebase already uses (scripts/run-tests.js itself
// spawns every test file as its own process; audit-ivr-audio-slots.test.js
// tests its own --check subcommand via execFileSync).
//
// Prints one JSON line to stdout: capability statuses for the three
// low-risk actions, plus the actual result of attempting prepareAction()
// for create_task and add_donor_note (proving rejection happens for real,
// not just that the registry label says "disabled").

const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "write-flag-check-"));
process.env.DB_PATH = path.join(tmpRoot, "test.sqlite");
delete process.env.NODE_ENV;

require("../../server"); // wires up lowrisk.js + highrisk.js as a real deployment would
const caps = require("../capabilities");
const aiActions = require("../actions");

async function main() {
  const worker = { id: 1, name: "מנהל בדיקה", role: "ADMIN" };

  const statuses = {
    create_task: caps.getCapability("action.create_task").status,
    add_donor_note: caps.getCapability("action.add_donor_note").status,
    prepare_campaign_recipients: caps.getCapability("action.prepare_campaign_recipients").status,
  };

  const createTaskAttempt = await aiActions.prepareAction({
    actionId: "create_task",
    params: { title: "בדיקת דגל", workerName: "מנהל בדיקה" },
    worker, ip: "127.0.0.1",
  });

  const addNoteAttempt = await aiActions.prepareAction({
    actionId: "add_donor_note",
    params: { donorId: 1, text: "x" },
    worker, ip: "127.0.0.1",
  });

  const campaignAttempt = await aiActions.prepareAction({
    actionId: "prepare_campaign_recipients",
    params: { recipientFilter: "all" },
    worker, ip: "127.0.0.1",
  });

  // Directly test confirm/execute's OWN rejection, independent of prepare —
  // craft a "prepared"-stage token by hand (bypassing prepareAction, which
  // is already blocked when disabled) so confirmAction/executeAction's own
  // isAllowed() check is what's actually being proven here, not just
  // prepareAction's.
  const now = Date.now();
  const forgedPrepareToken = aiActions._internal.sign({
    actionId: "create_task", workerId: worker.id, stage: "prepared",
    targetType: "task", targetId: null,
    canonicalParams: { title: "פורג'ד", workerName: "מנהל בדיקה", priority: "רגיל", dueDate: "", description: "", donorId: null },
    idempotencyKey: null, issuedAt: now, expiresAt: now + 600000,
  });
  const confirmAttempt = aiActions.confirmAction({ token: forgedPrepareToken, worker, ip: "127.0.0.1" });

  const forgedExecToken = aiActions._internal.sign({
    actionId: "create_task", workerId: worker.id, stage: "confirmed",
    targetType: "task", targetId: null,
    canonicalParams: { title: "פורג'ד", workerName: "מנהל בדיקה", priority: "רגיל", dueDate: "", description: "", donorId: null },
    idempotencyKey: null, issuedAt: now, expiresAt: now + 600000,
  });
  const executeAttempt = await aiActions.executeAction({ token: forgedExecToken, worker, ip: "127.0.0.1" });

  console.log(JSON.stringify({
    envValue: process.env.AI_ACTIONS_WRITE_ENABLED === undefined ? "(missing)" : process.env.AI_ACTIONS_WRITE_ENABLED,
    statuses,
    createTaskAttempt: { error: createTaskAttempt.error || null, code: createTaskAttempt.code || null, ok: !createTaskAttempt.error },
    addNoteAttempt: { error: addNoteAttempt.error || null, code: addNoteAttempt.code || null, ok: !addNoteAttempt.error },
    campaignAttempt: { error: campaignAttempt.error || null, code: campaignAttempt.code || null, ok: !campaignAttempt.error },
    confirmAttempt: { error: confirmAttempt.error || null, code: confirmAttempt.code || null, ok: !confirmAttempt.error },
    executeAttempt: { error: executeAttempt.error || null, code: executeAttempt.code || null, ok: executeAttempt.ok !== false && !executeAttempt.error },
  }));
}

main();

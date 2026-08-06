// ai/tests/write-flag.test.js — Phase F write-action deny-by-default flag
// (AI_ACTIONS_WRITE_ENABLED). Covers missing/false/true states.
//
// הרצה: node frontend/backend/ai/tests/write-flag.test.js

const assert = require("assert");
const path = require("path");
const { spawnSync } = require("child_process");

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, error: err.stack || err.message });
  }
}

const HELPER = path.join(__dirname, "write-flag-check.helper.js");

function runWithFlag(envValue) {
  const env = Object.assign({}, process.env);
  if (envValue === undefined) {
    delete env.AI_ACTIONS_WRITE_ENABLED;
  } else {
    env.AI_ACTIONS_WRITE_ENABLED = envValue;
  }
  const result = spawnSync(process.execPath, [HELPER], { cwd: path.join(__dirname, "..", ".."), env, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error("helper process exited " + result.status + "\nstdout:\n" + result.stdout + "\nstderr:\n" + result.stderr);
  }
  const lastLine = result.stdout.trim().split("\n").pop();
  return JSON.parse(lastLine);
}

// ─── missing (flag not set at all) — must default to disabled ───────────────
check("AI_ACTIONS_WRITE_ENABLED חסר לגמרי -> create_task/add_donor_note disabled כברירת מחדל", () => {
  const r = runWithFlag(undefined);
  assert.strictEqual(r.envValue, "(missing)");
  assert.strictEqual(r.statuses.create_task, "disabled");
  assert.strictEqual(r.statuses.add_donor_note, "disabled");
});

check("חסר: prepareAction(create_task) נדחה בפועל עם forbidden", () => {
  const r = runWithFlag(undefined);
  assert.strictEqual(r.createTaskAttempt.ok, false);
  assert.strictEqual(r.createTaskAttempt.code, "forbidden");
});

check("חסר: prepareAction(add_donor_note) נדחה בפועל עם forbidden", () => {
  const r = runWithFlag(undefined);
  assert.strictEqual(r.addNoteAttempt.ok, false);
  assert.strictEqual(r.addNoteAttempt.code, "forbidden");
});

check("חסר: prepare_campaign_recipients (קריאה בלבד) עדיין enabled ועובד — לא מושפע מהדגל", () => {
  const r = runWithFlag(undefined);
  assert.strictEqual(r.statuses.prepare_campaign_recipients, "enabled");
  assert.strictEqual(r.campaignAttempt.ok, true, JSON.stringify(r.campaignAttempt));
});

check("חסר: confirmAction נדחה גם עם אסימון 'prepared' מזויף ידנית (החסימה היא ב-confirm עצמו, לא רק ב-prepare)", () => {
  const r = runWithFlag(undefined);
  assert.strictEqual(r.confirmAttempt.ok, false);
  assert.strictEqual(r.confirmAttempt.code, "forbidden");
});

check("חסר: executeAction נדחה גם עם אסימון 'confirmed' מזויף ידנית (החסימה היא ב-execute עצמו)", () => {
  const r = runWithFlag(undefined);
  assert.strictEqual(r.executeAttempt.ok, false);
  assert.strictEqual(r.executeAttempt.code, "forbidden");
});

// ─── explicit "false" — must behave identically to missing ──────────────────
check('AI_ACTIONS_WRITE_ENABLED="false" -> disabled, זהה למצב חסר', () => {
  const r = runWithFlag("false");
  assert.strictEqual(r.statuses.create_task, "disabled");
  assert.strictEqual(r.statuses.add_donor_note, "disabled");
  assert.strictEqual(r.createTaskAttempt.ok, false);
  assert.strictEqual(r.createTaskAttempt.code, "forbidden");
});

// ─── any non-"true" garbage value — must still default to disabled ──────────
check('AI_ACTIONS_WRITE_ENABLED="yes" (ערך לא תקני) -> disabled (רק המחרוזת המדויקת "true" מפעילה)', () => {
  const r = runWithFlag("yes");
  assert.strictEqual(r.statuses.create_task, "disabled");
});

// ─── explicit "true" — must enable both write actions ────────────────────────
check('AI_ACTIONS_WRITE_ENABLED="true" -> create_task/add_donor_note enabled', () => {
  const r = runWithFlag("true");
  assert.strictEqual(r.statuses.create_task, "enabled");
  assert.strictEqual(r.statuses.add_donor_note, "enabled");
});

check('true: prepareAction(create_task) עובר בפועל (לא נדחה)', () => {
  const r = runWithFlag("true");
  assert.strictEqual(r.createTaskAttempt.ok, true, JSON.stringify(r.createTaskAttempt));
});

check('true: confirmAction/executeAction לא נחסמים יותר על ידי בדיקת ה-status (יכולים להיכשל מסיבות אחרות, אבל לא code=forbidden)', () => {
  const r = runWithFlag("true");
  assert.notStrictEqual(r.confirmAttempt.code, "forbidden", JSON.stringify(r.confirmAttempt));
  assert.notStrictEqual(r.executeAttempt.code, "forbidden", JSON.stringify(r.executeAttempt));
});

check('true: prepareAction(add_donor_note) עובר בפועל (לא נדחה) — התורם עדיין לא קיים ב-DB זמני, אז השגיאה (אם יש) חייבת להיות "לא נמצא", לא "forbidden"', () => {
  const r = runWithFlag("true");
  // donorId:1 doesn't exist in the helper's fresh temp DB — that's a
  // legitimate business-logic rejection, NOT a permission rejection. The
  // flag test only cares that it's no longer blocked by the flag.
  assert.notStrictEqual(r.addNoteAttempt.code, "forbidden");
});

// ── סיכום ────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
results.forEach((r) => {
  console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : "\n    " + r.error));
});
console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");
process.exitCode = failed.length ? 1 : 0;

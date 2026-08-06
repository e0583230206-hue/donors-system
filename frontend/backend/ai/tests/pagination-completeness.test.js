// ai/tests/pagination-completeness.test.js — when a result list is capped,
// the assistant must say so explicitly rather than let a partial list look
// like the full picture (search disambiguation, and every "recent N" style
// extended-domain read).
//
// הרצה: node frontend/backend/ai/tests/pagination-completeness.test.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-pagination-test-"));
process.env.DB_PATH = path.join(tmpRoot, "test.sqlite");
delete process.env.NODE_ENV;

const db = require("../../db");
const { searchDonors } = require("../search");
const { queryAI } = require("../../ai");

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
  await check("[בטיחות] הבדיקה פועלת מול DB זמני, לא מול data.sqlite האמיתי", async () => {
    assert.ok(db.DB_PATH.indexOf(tmpRoot) === 0);
  });

  await check("searchDonors: כשיש יותר תוצאות מה-limit, total משקף את המספר האמיתי ו-truncated=true", async () => {
    const donors = [];
    for (let i = 1; i <= 15; i++) {
      donors.push({ id: i, fullName: "תורם משותף " + i, city: "עיר", tags: [] });
    }
    db.setAppState("donors", donors);

    const r = searchDonors("תורם משותף", { field: "name", limit: 5 });
    assert.strictEqual(r.status, "ambiguous");
    assert.strictEqual(r.total, 15, "total אמור לשקף את כל 15 ההתאמות, לא רק את 5 שהוצגו");
    assert.strictEqual(r.matches.length, 5, "matches מוגבל ל-limit");
    assert.strictEqual(r.truncated, true);
    assert.ok(r.clarifyQ.includes("15"), "שאלת ההבהרה אמורה לציין את המספר האמיתי (15), לא רק 5: " + r.clarifyQ);
  });

  await check("searchDonors: כשכל התוצאות מוצגות, truncated אינו true", async () => {
    const r = searchDonors("תורם משותף", { field: "name", limit: 50 });
    assert.strictEqual(r.total, 15);
    assert.ok(!r.truncated);
  });

  await check("audit_recent: כשמגיעים לתקרה (15), התשובה אומרת זאת במפורש ולא מציגה כרשימה סופית", async () => {
    for (let i = 0; i < 20; i++) {
      db.insertAuditLog({ action: "TEST_ACTION_" + i, entityType: "test", workerId: 1, workerName: "בדיקה", ip: "127.0.0.1" });
    }
    const r = await queryAI({ question: "יומן ביקורת אחרון", donorId: null, history: [], pageContext: "global", role: "ADMIN" });
    assert.ok(r.answer.includes("15") && (r.answer.includes("ייתכן שיש רשומות נוספות") || r.answer.includes("לא ההיסטוריה המלאה")),
      "התשובה אמורה לציין שזו לא הרשימה המלאה: " + r.answer);
  });

  await check("click2call_recent: כשאין נתונים, אין מוצג caveat מיותר (0 < cap)", async () => {
    const r = await queryAI({ question: "חיוגים אחרונים מהמערכת", donorId: null, history: [], pageContext: "global", role: "ADMIN" });
    assert.ok(!r.answer.includes("ייתכן שיש רשומות נוספות"), "אין סיבה להראות caveat כשאין בכלל תוצאות");
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

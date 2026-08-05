// ai/tests/extended.test.js — Phase D: extended read/explain coverage
// (IVR monitor, Click2Call, payments, audit history, Alfon sync, IVR audio
// recordings, settings overview) — including per-domain role gating that
// mirrors the underlying REST route each handler reuses data from.
//
// הרצה: node frontend/backend/ai/tests/extended.test.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-extended-test-"));
process.env.DB_PATH = path.join(tmpRoot, "test.sqlite");
delete process.env.NODE_ENV;

const { queryAI } = require("../../ai");
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

const ADMIN_ONLY = ["ivr_status", "audit_recent", "alfon_sync_status", "recordings_overview"];
const BOTH_ROLES = ["click2call_recent", "payments_stats", "settings_overview"];

const QUESTION_FOR = {
  ivr_status:          "ניטור מוקד",
  click2call_recent:   "חיוגים אחרונים מהמערכת",
  payments_stats:      "פירוט טבלת תשלומים",
  audit_recent:        "יומן ביקורת אחרון",
  alfon_sync_status:   "קבצים ממתינים לאישור אלפון",
  recordings_overview: "רשימת הקלטות מוגדרות",
  settings_overview:   "כמה עובדים פעילים יש",
};

async function main() {
  await check("[בטיחות] הבדיקה פועלת מול DB זמני, לא מול data.sqlite האמיתי", async () => {
    assert.ok(db.DB_PATH.indexOf(tmpRoot) === 0);
  });

  for (const intent of ADMIN_ONLY.concat(BOTH_ROLES)) {
    await check("זיהוי כוונה נכון עבור '" + QUESTION_FOR[intent] + "' -> " + intent, async () => {
      const r = await queryAI({ question: QUESTION_FOR[intent], donorId: null, history: [], pageContext: "global", role: "ADMIN" });
      assert.strictEqual(r.intent, intent, "זוהתה כוונה שגויה: " + r.intent);
    });
  }

  for (const intent of ADMIN_ONLY) {
    await check(intent + ": ADMIN מקבל תשובה אמיתית", async () => {
      const r = await queryAI({ question: QUESTION_FOR[intent], donorId: null, history: [], pageContext: "global", role: "ADMIN" });
      assert.ok(!r.answer.includes("אין הרשאה"), "מנהל נחסם בטעות: " + r.answer);
    });
    await check(intent + ": SECRETARY נחסם (ADMIN-only, תואם את ה-REST route המקביל)", async () => {
      const r = await queryAI({ question: QUESTION_FOR[intent], donorId: null, history: [], pageContext: "global", role: "SECRETARY" });
      assert.ok(r.answer.includes("אין הרשאה"), "מזכיר/ה לא היה אמור לקבל גישה: " + r.answer);
    });
  }

  for (const intent of BOTH_ROLES) {
    await check(intent + ": גם ADMIN וגם SECRETARY מקבלים תשובה", async () => {
      const rA = await queryAI({ question: QUESTION_FOR[intent], donorId: null, history: [], pageContext: "global", role: "ADMIN" });
      const rS = await queryAI({ question: QUESTION_FOR[intent], donorId: null, history: [], pageContext: "global", role: "SECRETARY" });
      assert.ok(!rA.answer.includes("אין הרשאה"));
      assert.ok(!rS.answer.includes("אין הרשאה"));
    });
  }

  await check("payments_stats: אין [object Object] בפלט (בעיית פורמט נבדקת)", async () => {
    const r = await queryAI({ question: QUESTION_FOR.payments_stats, donorId: null, history: [], pageContext: "global", role: "ADMIN" });
    assert.ok(!r.answer.includes("[object Object]"), r.answer);
  });

  await check("settings_overview: לעולם לא חושף sip pass/user (אפילו לא כשדה ריק)", async () => {
    db.setAppState("sip_config", { server: "sip.example.com", ext: "100", user: "secretuser", pass: "SuperSecretPass123" });
    const r = await queryAI({ question: QUESTION_FOR.settings_overview, donorId: null, history: [], pageContext: "global", role: "ADMIN" });
    assert.ok(!r.answer.includes("SuperSecretPass123"), "סיסמת SIP דלפה לתשובת ה-AI!");
    assert.ok(!r.answer.includes("secretuser"), "שם משתמש SIP דלף לתשובת ה-AI!");
  });

  await check("כל היכולות המורחבות רשומות ברישום עם domain='extended'", async () => {
    Object.keys(QUESTION_FOR).forEach((intent) => {
      const cap = caps.getCapability("read." + intent);
      assert.ok(cap, "חסרה יכולת עבור " + intent);
      assert.strictEqual(cap.domain, "extended");
    });
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

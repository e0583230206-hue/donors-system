"use strict";
// ai/actions/highrisk.js — Phase G: high-risk action DEFINITIONS ONLY.
//
// These register the registry entries (id, roles, risk tier, description)
// and a safe placeholder execute() so the shape/contract exists for future
// review — but NONE of them call any real payment/campaign/telephony
// integration. That is deliberate: the task's non-negotiable rules forbid
// ever executing real payments, cancellations, refunds, debt changes, bulk
// donor edits, calls, messages, recordings, campaign sends, or email sends.
// Wiring any of these to the real business function is explicitly future
// work requiring its own separate owner approval — not something this
// phase does "if the flag happens to be on".
//
// Deny-by-default flag: AI_ACTIONS_HIGH_RISK_ENABLED. Absent/anything other
// than the exact string "true" == disabled. Read ONCE at process start (an
// env var can't change under a running process without a restart anyway,
// and restarts require separate explicit approval per the project's
// standing rules) — so this is a real deny-by-default gate, not a runtime
// toggle a compromised request could flip.
const HIGH_RISK_ENABLED = process.env.AI_ACTIONS_HIGH_RISK_ENABLED === "true";

const { registerAction } = require("./index");
const { ROLES } = require("../capabilities");

// Every high-risk action shares the same refusal — defense in depth beyond
// the registry's status:"disabled" gate (which already blocks prepare/
// confirm/execute from ever reaching this code while the flag is off).
function refuse() {
  return {
    ok: false,
    summary: "high_risk_action_disabled",
    error: "פעולה זו מוגדרת ברמת סיכון גבוהה ואינה מופעלת במערכת. " +
      "היא דורשת אישור בעלים מפורש והפעלה ידנית של AI_ACTIONS_HIGH_RISK_ENABLED " +
      "יחד עם חיבור בפועל לפונקציית השירות הרלוונטית — שניהם לא בוצעו.",
  };
}

function definePlaceholder(id, domain, description) {
  registerAction({
    id,
    domain,
    description,
    roles:       [ROLES.ADMIN],
    riskTier:    "high",
    requiresConfirmation: true,
    implemented: false, // registry-only — real business logic not wired up
    status:      HIGH_RISK_ENABLED ? "enabled" : "disabled",
    testCoverage: ["ai/tests/highrisk.test.js"],
    serviceFn:   null, // intentionally not wired to any real service function yet

    async prepare() {
      // Even if somehow reached (it shouldn't be — isAllowed() blocks this
      // whole stage while status is "disabled"), never produce a real preview
      // of an action that cannot execute.
      return { error: "פעולה ברמת סיכון גבוהה אינה זמינה" };
    },

    async execute() {
      return refuse();
    },
  });
}

definePlaceholder("process_payment",   "payments",  "עיבוד תשלום בפועל (חיוב אשראי/הפקדה) — לא ממומש, לא מופעל");
definePlaceholder("cancel_donation",   "payments",  "ביטול תרומה קיימת — לא ממומש, לא מופעל");
definePlaceholder("issue_refund",      "payments",  "ביצוע החזר כספי — לא ממומש, לא מופעל");
definePlaceholder("modify_debt",       "payments",  "שינוי ידני של סכום חוב תורם — לא ממומש, לא מופעל");
definePlaceholder("bulk_donor_edit",   "donor",     "עריכה המונית של רשומות תורמים — לא ממומש, לא מופעל");
definePlaceholder("initiate_call",     "softphone", "יזום שיחה יוצאת (click2call) — לא ממומש, לא מופעל");
definePlaceholder("send_sms_message",  "campaigns", "שליחת הודעת טקסט לתורם/ים — לא ממומש, לא מופעל");
definePlaceholder("send_campaign",     "campaigns", "שיגור קמפיין בפועל דרך טכנוליין — לא ממומש, לא מופעל");
definePlaceholder("delete_recording",  "ivr",       "מחיקת הקלטת IVR — לא ממומש, לא מופעל");
definePlaceholder("send_email",        "campaigns", "שליחת דוא\"ל — לא ממומש, לא מופעל (ואין תשתית דוא\"ל יוצא במערכת כלל)");

module.exports = { HIGH_RISK_ENABLED };

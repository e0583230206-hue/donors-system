"use strict";
// ai/handlers/extended.js — Phase D: read/explain coverage for domains
// beyond donor/system/insight — IVR monitor, Click2Call, payments, audit
// history (ADMIN-only), Alfon sync, IVR audio recordings, and a safe
// (non-secret) settings overview. Every handler here only reads through
// existing db.js functions — no new queries, no new tables, no writes.
//
// Campaigns and calendar are intentionally NOT duplicated here:
//   - campaigns: the existing prepare_campaign_recipients action's
//     prepare() stage already answers "what would this campaign filter
//     resolve to" without sending anything — building a second, near-
//     identical read-only path here would duplicate that logic.
//   - calendar: system_upcoming_rem / system_open_tasks (ai/handlers/
//     system.js, already registered before Phase D) already cover
//     reminders/tasks — the calendar screen has no data of its own beyond
//     those two.
//
// NOTE (known limitation, see final report): these handlers are wired into
// the LOCAL engine only. ai/engines/openai.js does not yet know about these
// domains — if OPENAI_API_KEY is ever set, a question that would route here
// still falls through to OpenAI's existing donor/global-context answer
// instead of an extended-domain-aware one. Not a privacy issue (the
// allow-list sanitizer still applies to whatever OpenAI *does* receive),
// just reduced answer quality for these specific domains until openai.js
// is extended too.

const {
  getIvrMonitorStats, getIvrAlerts, getRecentClick2CallLogs,
  getPaymentStats, getAuditLogs, getAlfonPending,
  getIvrAudioRecordings, countIvrAudioRecordings, getWorkers,
} = require("../../db");
const { registerCapability, ROLES } = require("../capabilities");

function fmtMoney(n) { return "₪" + Number(n || 0).toLocaleString("he-IL"); }

// ─── ivr_status ────────────────────────────────────────────────────────────
function ivrStatus() {
  const stats  = getIvrMonitorStats();
  const alerts = getIvrAlerts(30) || [];
  return {
    summary: "מצב ה-IVR היום (" + stats.date + "): " + stats.calls + " שיחות, " +
      stats.payments + " תשלומים (" + fmtMoney(stats.paymentsTotal) + ")",
    metrics: [
      { label: "שיחות היום",    value: String(stats.calls) },
      { label: "תשלומים היום",   value: String(stats.payments) },
      { label: "סה\"כ נגבה היום", value: fmtMoney(stats.paymentsTotal) },
      { label: "הודעות קוליות",  value: String(stats.voicemails) },
      { label: "שגיאות",         value: String(stats.errors) },
    ],
    sections: alerts.length ? [{
      title: "התראות אחרונות", urgent: true,
      items: alerts.slice(0, 10).map((a) => (a.time || "") + " — " + (a.type || a.step || "?")),
    }] : [],
    conclusion: alerts.length ? "יש " + alerts.length + " התראות לבדיקה." : "אין התראות פתוחות.",
    recommendation: stats.errors > 0 ? "לבדוק את השגיאות האחרונות במסך ניטור ה-IVR." : "אין פעולה נדרשת כרגע.",
    suggestions: ["הודעות קוליות היום", "תשלומים דרך IVR היום", "התראות אחרונות"],
  };
}

// ─── click2call_recent ─────────────────────────────────────────────────────
function click2callRecent() {
  const logs = getRecentClick2CallLogs(10) || [];
  return {
    summary: logs.length ? "בוצעו " + logs.length + " שיחות Click2Call אחרונות" : "לא בוצעו שיחות Click2Call לאחרונה",
    metrics: [{ label: "שיחות אחרונות", value: String(logs.length) }],
    sections: logs.length ? [{
      title: "שיחות אחרונות",
      items: logs.map((l) => (l.createdAt || "") + " — " + (l.donorName || l.phone || "?") + (l.status ? " (" + l.status + ")" : "")),
    }] : [],
    conclusion: "", recommendation: "",
    suggestions: ["מצב ה-IVR היום"],
  };
}

// ─── payments_stats ─────────────────────────────────────────────────────────
// getPaymentStats() returns { today:{count,total}, week:{count,total}, month:{count,total} }
function paymentsStats() {
  const stats = getPaymentStats() || {};
  const period = (label, p) => label + ": " + (p ? p.count + " תשלומים, " + fmtMoney(p.total) : "אין נתונים");
  return {
    summary: "סטטיסטיקת תשלומים (טבלת payments): " + (stats.today ? stats.today.count : 0) + " היום",
    metrics: [
      { label: "היום",  value: stats.today ? fmtMoney(stats.today.total) : fmtMoney(0) },
      { label: "השבוע", value: stats.week  ? fmtMoney(stats.week.total)  : fmtMoney(0) },
      { label: "החודש", value: stats.month ? fmtMoney(stats.month.total) : fmtMoney(0) },
    ],
    sections: [{
      title: "פירוט לפי תקופה",
      items: [period("היום", stats.today), period("השבוע", stats.week), period("החודש", stats.month)],
    }],
    conclusion: "", recommendation: "",
    suggestions: ["מצב ה-IVR היום", "סה\"כ שולם במערכת"],
  };
}

// ─── audit_recent — ADMIN only ──────────────────────────────────────────────
function auditRecent() {
  const logs = getAuditLogs(15) || [];
  return {
    summary: "15 הפעולות האחרונות ביומן הביקורת",
    metrics: [],
    sections: [{
      title: "פעילות אחרונה",
      items: logs.map((l) => (l.createdAt || "") + " — " + l.action + " (" + (l.workerName || "?") + ")"),
    }],
    conclusion: "", recommendation: "",
    suggestions: ["מצב המערכת"],
  };
}

// ─── alfon_sync_status ──────────────────────────────────────────────────────
function alfonSyncStatus() {
  const pending = getAlfonPending() || [];
  const waiting = pending.filter((p) => p.status === "pending");
  return {
    summary: waiting.length
      ? "יש " + waiting.length + " קבצי אלפון הממתינים לסקירה"
      : "אין קבצי אלפון הממתינים לסקירה כרגע",
    metrics: [
      { label: "ממתינים לסקירה", value: String(waiting.length) },
      { label: "סה\"כ ברשימה (30 אחרונים)", value: String(pending.length) },
    ],
    sections: waiting.length ? [{
      title: "ממתינים לסקירה",
      items: waiting.slice(0, 10).map((p) => (p.createdAt || "") + " — " + p.filename),
    }] : [],
    conclusion: "", recommendation: waiting.length ? "לסקור את קבצי האלפון הממתינים במסך הסנכרון." : "",
    suggestions: ["מצב המערכת"],
  };
}

// ─── recordings_overview ───────────────────────────────────────────────────
function recordingsOverview() {
  const all = getIvrAudioRecordings() || [];
  const count = countIvrAudioRecordings();
  const missing = all.filter((r) => !r.filename && !r.audioFile1);
  return {
    summary: "יש " + count + " רשומות הקלטת IVR מוגדרות במערכת",
    metrics: [
      { label: "סה\"כ רשומות", value: String(count) },
      { label: "ללא קובץ מוגדר", value: String(missing.length) },
    ],
    sections: [],
    conclusion: "", recommendation: "",
    suggestions: ["מצב ה-IVR היום"],
  };
}

// ─── settings_overview — deliberately excludes sip_config entirely ────────
// SIP_PASS/SIP_USER are PBX credentials returned by GET /api/sip-config —
// this handler never touches that key at all, even to check whether it's
// configured, so a credential can never end up in an AI chat transcript.
function settingsOverview() {
  const workers = getWorkers() || [];
  const active  = workers.filter((w) => w.status === "פעיל");
  const recCount = countIvrAudioRecordings();
  return {
    summary: "סקירת הגדרות מערכת (ללא פרטי התחברות/סודות)",
    metrics: [
      { label: "עובדים פעילים",   value: String(active.length) },
      { label: "סה\"כ עובדים",     value: String(workers.length) },
      { label: "רשומות הקלטת IVR", value: String(recCount) },
    ],
    sections: [],
    conclusion: "",
    recommendation: "פרטי חיבור/סיסמאות אינם מוצגים כאן — לצפייה יש לפנות למסך ההגדרות ישירות.",
    suggestions: ["מצב המערכת"],
  };
}

const HANDLERS = {
  ivr_status:          ivrStatus,
  click2call_recent:   click2callRecent,
  payments_stats:      paymentsStats,
  audit_recent:        auditRecent,
  alfon_sync_status:   alfonSyncStatus,
  recordings_overview: recordingsOverview,
  settings_overview:   settingsOverview,
};

// Per-intent role gates, each mirroring the exact REST route that already
// serves the same underlying data (not a new boundary invented here):
//   ivr_status          <- GET /api/admin/ivr-monitor        (ADMIN only)
//   audit_recent         <- GET /api/admin/audit-log          (ADMIN only)
//   alfon_sync_status    <- GET /api/sync/alfon-pending        (ADMIN only)
//   recordings_overview  <- /api/admin/ivr-audio/* subrouter   (ADMIN only)
//   click2call_recent    <- GET /api/technoline/send/recent-logs (ADMIN+SECRETARY)
//   payments_stats       <- GET /api/payments/stats            (ADMIN+SECRETARY)
//   settings_overview    <- GET /api/workers (counts only)     (ADMIN+SECRETARY)
const ROLES_BY_INTENT = {
  ivr_status:          [ROLES.ADMIN],
  click2call_recent:   [ROLES.ADMIN, ROLES.SECRETARY],
  payments_stats:      [ROLES.ADMIN, ROLES.SECRETARY],
  audit_recent:        [ROLES.ADMIN],
  alfon_sync_status:   [ROLES.ADMIN],
  recordings_overview: [ROLES.ADMIN],
  settings_overview:   [ROLES.ADMIN, ROLES.SECRETARY],
};

Object.keys(HANDLERS).forEach(function (name) {
  registerCapability({
    id:           "read." + name,
    category:     "read",
    domain:       "extended",
    description:  "שאילתת מידע מורחבת (" + name + ") — נתמכת דרך /api/ai/query",
    roles:        ROLES_BY_INTENT[name],
    riskTier:     "read",
    implemented:  true,
    status:       "enabled",
    testCoverage: ["ai/tests/extended.test.js"],
    serviceFn:    "ai/handlers/extended.js " + name + "()",
  });
});

function dispatch(intent) {
  const fn = HANDLERS[intent];
  if (!fn) return null;
  const result = fn();
  return Object.assign({ suggestions: [] }, result);
}

function isRoleAllowed(intent, role) {
  const allowed = ROLES_BY_INTENT[intent];
  return !allowed || allowed.indexOf(role) !== -1;
}

module.exports = { dispatch, isRoleAllowed, HANDLERS: Object.keys(HANDLERS) };

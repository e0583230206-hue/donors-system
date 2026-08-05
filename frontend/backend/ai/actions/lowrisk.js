"use strict";
// ai/actions/lowrisk.js — Phase F: low-risk actions, using only existing
// service functions (getAppState/setAppState from db.js, plus
// buildPhoneList/validateDonorsPayload injected from server.js — both are
// module-private there today, so no business logic is duplicated, only
// reused via a small injection point set once at server startup).
//
// Every action here still goes through the full prepare→confirm→execute
// envelope in ai/actions/index.js — "low risk" does not mean "skip
// confirmation", it means "safe enough to implement and enable at all
// during this phase" (vs. Phase G, which is prepared but execution-disabled).

const { registerAction } = require("./index");
const { ROLES } = require("../capabilities");
const { getAppState, setAppState } = require("../../db");

// Injected once by server.js after it defines these (they are module-private
// there — this avoids a circular require and avoids duplicating the logic).
let _services = { buildPhoneList: null, validateDonorsPayload: null };
function injectServices(services) {
  _services = Object.assign({}, _services, services);
}

function findDonor(id) {
  const donors = getAppState("donors") || [];
  return donors.find((d) => d.id === Number(id)) || null;
}

// ─── create_task ─────────────────────────────────────────────────────────────
// Mirrors frontend/js/tasks.js addTask() field-for-field and its same
// required-field rule (title + workerName), just server-initiated.
registerAction({
  id:          "create_task",
  domain:      "tasks",
  description: "יצירת משימה חדשה עבור עובד/ת, עם קישור אופציונלי לתורם",
  roles:       [ROLES.ADMIN, ROLES.SECRETARY],
  riskTier:    "low",
  requiresConfirmation: true,
  testCoverage: ["ai/tests/actions.test.js"],
  serviceFn:   "db.js getAppState/setAppState('tasks') — same path as frontend/js/tasks.js addTask()",

  async prepare(params) {
    const title = String(params.title || "").trim();
    const workerName = String(params.workerName || "").trim();
    if (!title) return { error: "חובה להזין כותרת למשימה" };
    if (!workerName) return { error: "חובה לבחור מטפל/ת למשימה" };

    const priority = ["רגיל", "חשוב", "דחוף"].includes(params.priority) ? params.priority : "רגיל";
    const dueDate = params.dueDate ? String(params.dueDate) : "";
    const description = params.description ? String(params.description).trim() : "";
    let donorId = null, donorLabel = null;
    if (params.donorId != null && params.donorId !== "") {
      const donor = findDonor(params.donorId);
      if (!donor) return { error: "לא נמצא תורם עם המזהה שסופק" };
      donorId = donor.id;
      donorLabel = donor.fullName || ("תורם #" + donor.id);
    }

    const previewParts = [
      "תיווצר משימה חדשה: \"" + title + "\" עבור " + workerName,
      donorLabel ? "בנוגע לתורם " + donorLabel : null,
      dueDate ? "עד תאריך " + dueDate : null,
      "עדיפות: " + priority,
    ].filter(Boolean);

    return {
      targetType: "task",
      targetId: null,
      targetLabel: title,
      previewHebrew: previewParts.join(" | "),
      paramsSummary: "fields=title,workerName,priority" + (donorId ? ",donorId" : "") + (dueDate ? ",dueDate" : ""),
      canonicalParams: { title, workerName, priority, dueDate, description, donorId },
    };
  },

  async execute(p) {
    const tasks = getAppState("tasks") || [];
    const newTask = {
      id: Date.now(),
      title: p.title,
      workerName: p.workerName,
      donorId: p.donorId,
      dueDate: p.dueDate,
      priority: p.priority,
      status: "ממתין",
      description: p.description,
      done: false,
      createdAt: new Date().toISOString(),
      doneAt: "",
    };
    const ok = setAppState("tasks", tasks.concat([newTask]));
    if (!ok) return { ok: false, summary: "שמירת המשימה נכשלה" };
    return { ok: true, summary: "task_created id=" + newTask.id, task: newTask };
  },
});

// ─── add_donor_note ───────────────────────────────────────────────────────────
// Appends to donor.notes (never overwrites existing text) — same field,
// same donors-array save path frontend/js/donor.js already uses.
registerAction({
  id:          "add_donor_note",
  domain:      "donor",
  description: "הוספת הערה לכרטיס תורם (מוסיפה לטקסט הקיים, לא מוחקת אותו)",
  roles:       [ROLES.ADMIN, ROLES.SECRETARY],
  riskTier:    "low",
  requiresConfirmation: true,
  testCoverage: ["ai/tests/actions.test.js"],
  serviceFn:   "db.js getAppState/setAppState('donors') + server.js validateDonorsPayload() (injected)",

  async prepare(params) {
    const donor = findDonor(params.donorId);
    if (!donor) return { error: "לא נמצא תורם עם המזהה שסופק" };
    const text = String(params.text || "").trim();
    if (!text) return { error: "חובה לספק טקסט להערה" };
    if (text.length > 1000) return { error: "טקסט ההערה ארוך מדי (מקסימום 1000 תווים)" };

    return {
      targetType: "donor",
      targetId: donor.id,
      targetLabel: donor.fullName || ("תורם #" + donor.id),
      previewHebrew: "תתווסף הערה לכרטיס התורם " + (donor.fullName || ("#" + donor.id)) + ": \"" + text + "\"",
      paramsSummary: "fields=notes donorId=" + donor.id,
      canonicalParams: { donorId: donor.id, text },
    };
  },

  async execute(p) {
    const donors = getAppState("donors") || [];
    const idx = donors.findIndex((d) => d.id === p.donorId);
    if (idx === -1) return { ok: false, summary: "התורם לא נמצא בעת הביצוע (ייתכן שנמחק בינתיים)" };

    const donor = Object.assign({}, donors[idx]);
    const existing = String(donor.notes || "").trim();
    donor.notes = existing ? existing + "\n" + p.text : p.text;
    donor.updatedAt = new Date().toISOString();

    const nextDonors = donors.slice();
    nextDonors[idx] = donor;

    if (_services.validateDonorsPayload) {
      const err = _services.validateDonorsPayload(nextDonors);
      if (err) return { ok: false, summary: "אימות נתונים נכשל: " + err };
    }

    const ok = setAppState("donors", nextDonors);
    if (!ok) return { ok: false, summary: "שמירת ההערה נכשלה" };
    return { ok: true, summary: "note_added donorId=" + p.donorId, donorId: p.donorId };
  },
});

// ─── prepare_campaign_recipients ───────────────────────────────────────────────
// Read-only computation, reusing buildPhoneList() from server.js exactly —
// this action never sends anything, it only returns the resolved recipient
// count/list so a human can review it before using the existing (separate,
// already-audited) campaign-send screen.
registerAction({
  id:          "prepare_campaign_recipients",
  domain:      "campaigns",
  description: "הכנת רשימת נמענים לקמפיין (ללא שליחה בפועל) — שימוש חוזר ב-buildPhoneList הקיים",
  roles:       [ROLES.ADMIN, ROLES.SECRETARY],
  riskTier:    "low",
  requiresConfirmation: true,
  testCoverage: ["ai/tests/actions.test.js"],
  serviceFn:   "server.js buildPhoneList() (injected)",

  async prepare(params) {
    if (!_services.buildPhoneList) return { error: "השירות אינו זמין כרגע" };
    const filter = String(params.recipientFilter || "all").trim();
    const fallbackToPrimary = !!params.fallbackToPrimary;
    let result;
    try {
      result = _services.buildPhoneList(filter, { fallbackToPrimary });
    } catch (err) {
      return { error: "חישוב רשימת הנמענים נכשל: " + err.message };
    }

    return {
      targetType: "campaign_recipient_list",
      targetId: filter,
      targetLabel: "פילטר: " + filter,
      previewHebrew: "תוכן רשימה בלבד (ללא שליחה): " + result.donorCount + " תורמים, " +
        result.phones.length + " מספרי טלפון (" + result.ivrPhoneCount + " מאושרים, " +
        result.fallbackPhoneCount + " גיבוי).",
      paramsSummary: "filter=" + filter + " donorCount=" + result.donorCount,
      canonicalParams: { filter, fallbackToPrimary },
    };
  },

  // "execute" here still performs no external side effect — it just returns
  // the same read-only computation again (freshly, in case the donor list
  // changed between prepare and confirm) as the action's confirmed result.
  // Actually sending a campaign remains exclusively the existing, separately
  // audited POST /api/technoline/send screen — this action never calls it.
  async execute(p) {
    if (!_services.buildPhoneList) return { ok: false, summary: "השירות אינו זמין כרגע" };
    const result = _services.buildPhoneList(p.filter, { fallbackToPrimary: p.fallbackToPrimary });
    return {
      ok: true,
      summary: "recipients_prepared filter=" + p.filter + " donorCount=" + result.donorCount,
      recipientList: {
        filter: p.filter,
        donorCount: result.donorCount,
        phoneCount: result.phones.length,
        ivrPhoneCount: result.ivrPhoneCount,
        fallbackPhoneCount: result.fallbackPhoneCount,
        donors: result.donors,
      },
    };
  },
});

module.exports = { injectServices };

"use strict";
// ai/audit.js — privacy-preserving audit logging for every AI query and every
// AI action attempt. Reuses the existing tamper-resistant server_audit_log
// table (via insertAuditLog) — no new table, no schema change.
//
// PRIVACY RULE (mirrors sanitizeIvrQueryForLog's philosophy elsewhere in this
// codebase): the *content* a worker types into the assistant, or the *values*
// an action would write, must never land in server_audit_log — only enough
// metadata to reconstruct "who did what to which record, when, with what
// outcome" for accountability. donorId is logged as a bare numeric id (the
// rest of the app already logs donorId in audit entries for the same
// records — e.g. ALFON_SYNC_* — so this is consistent, not a new exposure).

const { insertAuditLog } = require("../db");

function truncate(s, max) {
  s = String(s == null ? "" : s);
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// Never log free-text question content. Log only its length and the intent
// the detector resolved it to — enough to audit "what kind of thing was
// asked", never "what exactly was typed" (which may itself contain a phone
// number, ID number, or name pasted by the worker).
function recordAiQuery({ worker, ip, question, donorId, pageContext, intent, model, confidence, fallback }) {
  try {
    insertAuditLog({
      action:     "AI_QUERY",
      entityType: "ai_query",
      entityId:   donorId != null ? String(donorId) : null,
      entityName: null,
      details: [
        "intent=" + (intent || "?"),
        "model=" + (model || "?"),
        "page=" + (pageContext || "?"),
        "qlen=" + String(question || "").length,
        confidence != null ? "confidence=" + Number(confidence).toFixed(2) : null,
        fallback ? "fallback=1" : null,
      ].filter(Boolean).join(" "),
      workerId:   worker && worker.id,
      workerName: worker && worker.name,
      ip,
    });
  } catch (_) { /* audit logging must never break the request */ }
}

// Action attempts go through prepare → confirm → execute. Every stage is
// logged separately so a partial flow (prepared but never confirmed, or
// confirmed but expired) is visible in the audit trail, not silently lost.
// `paramsSummary` must already be a safe, non-PII string built by the caller
// (e.g. "fields=title,dueDate" not "title=פלוני הכהן"). This function does
// not attempt to sanitize an arbitrary object — callers own that decision,
// same pattern as summarizeDataSaveForAudit() in server.js.
function recordAiAction({ stage, worker, ip, actionId, targetType, targetId, fingerprint, paramsSummary, outcome, reason }) {
  try {
    insertAuditLog({
      action:     "AI_ACTION_" + String(stage || "?").toUpperCase(),
      entityType: targetType || "ai_action",
      entityId:   targetId != null ? String(targetId) : null,
      entityName: null,
      details: [
        "actionId=" + (actionId || "?"),
        fingerprint ? "fp=" + truncate(fingerprint, 16) : null,
        paramsSummary ? truncate(paramsSummary, 200) : null,
        outcome ? "outcome=" + outcome : null,
        reason ? "reason=" + truncate(reason, 120) : null,
      ].filter(Boolean).join(" "),
      workerId:   worker && worker.id,
      workerName: worker && worker.name,
      ip,
    });
  } catch (_) { /* audit logging must never break the request */ }
}

module.exports = { recordAiQuery, recordAiAction };

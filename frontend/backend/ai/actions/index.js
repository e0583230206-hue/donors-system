"use strict";
// ai/actions/index.js — Phase F core: the AI action framework.
//
// prepare -> confirm -> execute, with stateless signed/fingerprinted
// confirmations (no new DB table — per the approved plan's "avoid schema
// changes unless absolutely necessary"). Every concrete action (Phase F
// low-risk, Phase G high-risk) registers its own prepare()/execute() via
// registerAction() — this module only enforces the shared safety envelope:
// Hebrew preview before anything happens, a tamper-evident payload
// fingerprint, confirmation expiry, a hard confirm→execute stage gate
// (so "confirm without preview" is structurally impossible, not just
// discouraged), a live authorization re-check at execute time, idempotency,
// audit logging of every stage, and partial-failure reporting.
//
// It never contains business logic itself — see ai/actions/lowrisk.js and
// ai/actions/highrisk.js for the actual actions.

const crypto = require("crypto");
const { registerCapability, isAllowed } = require("../capabilities");
const { recordAiAction } = require("../audit");
const { findWorkerById } = require("../../db");

const PREPARE_TTL_MS      = 10 * 60 * 1000; // preview token valid 10 min
const CONFIRM_TTL_MS      = 2  * 60 * 1000; // execution token valid 2 min (tighter — meant to be used immediately)
const IDEMPOTENCY_TTL_MS  = 10 * 60 * 1000;

// ─── Signing key ───────────────────────────────────────────────────────────
// Derived from JWT_SECRET via HMAC into its own subkey, scoped to this
// purpose only — not a new secret to provision or rotate (same source of
// truth as auth.service.js, which already fails closed in production if
// unset), but cryptographically separated so an AI-action token can never
// be confused with, or forged from, a real login JWT.
const SIGNING_KEY = crypto
  .createHmac("sha256", process.env.JWT_SECRET || "INSECURE_DEV_ONLY_SECRET_DO_NOT_USE_IN_PRODUCTION")
  .update("ai-action-fingerprint-v1")
  .digest();

function sign(obj) {
  const b64 = Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
  const fp  = crypto.createHmac("sha256", SIGNING_KEY).update(b64).digest("base64url");
  return b64 + "." + fp;
}

function verify(token) {
  if (typeof token !== "string" || token.indexOf(".") === -1) return { valid: false, reason: "malformed" };
  const dot = token.indexOf(".");
  const b64 = token.slice(0, dot);
  const fp  = token.slice(dot + 1);
  const expectedFp = crypto.createHmac("sha256", SIGNING_KEY).update(b64).digest("base64url");
  const a = Buffer.from(fp);
  const b = Buffer.from(expectedFp);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { valid: false, reason: "bad_signature" };
  let payload;
  try {
    payload = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
  } catch (e) {
    return { valid: false, reason: "bad_payload" };
  }
  if (!payload.expiresAt || Date.now() > payload.expiresAt) return { valid: false, reason: "expired" };
  return { valid: true, payload };
}

// ─── Action registry ───────────────────────────────────────────────────────
const REGISTRY = new Map();

function registerAction(def) {
  if (!def || !def.id) throw new Error("registerAction: id is required");
  if (typeof def.prepare !== "function" || typeof def.execute !== "function") {
    throw new Error("registerAction: prepare() and execute() are both required — " + def.id);
  }
  if (REGISTRY.has(def.id)) throw new Error("registerAction: duplicate action id '" + def.id + "'");
  REGISTRY.set(def.id, def);

  registerCapability({
    id:                   "action." + def.id,
    category:             "action",
    domain:               def.domain || "general",
    description:          def.description || "",
    roles:                def.roles,
    riskTier:             def.riskTier || "low",
    requiresConfirmation: def.requiresConfirmation !== false,
    implemented:          def.implemented !== false,
    status:               def.status || "enabled", // Phase G actions register with status:"disabled"
    testCoverage:         def.testCoverage || [],
    serviceFn:            def.serviceFn || null,
  });
}

function getAction(id) { return REGISTRY.get(id) || null; }

// ─── Idempotency cache ─────────────────────────────────────────────────────
// Mirrors the existing in-memory Map pattern already used for campaign
// sends (_campaignSendIdempotency in server.js) — same shape, same TTL
// cleanup approach, just applied to AI actions. Not a new pattern for this
// codebase, and deliberately not a DB table (no schema change).
const _executedKeys = new Map(); // idempotencyKey -> { at, result }
function _cleanupIdempotency() {
  const now = Date.now();
  for (const [k, v] of _executedKeys) {
    if (now - v.at > IDEMPOTENCY_TTL_MS) _executedKeys.delete(k);
  }
}

// ─── Stage 1: prepare ──────────────────────────────────────────────────────
async function prepareAction({ actionId, params, worker, ip, idempotencyKey }) {
  const def = getAction(actionId);
  if (!def) return { error: "פעולה לא מוכרת: " + actionId, code: "unknown_action" };

  if (!isAllowed("action." + actionId, worker.role)) {
    recordAiAction({ stage: "prepare", worker, ip, actionId, outcome: "denied", reason: "role_not_allowed" });
    return { error: "אין הרשאה לפעולה זו", code: "forbidden" };
  }

  let prepared;
  try {
    prepared = await def.prepare(params || {}, { worker, ip });
  } catch (err) {
    recordAiAction({ stage: "prepare", worker, ip, actionId, outcome: "error", reason: err.message });
    return { error: "הכנת הפעולה נכשלה: " + err.message, code: "prepare_failed" };
  }
  if (!prepared || prepared.error) {
    recordAiAction({ stage: "prepare", worker, ip, actionId, outcome: "rejected", reason: (prepared && prepared.error) || "?" });
    return { error: (prepared && prepared.error) || "לא ניתן להכין את הפעולה", code: "prepare_rejected" };
  }

  const now = Date.now();
  const payload = {
    actionId,
    workerId:        worker.id,
    targetType:       prepared.targetType || null,
    targetId:         prepared.targetId != null ? String(prepared.targetId) : null,
    canonicalParams:  prepared.canonicalParams || {},
    idempotencyKey:   idempotencyKey || null,
    stage:            "prepared",
    issuedAt:         now,
    expiresAt:        now + PREPARE_TTL_MS,
  };
  const token = sign(payload);

  recordAiAction({
    stage: "prepare", worker, ip, actionId,
    targetType: prepared.targetType, targetId: prepared.targetId,
    fingerprint: token.split(".")[1],
    paramsSummary: prepared.paramsSummary || null,
    outcome: "ok",
  });

  return {
    token,
    expiresAt: payload.expiresAt,
    preview: {
      targetType:   prepared.targetType,
      targetId:     prepared.targetId,
      targetLabel:  prepared.targetLabel,
      effectHebrew: prepared.previewHebrew,
    },
  };
}

// ─── Stage 2: confirm ───────────────────────────────────────────────────────
// Re-validates the prepare-stage token, mints a separate, tighter-lived
// execution token. execute() only ever accepts a confirm-minted token, so
// skipping straight from a prepare token to execute is structurally
// impossible — not merely discouraged by convention.
function confirmAction({ token, worker, ip }) {
  const v = verify(token);
  if (!v.valid) {
    recordAiAction({ stage: "confirm", worker, ip, outcome: "rejected", reason: v.reason });
    return { error: "אישור לא תקף (" + v.reason + ") — יש להתחיל מחדש מהצגת התצוגה המקדימה", code: v.reason };
  }
  const p = v.payload;
  if (p.stage !== "prepared") {
    recordAiAction({ stage: "confirm", worker, ip, actionId: p.actionId, outcome: "rejected", reason: "wrong_stage" });
    return { error: "אסימון זה אינו אסימון תצוגה מקדימה תקף", code: "wrong_stage" };
  }
  if (p.workerId !== worker.id) {
    recordAiAction({ stage: "confirm", worker, ip, actionId: p.actionId, outcome: "rejected", reason: "worker_mismatch" });
    return { error: "האישור שייך למשתמש אחר", code: "worker_mismatch" };
  }
  if (!isAllowed("action." + p.actionId, worker.role)) {
    recordAiAction({ stage: "confirm", worker, ip, actionId: p.actionId, outcome: "denied", reason: "role_not_allowed" });
    return { error: "אין הרשאה לפעולה זו", code: "forbidden" };
  }

  const now = Date.now();
  const execPayload = Object.assign({}, p, { stage: "confirmed", issuedAt: now, expiresAt: now + CONFIRM_TTL_MS });
  const execToken = sign(execPayload);

  recordAiAction({
    stage: "confirm", worker, ip, actionId: p.actionId,
    targetType: p.targetType, targetId: p.targetId,
    fingerprint: execToken.split(".")[1], outcome: "ok",
  });

  return { executionToken: execToken, expiresAt: execPayload.expiresAt };
}

// ─── Stage 3: execute ───────────────────────────────────────────────────────
async function executeAction({ token, worker, ip }) {
  const v = verify(token);
  if (!v.valid) {
    recordAiAction({ stage: "execute", worker, ip, outcome: "rejected", reason: v.reason });
    return { error: "אסימון ביצוע לא תקף (" + v.reason + ") — יש לאשר מחדש", code: v.reason };
  }
  const p = v.payload;
  if (p.stage !== "confirmed") {
    recordAiAction({ stage: "execute", worker, ip, actionId: p.actionId, outcome: "rejected", reason: "confirm_without_preview" });
    return { error: "לא ניתן לבצע פעולה בלי שלב אישור תקין קודם", code: "confirm_without_preview" };
  }
  if (p.workerId !== worker.id) {
    recordAiAction({ stage: "execute", worker, ip, actionId: p.actionId, outcome: "rejected", reason: "worker_mismatch" });
    return { error: "האישור שייך למשתמש אחר", code: "worker_mismatch" };
  }

  // Live re-check — a role change or deactivation between prepare/confirm
  // and execute must be caught here, not assumed unchanged from the token.
  const liveWorker = findWorkerById(worker.id);
  if (!liveWorker || liveWorker.status !== "פעיל") {
    recordAiAction({ stage: "execute", worker, ip, actionId: p.actionId, outcome: "denied", reason: "worker_inactive" });
    return { error: "המשתמש אינו פעיל יותר", code: "forbidden" };
  }
  if (!isAllowed("action." + p.actionId, worker.role)) {
    recordAiAction({ stage: "execute", worker, ip, actionId: p.actionId, outcome: "denied", reason: "role_not_allowed" });
    return { error: "אין הרשאה לפעולה זו", code: "forbidden" };
  }

  const def = getAction(p.actionId);
  if (!def) {
    recordAiAction({ stage: "execute", worker, ip, actionId: p.actionId, outcome: "error", reason: "unknown_action" });
    return { error: "פעולה לא מוכרת", code: "unknown_action" };
  }

  _cleanupIdempotency();
  if (p.idempotencyKey) {
    const cached = _executedKeys.get(p.idempotencyKey);
    if (cached) {
      recordAiAction({ stage: "execute", worker, ip, actionId: p.actionId, outcome: "idempotent_replay" });
      return Object.assign({}, cached.result, { idempotent: true });
    }
  }

  let result;
  try {
    result = await def.execute(p.canonicalParams, { worker: liveWorker, ip });
  } catch (err) {
    recordAiAction({
      stage: "execute", worker, ip, actionId: p.actionId,
      targetType: p.targetType, targetId: p.targetId, outcome: "error", reason: err.message,
    });
    return { error: "ביצוע הפעולה נכשל: " + err.message, code: "execute_failed" };
  }

  const outcome = result && result.partialFailure ? "partial_failure"
    : (result && result.ok !== false ? "success" : "failed");

  recordAiAction({
    stage: "execute", worker, ip, actionId: p.actionId,
    targetType: p.targetType, targetId: p.targetId,
    paramsSummary: (result && result.summary) || null,
    outcome,
  });

  const responseBody = Object.assign({ ok: outcome !== "failed" }, result);
  if (p.idempotencyKey && outcome !== "failed") {
    _executedKeys.set(p.idempotencyKey, { at: Date.now(), result: responseBody });
  }
  return responseBody;
}

module.exports = {
  registerAction, getAction, prepareAction, confirmAction, executeAction,
  // exported for tests only:
  _internal: { sign, verify, _executedKeys },
};

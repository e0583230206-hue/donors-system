"use strict";
// ai/actions/idempotency.js — Phase F: durable, restart-surviving
// idempotency for write actions. Reuses server_audit_log (via
// db.insertAuditLog / db.getAuditLogsByEntity) as the persistence layer —
// no new table, no schema migration.
//
// Replaces the previous in-memory Map (which mirrored server.js's
// _campaignSendIdempotency and, like it, lost all state on restart or in a
// multi-instance PM2 cluster). This version's claim/resolution rows live in
// server_audit_log, so a retry with the same idempotencyKey is recognized
// even after the process restarts — see ai/tests/idempotency.test.js for a
// test that actually re-requires this module in a fresh subprocess against
// the same DB file to prove it.
//
// ── Design ──────────────────────────────────────────────────────────────────
// 1. CLAIM  — inserted synchronously, BEFORE the action's execute() runs.
//    entityType='ai_idempotency_claim', entityId=<idempotencyKey>,
//    details='actionId=<id>'. Because the "is there already a claim/
//    resolution?" check and this insert happen with no `await` in between
//    (better-sqlite3/node:sqlite calls are synchronous, and Node's
//    single-threaded event loop only yields at an await/I-O boundary), no
//    other request THIS PROCESS is handling can race between the check and
//    the claim. This is atomic per-process, not a DB-level UNIQUE
//    constraint — it does NOT protect against a multi-instance PM2 cluster
//    (documented limitation, same as the in-memory version it replaces;
//    current deployment is a single fork-mode instance).
// 2. RESOLVED — inserted after execute() finishes. Records only
//    status ('success'/'failed') + a re-fetchable `ref` (an entity id, e.g.
//    a task id) — never the actual result payload. This keeps
//    server_audit_log free of arbitrary free text, consistent with
//    ai/audit.js's existing redaction principle (donor note text, task
//    descriptions etc. never get duplicated into the audit log).
// 3. REPLAY — on a repeat request with a key that already resolved
//    successfully, the response is reconstructed by re-reading the
//    affected record's CURRENT state via the action's own replay(ref, ctx)
//    — not a frozen snapshot of the original response. This is a
//    deliberate, documented tradeoff (see the final remediation report):
//    lighter/safer than storing full payloads in the audit log, but not a
//    byte-identical replay if the record was legitimately modified again
//    since (e.g. the task was completed) between the original execution
//    and the replay.
// 4. IN-FLIGHT COLLISION — a genuinely concurrent duplicate request (same
//    key, no resolution yet) is rejected with idempotency_in_progress
//    rather than double-executing or blocking. A claim older than
//    STALE_CLAIM_MS with no resolution (e.g. the process crashed between
//    claim and resolve) is treated as abandoned and reclaimed.

const { insertAuditLog, getAuditLogsByEntity } = require("../../db");

const CLAIM_TYPE     = "ai_idempotency_claim";
const RESOLVED_TYPE  = "ai_idempotency_resolved";
const STALE_CLAIM_MS = 2 * 60 * 1000; // matches the action framework's own CONFIRM_TTL_MS scale

function actionMarker(actionId) { return "actionId=" + actionId; }

function parseStatus(details) {
  var m = /status=(success|failed)/.exec(details || "");
  return m ? m[1] : null;
}
// `ref` is always the last field appended by resolveClaim() below, so
// capture everything after "ref=" to the end of the string rather than
// \S+ — a campaign recipientFilter like "city:פתח תקווה" (a real Hebrew
// city name with a space) would otherwise be truncated at the first space.
function parseRef(details) {
  var m = /ref=([\s\S]*)$/.exec(details || "");
  return m ? m[1] : null;
}

/**
 * Call BEFORE running the action's execute(). Returns one of:
 *   { outcome: "no_key" }                       — no idempotencyKey given, always proceed
 *   { outcome: "replay", status, ref }           — already resolved; caller should replay, not re-execute
 *   { outcome: "in_progress" }                   — a live (non-stale) claim exists with no resolution yet
 *   { outcome: "claimed" }                       — no prior claim/resolution (or prior claim was stale/failed);
 *                                                   a new claim row has been inserted, caller should proceed
 */
function claimOrReplay({ actionId, idempotencyKey, worker, ip }) {
  if (!idempotencyKey) return { outcome: "no_key" };

  var rows = getAuditLogsByEntity(RESOLVED_TYPE, idempotencyKey, 20)
    .concat(getAuditLogsByEntity(CLAIM_TYPE, idempotencyKey, 20))
    .sort(function (a, b) { return b.id - a.id; }); // newest first, across both types

  var marker = actionMarker(actionId);

  var resolved = rows.find(function (r) { return r.entityType === RESOLVED_TYPE && r.details && r.details.indexOf(marker) !== -1; });
  if (resolved) {
    var status = parseStatus(resolved.details);
    if (status === "success") {
      return { outcome: "replay", status: "success", ref: parseRef(resolved.details) };
    }
    // status === "failed" (or unparseable) — fall through and allow a fresh claim.
  } else {
    var liveClaim = rows.find(function (r) { return r.entityType === CLAIM_TYPE && r.details && r.details.indexOf(marker) !== -1; });
    if (liveClaim) {
      var ageMs = Date.now() - new Date(liveClaim.createdAt).getTime();
      if (ageMs < STALE_CLAIM_MS) {
        return { outcome: "in_progress" };
      }
      // else: stale claim (process likely crashed between claim and
      // resolve) — fall through and reclaim.
    }
  }

  insertAuditLog({
    action: "AI_IDEM_CLAIM", entityType: CLAIM_TYPE, entityId: idempotencyKey,
    details: marker,
    workerId: worker && worker.id, workerName: worker && worker.name, ip: ip,
  });
  return { outcome: "claimed" };
}

/**
 * Call AFTER the action's execute() resolves (success, failure, or partial
 * failure — partial failure resolves as "success" for idempotency purposes,
 * consistent with how the framework already treats it as a completed call).
 */
function resolveClaim({ actionId, idempotencyKey, worker, ip, status, ref }) {
  if (!idempotencyKey) return;
  var details = actionMarker(actionId) + " status=" + status + (ref != null ? " ref=" + ref : "");
  insertAuditLog({
    action: "AI_IDEM_RESOLVED", entityType: RESOLVED_TYPE, entityId: idempotencyKey,
    details: details,
    workerId: worker && worker.id, workerName: worker && worker.name, ip: ip,
  });
}

module.exports = { claimOrReplay, resolveClaim, CLAIM_TYPE, RESOLVED_TYPE };

const {
  insertCallLog,
  startCallSession,
  updateCallSessionDonor,
  endCallSession,
} = require("./db");

// ── Low-level safe wrapper ────────────────────────────────────────────────────

function safeInsertCallLog(callId, phone, step, payload) {
  try {
    insertCallLog(callId, phone, step, payload);
  } catch (err) {
    console.error("[IVR:log] Failed to write call log step=" + step + ":", err && err.message ? err.message : err);
  }
}

// ── Session lifecycle ─────────────────────────────────────────────────────────

/**
 * Mark the beginning of a call. Returns true if this is the first event for
 * this callId (i.e. the session was just created).
 */
function logCallStart(callId, phone) {
  try {
    var isNew = startCallSession(callId, phone);
    if (isNew) {
      insertCallLog(callId, phone, "call_start", { phone });
    }
    return isNew;
  } catch (err) {
    console.error("[IVR:log] logCallStart failed:", err && err.message ? err.message : err);
    return false;
  }
}

/**
 * Record which donor was identified for this call. Safe to call multiple times
 * (the session update is idempotent — only sets donorId when it is still NULL).
 */
function logDonorIdentified(callId, phone, donorId, donorName, extra) {
  try {
    updateCallSessionDonor(callId, donorId, donorName);
    insertCallLog(callId, phone, "donor_identified", Object.assign(
      { donorId: donorId, donorName: donorName },
      extra || {}
    ));
  } catch (err) {
    console.error("[IVR:log] logDonorIdentified failed:", err && err.message ? err.message : err);
  }
}

/** Record that the caller's phone was not found in the donor registry. */
function logUnknownCaller(callId, phone) {
  try {
    insertCallLog(callId, phone, "unknown_caller", { phone: phone });
  } catch (err) {
    console.error("[IVR:log] logUnknownCaller failed:", err && err.message ? err.message : err);
  }
}

/**
 * Record the end of a call, set endedAt and duration on the session row.
 * outcome: 'hangup' | 'payment_success' | 'payment_failed' | 'voice_message' |
 *          'debt_inquiry' | 'error'
 */
function logCallEnd(callId, phone, outcome, amountPaid) {
  try {
    insertCallLog(callId, phone, "call_end", {
      outcome:    outcome    || "hangup",
      amountPaid: amountPaid || null,
    });
    endCallSession(callId, outcome || "hangup", amountPaid || null);
  } catch (err) {
    console.error("[IVR:log] logCallEnd failed:", err && err.message ? err.message : err);
  }
}

module.exports = {
  safeInsertCallLog,
  logCallStart,
  logDonorIdentified,
  logUnknownCaller,
  logCallEnd,
};

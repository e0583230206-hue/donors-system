// softphone-call-classifier.js — pure, dependency-free call-status
// classification for the browser JsSIP softphone. Loaded both as a plain
// <script> in softphone.html (exposes window.SoftphoneCallClassifier) and via
// require() from Node tests (module.exports) — same file, same logic, so the
// tests exercise exactly what runs in the browser.
//
// Built directly from the real event contract of the vendored JsSIP build at
// frontend/lib/jssip.min.js (verified by reading the minified source, not
// assumed from memory):
//   - RTCSession fires 'accepted'/'confirmed' when the call is answered
//     (accepted: {originator, response}, sets _start_time).
//   - RTCSession fires 'ended' ONLY when the session had been established —
//     data: {originator, message, cause}.
//   - RTCSession fires 'failed' when the session did NOT get established
//     (rejected/busy/canceled/timeout/technical failure before answer) —
//     same data shape: {originator, message, cause}.
//   - session.id (used as sipCallId) = request.call_id + from_tag, a stable
//     per-dialog identifier (RTCSession._id, exposed via the `id` getter).
//   - Cause strings come from JsSIP.C.causes, extracted verbatim from
//     jssip.min.js: "Busy", "Rejected", "Canceled", "No Answer", "Terminated"
//     (=BYE), "Request Timeout", "Expires", plus assorted technical causes.
//
// Exactly 9 status values are produced: 8 required terminal statuses plus
// one transient "in_progress" (written the moment a call/session is created,
// before any terminal event arrives — covers the edge case of a browser
// refresh/crash mid-call, so the row isn't silently lost).
(function (root) {
  "use strict";

  var STATUSES = [
    "in_progress",
    "incoming_answered",
    "incoming_missed",
    "incoming_rejected",
    "outgoing_answered",
    "outgoing_unanswered",
    "outgoing_rejected",
    "outgoing_failed",
    "cancelled",
  ];

  var TERMINAL_STATUSES = STATUSES.filter(function (s) { return s !== "in_progress"; });

  // JsSIP.C.causes string constants (copied verbatim from frontend/lib/jssip.min.js).
  var CAUSES = {
    CONNECTION_ERROR: "Connection Error",
    REQUEST_TIMEOUT: "Request Timeout",
    SIP_FAILURE_CODE: "SIP Failure Code",
    INTERNAL_ERROR: "Internal Error",
    BUSY: "Busy",
    REJECTED: "Rejected",
    REDIRECTED: "Redirected",
    UNAVAILABLE: "Unavailable",
    NOT_FOUND: "Not Found",
    ADDRESS_INCOMPLETE: "Address Incomplete",
    INCOMPATIBLE_SDP: "Incompatible SDP",
    MISSING_SDP: "Missing SDP",
    AUTHENTICATION_ERROR: "Authentication Error",
    BYE: "Terminated",
    WEBRTC_ERROR: "WebRTC Error",
    CANCELED: "Canceled",
    NO_ANSWER: "No Answer",
    EXPIRES: "Expires",
    NO_ACK: "No ACK",
    DIALOG_ERROR: "Dialog Error",
    USER_DENIED_MEDIA_ACCESS: "User Denied Media Access",
    BAD_MEDIA_DESCRIPTION: "Bad Media Description",
    RTP_TIMEOUT: "RTP Timeout",
  };

  // Hebrew, non-technical reasons shown to ordinary users — never the raw
  // SIP cause/response code. The raw cause is stored separately server-side
  // (rawSipCause) for admin/debug use only.
  var SAFE_REASON_HE = {
    outgoing_rejected: "המספר דחה את השיחה",
    outgoing_unanswered: "לא הייתה מענה",
    outgoing_failed: "השיחה נכשלה",
    cancelled: "השיחה בוטלה לפני מענה",
    incoming_missed: "שיחה שלא נענתה",
    incoming_rejected: "השיחה נדחתה",
  };

  /**
   * Classifies a JsSIP RTCSession 'failed' event.
   * @param {"incoming"|"outgoing"} direction
   * @param {string} cause - one of CAUSES values (session event data.cause)
   * @param {string} originator - "local" | "remote" | "system"
   * @returns {string} one of TERMINAL_STATUSES
   */
  function classifyFailed(direction, cause, originator) {
    if (direction === "outgoing") {
      if (cause === CAUSES.CANCELED) return "cancelled";
      if (cause === CAUSES.BUSY || cause === CAUSES.REJECTED) return "outgoing_rejected";
      if (cause === CAUSES.NO_ANSWER || cause === CAUSES.REQUEST_TIMEOUT || cause === CAUSES.EXPIRES) {
        return "outgoing_unanswered";
      }
      return "outgoing_failed";
    }
    // incoming
    if (cause === CAUSES.CANCELED) return "incoming_missed"; // caller hung up before we answered
    if (originator === "local" && (cause === CAUSES.REJECTED || cause === CAUSES.BUSY)) return "incoming_rejected";
    if (cause === CAUSES.REQUEST_TIMEOUT || cause === CAUSES.EXPIRES || cause === CAUSES.NO_ANSWER) {
      return "incoming_missed";
    }
    // Any other technical failure on an unanswered incoming call reads as a
    // missed call from the operator's perspective — matches a normal phone UI.
    return "incoming_missed";
  }

  /**
   * Classifies a JsSIP RTCSession 'ended' event — per JsSIP's own contract
   * this event only fires once the session was successfully established, so
   * the answer is direction-only, no cause branching needed.
   * @param {"incoming"|"outgoing"} direction
   */
  function classifyEnded(direction) {
    return direction === "outgoing" ? "outgoing_answered" : "incoming_answered";
  }

  function isAnsweredStatus(status) {
    return status === "outgoing_answered" || status === "incoming_answered";
  }

  // Safe (non-technical) Hebrew reason for a terminal status. Returns null
  // for the two "answered" statuses (no failure reason applies) and for the
  // transient "in_progress" status.
  function safeFailureReason(status) {
    return SAFE_REASON_HE[status] || null;
  }

  function toMs(iso) {
    if (!iso) return null;
    var t = new Date(iso).getTime();
    return isNaN(t) ? null : t;
  }

  /**
   * Pure duration math shared by client display and server-side storage.
   * @param {{startedAt:?string, ringingAt:?string, answeredAt:?string, endedAt:?string}} times - ISO 8601 strings
   * @returns {{ringDurationSec:?number, talkDurationSec:?number}}
   */
  function computeDurations(times) {
    times = times || {};
    var startedAtMs  = toMs(times.startedAt);
    var ringingAtMs  = toMs(times.ringingAt) || startedAtMs; // ringing starts no later than call creation
    var answeredAtMs = toMs(times.answeredAt);
    var endedAtMs    = toMs(times.endedAt);

    var ringDurationSec = null;
    if (ringingAtMs != null) {
      var ringEndMs = answeredAtMs != null ? answeredAtMs : endedAtMs;
      if (ringEndMs != null && ringEndMs >= ringingAtMs) {
        ringDurationSec = Math.round((ringEndMs - ringingAtMs) / 1000);
      }
    }

    var talkDurationSec = null;
    if (answeredAtMs != null && endedAtMs != null && endedAtMs >= answeredAtMs) {
      talkDurationSec = Math.round((endedAtMs - answeredAtMs) / 1000);
    }

    return { ringDurationSec: ringDurationSec, talkDurationSec: talkDurationSec };
  }

  var api = {
    STATUSES: STATUSES,
    TERMINAL_STATUSES: TERMINAL_STATUSES,
    CAUSES: CAUSES,
    classifyFailed: classifyFailed,
    classifyEnded: classifyEnded,
    isAnsweredStatus: isAnsweredStatus,
    safeFailureReason: safeFailureReason,
    computeDurations: computeDurations,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.SoftphoneCallClassifier = api;
  }
})(typeof window !== "undefined" ? window : this);

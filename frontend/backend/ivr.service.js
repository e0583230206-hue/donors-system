const { buildResponse } = require("./ivr");
const { getDonorForIvr, normalizePhone } = require("./donor.service");
const {
  safeInsertCallLog,
  logCallStart,
  logDonorIdentified,
  logUnknownCaller,
  logCallEnd,
} = require("./log.service");
const { parsePositiveAmount, saveIvrPaymentOnce } = require("./payment.service");

// ── Utilities ─────────────────────────────────────────────────────────────────

function asText(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function ivrErrorResponse() {
  return [
    { type: "simpleMessage", files: [{ text: "אירעה שגיאה. אנא נסה שוב מאוחר יותר." }] },
    { type: "hangup" },
  ];
}

// Technoline accumulates same-named params as arrays; always take the last value.
function lastParam(q, name) {
  var val = q[name];
  if (Array.isArray(val)) return val[val.length - 1];
  return val;
}

// Omit the full raw query from logs — only keep the params that matter.
function sanitizeQuery(q) {
  return {
    PBXcallId:     q.PBXcallId     || undefined,
    PBXphone:      q.PBXphone      || undefined,
    PBXcallStatus: q.PBXcallStatus || undefined,
    mainChoice:    q.mainChoice     || undefined,
    payChoice:     q.payChoice      || undefined,
    debtChoice:    q.debtChoice     || undefined,
    amount:        q.amount         || undefined,
    payment:       q.payment        || undefined,
    voiceMessage:  q.voiceMessage !== undefined ? "[RECEIVED]" : undefined,
  };
}

// ── Step detection ────────────────────────────────────────────────────────────

function detectIvrStep(q) {
  if (asText(q.PBXcallStatus) === "HANGUP") return "hangup";

  // Terminal state params take precedence over accumulated menu params
  if (q.voiceMessage !== undefined) return "voice_message";
  if (q.payment !== undefined)      return "payment";

  var main = lastParam(q, "mainChoice");
  var pay  = lastParam(q, "payChoice");
  var debt = lastParam(q, "debtChoice");
  var amt  = lastParam(q, "amount");

  if (main === "1") {
    if (pay === "1")                       return "pay_full";
    if (pay === "2" && amt !== undefined)  return "pay_custom";
    if (pay === "2")                       return "enter_amount";
    if (amt !== undefined)                 return "pay_custom";
    return "payment_menu";
  }
  if (main === "2") {
    if (debt === "1")                      return "pay_all_debts";
    if (debt === "2" && amt !== undefined) return "pay_debt_custom";
    if (debt === "2")                      return "enter_debt_amount";
    if (debt === "9")                      return "end";
    return "debt_list";
  }
  if (main === "3") return "record_message";
  return "menu";
}

// ── Amount resolution ─────────────────────────────────────────────────────────
//
// CRITICAL: Technoline does not echo back the amount it charged — we must infer
// it from the accumulated query params and the donor's current debt data.
// When payChoice=1 (full debt) or debtChoice=1 (all debts), there is no DTMF
// "amount" param in the query; we recover the amount from the donor record.

function resolvePaymentAmount(q, donor) {
  // User typed a custom DTMF amount — always prefer this
  var dtmf = parsePositiveAmount(lastParam(q, "amount"));
  if (dtmf !== null) return dtmf;

  // payChoice=1 → full current debt
  if (lastParam(q, "payChoice") === "1" && donor && donor.currentDebt) {
    return donor.currentDebt.amount;
  }

  // debtChoice=1 → sum all open debts
  if (lastParam(q, "debtChoice") === "1" && donor) {
    var allDebts = (donor.currentDebt ? [donor.currentDebt] : []).concat(donor.previousDebts || []);
    var total = allDebts.reduce(function (s, d) { return s + d.amount; }, 0);
    if (total > 0) return Math.round(total * 100) / 100;
  }

  return null;
}

// ── Step-level audit logging ──────────────────────────────────────────────────
//
// Each step is logged once, when Technoline first introduces that param.
// (Technoline sends ALL accumulated params on every request, so each new step
// adds exactly one new top-level param to the query.)

function logStepDetails(callId, phone, step, q, donor) {
  var donorId = donor ? donor.id : null;

  switch (step) {
    case "payment_menu":
      safeInsertCallLog(callId, phone, "menu_selection",
        { choice: "1", menu: "main", label: "payment", donorId: donorId });
      break;

    case "debt_list":
      safeInsertCallLog(callId, phone, "menu_selection",
        { choice: "2", menu: "main", label: "prev_debts", donorId: donorId });
      break;

    case "record_message":
      safeInsertCallLog(callId, phone, "menu_selection",
        { choice: "3", menu: "main", label: "voice_message", donorId: donorId });
      break;

    case "pay_full":
      safeInsertCallLog(callId, phone, "payment_submenu", {
        choice: "1", label: "full_debt",
        amount: donor && donor.currentDebt ? donor.currentDebt.amount : null,
        donorId: donorId,
      });
      break;

    case "enter_amount":
      safeInsertCallLog(callId, phone, "payment_submenu",
        { choice: "2", label: "custom_amount", donorId: donorId });
      break;

    case "pay_custom":
      safeInsertCallLog(callId, phone, "amount_entered",
        { amount: lastParam(q, "amount"), context: "payment", donorId: donorId });
      break;

    case "pay_all_debts":
      safeInsertCallLog(callId, phone, "debt_submenu",
        { choice: "1", label: "pay_all", donorId: donorId });
      break;

    case "enter_debt_amount":
      safeInsertCallLog(callId, phone, "debt_submenu",
        { choice: "2", label: "custom_amount", donorId: donorId });
      break;

    case "pay_debt_custom":
      safeInsertCallLog(callId, phone, "amount_entered",
        { amount: lastParam(q, "amount"), context: "debt_payment", donorId: donorId });
      break;

    case "end":
      safeInsertCallLog(callId, phone, "debt_submenu",
        { choice: "9", label: "end_call", donorId: donorId });
      break;
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

function handleIvrQuery(query) {
  var q      = query || {};
  var callId = asText(q.PBXcallId) || (asText(q.PBXphone) + "-" + Date.now());
  var phone  = normalizePhone(q.PBXphone);
  var step   = detectIvrStep(q);

  console.log("[IVR] step:", step, "| callId:", callId, "| phone:", phone,
              "| params:", Object.keys(q).join(","));

  // ── HANGUP ────────────────────────────────────────────────────────────────
  if (step === "hangup") {
    logCallEnd(callId, phone, "hangup");
    return { hangup: true };
  }

  // ── Phone required ────────────────────────────────────────────────────────
  if (!phone) {
    console.warn("[IVR] Missing PBXphone — cannot process call");
    safeInsertCallLog(callId, null, "error", { reason: "missing_phone" });
    return { response: ivrErrorResponse() };
  }

  // ── Session start + call_start log (only on first request per callId) ─────
  var isFirstRequest = logCallStart(callId, phone);

  // ── Donor lookup ──────────────────────────────────────────────────────────
  var donor = getDonorForIvr(phone);

  if (isFirstRequest) {
    if (donor) {
      logDonorIdentified(callId, phone, donor.id, donor.fullName, {
        hasDebt:    !!donor.currentDebt,
        debtAmount: donor.currentDebt ? donor.currentDebt.amount : null,
        prevDebts:  donor.previousDebts ? donor.previousDebts.length : 0,
      });
    } else {
      logUnknownCaller(callId, phone);
    }
  }

  console.log("[IVR] donor:", donor ? donor.fullName : "unknown",
              "| debt:", donor && donor.currentDebt ? donor.currentDebt.amount : "none");

  // ── Per-step audit log ────────────────────────────────────────────────────
  logStepDetails(callId, phone, step, q, donor);

  // ── Voice message received ────────────────────────────────────────────────
  if (step === "voice_message") {
    safeInsertCallLog(callId, phone, "voice_message_received",
      { donorId: donor ? donor.id : null });
    logCallEnd(callId, phone, "voice_message");
    return { response: buildResponse(q, donor) };
  }

  // ── Payment result ────────────────────────────────────────────────────────
  if (step === "payment") {
    var paymentStatus = asText(q.payment);
    var amount        = resolvePaymentAmount(q, donor);

    if (paymentStatus === "OK") {
      if (amount === null) {
        // Technoline reported success but we cannot determine the amount.
        // This should not happen in normal flow; log and surface an error.
        console.error("[IVR] payment=OK but amount could not be resolved.",
                      "sanitized query:", JSON.stringify(sanitizeQuery(q)));
        safeInsertCallLog(callId, phone, "error", {
          reason: "payment_ok_but_no_amount",
          params: sanitizeQuery(q),
        });
        logCallEnd(callId, phone, "error");
        return { response: ivrErrorResponse() };
      }

      var saveResult = saveIvrPaymentOnce({
        callId:  callId,
        phone:   phone,
        donorId: donor ? donor.id : null,
        amount:  amount,
      });

      safeInsertCallLog(callId, phone, "payment_success", {
        donorId:   donor ? donor.id   : null,
        donorName: donor ? donor.fullName : null,
        amount:    amount,
        duplicate: saveResult.duplicate,
      });
      logCallEnd(callId, phone, "payment_success", amount);

    } else {
      safeInsertCallLog(callId, phone, "payment_failed", {
        result:    paymentStatus,
        donorId:   donor ? donor.id : null,
      });
      logCallEnd(callId, phone, "payment_failed");
    }

    return { response: buildResponse(q, donor) };
  }

  // ── Normal flow step (menu, sub-menus, DTMF entry) ───────────────────────
  return { response: buildResponse(q, donor) };
}

module.exports = {
  asText,
  detectIvrStep,
  handleIvrQuery,
  ivrErrorResponse,
};

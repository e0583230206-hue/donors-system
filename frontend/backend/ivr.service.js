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
const { updateDonorDebtAfterPayment } = require("./db");

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
  // IMPORTANT: payment and voiceMessage MUST be checked before PBXcallStatus=HANGUP.
  // Technoline accumulates all params across requests, so the final HANGUP notification
  // often arrives with payment=OK still present in the accumulated query. Checking
  // HANGUP first would swallow the payment result entirely.
  if (q.voiceMessage !== undefined) {
    console.log("[IVR] detectIvrStep => voice_message");
    return "voice_message";
  }
  if (q.payment !== undefined) {
    console.log("[IVR] detectIvrStep => payment | raw payment:", JSON.stringify(q.payment),
                "| PBXcallStatus:", q.PBXcallStatus || "absent");
    return "payment";
  }
  if (asText(q.PBXcallStatus) === "HANGUP") {
    console.log("[IVR] detectIvrStep => hangup | payment NOT in query");
    return "hangup";
  }

  var main = lastParam(q, "mainChoice");
  var pay  = lastParam(q, "payChoice");
  var debt = lastParam(q, "debtChoice");
  var amt  = lastParam(q, "amount");

  var step;
  if (main === "1") {
    if (pay === "1")                           step = "pay_full";
    else if (pay === "2" && amt !== undefined) step = "pay_custom";
    else if (pay === "2")                      step = "enter_amount";
    else if (amt !== undefined)                step = "pay_custom";
    else                                       step = "payment_menu";
  } else if (main === "2") {
    if (debt === "1")                          step = "pay_all_debts";
    else if (debt === "2" && amt !== undefined) step = "pay_debt_custom";
    else if (debt === "2")                     step = "enter_debt_amount";
    else if (debt === "9")                     step = "end";
    else                                       step = "debt_list";
  } else if (main === "3") {
    step = "record_message";
  } else {
    step = "menu";
  }
  console.log("[IVR] detectIvrStep => " + step + " | main:", main, "pay:", pay, "debt:", debt, "amt:", amt);
  return step;
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
  var rawCallId = asText(q.PBXcallId);
  var callId    = rawCallId || ("phone-" + asText(q.PBXphone));
  if (!rawCallId) {
    console.warn("[IVR] PBXcallId missing — using phone-based fallback callId", { callId: callId });
  }
  var phone  = normalizePhone(q.PBXphone);
  var step   = detectIvrStep(q);

  console.log("[IVR] step:", step,
              "| callId:", callId,
              "| phone:", phone,
              "| params:", Object.keys(q).join(","),
              "| payment raw:", q.payment !== undefined ? JSON.stringify(q.payment) : "absent",
              "| PBXcallStatus:", q.PBXcallStatus || "absent");

  // ── HANGUP ────────────────────────────────────────────────────────────────
  if (step === "hangup") {
    console.log("[IVR] hangup handler | note: payment absent from query, nothing to save");
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
              "| currentDebt:", donor && donor.currentDebt ? donor.currentDebt.amount : "none",
              "| previousDebts count:", donor ? (donor.previousDebts || []).length : "N/A");

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
    // Technoline accumulates same-named params as arrays across requests.
    // If q.payment is e.g. ["OK","ERROR"], a prior success must not be ignored.
    // We treat the payment as successful if "OK" appears anywhere in the array.
    var paymentArr   = Array.isArray(q.payment) ? q.payment : [q.payment];
    var paymentStatus = paymentArr.some(function (v) { return v === "OK"; }) ? "OK"
                       : asText(lastParam(q, "payment"));

    var amount = resolvePaymentAmount(q, donor);

    console.log("[IVR] >>> payment handler entered",
                "| raw q.payment:", JSON.stringify(q.payment),
                "| paymentArr:", JSON.stringify(paymentArr),
                "| resolved paymentStatus:", paymentStatus,
                "| resolved amount:", amount,
                "| callId:", callId, "| phone:", phone);
    console.log("[IVR] payment context | payChoice:", lastParam(q, "payChoice"),
                "| debtChoice:", lastParam(q, "debtChoice"),
                "| amount param:", lastParam(q, "amount"),
                "| CONFIRM_payment:", lastParam(q, "CONFIRM_payment"),
                "| PBXcallStatus:", q.PBXcallStatus || "absent");

    if (paymentStatus === "OK") {
      if (amount === null) {
        // Technoline reported success but we cannot determine the amount.
        console.error("[IVR] payment=OK but amount could not be resolved.",
                      "| donor:", donor ? donor.fullName : "unknown",
                      "| currentDebt:", donor && donor.currentDebt ? JSON.stringify(donor.currentDebt) : "none",
                      "| previousDebts:", donor ? JSON.stringify(donor.previousDebts || []) : "N/A",
                      "| sanitized query:", JSON.stringify(sanitizeQuery(q)));
        safeInsertCallLog(callId, phone, "error", {
          reason: "payment_ok_but_no_amount",
          params: sanitizeQuery(q),
        });
        logCallEnd(callId, phone, "error");
        return { response: ivrErrorResponse() };
      }

      // Use lastParam for confirmation number in case it was also accumulated
      var confirmationNumber = asText(lastParam(q, "CONFIRM_payment")) || null;

      console.log("[IVR] payment=OK | amount:", amount, "| confirmation:", confirmationNumber,
                  "| donor:", donor ? donor.fullName : "unknown",
                  "| donorId:", donor ? donor.id : null);

      // ── Save payment record ──────────────────────────────────────────────────
      var saveResult = { duplicate: false };
      try {
        console.log("[IVR] calling saveIvrPaymentOnce | callId:", callId,
                    "phone:", phone, "amount:", amount, "confirmation:", confirmationNumber);
        saveResult = saveIvrPaymentOnce({
          callId:             callId,
          phone:              phone,
          donorId:            donor ? donor.id : null,
          amount:             amount,
          confirmationNumber: confirmationNumber,
        });
        console.log("[IVR] Payment saved to DB. callId:", callId,
                    "| amount:", amount, "| confirmation:", confirmationNumber,
                    "| duplicate:", saveResult.duplicate);
      } catch (saveErr) {
        console.error("[IVR] CRITICAL: failed to save payment record.",
                      "| callId:", callId, "| amount:", amount,
                      "| phone:", phone, "| confirmation:", confirmationNumber,
                      "| error:", saveErr.message || saveErr);
        safeInsertCallLog(callId, phone, "error", {
          reason:             "payment_db_save_failed",
          error:              saveErr.message || String(saveErr),
          amount:             amount,
          confirmationNumber: confirmationNumber,
        });
      }

      // ── Update donor's open debt in app_state ────────────────────────────────
      console.log("[IVR] calling updateDonorDebtAfterPayment | phone:", phone, "amount:", amount);
      var debtResult = updateDonorDebtAfterPayment(phone, amount);
      console.log("[IVR] updateDonorDebtAfterPayment returned:", JSON.stringify(debtResult));

      if (debtResult.updated) {
        console.log("[IVR] Donor debt updated. phone:", phone,
                    "| paid:", amount, "| affectedDebts:", debtResult.affectedDebts);
      } else {
        console.warn("[IVR] Donor debt NOT updated after payment.",
                     "| phone:", phone, "| amount:", amount,
                     "| reason:", debtResult.reason);
        if (!debtResult.donorFound || debtResult.reason === "no_open_debts") {
          safeInsertCallLog(callId, phone, "error", {
            reason:        "debt_update_failed",
            debtResult:    debtResult,
            amount:        amount,
          });
        }
      }

      safeInsertCallLog(callId, phone, "payment_success", {
        donorId:            donor ? donor.id   : null,
        donorName:          donor ? donor.fullName : null,
        amount:             amount,
        confirmationNumber: confirmationNumber,
        duplicate:          saveResult.duplicate,
        debtUpdated:        debtResult.updated,
      });
      logCallEnd(callId, phone, "payment_success", amount);

    } else {
      console.log("[IVR] paymentStatus is not OK:", paymentStatus,
                  "— entering failure branch",
                  "| raw q.payment:", JSON.stringify(q.payment),
                  "| callId:", callId);
      safeInsertCallLog(callId, phone, "payment_failed", {
        result:    paymentStatus,
        rawPayment: JSON.stringify(q.payment),
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

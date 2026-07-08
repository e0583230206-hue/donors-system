const { buildResponse, buildIdentificationResponse } = require("./ivr");
const {
  normalizePhone,
  findDonorByAniSafe,
  findDonorByPhoneOrIdNumber,
} = require("./donor.service");
const {
  safeInsertCallLog,
  logCallStart,
  logDonorIdentified,
  logUnknownCaller,
  logPayerIdentified,
  logCallEnd,
} = require("./log.service");
const { parsePositiveAmount, saveIvrPaymentOnce } = require("./payment.service");
const { updateDonorDebtAfterPayment, insertAuditLog } = require("./db");

// Caller-identification redesign: max failed attempts before falling back to
// voicemail (decision #1/#2 — same cap for self-identification and
// beneficiary search, counted independently per branch).
var MAX_IDENT_ATTEMPTS = 3;

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

// Normalizes an accumulated param to an array (missing → [], scalar → [x]).
// Used for identification DTMF fields, where the array's length doubles as
// the attempt count — each retry adds one more entered value, mirroring how
// Technoline already accumulates every other repeated param in this file.
function asArray(val) {
  if (val === undefined) return [];
  return Array.isArray(val) ? val : [val];
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

// Redact PII from console logs in production.
// Set IVR_DEBUG=true in .env to restore full logging without changing NODE_ENV.
var IVR_DEBUG = process.env.IVR_DEBUG === "true";
var _isProd   = process.env.NODE_ENV === "production" && !IVR_DEBUG;
function mask(v) { return _isProd ? "[REDACTED]" : v; }

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

  // ── Identification gate (decision #6) ──────────────────────────────────────
  // Until a beneficiary donor is confirmed, EVERY request is the
  // "identification" step — mainChoice/payChoice/debtChoice are not even
  // inspected below, regardless of what Technoline's accumulated query
  // happens to contain. Debt is never read and payment never proceeds
  // without a confirmed identification.
  var identChoice  = lastParam(q, "identChoice");
  var identConfirm = lastParam(q, "identConfirm");
  var beneficiaryConfirmed = identChoice === "1" || identConfirm === "1";
  if (!beneficiaryConfirmed) {
    console.log("[IVR] detectIvrStep => identification | identChoice:", identChoice, "identConfirm:", identConfirm);
    return "identification";
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
  var pay    = lastParam(q, "payChoice");
  var debt   = lastParam(q, "debtChoice");
  var rawAmt = lastParam(q, "amount");

  // payChoice=1 → full current debt takes priority over any accumulated amount param.
  // Technoline accumulates params across requests, so an old custom-amount entry may
  // still be present even after the user later chose "pay full" (payChoice=1).
  // Using amount in that case would charge the wrong figure.
  if (pay === "1") {
    if (rawAmt !== undefined) {
      console.warn("[IVR] resolvePaymentAmount: payChoice=1 but stale amount param present — param collision detected, using full debt");
    }
    if (donor && donor.currentDebt) return donor.currentDebt.amount;
    return null;
  }

  // debtChoice=1 → sum all open debts takes priority for the same reason.
  if (debt === "1") {
    if (rawAmt !== undefined) {
      console.warn("[IVR] resolvePaymentAmount: debtChoice=1 but stale amount param present — param collision detected, using all-debts total");
    }
    if (donor) {
      var allDebts = (donor.currentDebt ? [donor.currentDebt] : []).concat(donor.previousDebts || []);
      var total = allDebts.reduce(function (s, d) { return s + d.amount; }, 0);
      if (total > 0) return Math.round(total * 100) / 100;
    }
    return null;
  }

  // Custom amount path (pay=2 or debt=2): use the DTMF-entered value.
  var dtmf = parsePositiveAmount(rawAmt);
  if (dtmf !== null) return dtmf;

  return null;
}

// ── Caller identification ───────────────────────────────────────────────────
//
// Resolves WHO is on the phone (payer) and, once identChoice/identConfirm
// confirm it, WHOSE debt is being paid (beneficiary) — these can differ
// ("pay for someone else"). Every function here is a pure re-derivation from
// the accumulated query on this one stateless request; nothing is cached
// across requests except what donor.service/db already persist.

// No side effects (no logging) — used to re-derive the already-identified
// payer on every request AFTER identification is confirmed, and internally
// by resolveIdentificationState() below while identification is still in
// progress.
function resolvePayerSilent(q, phone) {
  var aniResult = findDonorByAniSafe(phone);
  if (aniResult.outcome === "single") {
    return { donor: aniResult.donor, method: "ani" };
  }

  var selfArr = asArray(q.selfIdentInput);
  if (selfArr.length === 0) return { donor: null, method: null };

  var manualResult = findDonorByPhoneOrIdNumber(selfArr[selfArr.length - 1]);
  return manualResult.outcome === "single"
    ? { donor: manualResult.donor, method: manualResult.method }
    : { donor: null, method: null };
}

// Beneficiary = whoever's debt is actually being paid. identChoice=1 (self)
// → beneficiary is the payer. identConfirm=1 (confirmed a searched donor) →
// beneficiary is that searched donor. No side effects.
function resolveBeneficiary(q, phone) {
  var identChoice  = lastParam(q, "identChoice");
  var identConfirm = lastParam(q, "identConfirm");

  if (identChoice === "1") {
    return resolvePayerSilent(q, phone).donor;
  }
  if (identConfirm === "1") {
    var benArr = asArray(q.beneficiaryIdentInput);
    if (benArr.length === 0) return null;
    var benResult = findDonorByPhoneOrIdNumber(benArr[benArr.length - 1]);
    return benResult.outcome === "single" ? benResult.donor : null;
  }
  return null;
}

// Resolves both payer and beneficiary together — used once, at the moment a
// payment is actually saved, so the payment record can capture who called
// (payer) as well as whose debt was paid (beneficiary), and whether it was
// a self-payment.
function resolvePayerAndBeneficiary(q, phone) {
  var identChoice = lastParam(q, "identChoice");
  var payer = resolvePayerSilent(q, phone);
  var beneficiaryDonor = identChoice === "1" ? payer.donor : resolveBeneficiary(q, phone);
  return {
    payerDonor:      payer.donor,
    payerMethod:     payer.method,
    beneficiaryDonor: beneficiaryDonor,
    isSelfPayment:   identChoice === "1",
  };
}

// The only function in this section WITH side effects (logging) — called
// once per request while step === "identification", to decide exactly which
// prompt to play next and record what happened along the way. Never reads or
// exposes debt information (that only happens once a beneficiary is
// confirmed and buildResponse() takes over).
function resolveIdentificationState(q, phone, callId) {
  var identChoice  = lastParam(q, "identChoice");
  var identConfirm = lastParam(q, "identConfirm");

  function logMultipleMatchesBlocked(context) {
    try {
      insertAuditLog({
        action:     "ivr_multiple_matches_blocked",
        entityType: "ivr_call",
        entityId:   callId,
        details:    context,
        workerName: "IVR",
      });
    } catch (err) {
      console.error("[IVR] Failed to write server_audit_log for ivr_multiple_matches_blocked:", err.message);
    }
  }

  // ── "Pay for someone else" branch ──────────────────────────────────────────
  if (identChoice === "2") {
    if (identConfirm === "2") {
      safeInsertCallLog(callId, phone, "beneficiary_search_retry", {});
      return { kind: "beneficiary_input" };
    }

    var benArr = asArray(q.beneficiaryIdentInput);
    if (benArr.length === 0) {
      return { kind: "beneficiary_input" };
    }

    var benResult = findDonorByPhoneOrIdNumber(benArr[benArr.length - 1]);

    if (benResult.outcome === "single") {
      safeInsertCallLog(callId, phone, "beneficiary_confirmed", {
        donorId: benResult.donor.id, donorName: benResult.donor.fullName, method: benResult.method,
      });
      return { kind: "beneficiary_confirm", donor: benResult.donor, method: benResult.method };
    }

    if (benResult.outcome === "multiple") {
      logMultipleMatchesBlocked("חיפוש תורם עבור תשלום — נמצאו כמה התאמות, לא נבחר אוטומטית");
      safeInsertCallLog(callId, phone, "beneficiary_multiple_matches", { attempt: benArr.length });
    } else {
      safeInsertCallLog(callId, phone, "beneficiary_not_found", { attempt: benArr.length });
    }

    if (benArr.length >= MAX_IDENT_ATTEMPTS) {
      safeInsertCallLog(callId, phone, "identification_max_attempts", { branch: "beneficiary" });
      return { kind: "max_attempts" };
    }
    return { kind: "beneficiary_input_retry", reason: benResult.outcome };
  }

  // ── Self branch (Caller ID, or manual self-identification) ─────────────────
  var aniResult = findDonorByAniSafe(phone);

  if (aniResult.outcome === "single") {
    logPayerIdentified(callId, phone, aniResult.donor.id, aniResult.donor.fullName, "ani");
    return { kind: "self_menu", donor: aniResult.donor, method: "ani" };
  }

  var selfArr = asArray(q.selfIdentInput);

  // Log the Caller-ID outcome exactly once — the first time we fall through
  // to manual self-identification for this call (selfArr still empty).
  if (selfArr.length === 0) {
    if (aniResult.outcome === "multiple") {
      logMultipleMatchesBlocked("זיהוי לפי Caller ID — נמצאו כמה תורמים למספר הזה, לא נבחר אוטומטית");
      safeInsertCallLog(callId, phone, "payer_ani_multiple_matches", { phone: phone });
    } else {
      safeInsertCallLog(callId, phone, "payer_unidentified", { phone: phone });
    }
    return { kind: "self_input" };
  }

  var selfResult = findDonorByPhoneOrIdNumber(selfArr[selfArr.length - 1]);

  if (selfResult.outcome === "single") {
    logPayerIdentified(callId, phone, selfResult.donor.id, selfResult.donor.fullName, selfResult.method);
    return { kind: "self_menu", donor: selfResult.donor, method: selfResult.method };
  }

  if (selfResult.outcome === "multiple") {
    logMultipleMatchesBlocked("זיהוי עצמי ידני — נמצאו כמה התאמות, לא נבחר אוטומטית");
    safeInsertCallLog(callId, phone, "payer_multiple_matches", { attempt: selfArr.length });
  } else {
    safeInsertCallLog(callId, phone, "payer_not_found", { attempt: selfArr.length });
  }

  if (selfArr.length >= MAX_IDENT_ATTEMPTS) {
    safeInsertCallLog(callId, phone, "identification_max_attempts", { branch: "self" });
    return { kind: "max_attempts" };
  }
  return { kind: "self_input_retry", reason: selfResult.outcome };
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
              "| phone:", mask(phone),
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

  // ── Identification phase (decision #6) ─────────────────────────────────────
  // No debt is ever read and no payment ever proceeds until a beneficiary is
  // confirmed (identChoice=1 or identConfirm=1) — see detectIvrStep().
  if (step === "identification") {
    var identState = resolveIdentificationState(q, phone, callId);
    return { response: buildIdentificationResponse(q, identState) };
  }

  // ── Beneficiary lookup (whose debt is being read/paid — may differ from
  // the payer when identChoice=2 "pay for someone else" was used) ───────────
  var donor = resolveBeneficiary(q, phone);

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

  console.log("[IVR] donor:", donor ? mask(donor.fullName) : "unknown",
              "| currentDebt:", donor && donor.currentDebt ? mask(donor.currentDebt.amount) : "none",
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
                      "| donor:", donor ? mask(donor.fullName) : "unknown",
                      "| currentDebt:", donor && donor.currentDebt ? (mask(donor.currentDebt.amount) + " " + (donor.currentDebt.currency || "")) : "none",
                      "| prevDebtsCount:", donor ? (donor.previousDebts || []).length : "N/A",
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

      // Payer (who called/identified themselves) vs beneficiary (donor, whose
      // debt this payment reduces) — may differ under "pay for someone else".
      var identInfo = resolvePayerAndBeneficiary(q, phone);

      // Defensive backstop: logPayerIdentified() normally already ran during
      // the identification phase (resolveIdentificationState), but re-assert
      // it here too (it's idempotent — only sets the session field once) so
      // the session's payer summary is never left blank even if this exact
      // request happens to be the first one where all params are present.
      if (identInfo.payerDonor) {
        logPayerIdentified(callId, phone, identInfo.payerDonor.id, identInfo.payerDonor.fullName, identInfo.payerMethod);
      }

      console.log("[IVR] payment=OK | amount:", mask(amount), "| confirmation:", mask(confirmationNumber),
                  "| donor:", donor ? mask(donor.fullName) : "unknown",
                  "| donorId:", donor ? donor.id : null,
                  "| payerDonorId:", identInfo.payerDonor ? identInfo.payerDonor.id : null,
                  "| identMethod:", identInfo.payerMethod,
                  "| isSelfPayment:", identInfo.isSelfPayment);

      // ── Save payment record ──────────────────────────────────────────────────
      var saveResult = { duplicate: false };
      try {
        console.log("[IVR] calling saveIvrPaymentOnce | callId:", callId,
                    "phone:", mask(phone), "amount:", mask(amount), "confirmation:", mask(confirmationNumber));
        saveResult = saveIvrPaymentOnce({
          callId:               callId,
          phone:                phone,
          donorId:              donor ? donor.id : null,
          amount:               amount,
          confirmationNumber:   confirmationNumber,
          payerDonorId:         identInfo.payerDonor ? identInfo.payerDonor.id : null,
          payerPhone:           phone,
          identificationMethod: identInfo.payerMethod,
          isSelfPayment:        identInfo.isSelfPayment,
        });
        console.log("[IVR] Payment saved to DB. callId:", callId,
                    "| amount:", mask(amount), "| confirmation:", mask(confirmationNumber),
                    "| duplicate:", saveResult.duplicate);
      } catch (saveErr) {
        console.error("[IVR] CRITICAL: failed to save payment record.",
                      "| callId:", callId, "| amount:", mask(amount),
                      "| phone:", mask(phone), "| confirmation:", mask(confirmationNumber),
                      "| error:", saveErr.message || saveErr);
        safeInsertCallLog(callId, phone, "error", {
          reason:             "payment_db_save_failed",
          error:              saveErr.message || String(saveErr),
          amount:             amount,
          confirmationNumber: confirmationNumber,
        });
      }

      // ── Update donor's open debt in app_state ────────────────────────────────
      console.log("[IVR] calling updateDonorDebtAfterPayment | phone:", mask(phone), "amount:", mask(amount));
      var debtResult = updateDonorDebtAfterPayment(phone, amount);
      console.log("[IVR] updateDonorDebtAfterPayment returned:", JSON.stringify(debtResult));

      if (debtResult.updated) {
        console.log("[IVR] Donor debt updated. phone:", mask(phone),
                    "| paid:", mask(amount), "| affectedDebts:", debtResult.affectedDebts);
      } else {
        console.warn("[IVR] Donor debt NOT updated after payment.",
                     "| phone:", mask(phone), "| amount:", mask(amount),
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

      try {
        insertAuditLog({
          action:     "ivr_payment_success",
          entityType: "donor",
          entityId:   donor ? donor.id : null,
          entityName: donor ? donor.fullName : null,
          details:    "תשלום IVR התקבל בסך " + amount + " ₪" +
                      (confirmationNumber ? " (אישור " + confirmationNumber + ")" : "") +
                      (saveResult.duplicate ? " — כפול, לא נספר פעמיים" : ""),
          workerName: "IVR",
        });
      } catch (auditErr) {
        console.error("[IVR] Failed to write server_audit_log for payment_success:", auditErr.message);
      }

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

      try {
        insertAuditLog({
          action:     "ivr_payment_failed",
          entityType: "donor",
          entityId:   donor ? donor.id : null,
          entityName: donor ? donor.fullName : null,
          details:    "תשלום IVR נכשל — סטטוס: " + paymentStatus,
          workerName: "IVR",
        });
      } catch (auditErr) {
        console.error("[IVR] Failed to write server_audit_log for payment_failed:", auditErr.message);
      }
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

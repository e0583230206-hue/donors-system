const { buildResponse } = require("./ivr");
const { getDonorForIvr, normalizePhone } = require("./donor.service");
const { safeInsertCallLog } = require("./log.service");
const { parsePositiveAmount, saveIvrPaymentOnce } = require("./payment.service");

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

// When Technoline accumulates same-named params, Express may give an array.
function lastParam(q, name) {
  var val = q[name];
  if (Array.isArray(val)) return val[val.length - 1];
  return val;
}

function detectIvrStep(q) {
  if (q.PBXcallStatus === "HANGUP") return "hangup";
  if (q.voiceMessage !== undefined)  return "voice_message";
  if (q.payment !== undefined)        return "payment";

  var main  = lastParam(q, "mainChoice");
  var pay   = lastParam(q, "payChoice");
  var debt  = lastParam(q, "debtChoice");
  var amt   = lastParam(q, "amount");

  if (main === "1") {
    if (pay === "1")                    return "pay_full";
    if (pay === "2" && amt !== undefined) return "pay_custom";
    if (pay === "2")                    return "enter_amount";
    if (amt !== undefined)              return "pay_custom";
    return "payment_menu";
  }
  if (main === "2") {
    if (debt === "1")                   return "pay_all_debts";
    if (debt === "2" && amt !== undefined) return "pay_debt_custom";
    if (debt === "2")                   return "enter_debt_amount";
    if (debt === "9")                   return "end";
    return "debt_list";
  }
  if (main === "3") return "record_message";
  return "menu";
}

function handleIvrQuery(query) {
  var q      = query || {};
  var callId = asText(q.PBXcallId) || asText(q.PBXphone) + "-" + Date.now();
  var phone  = normalizePhone(q.PBXphone);
  var step   = detectIvrStep(q);

  console.log("[IVR:handleIvrQuery] callId:", callId, "phone:", phone, "step:", step);

  safeInsertCallLog(callId, phone, step, q);

  if (q.PBXcallStatus === "HANGUP") {
    return { hangup: true };
  }

  if (!phone) {
    console.warn("[IVR] Missing PBXphone — cannot process");
    return { response: ivrErrorResponse() };
  }

  var donor = getDonorForIvr(phone);
  console.log("[IVR:handleIvrQuery] donor:", donor ? donor.fullName : "null", "currentDebt:", donor && donor.currentDebt ? donor.currentDebt.amount : "none");

  // Log voice message receipt
  if (q.voiceMessage !== undefined) {
    safeInsertCallLog(callId, phone, "voice_message_received", {
      voiceMessage: q.voiceMessage,
      donorId: donor ? donor.id : null,
    });
  }

  // Log payment errors
  if (q.payment !== undefined && asText(q.payment) !== "OK") {
    safeInsertCallLog(callId, phone, "payment_failed", {
      payment: q.payment,
      query: q,
    });
  }

  // Save successful payment
  if (asText(q.payment) === "OK") {
    var amount = parsePositiveAmount(lastParam(q, "amount"));

    if (amount === null) {
      safeInsertCallLog(callId, phone, "error", {
        reason: "payment_ok_but_no_amount",
        query: q,
      });
      return { response: ivrErrorResponse() };
    }

    var result = saveIvrPaymentOnce({
      callId:  callId,
      phone:   phone,
      donorId: donor ? donor.id : null,
      amount:  amount,
    });

    safeInsertCallLog(callId, phone, "payment_success", {
      donorId:   donor ? donor.id : null,
      amount:    amount,
      duplicate: result.duplicate,
    });
  }

  var ivrResponse = buildResponse(q, donor);
  console.log("[IVR:handleIvrQuery] response type:", Array.isArray(ivrResponse) ? "array" : (ivrResponse && ivrResponse.type) || typeof ivrResponse, "| name:", ivrResponse && ivrResponse.name);
  return { response: ivrResponse };
}

module.exports = {
  asText,
  detectIvrStep,
  handleIvrQuery,
  ivrErrorResponse,
};

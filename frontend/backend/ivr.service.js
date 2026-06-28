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
    { type: "simpleMessage", text: "אירעה שגיאה. אנא נסה שוב מאוחר יותר." },
    { type: "hangup" },
  ];
}

function detectIvrStep(q) {
  if (q.PBXcallStatus === "HANGUP") return "hangup";
  if (q.payment !== undefined) return "payment";
  if (q.menuChoice === "1" && q.amount !== undefined) return "amount";
  if (q.menuChoice === "1") return "menu";
  if (q.menuChoice === "2") return "menu";
  if (q.menuChoice === "3") return "hangup";
  return "menu";
}

function handleIvrQuery(query) {
  const q = query || {};
  const callId = asText(q.PBXcallId);
  const phone = normalizePhone(q.PBXphone);

  safeInsertCallLog(callId, phone, detectIvrStep(q), q);

  if (q.PBXcallStatus === "HANGUP") {
    return { hangup: true };
  }

  if (!callId || !phone) {
    safeInsertCallLog(callId, phone, "error", {
      reason: "missing_pbx_data",
      query: q,
    });

    return { response: ivrErrorResponse() };
  }

  const donor = getDonorForIvr(phone);

  if (q.menuChoice === "1" && q.amount !== undefined && q.payment === undefined) {
    const enteredAmount = parsePositiveAmount(q.amount);
    if (enteredAmount === null) {
      safeInsertCallLog(callId, phone, "error", {
        reason: "invalid_amount",
        amount: q.amount,
        query: q,
      });
    }
  }

  if (q.payment !== undefined && asText(q.payment) !== "OK") {
    safeInsertCallLog(callId, phone, "error", {
      reason: "payment_not_ok",
      payment: q.payment,
      query: q,
    });
  }

  if (asText(q.payment) === "OK") {
    const amount = parsePositiveAmount(q.amount);

    if (amount === null) {
      safeInsertCallLog(callId, phone, "error", {
        reason: "invalid_amount",
        amount: q.amount,
        query: q,
      });

      return { response: ivrErrorResponse() };
    }

    const result = saveIvrPaymentOnce({
      callId: callId,
      phone: phone,
      donorId: donor ? donor.id : null,
      amount: amount,
    });

    safeInsertCallLog(callId, phone, "payment_success", {
      callId: callId,
      phone: phone,
      donorId: donor ? donor.id : null,
      amount: amount,
      duplicate: result.duplicate,
    });
  }

  return {
    response: buildResponse(q, donor),
  };
}

module.exports = {
  asText,
  detectIvrStep,
  handleIvrQuery,
  ivrErrorResponse,
};

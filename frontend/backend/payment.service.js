const { savePaymentInTransaction } = require("./db");

function parsePositiveAmount(value) {
  if (value === undefined || value === null) return null;

  const text = String(value).trim();
  if (!text) return null;

  const amount = parseFloat(text);
  if (!isFinite(amount) || amount <= 0) return null;

  return amount;
}

function saveIvrPaymentOnce(details) {
  return savePaymentInTransaction({
    callId:               details.callId,
    phone:                details.phone,
    amount:               details.amount,
    donorId:              details.donorId              || null,
    confirmationNumber:   details.confirmationNumber    || null,
    payerDonorId:         details.payerDonorId          || null,
    payerPhone:           details.payerPhone            || null,
    identificationMethod: details.identificationMethod  || null,
    isSelfPayment:        !!details.isSelfPayment,
  });
}

module.exports = {
  parsePositiveAmount,
  saveIvrPaymentOnce,
};

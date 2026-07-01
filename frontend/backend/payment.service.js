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
  return savePaymentInTransaction(
    details.callId,
    details.phone,
    details.amount,
    details.donorId || null,
    details.confirmationNumber || null
  );
}

module.exports = {
  parsePositiveAmount,
  saveIvrPaymentOnce,
};

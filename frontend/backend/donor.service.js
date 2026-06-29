const {
  findDonorByPhone,
  getLastDonationAmountByPhone,
} = require("./db");

function normalizePhone(phone) {
  if (phone === undefined || phone === null) return "";

  // Strip all non-digit characters (+, spaces, dashes, parentheses)
  var digits = String(phone).trim().replace(/\D/g, "");
  if (!digits) return "";

  // Handle 00972... prefix (some carriers send this instead of +972)
  if (digits.startsWith("00")) {
    digits = digits.slice(2);
  }

  // 972XXXXXXXXX → 0XXXXXXXXX  (international → local Israeli format)
  if (digits.startsWith("972") && digits.length >= 11) {
    return "0" + digits.slice(3);
  }

  return digits;
}

function getDonorForIvr(phone) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return null;

  const donor = findDonorByPhone(normalizedPhone);
  if (!donor) return null;

  const suggestedAmount = getLastDonationAmountByPhone(normalizedPhone);

  return {
    id: donor.id,
    phone: donor.phone,
    fullName: donor.fullName,
    suggestedAmount: suggestedAmount,
  };
}

module.exports = {
  normalizePhone,
  getDonorForIvr,
};

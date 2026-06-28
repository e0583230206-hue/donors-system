const {
  findDonorByPhone,
  getLastDonationAmountByPhone,
} = require("./db");

function normalizePhone(phone) {
  if (phone === undefined || phone === null) return "";
  return String(phone).trim();
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

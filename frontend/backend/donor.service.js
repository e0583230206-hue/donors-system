const {
  findDonorByPhone,
  getAppState,
} = require("./db");

function normalizePhone(phone) {
  if (phone === undefined || phone === null) return "";

  var digits = String(phone).trim().replace(/\D/g, "");
  if (!digits) return "";

  if (digits.startsWith("00")) {
    digits = digits.slice(2);
  }

  if (digits.startsWith("972") && digits.length >= 11) {
    return "0" + digits.slice(3);
  }

  if (digits.length === 9 && !digits.startsWith("0")) {
    return "0" + digits;
  }

  return digits;
}

function getDonorForIvr(phone) {
  var normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return null;

  var donor = findDonorByPhone(normalizedPhone);
  if (!donor) return null;

  // Pull full donor data (donations, notes, IVR settings) from app_state JSON
  var appDonors = getAppState("donors");
  var appDonor  = null;
  if (Array.isArray(appDonors)) {
    appDonor = appDonors.find(function (d) {
      return normalizePhone(d.phone) === normalizedPhone;
    }) || null;
  }

  var publicPhoneNote = appDonor && appDonor.publicPhoneNote
    ? String(appDonor.publicPhoneNote).trim()
    : "";

  // Respect per-donor IVR settings; default everything to allowed
  var rawSettings = (appDonor && appDonor.phoneMessageSettings) || {};
  var settings = {
    allowPayment:       rawSettings.allowPayment       !== false,
    allowPreviousDebts: rawSettings.allowPreviousDebts !== false,
    allowCallback:      rawSettings.allowCallback      !== false,
  };

  // Build open debt list sorted newest first
  var openDebts = [];
  if (appDonor && Array.isArray(appDonor.donations)) {
    openDebts = appDonor.donations
      .filter(function (d) {
        return !d.paid && Number(d.remainingDebt) > 0;
      })
      .sort(function (a, b) {
        var da = new Date(a.date || a.createdAt || 0);
        var db = new Date(b.date || b.createdAt || 0);
        return db - da;
      })
      .map(function (d) {
        return {
          amount:  Math.round(Number(d.remainingDebt) * 100) / 100,
          purpose: String(d.finalPurpose || d.purpose || "כללי").trim(),
        };
      });
  }

  return {
    id:              donor.id,
    phone:           donor.phone,
    fullName:        donor.fullName,
    currentDebt:     openDebts[0]  || null,
    previousDebts:   openDebts.slice(1),
    publicPhoneNote: publicPhoneNote,
    settings:        settings,
  };
}

module.exports = {
  normalizePhone,
  getDonorForIvr,
};

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

// Returns all normalized phone numbers for a donor across all phone fields.
function getAllDonorPhones(donor) {
  var seen = {};
  var phones = [];
  function add(p) {
    var n = normalizePhone(p);
    if (n && !seen[n]) { seen[n] = true; phones.push(n); }
  }
  add(donor.phone);
  add(donor.phone2);
  add(donor.phone3);
  add(donor.phone4);
  (donor.phones || []).forEach(add);
  (donor.ivrApprovedPhones || []).forEach(add);
  return phones;
}

// Returns true if any of the donor's phones match normalizedPhone.
function donorMatchesPhone(donor, normalizedPhone) {
  return getAllDonorPhones(donor).indexOf(normalizedPhone) !== -1;
}

function getDonorForIvr(phone) {
  var normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return null;

  // Search app_state JSON by ALL phone fields — this is the authoritative source.
  var appDonors = getAppState("donors");
  var appDonor  = null;
  if (Array.isArray(appDonors)) {
    appDonor = appDonors.find(function (d) {
      return donorMatchesPhone(d, normalizedPhone);
    }) || null;
  }

  if (!appDonor) return null;

  // Find the SQLite donors row (for id used in FK references).
  // Try the canonical primary phone first, then any of the donor's phones.
  var donor = findDonorByPhone(normalizePhone(appDonor.phone));
  if (!donor) {
    var allPhones = getAllDonorPhones(appDonor);
    for (var i = 0; i < allPhones.length; i++) {
      donor = findDonorByPhone(allPhones[i]);
      if (donor) break;
    }
  }

  var publicPhoneNote = appDonor.publicPhoneNote
    ? String(appDonor.publicPhoneNote).trim()
    : "";

  // Respect per-donor IVR settings; default everything to allowed
  var rawSettings = appDonor.phoneMessageSettings || {};
  var settings = {
    allowPayment:       rawSettings.allowPayment       !== false,
    allowPreviousDebts: rawSettings.allowPreviousDebts !== false,
    allowCallback:      rawSettings.allowCallback      !== false,
  };

  // Build open debt list sorted newest first
  var openDebts = [];
  if (Array.isArray(appDonor.donations)) {
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
    id:              donor ? donor.id : null,
    phone:           donor ? donor.phone : appDonor.phone,
    fullName:        donor ? donor.fullName : (appDonor.fullName || ""),
    currentDebt:     openDebts[0]  || null,
    previousDebts:   openDebts.slice(1),
    publicPhoneNote: publicPhoneNote,
    settings:        settings,
  };
}

module.exports = {
  normalizePhone,
  getAllDonorPhones,
  donorMatchesPhone,
  getDonorForIvr,
};

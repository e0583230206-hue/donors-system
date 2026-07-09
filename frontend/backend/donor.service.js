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

// Israeli teudat zehut is numeric — same digit-stripping approach as phones.
function normalizeIdNumber(idNumber) {
  if (idNumber === undefined || idNumber === null) return "";
  return String(idNumber).trim().replace(/\D/g, "");
}

function donorMatchesIdNumber(donor, normalizedId) {
  return !!normalizedId && normalizeIdNumber(donor.idNumber) === normalizedId;
}

// Converts a raw app_state donor record into the shape the IVR flow needs
// (id/phone/fullName/currentDebt/previousDebts/publicPhoneNote/settings).
// Extracted out of getDonorForIvr() so the new multi-match-aware lookups
// below can build the exact same donor shape without duplicating this logic.
function buildIvrDonorFromAppRecord(appDonor) {
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

  return buildIvrDonorFromAppRecord(appDonor);
}

// ── Caller-identification redesign: multi-match-aware lookups ────────────────
//
// getDonorForIvr() above is left completely untouched (still used by
// /api/softphone/context) because it silently returns the FIRST matching
// donor via Array.find() — acceptable for a human-facing softphone hint, but
// not for an automated flow that authorizes a payment. The two functions
// below are used only by the new IVR identification flow (ivr.service.js)
// and never silently pick a donor when more than one matches.

function allAppDonors() {
  var appDonors = getAppState("donors");
  return Array.isArray(appDonors) ? appDonors : [];
}

// Multi-match-aware Caller-ID (ANI) lookup — decision #7.
function findDonorByAniSafe(phone) {
  var normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return { outcome: "not_found" };

  var matches = allAppDonors().filter(function (d) {
    return donorMatchesPhone(d, normalizedPhone);
  });

  if (matches.length === 0) return { outcome: "not_found" };
  if (matches.length > 1)   return { outcome: "multiple" };
  return { outcome: "single", donor: buildIvrDonorFromAppRecord(matches[0]), method: "ani" };
}

// Combined phone-or-teudat-zehut lookup for manual identification (self
// re-identification or "pay for someone else" search). Tries both fields
// against the same input and de-dupes by donor identity — if the same donor
// happens to match via both phone AND id number, that counts as ONE match,
// not two (explicitly required: "אם אותה התאמה נמצאה גם לפי טלפון וגם לפי
// מספר זהות אבל זה אותו תורם בדיוק — זה תקין").
function findDonorByPhoneOrIdNumber(input) {
  var normalizedPhone = normalizePhone(input);
  var normalizedId    = normalizeIdNumber(input);

  var donors = allAppDonors();
  var byKey  = {}; // appDonor.id -> { donor, methods: Set-like array }

  // Donors with no valid id must never be matched here — this function backs
  // an automated payment/identification flow, and `byKey[d.id]` would merge
  // every id-less donor into a single "undefined" bucket, letting two
  // different people be treated as one confirmed match.
  function hasValidId(d) { return d.id !== undefined && d.id !== null && d.id !== ""; }

  if (normalizedPhone) {
    donors.forEach(function (d) {
      if (!hasValidId(d)) return;
      if (!donorMatchesPhone(d, normalizedPhone)) return;
      var entry = byKey[d.id] || (byKey[d.id] = { donor: d, methods: [] });
      if (entry.methods.indexOf("phone") === -1) entry.methods.push("phone");
    });
  }
  if (normalizedId) {
    donors.forEach(function (d) {
      if (!hasValidId(d)) return;
      if (!donorMatchesIdNumber(d, normalizedId)) return;
      var entry = byKey[d.id] || (byKey[d.id] = { donor: d, methods: [] });
      if (entry.methods.indexOf("idNumber") === -1) entry.methods.push("idNumber");
    });
  }

  var uniqueKeys = Object.keys(byKey);
  if (uniqueKeys.length === 0) return { outcome: "not_found" };
  if (uniqueKeys.length > 1)   return { outcome: "multiple" };

  var only   = byKey[uniqueKeys[0]];
  var method = only.methods.length === 2 ? "both" : only.methods[0];
  return { outcome: "single", donor: buildIvrDonorFromAppRecord(only.donor), method: method };
}

module.exports = {
  normalizePhone,
  normalizeIdNumber,
  getAllDonorPhones,
  donorMatchesPhone,
  getDonorForIvr,
  findDonorByAniSafe,
  findDonorByPhoneOrIdNumber,
};

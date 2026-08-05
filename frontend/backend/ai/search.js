"use strict";
// ai/search.js — Phase C: global donor search + explicit disambiguation.
// Read-only, server-side. Mirrors the field set frontend/js/donors.js
// already searches (donorMatchesSearch: fullName/idNumber/phone.../city/
// neighborhood/address/alfonSerial/tags) so "which donor did you mean"
// resolves the same way the donors screen's own search box already does —
// this does not invent a new matching definition.

const { getAppState } = require("../db");
const { registerCapability, ROLES } = require("./capabilities");

const SUPPORTED_FIELDS = Object.freeze(["name", "phone", "idNumber", "city", "any"]);

function digitsOnly(s) {
  return String(s || "").replace(/\D/g, "");
}

function fieldMatch(donor, field, qLower, qDigits) {
  const s = (v) => String(v || "").toLowerCase().includes(qLower);
  switch (field) {
    case "name":
      return s(donor.fullName);
    case "phone":
      if (!qDigits) return false;
      return [donor.phone, donor.phone2, donor.phone3, donor.phone4]
        .some((p) => p && digitsOnly(p).includes(qDigits));
    case "idNumber":
      return s(donor.idNumber);
    case "city":
      return s(donor.city) || s(donor.neighborhood);
    case "any":
    default:
      return (
        s(donor.fullName) || s(donor.idNumber) || s(donor.city) || s(donor.neighborhood) ||
        s(donor.address) || s(donor.alfonSerial) ||
        (qDigits && [donor.phone, donor.phone2, donor.phone3, donor.phone4]
          .some((p) => p && digitsOnly(p).includes(qDigits))) ||
        (Array.isArray(donor.tags) && donor.tags.some((t) => s(t)))
      );
  }
}

function phoneLast4(donor) {
  const d = digitsOnly(donor.phone);
  return d ? d.slice(-4) : "";
}

/**
 * @param {string} query
 * @param {object} [opts]
 * @param {"name"|"phone"|"idNumber"|"city"|"any"} [opts.field="any"]
 * @param {number} [opts.limit=10]
 * @returns {{status:"none"|"unique"|"ambiguous", query, field, total, matches:Array, clarifyQ?:string}}
 */
function searchDonors(query, opts) {
  opts = opts || {};
  const field = SUPPORTED_FIELDS.includes(opts.field) ? opts.field : "any";
  const limit = Math.min(Math.max(Number(opts.limit) || 10, 1), 50);
  const q = String(query || "").trim();

  if (!q) {
    return { status: "none", query: q, field, total: 0, matches: [] };
  }

  const qLower  = q.toLowerCase();
  const qDigits = digitsOnly(q);
  const donors  = getAppState("donors") || [];

  const hits = donors.filter((d) => fieldMatch(d, field, qLower, qDigits));

  const matches = hits.slice(0, limit).map((d) => ({
    id:          d.id,
    fullName:    d.fullName || ("תורם #" + d.id),
    city:        d.city || null,
    phoneLast4:  phoneLast4(d),
    status:      d.status || "פעיל",
  }));

  if (hits.length === 0) {
    return { status: "none", query: q, field, total: 0, matches: [] };
  }

  if (hits.length === 1) {
    return { status: "unique", query: q, field, total: 1, matches, donorId: matches[0].id };
  }

  return {
    status: "ambiguous",
    query: q,
    field,
    total: hits.length,
    truncated: hits.length > limit,
    matches,
    clarifyQ: "נמצאו " + hits.length + " תורמים התואמים ל\"" + q + "\" — למי בדיוק התכוונת? " +
      matches.map((m) => m.fullName + (m.city ? " (" + m.city + ")" : "")).join(", "),
  };
}

registerCapability({
  id:           "read.donor_search",
  category:     "read",
  domain:       "donor",
  description:  "חיפוש תורם גלובלי לפי שם/טלפון/ת.ז./עיר, עם הבהרה מפורשת כשיש כמה תוצאות",
  roles:        [ROLES.ADMIN, ROLES.SECRETARY],
  riskTier:     "read",
  implemented:  true,
  status:       "enabled",
  testCoverage: ["ai/tests/search.test.js"],
  serviceFn:    "ai/search.js searchDonors()",
});

module.exports = { searchDonors, SUPPORTED_FIELDS };

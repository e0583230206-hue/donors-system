"use strict";
// ai/engines/sanitizer.js — PRIVACY ALLOW-LIST for anything sent to OpenAI.
//
// This replaces the previous strip-list approach (delete a handful of
// known-bad fields, forward everything else by default). A strip-list fails
// OPEN: a new PII field added to buildDonorContext/buildGlobalContext later
// would leak to OpenAI silently until someone remembered to add it to the
// delete-list. This fails CLOSED: only fields explicitly named below are
// ever forwarded — a new field is invisible here until someone deliberately
// allow-lists it, and even then only after deciding it's safe.
//
// Only aggregated numbers, dates, and the donor's own display name/city/tags
// are allow-listed. Never: phone numbers (any of phone/phone2/phone3/phone4/
// ivrApprovedPhones), notes/internalNotes/internalStaffNote/publicNotes/
// publicPhoneNote, address, idNumber, fatherName, externalId, alfonSerial,
// raw donation records, raw task/reminder text, or anything from the global
// context's allDonors/statsPerDonor/tasks/reminders arrays (those are full
// per-record objects containing the same PII).

const DONOR_ALLOWED_FIELDS = Object.freeze(["fullName", "city", "tags", "status"]);

const STATS_ALLOWED_FIELDS = Object.freeze([
  "totalDonations", "totalPaid", "totalDebt", "openDebtsCount",
  "avgAmount", "maxAmount", "lastDonationFmt", "daysSinceLastDonation", "paidCount",
]);

const GLOBAL_SUMMARY_ALLOWED_FIELDS = Object.freeze([
  "totalDonors", "activeDonors", "withDebt", "totalDebt", "totalPaid",
  "dormant90", "dormant180", "dormant365", "neverGiven",
  "openTasksCount", "urgentCount", "campaignReady", "noPhone",
]);

function pick(obj, allowedFields) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  allowedFields.forEach(function (f) {
    if (obj[f] !== undefined) out[f] = obj[f];
  });
  return out;
}

/**
 * Returns a new, minimal object containing ONLY allow-listed fields.
 * Never mutates the input. Unknown/future context types fail closed
 * (only the type marker is forwarded, nothing else).
 */
function sanitizeContextForOpenAI(ctx) {
  if (!ctx) return ctx;

  if (ctx.type === "donor") {
    return {
      type:     "donor",
      donor:    pick(ctx.donor, DONOR_ALLOWED_FIELDS),
      stats:    pick(ctx.stats, STATS_ALLOWED_FIELDS),
      fmtMoney: ctx.fmtMoney,
      fmtDate:  ctx.fmtDate,
    };
  }

  if (ctx.type === "global") {
    return {
      type:     "global",
      summary:  pick(ctx.summary, GLOBAL_SUMMARY_ALLOWED_FIELDS),
      fmtMoney: ctx.fmtMoney,
      fmtDate:  ctx.fmtDate,
    };
  }

  // Fail closed: any context shape not explicitly handled above forwards
  // nothing but its type marker rather than passing the raw object through.
  return { type: (ctx && ctx.type) || "unknown" };
}

module.exports = {
  sanitizeContextForOpenAI,
  DONOR_ALLOWED_FIELDS,
  STATS_ALLOWED_FIELDS,
  GLOBAL_SUMMARY_ALLOWED_FIELDS,
};

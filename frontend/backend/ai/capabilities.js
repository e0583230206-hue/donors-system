"use strict";
// ai/capabilities.js — Phase B: machine-readable capability registry.
//
// Single source of truth for "what can the AI assistant do, who is allowed
// to trigger it, does it need confirmation, and is it actually implemented
// today". Both the /api/ai/capabilities route (drives the widget's UI) and
// the capability-matrix generator in the final report read from here — so
// the matrix can never drift from what the server actually enforces.
//
// Two kinds of entries:
//   - "read"   — informational, always safe, no side effect. Read intents
//                already handled by ai/detector.js + ai/handlers/* are
//                bootstrapped in automatically below so this file doesn't
//                duplicate that list by hand.
//   - "action" — has a real (or, for Phase G, intentionally disabled)
//                side effect. Registered explicitly by ai/actions/*.js at
//                require-time via registerCapability(), never inferred.
//
// ADMIN-only domains (settings administration, audit history) are marked
// roles:["ADMIN"] here to mirror the exact same boundary server.js already
// enforces on the underlying REST routes (/api/admin/*) — this registry
// documents that boundary, it does not invent a new one.

const { ROLES } = require("../auth.service");
const { INTENTS } = require("./detector");

const REGISTRY = new Map();

function registerCapability(entry) {
  if (!entry || !entry.id) throw new Error("registerCapability: id is required");
  if (REGISTRY.has(entry.id)) {
    throw new Error("registerCapability: duplicate capability id '" + entry.id + "'");
  }
  const normalized = {
    id:                   entry.id,
    category:             entry.category === "action" ? "action" : "read",
    domain:                entry.domain || "general",
    description:          entry.description || "",
    roles:                Array.isArray(entry.roles) && entry.roles.length ? entry.roles : [ROLES.ADMIN, ROLES.SECRETARY],
    riskTier:             entry.riskTier || (entry.category === "action" ? "low" : "read"),
    requiresConfirmation: entry.category === "action" ? entry.requiresConfirmation !== false : false,
    implemented:          entry.implemented !== false,
    status:               entry.status || "enabled", // "enabled" | "disabled"
    testCoverage:         Array.isArray(entry.testCoverage) ? entry.testCoverage : [],
    serviceFn:            entry.serviceFn || null,    // human-readable pointer, e.g. "db.setAppState"
  };
  REGISTRY.set(entry.id, normalized);
  return normalized;
}

function getCapability(id) {
  return REGISTRY.get(id) || null;
}

function isAllowed(id, role) {
  const cap = REGISTRY.get(id);
  if (!cap) return false;
  if (cap.status !== "enabled") return false;
  return cap.roles.indexOf(role) !== -1;
}

function listCapabilities(filter) {
  filter = filter || {};
  return Array.from(REGISTRY.values()).filter(function (c) {
    if (filter.role && c.roles.indexOf(filter.role) === -1) return false;
    if (filter.category && c.category !== filter.category) return false;
    if (filter.domain && c.domain !== filter.domain) return false;
    return true;
  });
}

// Full matrix for reporting — every column the implementation report needs.
function buildMatrix() {
  return listCapabilities().map(function (c) {
    return {
      id: c.id,
      category: c.category,
      domain: c.domain,
      roles: c.roles.join("+"),
      riskTier: c.riskTier,
      requiresConfirmation: c.requiresConfirmation,
      implemented: c.implemented,
      status: c.status,
      testCoverage: c.testCoverage.join(", ") || "—",
    };
  }).sort(function (a, b) {
    return a.category === b.category
      ? (a.domain === b.domain ? a.id.localeCompare(b.id) : a.domain.localeCompare(b.domain))
      : (a.category === "read" ? -1 : 1);
  });
}

// ─── Bootstrap: read intents already served by the local engine ──────────────
// One capability per detector intent — these existed before Phase B and are
// registered here as-is (implemented:true, both roles, no confirmation).
// "extended" scope (Phase D) intents are excluded here — their per-domain
// roles differ (some ADMIN-only, mirroring the underlying REST route's own
// gate), so ai/handlers/extended.js registers those itself, same pattern
// as ai/search.js.
INTENTS.filter(function (intent) { return intent.scope !== "extended"; }).forEach(function (intent) {
  registerCapability({
    id:           "read." + intent.name,
    category:     "read",
    domain:       intent.scope === "donor" ? "donor" : intent.scope === "system" ? "system" : "insight",
    description:  "שאילתת מידע (" + intent.name + ") — נתמכת דרך /api/ai/query",
    roles:        [ROLES.ADMIN, ROLES.SECRETARY],
    riskTier:     "read",
    implemented:  true,
    status:       "enabled",
    testCoverage: ["ai/tests/regression.js"],
    serviceFn:    "ai/engines/local.js query()",
  });
});

module.exports = { registerCapability, getCapability, isAllowed, listCapabilities, buildMatrix, ROLES };

"use strict";
// engines/local.js — deterministic local engine, routes to handlers

const { buildDonorContext, buildGlobalContext } = require("../context");
const { detectIntent } = require("../detector");
const donorHandlers   = require("../handlers/donor");
const systemHandlers  = require("../handlers/system");
const insightHandlers = require("../handlers/insights");

const DONOR_INTENTS   = new Set([
  "donor_summary", "donor_last_donation", "donor_debt_list", "donor_debt_total",
  "donor_payment_history", "donor_donations_stats", "donor_contact", "donor_notes",
  "donor_tags", "donor_tasks", "donor_ivr_status", "donor_timeline", "donor_risk",
  "donor_recommendation", "donor_vs_average", "donor_campaign_fit",
  "donor_last_contact", "donor_debt_age",
]);

const SYSTEM_INTENTS  = new Set([
  "system_summary", "system_dormant", "system_priority_debts", "system_top_donors",
  "system_total_debt", "system_total_paid", "system_active_count", "system_new_donors",
  "system_by_city", "system_by_purpose", "system_open_tasks", "system_urgent_tasks",
  "system_upcoming_rem", "system_trend", "system_by_tag", "system_payment_methods",
  "system_campaign_ready", "system_biggest_debtor", "system_recent_payments",
  "system_no_phone", "system_debt_aging",
]);

const INSIGHT_INTENTS = new Set([
  "insight_who_to_call", "insight_quick_wins", "insight_at_risk", "insight_follow_up",
  "insight_potential", "insight_success_rate", "insight_debt_priority", "insight_before_holiday",
]);

function fallbackAnswer(intent, donorId) {
  if (donorId) {
    return {
      answer: "לא הצלחתי לענות על השאלה הזו. נסה לשאול בצורה אחרת, למשל: \"מה מצב התורם?\" או \"כמה חוב יש לו?\"",
      suggestions: ["מצב התורם", "חובות פתוחים", "תרומה אחרונה"],
    };
  }
  return {
    answer: "לא הצלחתי לענות על השאלה הזו. נסה: \"מצב המערכת\", \"חובות לפי עדיפות\", \"למי כדאי להתקשר?\"",
    suggestions: ["מצב המערכת", "חובות לפי עדיפות", "למי להתקשר?"],
  };
}

async function query({ question, donorId, history }) {
  const detected = detectIntent(question, history || []);
  const { intent, scope } = detected;

  // Donor-specific intent — needs donor context
  if (DONOR_INTENTS.has(intent)) {
    if (!donorId) {
      return {
        answer: "שאלה זו רלוונטית לתורם ספציפי. פתח את כרטיס התורם ושאל שם.",
        intent,
        model: "local",
        fallback: false,
        suggestions: ["מצב המערכת", "חובות לפי עדיפות"],
      };
    }
    const ctx = buildDonorContext(donorId);
    if (!ctx) {
      return {
        answer: "לא נמצא תורם עם המזהה שסופק.",
        intent,
        model: "local",
        fallback: false,
        suggestions: [],
      };
    }
    const result = donorHandlers.dispatch(intent, ctx, detected) || fallbackAnswer(intent, donorId);
    return { ...result, intent, model: "local", fallback: false };
  }

  // System-wide intent — global context
  if (SYSTEM_INTENTS.has(intent)) {
    const ctx = buildGlobalContext();
    const result = systemHandlers.dispatch(intent, ctx, detected) || fallbackAnswer(intent, null);
    return { ...result, intent, model: "local", fallback: false };
  }

  // Insight intent — global context (may use donorId if provided)
  if (INSIGHT_INTENTS.has(intent)) {
    const ctx = buildGlobalContext();
    const result = insightHandlers.dispatch(intent, ctx) || fallbackAnswer(intent, donorId);
    return { ...result, intent, model: "local", fallback: false };
  }

  // Scope is "donor" but intent is "general" and donorId provided — try donor summary
  if (donorId && scope !== "system") {
    const ctx = buildDonorContext(donorId);
    if (ctx) {
      const result = donorHandlers.dispatch("donor_summary", ctx, detected);
      if (result) return { ...result, intent: "donor_summary", model: "local", fallback: false };
    }
  }

  // Fallback: general / unrecognized
  const fb = fallbackAnswer(intent, donorId);
  return { ...fb, intent: "general", model: "local", fallback: false };
}

module.exports = { query };

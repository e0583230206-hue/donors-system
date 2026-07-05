"use strict";
// engines/local.js — deterministic local engine v3
// Routes to handlers, calls formatter, handles disambiguation and pageContext.

const { buildDonorContext, buildGlobalContext } = require("../context");
const { detectIntent }                          = require("../detector");
const { format }                                = require("../formatter");
const donorHandlers                             = require("../handlers/donor");
const systemHandlers                            = require("../handlers/system");
const insightHandlers                           = require("../handlers/insights");

const DONOR_INTENTS = new Set([
  "donor_summary","donor_last_donation","donor_debt_list","donor_debt_total",
  "donor_payment_history","donor_donations_stats","donor_contact","donor_notes",
  "donor_tags","donor_tasks","donor_ivr_status","donor_timeline","donor_risk",
  "donor_recommendation","donor_vs_average","donor_campaign_fit",
  "donor_last_contact","donor_debt_age",
]);
const SYSTEM_INTENTS = new Set([
  "system_summary","system_dormant","system_priority_debts","system_top_donors",
  "system_total_debt","system_total_paid","system_active_count","system_new_donors",
  "system_by_city","system_by_purpose","system_open_tasks","system_urgent_tasks",
  "system_upcoming_rem","system_trend","system_by_tag","system_payment_methods",
  "system_campaign_ready","system_biggest_debtor","system_recent_payments",
  "system_no_phone","system_debt_aging",
]);
const INSIGHT_INTENTS = new Set([
  "insight_who_to_call","insight_quick_wins","insight_at_risk","insight_follow_up",
  "insight_potential","insight_success_rate","insight_debt_priority","insight_before_holiday",
]);

function fallback(donorId) {
  const obj = {
    summary: donorId
      ? "לא הצלחתי להבין את השאלה."
      : "לא הצלחתי להבין את השאלה.",
    metrics: [],
    sections: [],
    conclusion: "",
    recommendation: donorId
      ? "נסה: \"מה מצב התורם?\", \"כמה חוב יש לו?\", \"מה ההמלצה?\""
      : "נסה: \"מצב המערכת\", \"חובות לפי עדיפות\", \"למי להתקשר?\"",
    suggestions: donorId
      ? ["מצב התורם", "חובות פתוחים", "תרומה אחרונה"]
      : ["מצב המערכת", "חובות לפי עדיפות", "למי להתקשר?"],
  };
  return { answer: format(obj), suggestions: obj.suggestions };
}

async function query({ question, donorId, history, pageContext }) {
  const detected = detectIntent(question, history || [], pageContext || "global");
  const { intent, scope, confidence, entities } = detected;

  // ── Disambiguation ─────────────────────────────────────────────────────────
  if (intent === "disambiguate") {
    const clarifyQ = detected.clarifyQ || "האם אתה מתכוון לתורם ספציפי או לכל המערכת?";
    return {
      answer:      clarifyQ,
      intent:      "disambiguate",
      model:       "local",
      fallback:    false,
      suggestions: ["תורם ספציפי", "כל המערכת", "מצב המערכת"],
      debug:       { intent, confidence, entities, pageContext },
    };
  }

  // ── Donor intents ──────────────────────────────────────────────────────────
  if (DONOR_INTENTS.has(intent)) {
    if (!donorId) {
      return {
        answer: "שאלה זו רלוונטית לתורם ספציפי. פתח את כרטיס התורם ושאל שם.",
        intent, model: "local", fallback: false,
        suggestions: ["מצב המערכת", "חובות לפי עדיפות"],
        debug: { intent, confidence, entities, pageContext },
      };
    }
    const ctx = buildDonorContext(donorId);
    if (!ctx) {
      return {
        answer: "לא נמצא מידע על תורם זה במערכת.",
        intent, model: "local", fallback: false,
        suggestions: [],
        debug: { intent, confidence, entities, pageContext },
      };
    }
    const result = donorHandlers.dispatch(intent, ctx, detected);
    if (!result) return Object.assign(fallback(donorId), { intent, model: "local", fallback: false, debug: { intent, confidence, entities, pageContext } });
    return {
      answer:      format(result),
      intent,
      model:       "local",
      fallback:    false,
      suggestions: result.suggestions || [],
      debug:       { intent, confidence, entities, pageContext },
    };
  }

  // ── System intents ─────────────────────────────────────────────────────────
  if (SYSTEM_INTENTS.has(intent)) {
    const ctx    = buildGlobalContext();
    const result = systemHandlers.dispatch(intent, ctx, detected);
    if (!result) return Object.assign(fallback(null), { intent, model: "local", fallback: false, debug: { intent, confidence, entities, pageContext } });
    return {
      answer:      format(result),
      intent,
      model:       "local",
      fallback:    false,
      suggestions: result.suggestions || [],
      debug:       { intent, confidence, entities, pageContext },
    };
  }

  // ── Insight intents ────────────────────────────────────────────────────────
  if (INSIGHT_INTENTS.has(intent)) {
    const ctx    = buildGlobalContext();
    const result = insightHandlers.dispatch(intent, ctx);
    if (!result) return Object.assign(fallback(donorId), { intent, model: "local", fallback: false, debug: { intent, confidence, entities, pageContext } });
    return {
      answer:      format(result),
      intent,
      model:       "local",
      fallback:    false,
      suggestions: result.suggestions || [],
      debug:       { intent, confidence, entities, pageContext },
    };
  }

  // ── Contextual fallback: donor page with no specific intent ────────────────
  if (donorId && scope !== "system") {
    const ctx = buildDonorContext(donorId);
    if (ctx) {
      const result = donorHandlers.dispatch("donor_summary", ctx, detected);
      if (result) {
        return {
          answer:      format(result),
          intent:      "donor_summary",
          model:       "local",
          fallback:    false,
          suggestions: result.suggestions || [],
          debug:       { intent: "donor_summary (fallback)", confidence, entities, pageContext },
        };
      }
    }
  }

  // ── General fallback ───────────────────────────────────────────────────────
  return Object.assign(
    fallback(donorId),
    { intent: "general", model: "local", fallback: false, debug: { intent, confidence, entities, pageContext } }
  );
}

module.exports = { query };

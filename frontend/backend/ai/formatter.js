"use strict";
// formatter.js — converts a ResponseObject to formatted Hebrew text
//
// ResponseObject shape:
// {
//   summary:        string,                    // one concise Hebrew sentence
//   metrics:        [{label, value}],           // key numbers (max 5)
//   sections:       [{title, items:[string], urgent?:bool}],
//   conclusion:     string,                    // conclusion sentence
//   recommendation: string,                    // specific actionable recommendation
//   suggestions:    [string]                   // 2-3 follow-up buttons (not rendered in body)
// }

function format(obj) {
  if (!obj || typeof obj !== "object") return String(obj || "");

  // Legacy: plain {answer} object
  if (typeof obj.answer === "string" && !obj.summary) return obj.answer;

  const parts = [];

  // ── Summary (bold) ────────────────────────────────────────────────────────
  if (obj.summary) {
    parts.push("**" + obj.summary + "**");
  }

  // ── Metrics row ────────────────────────────────────────────────────────────
  if (obj.metrics && obj.metrics.length) {
    const row = obj.metrics
      .map(m => m.label + ": **" + m.value + "**")
      .join(" | ");
    parts.push(row);
  }

  // ── Sections ───────────────────────────────────────────────────────────────
  if (obj.sections && obj.sections.length) {
    obj.sections.forEach(function (sec) {
      if (!sec || (!sec.title && !(sec.items || []).length)) return;
      const lines = [];
      if (sec.title) {
        const icon = sec.urgent ? "🔴 " : "";
        lines.push("\n**" + icon + sec.title + "**");
      }
      (sec.items || []).forEach(function (item) {
        if (item) lines.push("• " + item);
      });
      if (lines.length) parts.push(lines.join("\n"));
    });
  }

  // ── Conclusion ─────────────────────────────────────────────────────────────
  if (obj.conclusion) {
    parts.push("\n💡 " + obj.conclusion);
  }

  // ── Recommendation ─────────────────────────────────────────────────────────
  if (obj.recommendation) {
    parts.push("✅ **המלצה:** " + obj.recommendation);
  }

  const result = parts.filter(Boolean).join("\n");
  return result || "(אין מידע זמין)";
}

/**
 * Try to parse a ResponseObject from an OpenAI JSON string.
 * Falls back gracefully — never throws.
 */
function parseOpenAIResponse(raw) {
  if (!raw) return _empty();
  try {
    const clean = raw
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();
    const obj = JSON.parse(clean);
    // Validate it looks like a ResponseObject
    if (typeof obj.summary === "string" || typeof obj.conclusion === "string") {
      return {
        summary:        String(obj.summary || ""),
        metrics:        Array.isArray(obj.metrics)   ? obj.metrics   : [],
        sections:       Array.isArray(obj.sections)  ? obj.sections  : [],
        conclusion:     String(obj.conclusion     || ""),
        recommendation: String(obj.recommendation || ""),
        suggestions:    Array.isArray(obj.suggestions) ? obj.suggestions : [],
      };
    }
  } catch (e) { /* not JSON */ }
  // OpenAI returned plain Hebrew text — wrap in summary
  return {
    summary:        raw.split("\n")[0].replace(/\*\*/g, "").slice(0, 120),
    metrics:        [],
    sections:       [],
    conclusion:     "",
    recommendation: "",
    suggestions:    [],
    _rawFallback:   raw,
  };
}

function _empty() {
  return { summary: "", metrics: [], sections: [], conclusion: "", recommendation: "", suggestions: [] };
}

module.exports = { format, parseOpenAIResponse };

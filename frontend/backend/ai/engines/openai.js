"use strict";
// engines/openai.js — OpenAI GPT adapter
// Falls back to local engine if API call fails.

const https = require("https");
const { buildDonorContext, buildGlobalContext } = require("../context");

function buildSystemPrompt(ctx) {
  if (!ctx) return "You are an AI assistant for a Jewish charity CRM system. Answer in Hebrew only.";

  const { fmtMoney } = ctx;

  if (ctx.type === "donor") {
    const { donor, stats, openDebts } = ctx;
    return [
      "You are an AI assistant for a Jewish charity donor management CRM.",
      "Answer ONLY in Hebrew. Be concise. Never modify data.",
      "",
      `Donor: ${donor.fullName || "Unknown"} | City: ${donor.city || "-"} | Phone: ${donor.phone || "-"}`,
      `Donations: ${stats.totalDonations} | Paid: ${fmtMoney(stats.totalPaid)} | Debt: ${fmtMoney(stats.totalDebt)}`,
      `Last donation: ${stats.lastDonationFmt} (${stats.daysSinceLastDonation} days ago)`,
      `Open debts: ${stats.openDebtsCount}`,
      `Tags: ${(donor.tags || []).join(", ") || "none"}`,
      `Notes: ${donor.notes || "none"}`,
      "",
      "Answer based on this data. If unsure, say so in Hebrew.",
    ].join("\n");
  }

  // Global context — brief summary
  const { summary } = ctx;
  return [
    "You are an AI assistant for a Jewish charity donor management CRM.",
    "Answer ONLY in Hebrew. Be concise. Never modify data.",
    "",
    `System: ${summary.totalDonors} donors | Active: ${summary.activeDonors}`,
    `Total debt: ${fmtMoney(summary.totalDebt)} across ${summary.withDebt} donors`,
    `Total paid: ${fmtMoney(summary.totalPaid)}`,
    `Dormant 180d: ${summary.dormant180} | Dormant 365d: ${summary.dormant365}`,
    `Open tasks: ${summary.openTasksCount} (${summary.urgentCount} urgent)`,
    `Campaign ready: ${summary.campaignReady} | No phone: ${summary.noPhone}`,
    "",
    "Answer based on this data. If unsure, say so in Hebrew.",
  ].join("\n");
}

function callOpenAI(apiKey, model, messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, messages, max_tokens: 600, temperature: 0.4 });
    const opts  = {
      hostname: "api.openai.com",
      path:     "/v1/chat/completions",
      method:   "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = https.request(opts, res => {
      let raw = "";
      res.on("data", c => { raw += c; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.error) { reject(new Error(parsed.error.message)); return; }
          resolve(parsed.choices[0].message.content.trim());
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("OpenAI timeout")); });
    req.write(body);
    req.end();
  });
}

async function query({ question, donorId, history }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const ctx = donorId ? buildDonorContext(donorId) : buildGlobalContext();
  const systemPrompt = buildSystemPrompt(ctx);

  // Build messages array from history + current question
  const messages = [{ role: "system", content: systemPrompt }];
  if (Array.isArray(history)) {
    history.slice(-6).forEach(m => {
      if (m.role === "user" || m.role === "assistant") {
        messages.push({ role: m.role, content: m.text || m.content || "" });
      }
    });
  }
  messages.push({ role: "user", content: question });

  const model  = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const answer = await callOpenAI(apiKey, model, messages);

  return {
    answer,
    intent: "openai",
    model:  `openai:${model}`,
    fallback: false,
    suggestions: ["ספר לי עוד", "מה ההמלצה שלך?", "מה הצעד הבא?"],
  };
}

module.exports = { query };

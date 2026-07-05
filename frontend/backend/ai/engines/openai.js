"use strict";
// engines/openai.js — OpenAI GPT adapter v3
// Returns a ResponseObject (JSON) from GPT, then runs through formatter.

const https  = require("https");
const { buildDonorContext, buildGlobalContext } = require("../context");
const { format, parseOpenAIResponse }          = require("../formatter");

// ─── System prompt ─────────────────────────────────────────────────────────────
function buildSystemPrompt(ctx) {
  const base = [
    "אתה עוזר CRM חכם למערכת ניהול תורמים של ארגון צדקה יהודי.",
    "כללים מחייבים:",
    "1. ענה בעברית בלבד — שפה טבעית, מקצועית ומעשית.",
    "2. Read Only בלבד — אל תמליץ על שינוי נתונים, רק על פעולות אנושיות (התקשרות, מעקב).",
    "3. אם חסר מידע, אמור במפורש שאין מספיק נתונים — אל תמציא.",
    "4. המלצות חייבות להתבסס על הנתונים בלבד.",
    "5. החזר תשובה בפורמט JSON הבא בדיוק (ללא ```json):",
    '{',
    '  "summary": "משפט מסכם אחד בעברית",',
    '  "metrics": [{"label": "...", "value": "..."}],',
    '  "sections": [{"title": "...", "items": ["..."]}],',
    '  "conclusion": "מסקנה בעברית",',
    '  "recommendation": "המלצה מעשית ספציפית בעברית",',
    '  "suggestions": ["שאלת המשך 1", "שאלת המשך 2", "שאלת המשך 3"]',
    '}',
  ].join("\n");

  if (!ctx) return base;

  const { fmtMoney, fmtDate } = ctx;

  if (ctx.type === "donor") {
    const { donor, stats, openDebts } = ctx;
    return [
      base,
      "",
      "=== נתוני תורם ===",
      "שם: " + (donor.fullName || "לא ידוע"),
      "עיר: " + (donor.city || "לא ידוע") + " | טלפון: " + (donor.phone || "אין"),
      "תרומות: " + stats.totalDonations + " | שולם: " + fmtMoney(stats.totalPaid) + " | חוב: " + fmtMoney(stats.totalDebt),
      "תרומה אחרונה: " + stats.lastDonationFmt + " (" + stats.daysSinceLastDonation + " ימים)",
      "חובות פתוחים: " + stats.openDebtsCount,
      "תגיות: " + (donor.tags || []).join(", ") || "אין",
      "הערות: " + (donor.notes || "אין"),
    ].join("\n");
  }

  // Global context — brief summary
  const { summary } = ctx;
  return [
    base,
    "",
    "=== נתוני מערכת ===",
    "תורמים: " + summary.totalDonors + " (פעילים: " + summary.activeDonors + ")",
    "חוב כולל: " + fmtMoney(summary.totalDebt) + " (" + summary.withDebt + " תורמים)",
    "גביה כוללת: " + fmtMoney(summary.totalPaid),
    "רדומים 180+: " + summary.dormant180 + " | 365+: " + summary.dormant365,
    "משימות פתוחות: " + summary.openTasksCount + " (" + summary.urgentCount + " דחופות)",
    "מוכנים לקמפיין: " + summary.campaignReady,
  ].join("\n");
}

// ─── HTTP call to OpenAI ───────────────────────────────────────────────────────
function callOpenAI(apiKey, model, messages) {
  return new Promise(function (resolve, reject) {
    const body = JSON.stringify({ model: model, messages: messages, max_tokens: 700, temperature: 0.3 });
    const opts  = {
      hostname: "api.openai.com",
      path:     "/v1/chat/completions",
      method:   "POST",
      headers: {
        "Content-Type":   "application/json",
        "Authorization":  "Bearer " + apiKey,
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = https.request(opts, function (res) {
      var raw = "";
      res.on("data", function (c) { raw += c; });
      res.on("end", function () {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.error) { reject(new Error(parsed.error.message)); return; }
          resolve(parsed.choices[0].message.content.trim());
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.setTimeout(18000, function () { req.destroy(); reject(new Error("OpenAI timeout")); });
    req.write(body);
    req.end();
  });
}

// ─── Main query ───────────────────────────────────────────────────────────────
async function query({ question, donorId, history, pageContext }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const ctx          = donorId ? buildDonorContext(donorId) : buildGlobalContext();
  const systemPrompt = buildSystemPrompt(ctx);

  const messages = [{ role: "system", content: systemPrompt }];
  if (Array.isArray(history)) {
    history.slice(-6).forEach(function (m) {
      if (m.role === "user" || m.role === "assistant") {
        messages.push({ role: m.role, content: m.text || m.content || "" });
      }
    });
  }
  messages.push({ role: "user", content: question });

  const model  = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const raw    = await callOpenAI(apiKey, model, messages);
  const parsed = parseOpenAIResponse(raw);

  // If raw fallback (not JSON), return it as-is
  const answer = parsed._rawFallback ? parsed._rawFallback : format(parsed);

  return {
    answer:      answer,
    intent:      "openai",
    model:       "openai:" + model,
    fallback:    false,
    suggestions: parsed.suggestions || ["ספר לי עוד", "מה ההמלצה שלך?", "מה הצעד הבא?"],
    debug:       { intent: "openai", model: "openai:" + model, pageContext },
  };
}

module.exports = { query };

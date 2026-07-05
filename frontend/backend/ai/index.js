"use strict";
// ai/index.js — public AI API v3
// Usage: const { queryAI } = require("./ai");

const localEngine  = require("./engines/local");
const openaiEngine = require("./engines/openai");

/**
 * @param {object}   opts
 * @param {string}   opts.question    — user's question (Hebrew)
 * @param {number|null} opts.donorId  — donor ID if on donor page
 * @param {Array}    opts.history     — [{role, text, intent?}] from localStorage
 * @param {string}   opts.pageContext — "donor"|"debts"|"tasks"|"reminders"|"reports"|"phone"|"global"
 * @returns {Promise<{answer, intent, model, fallback, suggestions, debug}>}
 */
async function queryAI({ question, donorId, history, pageContext }) {
  const useOpenAI = Boolean(process.env.OPENAI_API_KEY);

  if (useOpenAI) {
    try {
      return await openaiEngine.query({ question, donorId, history, pageContext });
    } catch (err) {
      console.warn("[AI] OpenAI failed, falling back to local:", err.message);
      const result = await localEngine.query({ question, donorId, history, pageContext });
      return Object.assign({}, result, { fallback: true });
    }
  }

  return localEngine.query({ question, donorId, history, pageContext });
}

console.log("[AI] ai/index.js v3 loaded OK");
module.exports = { queryAI };

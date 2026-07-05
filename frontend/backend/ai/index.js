"use strict";
// ai/index.js — public AI API, replaces ai.service.js
// Usage: const { queryAI } = require("./ai");

const localEngine  = require("./engines/local");
const openaiEngine = require("./engines/openai");

/**
 * @param {object} opts
 * @param {string} opts.question   — user's question (Hebrew)
 * @param {number|null} opts.donorId — donor ID if on a donor page, else null
 * @param {Array}  opts.history    — [{role, text, intent?}] from localStorage
 * @returns {Promise<{answer, intent, model, fallback, suggestions}>}
 */
async function queryAI({ question, donorId, history }) {
  const useOpenAI = Boolean(process.env.OPENAI_API_KEY);

  if (useOpenAI) {
    try {
      return await openaiEngine.query({ question, donorId, history });
    } catch (err) {
      console.warn("[AI] OpenAI failed, falling back to local:", err.message);
      const result = await localEngine.query({ question, donorId, history });
      return { ...result, fallback: true };
    }
  }

  return localEngine.query({ question, donorId, history });
}

console.log("[AI] ai/index.js loaded OK");
module.exports = { queryAI };

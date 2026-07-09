"use strict";
// logger.js — small centralized logger with levels + PII redaction.
//
// Added for audit finding #30. This intentionally does NOT replace every
// console.log in the project (that would be a much larger, unrelated
// change) — it's used only at the specific call sites found to print
// sensitive data (donor names/phones) straight into server logs with no
// redaction, the same class of issue already fixed for IVR logging
// (findings #10/#12). Everywhere else keeps using console.* directly.
//
// Levels: debug < info < warn < error. Set LOG_LEVEL in .env to change the
// minimum level that gets printed (default: "info").
// Set LOG_DEBUG=true in .env to see raw (unredacted) values in production
// for troubleshooting — same escape-hatch convention as ivr.service.js's
// IVR_DEBUG and server.js's IVR_DEBUG for IVR query logging.

const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function configuredLevel() {
  return LOG_LEVELS[(process.env.LOG_LEVEL || "info").toLowerCase()] || LOG_LEVELS.info;
}

function isProd() {
  return process.env.NODE_ENV === "production" && process.env.LOG_DEBUG !== "true";
}

// Redacts a single value when running in production (see isProd above).
// Use this only for values that are genuinely sensitive (phone numbers,
// full names alongside identifying context, tokens, keys) — not for
// non-identifying operational data (counts, statuses, ids used for
// debugging that aren't personal data on their own).
function redact(value) {
  if (!isProd()) return value;
  if (value === null || value === undefined) return value;
  return "[REDACTED]";
}

function shouldLog(level) {
  return LOG_LEVELS[level] >= configuredLevel();
}

function write(level, tag, args) {
  if (!shouldLog(level)) return;
  const consoleMethod = level === "debug" ? "log" : level;
  console[consoleMethod]("[" + new Date().toISOString() + "] [" + tag + "]", ...args);
}

module.exports = {
  debug: function (tag, ...args) { write("debug", tag, args); },
  info:  function (tag, ...args) { write("info",  tag, args); },
  warn:  function (tag, ...args) { write("warn",  tag, args); },
  error: function (tag, ...args) { write("error", tag, args); },
  redact,
};

const { insertCallLog } = require("./db");

function safeInsertCallLog(callId, phone, step, payload) {
  try {
    insertCallLog(callId, phone, step, payload);
  } catch (err) {
    console.error("IVR call log failed:", err && err.message ? err.message : err);
  }
}

module.exports = {
  safeInsertCallLog,
};

// ivr-audio-trial.route.js — isolated, temporary route for the Technoline
// fileLink/fileName audio-file experiment (see docs/ivr-audio/ — OPEN-001
// trial). Exists ONLY to prove the fileLink/fileName mechanism works on a
// separate trial extension before any real integration work begins.
//
// Deliberately does NOT require ivr.js, ivr.service.js, donor.service.js, or
// any DB module — it never touches donors, payments, call logs, or the
// ivr_audio_recordings table (the 83-row spec). It is pure, stateless,
// hardcoded JSON keyed by a closed `scenario` whitelist.
//
// Auth is two independent checks, both required:
//   1. IVR_AUDIO_TRIAL_KEY — a secret SEPARATE from the production IVR_KEY,
//      sent by Technoline as ?trialKey=... (query string — Technoline's
//      Module API does not support custom headers, same constraint as the
//      real /ivr endpoint; see nginx/ivr-site.conf and requireIvrKey in
//      server.js). Compared with the same timing-safe, length-safe method
//      already used for the production IVR_KEY.
//   2. PBXextensionId — must equal TECHNOLINE_IVR_TRIAL_EXTENSION, so a
//      request that somehow reaches this route via extension 9263 (or any
//      other extension) is rejected even if the key were somehow known.
//
// No request data is ever logged — not req.query, not the key, not the
// phone, not the call id. Diagnostics are fully off by default and there is
// no flag in this file to turn any of it on.

const crypto = require("crypto");

// Same implementation as server.js's timingSafeEq — duplicated here (not
// imported) so this file has zero dependency on server.js internals and can
// be required/tested completely standalone.
function timingSafeEq(a, b) {
  try {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch (_) {
    return false;
  }
}

// Production audio files (the real 83) will eventually live under a
// dedicated production path — this base URL is ONLY for the trial file(s)
// placed manually by hand, never through the settings.html upload tool, and
// never recorded in the ivr_audio_recordings table.
const TRIAL_AUDIO_BASE_URL = "https://30206.co.il/uploads/ivr-audio";

function file(filename) {
  return {
    fileLink: TRIAL_AUDIO_BASE_URL + "/" + filename,
    fileName: filename.replace(/\.[^.]+$/, ""),
  };
}

// Four fixed scenarios only — no other input from the request ever reaches
// the response body. "sequence" and "multi" reuse the single OPEN-001 trial
// file more than once on purpose: at this stage only one real recording
// exists, and the goal is to prove the *mechanism* (multi fileLink items,
// fileLink+text interleaving), not to preview real IDENT/number content.
const SCENARIOS = {
  open001: function () {
    return { type: "simpleMessage", files: [file("TRIAL-open001-v1.mp3")] };
  },
  sequence: function () {
    return {
      type: "simpleMessage",
      files: [
        file("TRIAL-open001-v1.mp3"),
        { text: "שם בדיקה" },
        file("TRIAL-open001-v1.mp3"),
      ],
    };
  },
  multi: function () {
    return {
      type: "simpleMessage",
      files: [
        file("TRIAL-open001-v1.mp3"),
        file("TRIAL-open001-v1.mp3"),
        file("TRIAL-open001-v1.mp3"),
      ],
    };
  },
  // Deliberately points at a file that will never exist on disk — proves
  // what Technoline actually does with a broken fileLink (open question,
  // not covered by the documentation we have).
  notfound: function () {
    return { type: "simpleMessage", files: [file("TRIAL-notfound-v1.mp3")] };
  },
};

function isAuthorized(query) {
  const q = query || {};
  const trialKey = process.env.IVR_AUDIO_TRIAL_KEY || "";
  const trialExt = process.env.TECHNOLINE_IVR_TRIAL_EXTENSION || "";
  // Fail closed: if either is unset, no request can ever pass — mirrors
  // requireIvrKey's fail-closed behavior for a missing IVR_KEY.
  if (!trialKey || !trialExt) return false;
  if (!timingSafeEq(q.trialKey || "", trialKey)) return false;
  if (String(q.PBXextensionId || "") !== String(trialExt)) return false;
  return true;
}

function trialHandler(req, res) {
  if (!isAuthorized(req.query)) {
    res.status(403).json({ error: "trial_auth_failed" });
    return;
  }
  const scenario = String((req.query && req.query.scenario) || "");
  const build = SCENARIOS[scenario];
  if (!build) {
    // Authenticated but unrecognized scenario — safe, inert response, not
    // an error (matches how the real Module API is meant to degrade).
    res.status(200).json({ type: "hangup" });
    return;
  }
  res.status(200).json(build());
}

module.exports = { trialHandler, isAuthorized, SCENARIOS, timingSafeEq };

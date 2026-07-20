// ivr-audio-mode.service.js
//
// Parses IVR_AUDIO_MODE and decides, per call, whether the audio resolver
// should be used instead of TTS. Pure/testable infrastructure only — NOT
// wired into ivr.js or ivr.service.js in this step. Missing/invalid value
// always resolves to "off" (fail closed — no accidental audio rollout from
// a typo).
//
//   off   — never use recordings, current TTS behavior for every call.
//   trial — only the call whose phone matches IVR_AUDIO_TRIAL_CALLER_PHONE.
//   on    — every call.

const VALID_MODES = ["off", "trial", "on"];

function parseAudioMode(rawValue) {
  const normalized = String(rawValue === undefined || rawValue === null ? "" : rawValue)
    .trim()
    .toLowerCase();
  return VALID_MODES.indexOf(normalized) !== -1 ? normalized : "off";
}

// opts: { mode, phone, trialPhone }
// `phone` and `trialPhone` must already be normalized the same way
// (donor.service.js's normalizePhone) — this function does not normalize.
function shouldUseAudioForCall(opts) {
  const mode = parseAudioMode(opts && opts.mode);
  if (mode === "off") return false;
  if (mode === "on") return true;

  // trial
  const trialPhone = String((opts && opts.trialPhone) || "").trim();
  if (!trialPhone) return false;
  const phone = String((opts && opts.phone) || "").trim();
  return phone !== "" && phone === trialPhone;
}

module.exports = { parseAudioMode, shouldUseAudioForCall, VALID_MODES };

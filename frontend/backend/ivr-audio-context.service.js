// ivr-audio-context.service.js
//
// Builds the "audio" context object passed into ivr.js's buildResponse /
// buildIdentificationResponse for a single call. Decides, ONCE per request,
// whether this call uses pre-recorded audio (IVR_AUDIO_MODE + caller phone)
// and exposes two small functions ivr.js uses instead of always calling
// txt(...) directly — both always degrade to {text: ...} (today's exact
// behavior) when audio is off, or when a specific piece of audio can't be
// resolved. ivr.js itself never touches the DB/filesystem — this file (and
// ivr-audio-resolver.service.js, which it wraps) is the only place that
// does.
//
// resolveOrText's exact-text reverse lookup (Hebrew sentence -> audioId) is
// now a SECONDARY mechanism only — ivr.js uses explicit rid(audio, audioId,
// fallbackText) calls for every message with a known audioId (see the fix
// for the IDENT-002 bug below). resolveOrText still exists for the small
// number of genuinely open-ended cases (e.g. a donor's free-text purpose
// that might coincidentally equal an approved phrase like "כללי"), so it's
// still built here — from BOTH real sources, not guessed:
//   - db.js's IVR_AUDIO_CANONICAL_RECORDINGS (73 rows: 29 fixed phrases +
//     44 number/currency).
//   - seed-ident-audio.js's IDENT_RECORDINGS (10 rows) — a SEPARATE array
//     that IVR_AUDIO_CANONICAL_RECORDINGS never included. This was the
//     actual root cause of the IDENT-002 bug: resolveOrText("...
//     למישהו אחר הקישו 2.") could never find IDENT-002 no matter how
//     exactly the text matched, because the array it searched structurally
//     never contained any IDENT-* row at all. Fixed here for defense in
//     depth (e.g. the purpose-text fallback could legitimately need an
//     IDENT-* match some day) even though ivr.js no longer depends on this
//     lookup for anything that already has a known, hardcoded audioId.
const { parseAudioMode, shouldUseAudioForCall } = require("./ivr-audio-mode.service");
const { resolveAudioForProduction } = require("./ivr-audio-resolver.service");
const { normalizePhone } = require("./donor.service");

let textToAudioIdCache = null;

function textToAudioIdMap() {
  if (!textToAudioIdCache) {
    const db = require("./db");
    const { IDENT_RECORDINGS } = require("./seed-ident-audio");
    textToAudioIdCache = textToAudioIdFrom(
      db.IVR_AUDIO_CANONICAL_RECORDINGS.concat(IDENT_RECORDINGS)
    );
  }
  return textToAudioIdCache;
}

// שימושי גם לבדיקות (לא נטען DB, מזריקים מפה מוכנה).
function textToAudioIdFrom(canonicalRecordings) {
  const map = {};
  canonicalRecordings.forEach(function (rec) {
    const key = String(rec.sourceTextHe || "").trim();
    if (key && map[key] === undefined) map[key] = rec.audioId;
  });
  return map;
}

function passthroughAudioContext() {
  return {
    resolveOrText: function (text) { return { text: text }; },
    resolveAudioId: function (audioId, fallbackText) { return { text: fallbackText }; },
  };
}

// deps (לבדיקות — DI מלא, לא נוגע ב-DB/דיסק אמיתיים):
//   textToAudioId -> { [hebrewText]: audioId }
//   resolveAudio(audioId, fallbackText) -> {fileLink,fileName} | {text}
function createAudioContext(deps) {
  return {
    resolveOrText: function (text) {
      const trimmed = String(text || "").trim();
      const audioId = deps.textToAudioId[trimmed];
      if (!audioId) return { text: text };
      return deps.resolveAudio(audioId, text);
    },
    resolveAudioId: function (audioId, fallbackText) {
      return deps.resolveAudio(audioId, fallbackText);
    },
  };
}

function realAudioContext() {
  return createAudioContext({
    textToAudioId: textToAudioIdMap(),
    resolveAudio: resolveAudioForProduction,
  });
}

// phone: raw (not-yet-normalized) caller phone for this call.
function buildAudioContext(phone) {
  const mode = parseAudioMode(process.env.IVR_AUDIO_MODE);
  const trialPhone = normalizePhone(process.env.IVR_AUDIO_TRIAL_CALLER_PHONE || "");
  const useAudio = shouldUseAudioForCall({
    mode: mode,
    phone: normalizePhone(phone),
    trialPhone: trialPhone,
  });
  return useAudio ? realAudioContext() : passthroughAudioContext();
}

module.exports = {
  buildAudioContext,
  createAudioContext,
  passthroughAudioContext,
  textToAudioIdFrom,
};

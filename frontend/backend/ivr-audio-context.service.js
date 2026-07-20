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
// The exact-text reverse lookup (Hebrew sentence -> audioId) is built once
// from db.js's IVR_AUDIO_CANONICAL_RECORDINGS — the canonical, already-
// approved 83-row list — never guessed or duplicated by hand here. Any T.*
// string in ivr.js that doesn't byte-for-byte match (after trim) a
// canonical sourceTextHe simply won't be found and stays TTS automatically
// — this is how dynamic/no-recording texts (donor-name greetings, etc.)
// safely fall through without special-casing them here.

const { parseAudioMode, shouldUseAudioForCall } = require("./ivr-audio-mode.service");
const { resolveAudioForProduction } = require("./ivr-audio-resolver.service");
const { normalizePhone } = require("./donor.service");

let textToAudioIdCache = null;

function textToAudioIdMap() {
  if (!textToAudioIdCache) {
    const db = require("./db");
    textToAudioIdCache = {};
    db.IVR_AUDIO_CANONICAL_RECORDINGS.forEach(function (rec) {
      const key = String(rec.sourceTextHe || "").trim();
      // הראשון בכל התנגשות טקסט זוכה (לא אמורה לקרות ב-83 הרשומות הנוכחיות,
      // אבל עדיפות דטרמיניסטית ולא "האחרון מנצח" עדיפה כברירת מחדל בטוחה).
      if (key && textToAudioIdCache[key] === undefined) {
        textToAudioIdCache[key] = rec.audioId;
      }
    });
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

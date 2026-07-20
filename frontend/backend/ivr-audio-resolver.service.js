// ivr-audio-resolver.service.js
//
// Resolves one IVR audioId to either a Technoline fileLink/fileName pointing
// at an approved, physically-present WAV recording, or a {text} fallback for
// TTS — never both, never throws, NEVER returns an empty/silent fallback,
// never leaves a call without something real to say.
//
// resolveAudio(audioId, fallbackText) takes the caller-supplied fallbackText
// as the PRIMARY fallback — every live call site passes the exact original
// message text that would have played before audio existed, so a failed
// resolution always degrades to that same original wording. The resolver's
// own canonical-text map (built from db.js's IVR_AUDIO_CANONICAL_RECORDINGS)
// is only a secondary safety net for a caller that forgets to pass one, and
// a fixed generic sentence (itself an already-approved recording, SYS-002)
// is the last-resort tertiary net — {text:""} is never returned.
//
// No DB writes anywhere. No ffprobe/ffmpeg at request time — format
// correctness was already verified once, offline, by
// scripts/convert-ivr-audio-to-wav.js --apply; this resolver only checks
// physical existence + path containment, which is cheap enough for a live
// call. No new DB column: the derived-file name is always recomputed from
// audioFile1 (see computeDerivedFilename in the conversion script).
//
// Trust boundary (documented, not silent): a file at the deterministic
// "<source-basename>-pcm8k.wav" path is trusted to be valid PCM 16-bit/
// mono/8000Hz purely because nothing else in the system ever writes to that
// exact path — only the conversion script's verified atomic rename does.
// Similarly, an approved audioFile1 that already ends in .wav (case-
// insensitive) AND has no derived file is trusted to be ready-as-is, because
// the same conversion script's dry-run already classified it that way
// (ready-original) and would have produced a derived file otherwise.

const path = require("path");
const { computeDerivedFilename, isPathContained } = require("./scripts/convert-ivr-audio-to-wav");

const DEFAULT_BASE_URL = "https://30206.co.il/uploads/ivr-audio";
const APPROVED_STATUS = "אושר";

// SYS-002's own approved wording — reused verbatim as the absolute last
// resort, never invented text. Duplicated here (not imported from db.js) so
// this file's pure createAudioResolver() core stays DB-free; the value is
// asserted against the live db.js entry in the test file so it can't drift.
const GENERIC_FALLBACK_TEXT = "אירעה שגיאה. אנא נסו שוב מאוחר יותר.";

function stripExtension(filename) {
  return filename.replace(/\.[^./\\]+$/, "");
}

function toPublicResult(baseUrl, filename) {
  return {
    fileLink: baseUrl + "/" + filename,
    fileName: stripExtension(filename),
  };
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

// deps (all required — this is the pure, dependency-injected core; see
// getProductionResolver()/resolveAudioForProduction() below for the real
// wiring):
//   getRecordByAudioId(audioId) -> { status, audioFile1 } | null | undefined
//   fileExists(absolutePath) -> boolean
//   uploadDir -> absolute (or resolvable) upload directory path
//   baseUrl -> public base URL, no trailing slash required
//   fallbackTextByAudioId -> { [audioId]: string } — canonical Hebrew text,
//     secondary safety net only (see module comment above).
function createAudioResolver(deps) {
  const uploadDir = path.resolve(deps.uploadDir);
  const baseUrl = String(deps.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fallbackTextByAudioId = deps.fallbackTextByAudioId || {};

  function fallback(audioId, callerFallbackText) {
    if (isNonEmptyString(callerFallbackText)) {
      return { text: callerFallbackText };
    }
    const canonical = fallbackTextByAudioId[audioId];
    if (isNonEmptyString(canonical)) {
      return { text: canonical };
    }
    return { text: GENERIC_FALLBACK_TEXT };
  }

  return function resolveAudio(audioId, fallbackText) {
    try {
      const row = deps.getRecordByAudioId(audioId);
      if (!row || row.status !== APPROVED_STATUS || !row.audioFile1) {
        return fallback(audioId, fallbackText);
      }

      // audioFile1 עצמו חייב להיות שם קובץ בטוח (בתוך uploadDir) לפני שנגזר
      // ממנו כל דבר — computeDerivedFilename משתמש ב-path.parse().name, שכבר
      // חותך רכיבי תיקייה/".." בעצמו, כך ש-containment על השם הנגזר לבדו לא
      // אמין כבדיקת ביטחון (הוא תמיד "יעבור" גם עבור קלט עוין). הבדיקה
      // האמיתית חייבת להיות על audioFile1 הגולמי, לפני כל חישוב.
      const sourceContainment = isPathContained(uploadDir, row.audioFile1);
      if (!sourceContainment.ok) {
        return fallback(audioId, fallbackText);
      }

      // 1. נגזרת תקינה (PCM/mono/8000) — תמיד מועדפת אם קיימת.
      const derivedFilename = computeDerivedFilename(row.audioFile1);
      const derivedContainment = isPathContained(uploadDir, derivedFilename);
      if (derivedContainment.ok && deps.fileExists(derivedContainment.resolvedPath)) {
        return toPublicResult(baseUrl, derivedFilename);
      }

      // 2. אין נגזרת — המקור עצמו קביל רק אם הוא כבר .wav (וגם קיים פיזית).
      //    ללא נגזרת + סיומת לא-wav ⇒ הפורמט מעולם לא אומת, לא משתמשים בו.
      if (/\.wav$/i.test(row.audioFile1) && deps.fileExists(sourceContainment.resolvedPath)) {
        return toPublicResult(baseUrl, row.audioFile1);
      }

      return fallback(audioId, fallbackText);
    } catch (e) {
      return fallback(audioId, fallbackText);
    }
  };
}

// ── חיווט לפרודקשן — נטען עצלנית (lazy) בקריאה הראשונה בפועל, לא ב-require
// של המודול, כדי ש-require("./ivr-audio-resolver.service") בבדיקות (או בכל
// מקום אחר) לעולם לא יפתח את ה-DB האמיתי או ייגע בדיסק האמיתי מעצם הטעינה.
let productionResolver = null;

function getProductionResolver() {
  if (!productionResolver) {
    const fs = require("fs");
    const db = require("./db");
    const fallbackTextByAudioId = {};
    db.IVR_AUDIO_CANONICAL_RECORDINGS.forEach(function (rec) {
      fallbackTextByAudioId[rec.audioId] = rec.sourceTextHe;
    });
    productionResolver = createAudioResolver({
      getRecordByAudioId: db.getIvrAudioRecordingById,
      fileExists: fs.existsSync,
      uploadDir: path.join(__dirname, "uploads", "ivr-audio"),
      baseUrl: process.env.IVR_AUDIO_PUBLIC_BASE_URL || DEFAULT_BASE_URL,
      fallbackTextByAudioId: fallbackTextByAudioId,
    });
  }
  return productionResolver;
}

function resolveAudioForProduction(audioId, fallbackText) {
  return getProductionResolver()(audioId, fallbackText);
}

module.exports = {
  createAudioResolver,
  resolveAudioForProduction,
  stripExtension,
  DEFAULT_BASE_URL,
  GENERIC_FALLBACK_TEXT,
};

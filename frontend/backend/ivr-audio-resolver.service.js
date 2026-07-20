// ivr-audio-resolver.service.js
//
// Resolves one IVR audioId to either a Technoline fileLink/fileName pointing
// at an approved, physically-present WAV recording, or a {text} fallback for
// TTS — never both, never throws, never leaves a call without something to
// say. Not wired into ivr.js yet (see ivr-audio-mode.service.js) — this file
// only builds the resolver itself.
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

function stripExtension(filename) {
  return filename.replace(/\.[^./\\]+$/, "");
}

function toPublicResult(baseUrl, filename) {
  return {
    fileLink: baseUrl + "/" + filename,
    fileName: stripExtension(filename),
  };
}

// deps (all required — this is the pure, dependency-injected core; see
// createProductionAudioResolver() below for the real wiring):
//   getRecordByAudioId(audioId) -> { status, audioFile1 } | null | undefined
//   fileExists(absolutePath) -> boolean
//   uploadDir -> absolute (or resolvable) upload directory path
//   baseUrl -> public base URL, no trailing slash required
//   fallbackTextByAudioId -> { [audioId]: string } — canonical Hebrew text,
//     used only when the audio itself can't be used for any reason.
function createAudioResolver(deps) {
  const uploadDir = path.resolve(deps.uploadDir);
  const baseUrl = String(deps.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fallbackTextByAudioId = deps.fallbackTextByAudioId || {};

  function fallback(audioId) {
    const text = Object.prototype.hasOwnProperty.call(fallbackTextByAudioId, audioId)
      ? fallbackTextByAudioId[audioId]
      : "";
    return { text: text };
  }

  return function resolveAudio(audioId) {
    try {
      const row = deps.getRecordByAudioId(audioId);
      if (!row || row.status !== APPROVED_STATUS || !row.audioFile1) {
        return fallback(audioId);
      }

      // audioFile1 עצמו חייב להיות שם קובץ בטוח (בתוך uploadDir) לפני שנגזר
      // ממנו כל דבר — computeDerivedFilename משתמש ב-path.parse().name, שכבר
      // חותך רכיבי תיקייה/".." בעצמו, כך ש-containment על השם הנגזר לבדו לא
      // אמין כבדיקת ביטחון (הוא תמיד "יעבור" גם עבור קלט עוין). הבדיקה
      // האמיתית חייבת להיות על audioFile1 הגולמי, לפני כל חישוב.
      const sourceContainment = isPathContained(uploadDir, row.audioFile1);
      if (!sourceContainment.ok) {
        return fallback(audioId);
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

      return fallback(audioId);
    } catch (e) {
      return fallback(audioId);
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

function resolveAudioForProduction(audioId) {
  return getProductionResolver()(audioId);
}

module.exports = {
  createAudioResolver,
  resolveAudioForProduction,
  stripExtension,
  DEFAULT_BASE_URL,
};

// ivr-pregreeting.service.js
//
// A single, optional "pre-greeting" IVR message that plays once, immediately
// before the fixed OPEN-001 opening greeting ("שלום וברכה..."), only while
// explicitly enabled AND (if a schedule is set) inside the Asia/Jerusalem
// start/end window. Reuses the exact same ivr_audio_recordings row (fixed
// audioId "PREGREETING-001") and the exact same upload/format-conversion/
// path-safety machinery as every other recording (see
// ivr-audio-paymsg-lifecycle.service.js / ivr-audio-resolver.service.js) —
// this file only adds the enabled/schedule gate on top of that, and the
// "skip silently instead of falling back to TTS" behavior that makes sense
// for an optional temporary message but not for any other recording.
//
// Pure/dependency-injected core (createPregreetingResolver), exactly like
// ivr-audio-resolver.service.js's createAudioResolver — no require("./db"),
// no fs, at the core. Production wiring is lazy (see
// getProductionPregreetingResolver below), same reasoning as the resolver:
// requiring this module (e.g. from a test) must never open the real DB or
// touch the real disk just by being required.

const path = require("path");

// Duplicated literal (not imported from db.js) — same reasoning as
// ivr-audio-resolver.service.js's GENERIC_FALLBACK_TEXT: keeps this file's
// pure core free of any require("./db"), and avoids a circular require
// (db.js's own pregreeting seeding needs this same id before this file's
// production-wiring section ever runs).
const PREGREETING_AUDIO_ID = "PREGREETING-001";
const APPROVED_STATUS = "אושר";

// "Now", as an Asia/Jerusalem wall-clock string "YYYY-MM-DDTHH:mm" — the
// exact same format admin-submitted startAt/endAt are stored in (an HTML
// <input type="datetime-local">, minute precision, no timezone attached).
// Comparing these as plain strings is correct chronological ordering for
// same-format zero-padded timestamps — no UTC-offset/DST math needed, since
// both sides of every comparison are always "wall-clock time in
// Asia/Jerusalem", never mixed with any other timezone or with a raw UTC
// instant.
function nowInJerusalem(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jerusalem",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date || new Date());
  const byType = {};
  parts.forEach(function (p) { byType[p.type] = p.value; });
  // Some ICU implementations render midnight as "24:00" under hour12:false —
  // normalize to "00" so the string stays a valid, comparable timestamp.
  const hour = byType.hour === "24" ? "00" : byType.hour;
  return byType.year + "-" + byType.month + "-" + byType.day + "T" + hour + ":" + byType.minute;
}

const SCHEDULE_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

// Accepts empty/null/undefined (no bound set) or a well-formed
// "YYYY-MM-DDTHH:mm" string with a real calendar date behind it.
function isValidScheduleValue(v) {
  if (v === null || v === undefined || v === "") return true;
  if (typeof v !== "string" || !SCHEDULE_FORMAT.test(v)) return false;
  const d = new Date(v + ":00");
  return !isNaN(d.getTime());
}

// Pure — testable without any Date/DB dependency by passing `now` explicitly
// (defaults to the real current time in Asia/Jerusalem).
function isPregreetingActiveNow(row, now) {
  if (!row) return false;
  if (!Number(row.enabled)) return false;
  if (!row.audioFile1 || row.status !== APPROVED_STATUS) return false;
  const nowStr = now || nowInJerusalem();
  if (row.startAt && nowStr < row.startAt) return false;
  if (row.endAt && nowStr > row.endAt) return false;
  return true;
}

function stripExtension(filename) {
  return filename.replace(/\.[^./\\]+$/, "");
}

// deps (all required):
//   getRow() -> row | null            — the live PREGREETING-001 row
//   fileExists(absolutePath) -> boolean
//   isPathContained(uploadDir, filename) -> { ok, resolvedPath }
//   computeDerivedFilename(filename) -> string
//   uploadDir -> absolute upload directory path
//   baseUrl -> public base URL, no trailing slash required
//   now -> optional "YYYY-MM-DDTHH:mm" override for isPregreetingActiveNow (tests)
//   log(line) -> void (defaults to a no-op)
function createPregreetingResolver(deps) {
  const uploadDir = path.resolve(deps.uploadDir);
  const baseUrl = String(deps.baseUrl || "").replace(/\/+$/, "");
  const log = deps.log || function () {};

  // Returns [] (skip — safe no-op, caller falls through to the fixed
  // OPENING greeting) or [{fileLink, fileName}] — unlike
  // ivr-audio-resolver.service.js's resolveAudio, this NEVER falls back to
  // {text: ...}: an unavailable/disabled/out-of-schedule temporary message
  // must simply be omitted, not replaced by some generic spoken sentence.
  function buildPregreetingFiles() {
    try {
      const row = deps.getRow();
      if (!isPregreetingActiveNow(row, deps.now)) return [];

      const containment = deps.isPathContained(uploadDir, row.audioFile1);
      if (!containment.ok) {
        log("[pregreeting] audioFile1 נכשל בבדיקת path-containment — מדלגים לפתיח הקבוע: " + row.audioFile1);
        return [];
      }

      // Same trust order as the main resolver: prefer the converted
      // PCM/mono/8000Hz derived file if present, else accept the source only
      // if it's already .wav.
      const derivedFilename = deps.computeDerivedFilename(row.audioFile1);
      const derivedContainment = deps.isPathContained(uploadDir, derivedFilename);
      if (derivedContainment.ok && deps.fileExists(derivedContainment.resolvedPath)) {
        return [{ fileLink: baseUrl + "/" + derivedFilename, fileName: stripExtension(derivedFilename) }];
      }
      if (/\.wav$/i.test(row.audioFile1) && deps.fileExists(containment.resolvedPath)) {
        return [{ fileLink: baseUrl + "/" + row.audioFile1, fileName: stripExtension(row.audioFile1) }];
      }

      log("[pregreeting] הקובץ הפעיל חסר/לא מוכן בדיסק — מדלגים לפתיח הקבוע: " + row.audioFile1);
      return [];
    } catch (e) {
      log("[pregreeting] שגיאה בפתרון ההודעה הזמנית — מדלגים בבטחה לפתיח הקבוע: " + (e && e.message));
      return [];
    }
  }

  return { buildPregreetingFiles: buildPregreetingFiles };
}

// ── חיווט לפרודקשן — עצלני, בדיוק כמו ivr-audio-resolver.service.js ─────────
let productionResolver = null;

function getProductionPregreetingResolver() {
  if (!productionResolver) {
    const fs = require("fs");
    const db = require("./db");
    const { isPathContained, computeDerivedFilename } = require("./scripts/convert-ivr-audio-to-wav");
    productionResolver = createPregreetingResolver({
      getRow: function () { return db.getIvrAudioRecordingById(PREGREETING_AUDIO_ID); },
      fileExists: fs.existsSync,
      isPathContained: isPathContained,
      computeDerivedFilename: computeDerivedFilename,
      uploadDir: path.join(__dirname, "uploads", "ivr-audio"),
      baseUrl: process.env.IVR_AUDIO_PUBLIC_BASE_URL || "https://30206.co.il/uploads/ivr-audio",
      log: function (line) { console.error(line); },
    });
  }
  return productionResolver;
}

function buildPregreetingFilesForProduction() {
  return getProductionPregreetingResolver().buildPregreetingFiles();
}

module.exports = {
  PREGREETING_AUDIO_ID,
  nowInJerusalem,
  isValidScheduleValue,
  isPregreetingActiveNow,
  createPregreetingResolver,
  buildPregreetingFilesForProduction,
};

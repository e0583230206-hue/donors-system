// ivr-audio.service.js — business logic for settings.html "ניהול הקלטות" tab.
// IMPORTANT: this is a management/staging tool for the FUTURE Yiddish IVR audio
// files. It does NOT connect to ivr.js / ivr.service.js / Technoline in any way —
// see docs/ivr-audio/ivr-audio-spec-v1.0-FROZEN.md for the source spec, and
// הקלטות_א_בלאט_גמרא_מעוצב.xlsx for the authoritative 73-row content/structure.

const {
  ensureIvrAudioRecordingsUpToDate,
  getIvrAudioRecordings,
  getIvrAudioRecordingById,
  createIvrAudioRecording,
  updateIvrAudioRecording,
  setIvrAudioRecordingFileSlot,
  clearIvrAudioRecordingFileSlot,
} = require("./db");

const STATUSES = ["חסר", "תורגם", "הוקלט", "נבדק", "אושר"];
const STATUS_ORDER = STATUSES;
const SLOTS = [1, 2, 3];

function isValidStatus(status) {
  return STATUSES.includes(status);
}

function isValidSlot(slot) {
  return SLOTS.includes(Number(slot));
}

function bumpStatusOnUpload(currentStatus) {
  const idx = STATUS_ORDER.indexOf(currentStatus);
  const uploadIdx = STATUS_ORDER.indexOf("הוקלט");
  if (idx < uploadIdx) return "הוקלט";
  return currentStatus;
}

// Audio IDs are Latin (OPEN-001, NUM-DIGIT-007, ...) — this only guards
// against path traversal / odd characters when building filenames on disk.
function sanitizeAudioIdForFilename(audioId) {
  return String(audioId || "").trim().replace(/[^a-zA-Z0-9_-]/g, "_") || "audio";
}

// Runs once (idempotent — see db.js for the exact rules): migrates the old
// schema/IDs to match the Excel, or seeds a fresh install, or no-ops if the
// table already holds up-to-date data. Called once at server startup.
function runStartupMigration() {
  return ensureIvrAudioRecordingsUpToDate();
}

// ── Import from the Excel structure (client parses the file with the xlsx
// lib already loaded on the page; this just receives the resulting rows as
// JSON). Safe merge only — never overwrites a non-blank translation, status,
// sourceTextHe, usageDescription or category. New Audio IDs are inserted.
const IMPORT_HEADER_MAP = {
  audioId: ["audio id", "audioid"],
  sourceTextHe: ["טקסט מקור בעברית"],
  translation: ["תרגום"],
  usageDescription: ["הסבר שימוש"],
  status: ["סטטוס"],
};

function findImportValue(rawRow, aliases) {
  const keys = Object.keys(rawRow);
  for (const alias of aliases) {
    const match = keys.find((k) => String(k).trim().toLowerCase() === alias.toLowerCase());
    if (match && rawRow[match] !== undefined && rawRow[match] !== null && String(rawRow[match]).trim() !== "") {
      return String(rawRow[match]).trim();
    }
  }
  return "";
}

function mapImportRow(rawRow) {
  const audioId = findImportValue(rawRow, IMPORT_HEADER_MAP.audioId);
  if (!audioId) return null;
  return {
    audioId,
    sourceTextHe: findImportValue(rawRow, IMPORT_HEADER_MAP.sourceTextHe),
    translation: findImportValue(rawRow, IMPORT_HEADER_MAP.translation),
    usageDescription: findImportValue(rawRow, IMPORT_HEADER_MAP.usageDescription),
    status: findImportValue(rawRow, IMPORT_HEADER_MAP.status),
  };
}

// rows: array of raw objects with Excel-style Hebrew headers (from both sheets,
// combined — category isn't in the Excel so existing/blank category is left as-is).
function importRows(rows) {
  let inserted = 0, merged = 0, skipped = 0;
  for (const raw of rows) {
    const mapped = mapImportRow(raw);
    if (!mapped) { skipped++; continue; }

    const existing = getIvrAudioRecordingById(mapped.audioId);
    if (!existing) {
      createIvrAudioRecording(mapped.audioId);
      updateIvrAudioRecording(mapped.audioId, {
        sourceTextHe: mapped.sourceTextHe,
        translation: mapped.translation,
        usageDescription: mapped.usageDescription,
        status: mapped.status && isValidStatus(mapped.status) ? mapped.status : undefined,
      });
      inserted++;
      continue;
    }

    const fields = {};
    if (!existing.sourceTextHe && mapped.sourceTextHe) fields.sourceTextHe = mapped.sourceTextHe;
    if (!existing.translation && mapped.translation) fields.translation = mapped.translation;
    if (!existing.usageDescription && mapped.usageDescription) fields.usageDescription = mapped.usageDescription;
    if (!existing.status || existing.status === "חסר") {
      if (mapped.status && isValidStatus(mapped.status)) fields.status = mapped.status;
    }
    if (Object.keys(fields).length > 0) {
      updateIvrAudioRecording(mapped.audioId, fields);
      merged++;
    }
  }
  return { inserted, merged, skipped, total: rows.length };
}

module.exports = {
  STATUSES,
  isValidStatus,
  isValidSlot,
  bumpStatusOnUpload,
  sanitizeAudioIdForFilename,
  runStartupMigration,
  importRows,
  getIvrAudioRecordings,
  getIvrAudioRecordingById,
  createIvrAudioRecording,
  updateIvrAudioRecording,
  setIvrAudioRecordingFileSlot,
  clearIvrAudioRecordingFileSlot,
};

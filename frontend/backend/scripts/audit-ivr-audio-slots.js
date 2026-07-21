// scripts/audit-ivr-audio-slots.js
//
// READ-ONLY inventory report — opens data.sqlite with { readOnly: true } and
// never writes to disk anywhere. Answers the one question that determines
// whether migrating the two legacy sheets ("משפטים קבועים" / "מספרים ומטבע")
// to the same audioFile1=active/audioFile2=previous/audioFile3=pending
// lifecycle already live for "paymsg" is safe to do as a pure code/behavior
// change, or needs a data-reset step first:
//
//   Do any of the 83 legacy rows (category != "paymsg") already have content
//   in audioFile2 and/or audioFile3 — columns that today have NO defined
//   meaning (the live resolver only ever reads audioFile1) but WOULD gain
//   "previous version" / "pending approval, one click from going live"
//   meaning the moment the lifecycle is turned on for these categories?
//
// Two modes:
//   1. Default (no flags) — human-readable full report, printed to stdout.
//      For manual SSH use only; not what CI runs (see mode 2).
//   2. `--check=<name> [--expect=<n>]` — a SINGLE numeric assertion. Prints
//      only PASS/FAIL + the actual count (never a filename/path), and sets
//      the process exit code to 0 (pass) or 1 (fail). This is what
//      .github/workflows/audit-ivr-audio-slots.yml runs, as 4 separate
//      workflow steps — so each claim's pass/fail is visible via GitHub's
//      public jobs/steps API without needing log access at all.
//
// Usage (from frontend/backend/, on the real server via SSH):
//   node scripts/audit-ivr-audio-slots.js
//   node scripts/audit-ivr-audio-slots.js --check=legacyCount --expect=83
//   node scripts/audit-ivr-audio-slots.js --check=audioFile2Count --expect=0
//   node scripts/audit-ivr-audio-slots.js --check=audioFile3Count --expect=0
//   node scripts/audit-ivr-audio-slots.js --check=slotFilesAbsent

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const {
  isPathContained,
  computeDerivedFilename,
  probeAudioSafe,
  isValidDerivedProbe,
  isReadyAsIs,
} = require("./convert-ivr-audio-to-wav");

const PROJECT_DIR = path.join(__dirname, "..");
const DB_PATH = path.join(PROJECT_DIR, "data.sqlite");
const UPLOAD_DIR = path.resolve(PROJECT_DIR, "uploads", "ivr-audio");

function isFormatReady(filename) {
  if (!filename) return false;
  const containment = isPathContained(UPLOAD_DIR, filename);
  if (!containment.ok || !fs.existsSync(containment.resolvedPath)) return false;
  const derivedFilename = computeDerivedFilename(filename);
  const derivedContainment = isPathContained(UPLOAD_DIR, derivedFilename);
  if (derivedContainment.ok && fs.existsSync(derivedContainment.resolvedPath)) {
    if (isValidDerivedProbe(probeAudioSafe(derivedContainment.resolvedPath))) return true;
  }
  if (/\.wav$/i.test(filename) && isReadyAsIs(filename, probeAudioSafe(containment.resolvedPath))) return true;
  return false;
}

function describeSlot(filename) {
  if (!filename) return null;
  const containment = isPathContained(UPLOAD_DIR, filename);
  return {
    filename: filename,
    pathSafe: containment.ok,
    existsOnDisk: containment.ok ? fs.existsSync(containment.resolvedPath) : false,
    wouldBeFormatReady: isFormatReady(filename),
  };
}

// Pure(ish) computation — the ONE query, read-only, shared by both the
// human-readable report and the --check assertions, so the two modes can
// never silently disagree with each other.
function computeReport() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const rows = db.prepare(
      "SELECT audioId, category, status, audioFile1, audioFile2, audioFile3 FROM ivr_audio_recordings WHERE category != 'paymsg' ORDER BY category, audioId"
    ).all();

    let slot1Count = 0, slot2Count = 0, slot3Count = 0;
    const slot2Details = [];
    const slot3Details = [];

    rows.forEach(function (row) {
      if (row.audioFile1) slot1Count++;
      if (row.audioFile2) { slot2Count++; slot2Details.push(Object.assign({ audioId: row.audioId, category: row.category, status: row.status }, describeSlot(row.audioFile2))); }
      if (row.audioFile3) { slot3Count++; slot3Details.push(Object.assign({ audioId: row.audioId, category: row.category, status: row.status }, describeSlot(row.audioFile3))); }
    });

    return { rows: rows, slot1Count: slot1Count, slot2Count: slot2Count, slot3Count: slot3Count, slot2Details: slot2Details, slot3Details: slot3Details };
  } finally {
    db.close();
  }
}

// Independent of the DB columns entirely — scans the upload directory
// itself for any file whose name matches "<legacyAudioId>-2-..." or
// "<legacyAudioId>-3-...", so this catches even an orphaned file that isn't
// referenced by audioFile2/audioFile3 at all anymore (e.g. left over from
// some earlier state). audioId values for every legacy category are
// Latin/digits/hyphen only (see sanitizeAudioIdForFilename in
// ivr-audio.service.js — a no-op for these IDs), so building a literal
// prefix match here is safe.
function findOrphanSlotFiles(legacyAudioIds) {
  if (!fs.existsSync(UPLOAD_DIR)) return [];
  const entries = fs.readdirSync(UPLOAD_DIR);
  const orphans = [];
  legacyAudioIds.forEach(function (audioId) {
    const escaped = String(audioId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("^" + escaped + "-[23]-");
    entries.forEach(function (name) {
      if (re.test(name)) orphans.push(name);
    });
  });
  return orphans;
}

function printFullReport() {
  const report = computeReport();

  console.log("=== ivr_audio_recordings — legacy (non-paymsg) slot inventory ===");
  console.log("total legacy rows: " + report.rows.length);
  console.log("audioFile1 (active today) non-empty: " + report.slot1Count);
  console.log("audioFile2 non-empty: " + report.slot2Count);
  console.log("audioFile3 non-empty: " + report.slot3Count);

  if (report.slot2Count === 0 && report.slot3Count === 0) {
    console.log("\n✓ No legacy row has anything in audioFile2/audioFile3 — turning on the lifecycle for these categories requires no data reset at all.");
  } else {
    console.log("\naudioFile2 details (would become \"previous version\"):");
    console.log(JSON.stringify(report.slot2Details, null, 2));
    console.log("\naudioFile3 details (would become \"pending approval\"):");
    console.log(JSON.stringify(report.slot3Details, null, 2));
    console.log("\n⚠ At least one legacy row has content in slot 2/3 — see docs/ivr-audio plan for the recommended reset-with-backup step before enabling the lifecycle for legacy categories.");
  }
}

// Single numeric assertion, safe to expose via a CI step name: prints only
// PASS/FAIL + a count, NEVER a filename/path/donor-facing text. Sets
// process.exitCode so the calling shell (and therefore the GitHub Actions
// step) fails visibly, without any log content needing to be read.
function runCheck(checkName, expectRaw) {
  const report = computeReport();
  let actual, label, pass;

  switch (checkName) {
    case "legacyCount":
      actual = report.rows.length;
      label = "legacy rows (category != paymsg)";
      pass = actual === Number(expectRaw);
      break;
    case "audioFile2Count":
      actual = report.slot2Count;
      label = "legacy rows with non-empty audioFile2";
      pass = actual === Number(expectRaw);
      break;
    case "audioFile3Count":
      actual = report.slot3Count;
      label = "legacy rows with non-empty audioFile3";
      pass = actual === Number(expectRaw);
      break;
    case "slotFilesAbsent": {
      const orphans = findOrphanSlotFiles(report.rows.map(function (r) { return r.audioId; }));
      actual = orphans.length;
      label = "orphan slot-2/3 files on disk for legacy audioIds (DB-independent scan)";
      pass = actual === 0;
      break;
    }
    default:
      console.log("FAIL — unknown --check value: " + checkName);
      process.exitCode = 1;
      return;
  }

  console.log((pass ? "PASS" : "FAIL") + " — " + label + ": actual=" + actual + (expectRaw !== undefined ? " expected=" + expectRaw : ""));
  process.exitCode = pass ? 0 : 1;
}

function parseArgs(argv) {
  const args = {};
  argv.forEach(function (arg) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (m) args[m[1]] = m[2];
  });
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.check) {
    runCheck(args.check, args.expect);
  } else {
    printFullReport();
  }
}

if (require.main === module) {
  main();
}

module.exports = { isFormatReady, describeSlot, computeReport, findOrphanSlotFiles };

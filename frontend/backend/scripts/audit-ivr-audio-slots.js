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
// For every non-paymsg row with a non-empty audioFile2/audioFile3, reports
// whether that file physically exists and whether it would already pass
// isFormatReady() (the same check approvePending()/restorePrevious() run) —
// i.e. whether it's the kind of leftover that could actually be promoted to
// a live call by an accidental click once the new UI ships, vs. inert/
// missing/invalid content that the lifecycle would safely refuse anyway.
//
// Usage (from frontend/backend/, on the real server via SSH):
//   node scripts/audit-ivr-audio-slots.js

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

function main() {
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

    console.log("=== ivr_audio_recordings — legacy (non-paymsg) slot inventory ===");
    console.log("total legacy rows: " + rows.length);
    console.log("audioFile1 (active today) non-empty: " + slot1Count);
    console.log("audioFile2 non-empty: " + slot2Count);
    console.log("audioFile3 non-empty: " + slot3Count);

    if (slot2Count === 0 && slot3Count === 0) {
      console.log("\n✓ No legacy row has anything in audioFile2/audioFile3 — turning on the lifecycle for these categories requires no data reset at all.");
    } else {
      console.log("\naudioFile2 details (would become \"previous version\"):");
      console.log(JSON.stringify(slot2Details, null, 2));
      console.log("\naudioFile3 details (would become \"pending approval\"):");
      console.log(JSON.stringify(slot3Details, null, 2));
      console.log("\n⚠ At least one legacy row has content in slot 2/3 — see docs/ivr-audio plan for the recommended reset-with-backup step before enabling the lifecycle for legacy categories.");
    }
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main();
}

module.exports = { isFormatReady, describeSlot };

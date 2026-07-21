// ivr-audio-paymsg-lifecycle.service.js
//
// Pure(ish), dependency-injected core for the 3-slot PAYMSG recording
// lifecycle (see docs/ivr-audio/ivr-audio-paymsg-v1.0-DRAFT.md §9.12):
//
//   audioFile1 = active/approved — the ONLY slot ivr-audio-resolver.service.js
//                reads. Never written by a plain upload.
//   audioFile2 = previous version — one-step rollback target.
//   audioFile3 = pending — newly uploaded, format-checked and (if needed)
//                converted, but NOT yet approved. Never read by the resolver.
//   status     = describes ONLY audioFile1 — identical meaning to every
//                other row in the table, untouched by staging a pending
//                upload.
//
// This module contains NO require("./db"), NO fs, NO child_process — every
// side effect comes in through `deps`, exactly like
// ivr-audio-resolver.service.js's createAudioResolver(deps). server.js wires
// the real DB/fs/ffmpeg deps; tests wire fakes/temp dirs. This is what makes
// it possible to test the full stage/approve/restore state machine without
// ffmpeg installed and without spinning up Express.

function noop() {}

// deps (all required):
//   getRecordByAudioId(audioId) -> row | null
//   setSlots(audioId, {audioFile1, audioFile2, audioFile3, status}) -> row
//     — ONE atomic UPDATE writing all 4 columns together.
//   uploadDir -> absolute upload directory path
//   isPathContained(uploadDir, filename) -> {ok, resolvedPath}
//   computeDerivedFilename(filename) -> string
//   computeTmpFilename(derivedFilename) -> string
//   fileExists(absPath) -> boolean
//   probeAudioSafe(absPath) -> probeResult | null
//   isValidDerivedProbe(probeResult) -> boolean
//   isReadyAsIs(filename, probeResult) -> boolean
//   convertToTmpWav(inputAbsPath, outputTmpAbsPath) -> void (throws on failure)
//   rename(fromAbsPath, toAbsPath) -> void
//   unlink(absPath) -> void (throws on failure — callers catch)
//   log(line) -> void (defaults to a no-op; server.js passes console.warn)
function createPaymsgLifecycle(deps) {
  const log = deps.log || noop;

  // True iff `filename` (already on disk under uploadDir) is safe to serve
  // as-is: either it already has a valid derived PCM8k/mono file next to it,
  // or it's itself a ready-as-is .wav. Mirrors the resolver's own trust
  // logic, but actively re-probes — this only runs on rare admin actions
  // (approve/restore), never on the live call path, so the extra ffprobe
  // cost here is fine and deliberate (point 3/6 — "full format check", not
  // just fs.existsSync).
  function isFormatReady(filename) {
    if (!filename) return false;
    const containment = deps.isPathContained(deps.uploadDir, filename);
    if (!containment.ok || !deps.fileExists(containment.resolvedPath)) return false;

    const derivedFilename = deps.computeDerivedFilename(filename);
    const derivedContainment = deps.isPathContained(deps.uploadDir, derivedFilename);
    if (derivedContainment.ok && deps.fileExists(derivedContainment.resolvedPath)) {
      if (deps.isValidDerivedProbe(deps.probeAudioSafe(derivedContainment.resolvedPath))) {
        return true;
      }
    }
    if (/\.wav$/i.test(filename)) {
      if (deps.isReadyAsIs(filename, deps.probeAudioSafe(containment.resolvedPath))) {
        return true;
      }
    }
    return false;
  }

  // Best-effort delete of `filename` + its derived counterpart. Never
  // throws — logs and moves on, per the explicit "failure to delete must
  // not fail the operation" requirement.
  function safeUnlink(filename) {
    if (!filename) return;
    [filename, deps.computeDerivedFilename(filename)].forEach(function (name) {
      const containment = deps.isPathContained(deps.uploadDir, name);
      if (!containment.ok) return;
      try {
        if (deps.fileExists(containment.resolvedPath)) deps.unlink(containment.resolvedPath);
      } catch (e) {
        log("[paymsg] מחיקת קובץ ישן נכשלה, נדרש ניקוי ידני מאוחר יותר: " + containment.resolvedPath + " — " + e.message);
      }
    });
  }

  // Runs right after multer has saved a new raw file at `rawFilename`.
  // Validates format and converts to a derived PCM8k WAV when needed, using
  // the exact same pure decision functions + ffmpeg invocation as
  // scripts/convert-ivr-audio-to-wav.js --apply (reused via deps, not
  // reimplemented). Never touches the DB. On failure, cleans up only what
  // THIS call itself created.
  function convertUploadedFile(rawFilename) {
    const containment = deps.isPathContained(deps.uploadDir, rawFilename);
    if (!containment.ok) return { ok: false, error: "שם קובץ לא תקין" };
    const sourcePath = containment.resolvedPath;

    const sourceProbe = deps.probeAudioSafe(sourcePath);
    if (!sourceProbe) {
      safeUnlink(rawFilename);
      return { ok: false, error: "הקובץ שהועלה אינו קובץ שמע תקין. ההקלטה הקודמת (אם יש) נשארה ללא שינוי." };
    }
    if (deps.isReadyAsIs(rawFilename, sourceProbe)) {
      return { ok: true }; // already correct PCM/mono/8000 + .wav — no conversion needed
    }

    const derivedFilename = deps.computeDerivedFilename(rawFilename);
    const derivedContainment = deps.isPathContained(deps.uploadDir, derivedFilename);
    if (!derivedContainment.ok) {
      safeUnlink(rawFilename);
      return { ok: false, error: "שם קובץ נגזר לא תקין" };
    }
    const tmpFilename = deps.computeTmpFilename(derivedFilename);
    const tmpContainment = deps.isPathContained(deps.uploadDir, tmpFilename);
    if (!tmpContainment.ok) {
      safeUnlink(rawFilename);
      return { ok: false, error: "שם קובץ זמני לא תקין" };
    }

    try {
      deps.convertToTmpWav(sourcePath, tmpContainment.resolvedPath);
      const tmpProbe = deps.probeAudioSafe(tmpContainment.resolvedPath);
      if (!deps.isValidDerivedProbe(tmpProbe)) {
        throw new Error("תוצאת ההמרה לא עברה אימות פורמט");
      }
      deps.rename(tmpContainment.resolvedPath, derivedContainment.resolvedPath);
      return { ok: true };
    } catch (e) {
      try {
        if (deps.fileExists(tmpContainment.resolvedPath)) deps.unlink(tmpContainment.resolvedPath);
      } catch (cleanupErr) {
        // ignore — never touched the source or any valid existing derived file
      }
      safeUnlink(rawFilename);
      return { ok: false, error: "ההמרה לא הצליחה. נסו קובץ אחר. ההקלטה הקודמת (אם יש) נשארה ללא שינוי." };
    }
  }

  // Commits an already-converted `newRawFilename` into audioFile3 (pending).
  // Only ever writes audioFile3 + leaves audioFile1/audioFile2/status
  // untouched (re-written with their own current values, since setSlots
  // always writes all 4 columns in one statement). Discards whatever WAS
  // pending, but only after the DB commit succeeds.
  function commitStagedUpload(audioId, newRawFilename) {
    const row = deps.getRecordByAudioId(audioId);
    if (!row) return { ok: false, status: 404, error: "לא נמצאה הקלטה עם המזהה הזה" };

    const oldPending = row.audioFile3;
    const updated = deps.setSlots(audioId, {
      audioFile1: row.audioFile1,
      audioFile2: row.audioFile2,
      audioFile3: newRawFilename,
      status: row.status, // never bumped — audioFile3 isn't the active slot
    });

    if (oldPending && oldPending !== newRawFilename) safeUnlink(oldPending);
    return { ok: true, recording: updated };
  }

  // Promotes audioFile3 -> audioFile1, shifts old audioFile1 -> audioFile2,
  // clears audioFile3, sets status="אושר" — ONE atomic DB update. Must be
  // called even when the row's status is ALREADY "אושר" (that's exactly the
  // case this exists for — an already-approved row with a newly staged
  // pending replacement); never skip as "no-op" just because the requested
  // status string is unchanged.
  function approvePending(audioId) {
    const row = deps.getRecordByAudioId(audioId);
    if (!row) return { ok: false, status: 404, error: "לא נמצאה הקלטה עם המזהה הזה" };
    if (!row.audioFile3) return { ok: false, status: 400, error: "אין גרסה ממתינה לאישור" };
    if (!isFormatReady(row.audioFile3)) {
      return { ok: false, status: 422, error: "הגרסה הממתינה אינה קובץ שמע תקין בפורמט הנדרש — לא ניתן לאשר. נסו להעלות קובץ אחר." };
    }

    const oldFile1 = row.audioFile1;
    const oldFile2 = row.audioFile2;
    const updated = deps.setSlots(audioId, {
      audioFile1: row.audioFile3,
      audioFile2: oldFile1,
      audioFile3: "",
      status: "אושר",
    });

    // Only after the DB commit succeeds — discard whatever fell out of the
    // 1-step rollback window. Never blocks/fails the approval itself.
    if (oldFile2) safeUnlink(oldFile2);

    return { ok: true, recording: updated };
  }

  // Swaps audioFile1 <-> audioFile2 in one atomic DB update. audioFile3
  // (pending) and status are carried through unchanged. Both the file
  // becoming active (audioFile2) AND the file becoming the new "previous"
  // (audioFile1) must independently pass the full format check — an
  // already-broken/missing active file is exactly the situation restore
  // exists to recover from, but restoring is pointless (and would silently
  // discard the one working copy) if the swap target itself isn't usable
  // too. Either one failing blocks the entire swap — no partial change.
  function restorePrevious(audioId) {
    const row = deps.getRecordByAudioId(audioId);
    if (!row) return { ok: false, status: 404, error: "לא נמצאה הקלטה עם המזהה הזה" };
    if (!row.audioFile2) return { ok: false, status: 400, error: "אין גרסה קודמת לשחזור" };
    if (!isFormatReady(row.audioFile2)) {
      return { ok: false, status: 422, error: "הגרסה הקודמת פגומה או חסרה בדיסק — לא ניתן לשחזר אליה" };
    }
    if (!isFormatReady(row.audioFile1)) {
      return { ok: false, status: 422, error: "הגרסה הפעילה הנוכחית פגומה או חסרה בדיסק — לא ניתן לבצע שחזור בטוח (היא הייתה הופכת לגרסה הקודמת)" };
    }

    const updated = deps.setSlots(audioId, {
      audioFile1: row.audioFile2,
      audioFile2: row.audioFile1,
      audioFile3: row.audioFile3,
      status: row.status,
    });

    return { ok: true, recording: updated };
  }

  // Clears audioFile3 (rejects/discards a pending upload that was never
  // approved) — DB-first, disk-after, mirroring approvePending's ordering
  // (see requirement: never delete the file before the DB row stops
  // pointing at it). Path containment is checked directly here (NOT via
  // isFormatReady, which also demands the file be a *valid, ready* audio
  // file — wrong requirement for a delete: an admin must be able to reject
  // a pending upload precisely BECAUSE it's broken).
  function rejectPending(audioId) {
    const row = deps.getRecordByAudioId(audioId);
    if (!row) return { ok: false, status: 404, error: "לא נמצאה הקלטה עם המזהה הזה" };
    if (!row.audioFile3) return { ok: false, status: 400, error: "אין גרסה ממתינה למחיקה" };

    const containment = deps.isPathContained(deps.uploadDir, row.audioFile3);
    if (!containment.ok) {
      return { ok: false, status: 400, error: "שם קובץ לא תקין — לא ניתן למחוק" };
    }

    const oldPending = row.audioFile3;
    const updated = deps.setSlots(audioId, {
      audioFile1: row.audioFile1,
      audioFile2: row.audioFile2,
      audioFile3: "",
      status: row.status,
    });

    // Only after the DB commit succeeds — and via safeUnlink, which also
    // cleans up the derived file, not just the raw upload.
    safeUnlink(oldPending);

    return { ok: true, recording: updated };
  }

  return {
    isFormatReady: isFormatReady,
    convertUploadedFile: convertUploadedFile,
    commitStagedUpload: commitStagedUpload,
    approvePending: approvePending,
    restorePrevious: restorePrevious,
    rejectPending: rejectPending,
  };
}

module.exports = { createPaymsgLifecycle };

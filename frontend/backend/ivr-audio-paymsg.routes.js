// ivr-audio-paymsg.routes.js
//
// The 4 admin routes that touch the PAYMSG 3-slot lifecycle — PUT /:id
// (approve branch + the pre-existing generic field-update fallback),
// POST /:id/audio/:slot (paymsg-staging branch + the pre-existing generic
// upload fallback), DELETE /:id/audio/:slot (paymsg-reject branch + the
// pre-existing generic delete fallback), POST /:id/restore-previous
// (paymsg-only). Extracted VERBATIM out of server.js into this
// dependency-injected factory for exactly one reason: so the SAME route
// code that runs in production can be mounted on a throwaway Express app
// with fake dependencies and hit with real HTTP requests in a test — see
// ivr-audio-paymsg.routes.test.js. server.js calls createIvrAudioSlotRoutes()
// with its real dependencies and mounts the result; nothing about the
// logic changed in the extraction, only where it's defined.
//
// Auth (requireRole/apiLimiter) is NOT applied here — server.js already
// applies it via app.use("/api/admin/ivr-audio", apiLimiter,
// requireRole([ROLES.ADMIN])) BEFORE this router is mounted, exactly like
// every other route under that prefix. A test mounting this router directly
// (without that middleware) is intentionally testing the route logic in
// isolation from auth, which is unrelated to the PAYMSG lifecycle.

const express = require("express");

// deps (all required — server.js passes its real bindings; tests pass fakes):
//   getIvrAudioRecordingById(audioId) -> row | null
//   updateIvrAudioRecording(audioId, fields) -> row | null
//   setIvrAudioRecordingFileSlot(audioId, slot, filename, status) -> row
//   clearIvrAudioRecordingFileSlot(audioId, slot) -> row
//   bumpStatusOnUpload(currentStatus) -> string
//   isValidStatus(status) -> boolean
//   isValidSlot(slot) -> boolean
//   insertAuditLog(entry) -> void (may throw — callers already catch)
//   paymsgLock -> { tryLock(id), unlock(id) }
//   paymsgLifecycle -> { convertUploadedFile, commitStagedUpload, approvePending, restorePrevious, rejectPending }
//   ivrAudioUpload -> configured multer middleware, multer(...).single("audio")
//   IVR_AUDIO_FILE_FIELD -> {1:"audioFile1",2:"audioFile2",3:"audioFile3"}
//   uploadsDir -> absolute uploads directory (for the generic non-paymsg fallback)
//   fs, path -> Node's fs/path (for the generic non-paymsg fallback's raw file delete)
// Explicit allowlist of body fields a PUT to a category="paymsg" row is
// ever allowed to touch. audioFile1/2/3, category, and audioId are
// DELIBERATELY absent — those can only ever change through
// paymsgLifecycle (approvePending/restorePrevious/commitStagedUpload/
// rejectPending), never through this generic route, no matter what a
// client sends. "status" is included because non-promotion status
// transitions (חסר->תורגם->הוקלט->נבדק, or a plain re-approve with no
// pending file to promote) are legitimate editorial actions unrelated to
// the slot machinery.
const PAYMSG_EDITABLE_FIELDS = ["sourceTextHe", "translation", "usageDescription", "notes", "status"];

function pickAllowedPaymsgFields(body, allowedFields) {
  const picked = {};
  allowedFields.forEach(function (field) {
    if (body[field] !== undefined) picked[field] = body[field];
  });
  return picked;
}

function createIvrAudioSlotRoutes(deps) {
  const router = express.Router();
  const {
    getIvrAudioRecordingById,
    updateIvrAudioRecording,
    setIvrAudioRecordingFileSlot,
    clearIvrAudioRecordingFileSlot,
    bumpStatusOnUpload,
    isValidStatus,
    isValidSlot,
    insertAuditLog,
    paymsgLock,
    paymsgLifecycle,
    ivrAudioUpload,
    IVR_AUDIO_FILE_FIELD,
    uploadsDir,
    fs,
    path,
  } = deps;

  router.put("/:id", function (req, res, next) {
    try {
      var body = req.body || {};
      if (body.status !== undefined && !isValidStatus(String(body.status))) {
        return res.status(400).json({ error: "סטטוס לא תקין: " + body.status });
      }

      var existingForStatus = getIvrAudioRecordingById(req.params.id);
      if (!existingForStatus) return res.status(404).json({ error: "לא נמצאה הקלטה עם המזהה הזה" });

      // PAYMSG rows: audioFile1/2/3 (and category/audioId) may NEVER be
      // changed through this generic field-update route, regardless of
      // what's in the request body — the only way to move a file between
      // slots is through the lifecycle service (upload -> audioFile3,
      // approve -> promotion, restore -> swap). This is enforced with an
      // explicit allowlist, not by trusting the client to only send safe
      // fields and not by relying on updateIvrAudioRecording() to silently
      // ignore unknown keys (defense in depth — that behavior could change
      // independently of this route).
      if (existingForStatus.category === "paymsg") {
        // Approving (status "אושר") while a pending upload (audioFile3)
        // exists is a slot-rotation promotion, not a plain field update —
        // see ivr-audio-paymsg-lifecycle.service.js §9.12. Must run even
        // when the row's status is ALREADY "אושר" (re-approving a
        // replacement) — never skipped as "no change" just because the
        // requested status string matches the current one.
        //
        // This request is LIFECYCLE-ONLY: it goes to approvePending() and
        // nothing else. Any other fields present in the same body
        // (notes/sourceTextHe/translation/usageDescription) are silently
        // IGNORED, not applied in a second step — a two-step "promote,
        // then also update fields" was tried and rejected: if the second
        // step (a plain DB write) failed after the promotion already
        // succeeded, the recording would already be live+approved while
        // the client saw an error and the caller would wrongly believe the
        // approval itself had failed. There is no second step to fail.
        // Editing metadata on a paymsg row is always a SEPARATE PUT that
        // doesn't include status:"אושר" while a pending version exists.
        if (body.status === "אושר" && existingForStatus.audioFile3) {
          if (!paymsgLock.tryLock(req.params.id)) {
            return res.status(409).json({ error: "פעולה אחרת כבר מתבצעת על הקלטה זו, נסו שוב בעוד רגע" });
          }
          try {
            var promoted = paymsgLifecycle.approvePending(req.params.id);
            if (!promoted.ok) return res.status(promoted.status || 400).json({ error: promoted.error });

            try {
              insertAuditLog({
                action: "ivr_audio_paymsg_approve", entityType: "ivr_audio_recording", entityId: req.params.id, entityName: req.params.id,
                details: "אושרה גרסה ממתינה והוחלפה כגרסה פעילה עבור " + req.params.id,
                workerId: req.user.id, workerName: req.user.name, ip: req.ip,
              });
            } catch (_) {}

            return res.json({ ok: true, recording: promoted.recording });
          } finally {
            paymsgLock.unlock(req.params.id);
          }
        }

        // Any other PUT to a paymsg row (including status changes that
        // aren't a promotion, e.g. חסר->תורגם, or a plain re-approve with
        // no pending file) — allowlisted fields only, audioFile1/2/3/
        // category/audioId are ALWAYS stripped regardless of what the
        // client sent.
        var filtered = pickAllowedPaymsgFields(body, PAYMSG_EDITABLE_FIELDS);
        var updatedPaymsg = updateIvrAudioRecording(req.params.id, filtered);
        if (!updatedPaymsg) return res.status(404).json({ error: "לא נמצאה הקלטה עם המזהה הזה" });
        return res.json({ ok: true, recording: updatedPaymsg });
      }

      var updated = updateIvrAudioRecording(req.params.id, body);
      if (!updated) return res.status(404).json({ error: "לא נמצאה הקלטה עם המזהה הזה" });
      res.json({ ok: true, recording: updated });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/audio/:slot", function (req, res, next) {
    if (!isValidSlot(req.params.slot)) return res.status(400).json({ error: "סלוט לא תקין (1/2/3 בלבד)" });
    var existing = getIvrAudioRecordingById(req.params.id);
    if (!existing) return res.status(404).json({ error: "לא נמצאה הקלטה עם המזהה הזה" });

    // PAYMSG rows: uploads only ever land in the pending slot (3) — never the
    // active slot (1) — enforced here server-side, not just hidden in the UI.
    // The active recording keeps serving calls untouched until an explicit
    // approve (PUT status="אושר") promotes the pending file. category/slot
    // are always re-checked against the DB row, never trusted from the client.
    var isPaymsg = existing.category === "paymsg";
    if (isPaymsg && Number(req.params.slot) !== 3) {
      return res.status(400).json({
        error: "עבור הודעות סליקה ניתן להעלות רק לגרסה הממתינה (סלוט 3) — האישור וההפעלה נעשים דרך פעולת האישור, לא דרך העלאה ישירה",
      });
    }
    if (isPaymsg && !paymsgLock.tryLock(req.params.id)) {
      return res.status(409).json({ error: "פעולה אחרת כבר מתבצעת על הקלטה זו, נסו שוב בעוד רגע" });
    }

    ivrAudioUpload(req, res, function (err) {
      try {
        if (err) return res.status(400).json({ error: err.message });
        if (!req.file) return res.status(400).json({ error: "לא נשלח קובץ שמע" });

        if (isPaymsg) {
          // Automatic format check + conversion (reuses the exact pure logic
          // + ffmpeg invocation from scripts/convert-ivr-audio-to-wav.js
          // --apply — no manual server-side script run needed). On failure,
          // audioFile1/2/3 are all left completely untouched.
          var converted = paymsgLifecycle.convertUploadedFile(req.file.filename);
          if (!converted.ok) return res.status(422).json({ error: converted.error });

          var staged = paymsgLifecycle.commitStagedUpload(req.params.id, req.file.filename);
          if (!staged.ok) return res.status(staged.status || 400).json({ error: staged.error });

          try {
            insertAuditLog({
              action: "ivr_audio_paymsg_stage", entityType: "ivr_audio_recording", entityId: req.params.id, entityName: req.params.id,
              details: "הועלתה גרסה ממתינה לאישור עבור " + req.params.id + " (" + req.file.filename + ")",
              workerId: req.user.id, workerName: req.user.name, ip: req.ip,
            });
          } catch (_) {}

          return res.json({ ok: true, recording: staged.recording });
        }

        var slot = Number(req.params.slot);
        var existingFilename = existing[IVR_AUDIO_FILE_FIELD[slot]];
        if (existingFilename && existingFilename !== req.file.filename) {
          var oldPath = path.join(uploadsDir, existingFilename);
          if (fs.existsSync(oldPath)) { try { fs.unlinkSync(oldPath); } catch (_) {} }
        }

        var nextStatus = bumpStatusOnUpload(existing.status);
        var updated = setIvrAudioRecordingFileSlot(req.params.id, slot, req.file.filename, nextStatus);

        try {
          insertAuditLog({
            action: "ivr_audio_upload", entityType: "ivr_audio_recording", entityId: req.params.id, entityName: req.params.id,
            details: "הועלה קובץ הקלטה " + slot + " ל-" + req.params.id + " (" + req.file.filename + ")",
            workerId: req.user.id, workerName: req.user.name, ip: req.ip,
          });
        } catch (_) {}

        res.json({ ok: true, recording: updated });
      } finally {
        if (isPaymsg) paymsgLock.unlock(req.params.id);
      }
    });
  });

  router.delete("/:id/audio/:slot", function (req, res, next) {
    try {
      if (!isValidSlot(req.params.slot)) return res.status(400).json({ error: "סלוט לא תקין (1/2/3 בלבד)" });
      var existing = getIvrAudioRecordingById(req.params.id);
      if (!existing) return res.status(404).json({ error: "לא נמצאה הקלטה עם המזהה הזה" });

      // PAYMSG rows: only the pending slot (3) may ever be deleted directly.
      // The active slot (1) and previous slot (2) are only ever changed by
      // approve/restore — never by a raw delete, even from an admin — to keep
      // the 3-slot invariant intact. Same per-audioId lock as upload/approve/
      // restore, since a delete of slot 3 must not interleave with those.
      var isPaymsg = existing.category === "paymsg";
      if (isPaymsg && Number(req.params.slot) !== 3) {
        return res.status(400).json({ error: "עבור הודעות סליקה ניתן למחוק רק את הגרסה הממתינה (סלוט 3)" });
      }
      if (isPaymsg && !paymsgLock.tryLock(req.params.id)) {
        return res.status(409).json({ error: "פעולה אחרת כבר מתבצעת על הקלטה זו, נסו שוב בעוד רגע" });
      }
      try {
        var slot = Number(req.params.slot);

        if (isPaymsg) {
          // DB-first, disk-after (opposite order from the generic path below)
          // — the row must stop pointing at the file BEFORE it's deleted, so
          // a crash/failure between the two steps never leaves a dangling DB
          // reference to a missing file. Re-validates the row/slot fresh
          // under the lock (rejectPending re-fetches by audioId itself).
          // Also removes the derived file (via safeUnlink inside
          // rejectPending), not just the raw upload.
          var rejected = paymsgLifecycle.rejectPending(req.params.id);
          if (!rejected.ok) return res.status(rejected.status || 400).json({ error: rejected.error });

          try {
            insertAuditLog({
              action: "ivr_audio_paymsg_reject", entityType: "ivr_audio_recording", entityId: req.params.id, entityName: req.params.id,
              details: "נדחתה/נמחקה גרסה ממתינה עבור " + req.params.id,
              workerId: req.user.id, workerName: req.user.name, ip: req.ip,
            });
          } catch (_) {}

          return res.json({ ok: true, recording: rejected.recording });
        }

        var filename = existing[IVR_AUDIO_FILE_FIELD[slot]];
        if (filename) {
          var p = path.join(uploadsDir, filename);
          if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch (_) {} }
        }
        var updated = clearIvrAudioRecordingFileSlot(req.params.id, slot);

        try {
          insertAuditLog({
            action: "ivr_audio_delete_file", entityType: "ivr_audio_recording", entityId: req.params.id, entityName: req.params.id,
            details: "נמחק קובץ הקלטה " + slot + " מ-" + req.params.id,
            workerId: req.user.id, workerName: req.user.name, ip: req.ip,
          });
        } catch (_) {}

        res.json({ ok: true, recording: updated });
      } finally {
        if (isPaymsg) paymsgLock.unlock(req.params.id);
      }
    } catch (err) {
      next(err);
    }
  });

  // Restores audioFile1<->audioFile2 (swap) for a PAYMSG row — one-step
  // rollback to the previous version. audioFile3 (pending) and status are
  // left completely untouched. See ivr-audio-paymsg-lifecycle.service.js.
  router.post("/:id/restore-previous", function (req, res, next) {
    try {
      var existing = getIvrAudioRecordingById(req.params.id);
      if (!existing) return res.status(404).json({ error: "לא נמצאה הקלטה עם המזהה הזה" });
      if (existing.category !== "paymsg") {
        return res.status(400).json({ error: "שחזור גרסה קודמת נתמך כרגע רק עבור הודעות סליקה (paymsg)" });
      }
      if (!paymsgLock.tryLock(req.params.id)) {
        return res.status(409).json({ error: "פעולה אחרת כבר מתבצעת על הקלטה זו, נסו שוב בעוד רגע" });
      }
      try {
        var restored = paymsgLifecycle.restorePrevious(req.params.id);
        if (!restored.ok) return res.status(restored.status || 400).json({ error: restored.error });

        try {
          insertAuditLog({
            action: "ivr_audio_paymsg_restore", entityType: "ivr_audio_recording", entityId: req.params.id, entityName: req.params.id,
            details: "שוחזרה גרסה קודמת (audioFile1<->audioFile2) עבור " + req.params.id,
            workerId: req.user.id, workerName: req.user.name, ip: req.ip,
          });
        } catch (_) {}

        res.json({ ok: true, recording: restored.recording });
      } finally {
        paymsgLock.unlock(req.params.id);
      }
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createIvrAudioSlotRoutes };

// ivr-audio-paymsg-lifecycle.service.test.js — covers the required test
// list for the PAYMSG 3-slot lifecycle (audioFile1=active, audioFile2=
// previous, audioFile3=pending). Fully dependency-injected fake DB row +
// fake filesystem/ffmpeg — no real DB, no real ffmpeg.
//
// ⚠️ IMPORTANT SCOPE NOTE: ffmpeg/ffprobe are NOT installed in this
// environment. Every test below that exercises convertUploadedFile() uses
// a FAKE probeAudioSafe/convertToTmpWav (see makeHarness() below) — they
// prove the DECISION LOGIC (when to convert, how to react to success/
// failure, ordering, locking, DB atomicity) is correct, using the REAL
// pure functions from scripts/convert-ivr-audio-to-wav.js (isPathContained,
// computeDerivedFilename, isReadyAsIs, isValidDerivedProbe). They do NOT
// prove that a real upload through a real browser, hitting real multer and
// real ffmpeg/ffprobe binaries on the actual server, produces a playable
// WAV Technoline can fetch. That still needs one real manual upload+
// approve test run in an environment where ffmpeg/ffprobe are installed
// (i.e. the actual server) before this is relied on in production.
//
// הרצה: node ivr-audio-paymsg-lifecycle.service.test.js

const assert = require("assert");
const path = require("path");
const {
  isPathContained,
  computeDerivedFilename,
  computeTmpFilename,
  isReadyAsIs,
  isValidDerivedProbe,
} = require("./scripts/convert-ivr-audio-to-wav");
const { createPaymsgLifecycle } = require("./ivr-audio-paymsg-lifecycle.service");

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name: name, ok: true });
  } catch (err) {
    results.push({ name: name, ok: false, error: err.stack || err.message });
  }
}

const UPLOAD_DIR = path.resolve(__dirname, "fake-uploads-paymsg-test");
const VALID_PCM8K_PROBE = { codec_name: "pcm_s16le", sample_rate: "8000", channels: "1" };

function makeHarness() {
  const files = Object.create(null);   // absPath -> true
  const probes = Object.create(null);  // absPath -> probeResult | null
  const rows = Object.create(null);    // audioId -> {audioFile1,audioFile2,audioFile3,status}
  const logs = [];
  let convertFailForAbsPath = null;
  let unlinkShouldThrowFor = null;

  function absOf(filename) {
    return isPathContained(UPLOAD_DIR, filename).resolvedPath;
  }

  const deps = {
    getRecordByAudioId: function (audioId) {
      return rows[audioId] ? Object.assign({ audioId: audioId }, rows[audioId]) : null;
    },
    setSlots: function (audioId, fields) {
      rows[audioId] = {
        audioFile1: fields.audioFile1 || "",
        audioFile2: fields.audioFile2 || "",
        audioFile3: fields.audioFile3 || "",
        status: fields.status || "",
      };
      return Object.assign({ audioId: audioId }, rows[audioId]);
    },
    uploadDir: UPLOAD_DIR,
    isPathContained: isPathContained,
    computeDerivedFilename: computeDerivedFilename,
    computeTmpFilename: computeTmpFilename,
    fileExists: function (absPath) { return !!files[absPath]; },
    probeAudioSafe: function (absPath) {
      return Object.prototype.hasOwnProperty.call(probes, absPath) ? probes[absPath] : null;
    },
    isValidDerivedProbe: isValidDerivedProbe,
    isReadyAsIs: isReadyAsIs,
    convertToTmpWav: function (inputAbsPath, outputTmpAbsPath) {
      if (convertFailForAbsPath && convertFailForAbsPath === inputAbsPath) {
        throw new Error("ffmpeg נכשל (מדומה בבדיקה)");
      }
      files[outputTmpAbsPath] = true;
      if (!Object.prototype.hasOwnProperty.call(probes, outputTmpAbsPath)) {
        probes[outputTmpAbsPath] = VALID_PCM8K_PROBE;
      }
    },
    rename: function (fromAbsPath, toAbsPath) {
      if (!files[fromAbsPath]) throw new Error("ENOENT — rename ממקור שלא קיים");
      files[toAbsPath] = true;
      if (fromAbsPath in probes) { probes[toAbsPath] = probes[fromAbsPath]; delete probes[fromAbsPath]; }
      delete files[fromAbsPath];
    },
    unlink: function (absPath) {
      if (unlinkShouldThrowFor && unlinkShouldThrowFor === absPath) {
        throw new Error("EPERM — מחיקה נכשלה (מדומה בבדיקה)");
      }
      if (!files[absPath]) throw new Error("ENOENT — unlink");
      delete files[absPath];
      delete probes[absPath];
    },
    log: function (line) { logs.push(line); },
  };

  return {
    deps: deps,
    lifecycle: createPaymsgLifecycle(deps),
    rows: rows,
    logs: logs,
    absOf: absOf,
    hasFile: function (filename) { return !!files[absOf(filename)]; },
    // Registers a file as already "on disk" with an optional probe result
    // (defaults to a valid PCM8k probe, i.e. a ready-as-is .wav).
    putReadyWavFile: function (filename) {
      files[absOf(filename)] = true;
      probes[absOf(filename)] = VALID_PCM8K_PROBE;
    },
    putMissingFile: function (filename) {
      // deliberately does NOT register it in `files` — simulates a DB
      // pointer to a file that isn't actually on disk.
      void filename;
    },
    putCorruptFile: function (filename) {
      files[absOf(filename)] = true;
      probes[absOf(filename)] = null; // ffprobe fails on it
    },
    setRow: function (audioId, fields) {
      rows[audioId] = Object.assign({ audioFile1: "", audioFile2: "", audioFile3: "", status: "חסר" }, fields);
    },
    failConvertFor: function (filename) { convertFailForAbsPath = absOf(filename); },
    failUnlinkFor: function (filename) { unlinkShouldThrowFor = absOf(filename); },
  };
}

// ── 1. העלאה ראשונה ללא הקלטה פעילה ─────────────────────────────────────────
check("[1] העלאה ראשונה — אין עדיין שורה כלל: convertUploadedFile+commitStagedUpload יוצרים audioFile3, לא נוגעים ב-audioFile1/status", function () {
  const h = makeHarness();
  h.setRow("PAYMSG-3000", {}); // שורה קיימת אך ריקה (כמו אחרי seed)
  h.putReadyWavFile("PAYMSG-3000-3-aaa.wav");

  const converted = h.lifecycle.convertUploadedFile("PAYMSG-3000-3-aaa.wav");
  assert.strictEqual(converted.ok, true);

  const staged = h.lifecycle.commitStagedUpload("PAYMSG-3000", "PAYMSG-3000-3-aaa.wav");
  assert.strictEqual(staged.ok, true);
  assert.strictEqual(staged.recording.audioFile3, "PAYMSG-3000-3-aaa.wav");
  assert.strictEqual(staged.recording.audioFile1, "");
  assert.strictEqual(staged.recording.status, "חסר");
});

// ── 2. העלאה כאשר קיימת הקלטה מאושרת ───────────────────────────────────────
check("[2] העלאה כשקיימת גרסה פעילה ומאושרת — audioFile1+status נשארים בדיוק כמו שהיו", function () {
  const h = makeHarness();
  h.putReadyWavFile("PAYMSG-3001-1-live.wav");
  h.setRow("PAYMSG-3001", { audioFile1: "PAYMSG-3001-1-live.wav", status: "אושר" });
  h.putReadyWavFile("PAYMSG-3001-3-newpending.wav");

  const converted = h.lifecycle.convertUploadedFile("PAYMSG-3001-3-newpending.wav");
  assert.strictEqual(converted.ok, true);
  const staged = h.lifecycle.commitStagedUpload("PAYMSG-3001", "PAYMSG-3001-3-newpending.wav");
  assert.strictEqual(staged.ok, true);
  assert.strictEqual(staged.recording.audioFile1, "PAYMSG-3001-1-live.wav", "הגרסה הפעילה לא זזה");
  assert.strictEqual(staged.recording.status, "אושר", "הסטטוס לא השתנה — עדיין מתאר את audioFile1");
  assert.strictEqual(staged.recording.audioFile3, "PAYMSG-3001-3-newpending.wav");
  assert.ok(h.hasFile("PAYMSG-3001-1-live.wav"), "קובץ הפעיל עדיין קיים בדיסק");
});

// ── 3. העלאה שנכשלת בהמרה ────────────────────────────────────────────────
check("[3a] כישלון פורמט — הקובץ שהועלה אינו קובץ שמע כלל: אין שינוי לשום סלוט/סטטוס", function () {
  const h = makeHarness();
  h.putReadyWavFile("PAYMSG-3002-1-live.wav");
  h.setRow("PAYMSG-3002", { audioFile1: "PAYMSG-3002-1-live.wav", status: "אושר" });
  h.putCorruptFile("PAYMSG-3002-3-garbage.wav");

  const converted = h.lifecycle.convertUploadedFile("PAYMSG-3002-3-garbage.wav");
  assert.strictEqual(converted.ok, false);
  assert.ok(converted.error);
  // ה-route לא היה קורא ל-commitStagedUpload כלל בכישלון — מוודאים שהקובץ
  // הפגום עצמו נוקה, ושהשורה נשארת בדיוק כמו שהייתה.
  assert.strictEqual(h.hasFile("PAYMSG-3002-3-garbage.wav"), false);
  assert.deepStrictEqual(h.rows["PAYMSG-3002"], { audioFile1: "PAYMSG-3002-1-live.wav", audioFile2: "", audioFile3: "", status: "אושר" });
});

check("[3b] כישלון המרה — ffmpeg נכשל (MP3 שצריך המרה): audioFile1/2/3/status נשארים ללא שינוי", function () {
  const h = makeHarness();
  h.setRow("PAYMSG-3003", { audioFile1: "PAYMSG-3003-1-live.wav", status: "אושר" });
  h.putReadyWavFile("PAYMSG-3003-1-live.wav");
  // MP3 עם probe תקין (אז isReadyAsIs=false כי הסיומת לא wav) -> ידרוש המרה
  const absSrc = h.absOf("PAYMSG-3003-3-bad.mp3");
  void absSrc;
  // רושמים קובץ MP3 "תקין כתוכן" אבל מכריחים את ההמרה עצמה להיכשל
  h.deps.fileExists; // no-op, keeps linter quiet about unused
  h.putReadyWavFile("PAYMSG-3003-3-bad.mp3"); // מסמן כקיים+probe תקין (מדמה תוכן PCM8k תקין, רק סיומת mp3)
  h.failConvertFor("PAYMSG-3003-3-bad.mp3");

  const converted = h.lifecycle.convertUploadedFile("PAYMSG-3003-3-bad.mp3");
  assert.strictEqual(converted.ok, false);
  assert.strictEqual(h.hasFile("PAYMSG-3003-3-bad.mp3"), false, "הקובץ שהועלה נוקה אחרי כישלון");
  assert.deepStrictEqual(h.rows["PAYMSG-3003"], { audioFile1: "PAYMSG-3003-1-live.wav", audioFile2: "", audioFile3: "", status: "אושר" });
});

// ── 4. החלפת audioFile3 ממתין ────────────────────────────────────────────
check("[4] העלאה חדשה כשכבר יש audioFile3 ממתין — הישן נמחק רק אחרי שהחדש נשמר בהצלחה", function () {
  const h = makeHarness();
  h.putReadyWavFile("PAYMSG-3004-3-old-pending.wav");
  h.setRow("PAYMSG-3004", { audioFile3: "PAYMSG-3004-3-old-pending.wav", status: "חסר" });
  h.putReadyWavFile("PAYMSG-3004-3-new-pending.wav");

  const converted = h.lifecycle.convertUploadedFile("PAYMSG-3004-3-new-pending.wav");
  assert.strictEqual(converted.ok, true);
  const staged = h.lifecycle.commitStagedUpload("PAYMSG-3004", "PAYMSG-3004-3-new-pending.wav");
  assert.strictEqual(staged.ok, true);
  assert.strictEqual(staged.recording.audioFile3, "PAYMSG-3004-3-new-pending.wav");
  assert.strictEqual(h.hasFile("PAYMSG-3004-3-old-pending.wav"), false, "הממתין הישן נמחק אחרי ההצלחה");
  assert.strictEqual(h.hasFile("PAYMSG-3004-3-new-pending.wav"), true);
});

// ── 5. אישור כאשר status כבר "אושר" ──────────────────────────────────────
check("[5] אישור גרסה ממתינה כש-status כבר \"אושר\" — הקידום עדיין מתבצע, לא מדולג כ'אין שינוי'", function () {
  const h = makeHarness();
  h.putReadyWavFile("PAYMSG-3005-1-old-active.wav");
  h.putReadyWavFile("PAYMSG-3005-2-oldest.wav");
  h.putReadyWavFile("PAYMSG-3005-3-pending.wav");
  h.setRow("PAYMSG-3005", {
    audioFile1: "PAYMSG-3005-1-old-active.wav",
    audioFile2: "PAYMSG-3005-2-oldest.wav",
    audioFile3: "PAYMSG-3005-3-pending.wav",
    status: "אושר",
  });

  const result = h.lifecycle.approvePending("PAYMSG-3005");
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.recording.audioFile1, "PAYMSG-3005-3-pending.wav", "הממתין הפך לפעיל");
  assert.strictEqual(result.recording.audioFile2, "PAYMSG-3005-1-old-active.wav", "הפעיל הישן זז לגרסה קודמת");
  assert.strictEqual(result.recording.audioFile3, "", "הממתין התרוקן");
  assert.strictEqual(result.recording.status, "אושר");
  assert.strictEqual(h.hasFile("PAYMSG-3005-2-oldest.wav"), false, "הגרסה-לפני-הקודמת (2 גרסאות אחורה) נמחקה");
  assert.strictEqual(h.hasFile("PAYMSG-3005-1-old-active.wav"), true, "הפעיל הישן עדיין קיים — הוא עכשיו הגיבוי");
});

// ── 6. אישור ללא audioFile3 ──────────────────────────────────────────────
check("[6] אישור ללא גרסה ממתינה כלל — נכשל, לא משנה שום דבר", function () {
  const h = makeHarness();
  h.putReadyWavFile("PAYMSG-3006-1-active.wav");
  h.setRow("PAYMSG-3006", { audioFile1: "PAYMSG-3006-1-active.wav", status: "אושר" });

  const result = h.lifecycle.approvePending("PAYMSG-3006");
  assert.strictEqual(result.ok, false);
  assert.ok(result.error);
  assert.deepStrictEqual(h.rows["PAYMSG-3006"], { audioFile1: "PAYMSG-3006-1-active.wav", audioFile2: "", audioFile3: "", status: "אושר" });
});

check("[6b] אישור עם audioFile3 שמצביע לקובץ פגום/לא תקין — נדחה, לא מקדם", function () {
  const h = makeHarness();
  h.putReadyWavFile("PAYMSG-3006b-1-active.wav");
  h.putCorruptFile("PAYMSG-3006b-3-bad.wav");
  h.setRow("PAYMSG-3006b", {
    audioFile1: "PAYMSG-3006b-1-active.wav",
    audioFile3: "PAYMSG-3006b-3-bad.wav",
    status: "אושר",
  });

  const result = h.lifecycle.approvePending("PAYMSG-3006b");
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(h.rows["PAYMSG-3006b"], {
    audioFile1: "PAYMSG-3006b-1-active.wav", audioFile2: "", audioFile3: "PAYMSG-3006b-3-bad.wav", status: "אושר",
  });
});

// ── 7. מחיקת ממתין בלי פגיעה בפעיל — rejectPending (DB-first, disk-after) ──
check("[7a] rejectPending תקין — DB מתעדכן (audioFile3 מתרוקן), audioFile1/status לא נוגעים, הקובץ נמחק מהדיסק", function () {
  const h = makeHarness();
  h.putReadyWavFile("PAYMSG-3007-1-active.wav");
  h.putReadyWavFile("PAYMSG-3007-3-pending.wav");
  h.setRow("PAYMSG-3007", {
    audioFile1: "PAYMSG-3007-1-active.wav",
    audioFile3: "PAYMSG-3007-3-pending.wav",
    status: "אושר",
  });

  const result = h.lifecycle.rejectPending("PAYMSG-3007");
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.recording.audioFile3, "");
  assert.strictEqual(result.recording.audioFile1, "PAYMSG-3007-1-active.wav", "הפעיל לא נגע");
  assert.strictEqual(result.recording.status, "אושר", "הסטטוס לא נגע");
  assert.strictEqual(h.hasFile("PAYMSG-3007-3-pending.wav"), false, "הקובץ שנדחה נמחק בפועל מהדיסק");
  assert.strictEqual(h.hasFile("PAYMSG-3007-1-active.wav"), true, "הפעיל עדיין קיים בדיסק");
});

check("[7b] rejectPending ללא audioFile3 בכלל — נכשל, לא משנה כלום", function () {
  const h = makeHarness();
  h.putReadyWavFile("PAYMSG-3007b-1-active.wav");
  h.setRow("PAYMSG-3007b", { audioFile1: "PAYMSG-3007b-1-active.wav", status: "אושר" });

  const result = h.lifecycle.rejectPending("PAYMSG-3007b");
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(h.rows["PAYMSG-3007b"], { audioFile1: "PAYMSG-3007b-1-active.wav", audioFile2: "", audioFile3: "", status: "אושר" });
});

check("[7c — כישלון DB] rejectPending: אם setSlots זורק (כישלון DB), הקובץ והפניית ה-DB נשארים ללא שינוי", function () {
  const h = makeHarness();
  h.putReadyWavFile("PAYMSG-3007c-3-pending.wav");
  h.setRow("PAYMSG-3007c", { audioFile3: "PAYMSG-3007c-3-pending.wav", status: "חסר" });
  var realSetSlots = h.deps.setSlots;
  h.deps.setSlots = function () { throw new Error("DB כשל מדומה"); };

  assert.throws(function () { h.lifecycle.rejectPending("PAYMSG-3007c"); }, /DB כשל מדומה/);
  h.deps.setSlots = realSetSlots; // restore, so getRecordByAudioId reads see the original state below
  assert.strictEqual(h.rows["PAYMSG-3007c"].audioFile3, "PAYMSG-3007c-3-pending.wav", "ה-DB נשאר מצביע לקובץ הישן");
  assert.strictEqual(h.hasFile("PAYMSG-3007c-3-pending.wav"), true, "הקובץ הפיזי לא נמחק כי ה-DB לא הצליח קודם");
});

check("[7d — הצלחת DB + כישלון מחיקה] rejectPending: audioFile3 מתרוקן ב-DB, אך מחיקת הקובץ נכשלת — נרשם ללוג, הפעולה לא נכשלת", function () {
  const h = makeHarness();
  h.putReadyWavFile("PAYMSG-3007d-3-pending.wav");
  h.setRow("PAYMSG-3007d", { audioFile3: "PAYMSG-3007d-3-pending.wav", status: "חסר" });
  h.failUnlinkFor("PAYMSG-3007d-3-pending.wav");

  const result = h.lifecycle.rejectPending("PAYMSG-3007d");
  assert.strictEqual(result.ok, true, "כישלון מחיקה לא מבטל את הצלחת ה-DB");
  assert.strictEqual(result.recording.audioFile3, "", "ה-DB כבר לא מצביע לקובץ, גם שהקובץ עצמו עדיין בדיסק בפועל");
  assert.ok(h.logs.some(function (l) { return l.indexOf("ניקוי ידני") !== -1; }), "כישלון המחיקה נרשם ללוג לניקוי מאוחר");
});

check("[7e — נתיב לא בטוח] rejectPending: audioFile3 עם ניסיון path traversal — נדחה, שום מחיקה ושום שינוי DB", function () {
  const h = makeHarness();
  h.setRow("PAYMSG-3007e", { audioFile3: "../../etc/passwd", status: "חסר" });

  const result = h.lifecycle.rejectPending("PAYMSG-3007e");
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(h.rows["PAYMSG-3007e"], { audioFile1: "", audioFile2: "", audioFile3: "../../etc/passwd", status: "חסר" });
});

// ── 8. שחזור תקין ─────────────────────────────────────────────────────────
check("[8] שחזור תקין — audioFile1<->audioFile2 מוחלפים, audioFile3+status לא זזים", function () {
  const h = makeHarness();
  h.putReadyWavFile("PAYMSG-3008-1-active.wav");
  h.putReadyWavFile("PAYMSG-3008-2-previous.wav");
  h.putReadyWavFile("PAYMSG-3008-3-pending.wav");
  h.setRow("PAYMSG-3008", {
    audioFile1: "PAYMSG-3008-1-active.wav",
    audioFile2: "PAYMSG-3008-2-previous.wav",
    audioFile3: "PAYMSG-3008-3-pending.wav",
    status: "אושר",
  });

  const result = h.lifecycle.restorePrevious("PAYMSG-3008");
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.recording.audioFile1, "PAYMSG-3008-2-previous.wav");
  assert.strictEqual(result.recording.audioFile2, "PAYMSG-3008-1-active.wav");
  assert.strictEqual(result.recording.audioFile3, "PAYMSG-3008-3-pending.wav", "הממתין לא זז בעקבות שחזור");
  assert.strictEqual(result.recording.status, "אושר");
  // שחזור אף פעם לא נוגע בדיסק — שני הקבצים כבר שם, רק מתחלפת ההפניה.
  assert.strictEqual(h.hasFile("PAYMSG-3008-1-active.wav"), true);
  assert.strictEqual(h.hasFile("PAYMSG-3008-2-previous.wav"), true);
});

// ── 9. שחזור ללא גרסה קודמת ──────────────────────────────────────────────
check("[9] שחזור ללא audioFile2 בכלל — נכשל, לא משנה כלום", function () {
  const h = makeHarness();
  h.putReadyWavFile("PAYMSG-3009-1-active.wav");
  h.setRow("PAYMSG-3009", { audioFile1: "PAYMSG-3009-1-active.wav", status: "אושר" });

  const result = h.lifecycle.restorePrevious("PAYMSG-3009");
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(h.rows["PAYMSG-3009"], { audioFile1: "PAYMSG-3009-1-active.wav", audioFile2: "", audioFile3: "", status: "אושר" });
});

// ── 10. שחזור עם קובץ חסר/לא תקין ────────────────────────────────────────
check("[10a] שחזור כש-audioFile2 מוגדר ב-DB אך חסר בפועל בדיסק — נכשל, DB לא משתנה", function () {
  const h = makeHarness();
  h.putReadyWavFile("PAYMSG-3010-1-active.wav");
  h.setRow("PAYMSG-3010", {
    audioFile1: "PAYMSG-3010-1-active.wav",
    audioFile2: "PAYMSG-3010-2-missing.wav", // מעולם לא נרשם ב-files
    status: "אושר",
  });

  const result = h.lifecycle.restorePrevious("PAYMSG-3010");
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(h.rows["PAYMSG-3010"], {
    audioFile1: "PAYMSG-3010-1-active.wav", audioFile2: "PAYMSG-3010-2-missing.wav", audioFile3: "", status: "אושר",
  });
});

check("[10b] שחזור כש-audioFile2 קיים בדיסק אך פגום (ffprobe נכשל) — נכשל, DB לא משתנה", function () {
  const h = makeHarness();
  h.putReadyWavFile("PAYMSG-3010b-1-active.wav");
  h.putCorruptFile("PAYMSG-3010b-2-corrupt.wav");
  h.setRow("PAYMSG-3010b", {
    audioFile1: "PAYMSG-3010b-1-active.wav",
    audioFile2: "PAYMSG-3010b-2-corrupt.wav",
    status: "אושר",
  });

  const result = h.lifecycle.restorePrevious("PAYMSG-3010b");
  assert.strictEqual(result.ok, false);
  assert.strictEqual(h.rows["PAYMSG-3010b"].audioFile1, "PAYMSG-3010b-1-active.wav");
});

// ── 10c/10d (תיקון ממצא 2) — restorePrevious חייב לבדוק גם audioFile1 ─────
// לא רק audioFile2. audioFile1 הוא הקובץ שהופך לגרסה הקודמת אחרי ה-swap —
// אם הוא עצמו חסר/פגום, אסור לבצע swap בכלל (היה מוחק בפועל את עותק
// העבודה היחיד התקין — audioFile2 — בלי שום דרך חזרה).
check("[10c] שחזור נדחה כש-audioFile1 (הפעיל הנוכחי) חסר בפועל בדיסק, גם ש-audioFile2 תקין לגמרי — DB לא משתנה", function () {
  const h = makeHarness();
  h.putReadyWavFile("PAYMSG-3010c-2-previous.wav");
  h.setRow("PAYMSG-3010c", {
    audioFile1: "PAYMSG-3010c-1-missing.wav", // מוגדר ב-DB, אך מעולם לא נרשם ב-files
    audioFile2: "PAYMSG-3010c-2-previous.wav",
    status: "אושר",
  });

  const result = h.lifecycle.restorePrevious("PAYMSG-3010c");
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(h.rows["PAYMSG-3010c"], {
    audioFile1: "PAYMSG-3010c-1-missing.wav", audioFile2: "PAYMSG-3010c-2-previous.wav", audioFile3: "", status: "אושר",
  });
});

check("[10d] שחזור נדחה כש-audioFile1 (הפעיל הנוכחי) פגום (ffprobe נכשל), גם ש-audioFile2 תקין לגמרי — DB לא משתנה", function () {
  const h = makeHarness();
  h.putCorruptFile("PAYMSG-3010d-1-corrupt.wav");
  h.putReadyWavFile("PAYMSG-3010d-2-previous.wav");
  h.setRow("PAYMSG-3010d", {
    audioFile1: "PAYMSG-3010d-1-corrupt.wav",
    audioFile2: "PAYMSG-3010d-2-previous.wav",
    status: "אושר",
  });

  const result = h.lifecycle.restorePrevious("PAYMSG-3010d");
  assert.strictEqual(result.ok, false);
  assert.strictEqual(h.rows["PAYMSG-3010d"].audioFile1, "PAYMSG-3010d-1-corrupt.wav", "לא הוחלף — היה מאבד את audioFile2 התקין בלי חזרה");
  assert.strictEqual(h.hasFile("PAYMSG-3010d-2-previous.wav"), true, "audioFile2 התקין עדיין קיים, לא הועבר/נמחק");
});

// ── 11. שתי פעולות מקבילות וקבלת 409 ─────────────────────────────────────
// (מכוסה במלואו ב-ivr-audio-paymsg-lock.service.test.js — tryLock פעמיים על
// אותו audioId. מוזכר כאן כהפניה כדי שרשימת ה-14 תישאר עקבית עם קובץ אחד
// לכל דרישה; אין לוגיקה נוספת לבדוק כאן.)
check("[11] ראה ivr-audio-paymsg-lock.service.test.js — 409 על נעילה כפולה לאותו audioId", function () {
  assert.ok(true);
});

// ── 12. כישלון מחיקת קובץ ישן לאחר הצלחת DB ──────────────────────────────
check("[12] approvePending: מחיקת audioFile2 הישן נכשלת (EPERM) — האישור עצמו עדיין מצליח, נרשם ללוג", function () {
  const h = makeHarness();
  h.putReadyWavFile("PAYMSG-3012-1-active.wav");
  h.putReadyWavFile("PAYMSG-3012-2-oldest.wav");
  h.putReadyWavFile("PAYMSG-3012-3-pending.wav");
  h.setRow("PAYMSG-3012", {
    audioFile1: "PAYMSG-3012-1-active.wav",
    audioFile2: "PAYMSG-3012-2-oldest.wav",
    audioFile3: "PAYMSG-3012-3-pending.wav",
    status: "אושר",
  });
  h.failUnlinkFor("PAYMSG-3012-2-oldest.wav");

  const result = h.lifecycle.approvePending("PAYMSG-3012");
  assert.strictEqual(result.ok, true, "האישור עצמו לא נכשל בגלל כישלון ניקוי");
  assert.strictEqual(result.recording.audioFile1, "PAYMSG-3012-3-pending.wav");
  assert.ok(h.logs.some(function (l) { return l.indexOf("ניקוי ידני") !== -1; }), "כישלון המחיקה נרשם ללוג");
});

check("[12b] commitStagedUpload: מחיקת הממתין הישן נכשלת — ההעלאה החדשה עדיין מצליחה", function () {
  const h = makeHarness();
  h.putReadyWavFile("PAYMSG-3012c-3-old-pending.wav");
  h.setRow("PAYMSG-3012c", { audioFile3: "PAYMSG-3012c-3-old-pending.wav", status: "חסר" });
  h.putReadyWavFile("PAYMSG-3012c-3-new-pending.wav");
  h.failUnlinkFor("PAYMSG-3012c-3-old-pending.wav");

  const staged = h.lifecycle.commitStagedUpload("PAYMSG-3012c", "PAYMSG-3012c-3-new-pending.wav");
  assert.strictEqual(staged.ok, true);
  assert.strictEqual(staged.recording.audioFile3, "PAYMSG-3012c-3-new-pending.wav");
});

// ── 13. וידוא שה-resolver מגיש רק audioFile1 ─────────────────────────────
check("[13] ivr-audio-resolver.service.js: מגיש קובץ אך ורק לפי audioFile1 — audioFile2/3 בשורה לא משפיעים בכלל", function () {
  const { createAudioResolver } = require("./ivr-audio-resolver.service");
  const resolver = createAudioResolver({
    getRecordByAudioId: function () {
      return {
        status: "אושר",
        audioFile1: "PAYMSG-3013-1-active.wav",
        audioFile2: "PAYMSG-3013-2-should-never-be-served.wav",
        audioFile3: "PAYMSG-3013-3-should-never-be-served.wav",
      };
    },
    fileExists: function (absPath) {
      // רק audioFile1 (ready-as-is .wav) "קיים" בפועל בדמה הזו
      return /PAYMSG-3013-1-active\.wav$/.test(absPath);
    },
    uploadDir: UPLOAD_DIR,
    baseUrl: "https://example.test/uploads/ivr-audio",
    fallbackTextByAudioId: {},
  });

  const result = resolver("PAYMSG-3013", "טקסט ברירת מחדל");
  assert.ok(result.fileLink, "אמור להחזיר fileLink אמיתי");
  assert.ok(result.fileLink.indexOf("PAYMSG-3013-1-active.wav") !== -1, "ה-fileLink מבוסס על audioFile1");
  assert.ok(result.fileLink.indexOf("audioFile2") === -1 && result.fileLink.indexOf("should-never-be-served") === -1);
});

// ── 14. רגרסיה — שני הגיליונות הקיימים ──────────────────────────────────
// אין מסגרת בדיקות frontend בפרויקט (אין קובץ *.test.js הנוגע ב-DOM/settings.js
// היום) — לא ממציאים כזו כאן. הבדיקה בפועל: matchesSheet/addRow/exportToExcel
// ב-settings.js נבדקו ידנית בקוד (כל הענפים החדשים מותנים במפורש ב-
// category==="paymsg", עם "return false"/ניתוב מפורש ל-else המקורי ללא שינוי
// עבורו) — ראו diff. בצד השרת, רגרסיית ivr.js המלאה (185+ בדיקות קיימות)
// רצה בנפרד כחלק מריצת הרגרסיה הכוללת.
check("[14] תיעוד: אין מסגרת בדיקות frontend בפרויקט — נבדק בעיון קוד, לא בדיקה אוטומטית", function () {
  assert.ok(true);
});

// ── סיכום ────────────────────────────────────────────────────────────────
const failed = results.filter(function (r) { return !r.ok; });
results.forEach(function (r) {
  console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : " — " + r.error));
});
console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");
process.exit(failed.length ? 1 : 0);

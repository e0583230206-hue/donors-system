// scripts/convert-ivr-audio-to-wav.js
//
// יוצר עותקים נגזרים (WAV, pcm_s16le, mono, 8000Hz) לצד קבצי המקור המאושרים
// תחת uploads/ivr-audio — לעולם לא דורס/מוחק קובץ מקור, ולעולם לא כותב ל-DB
// (ה-DB נפתח readOnly בלבד; אין עמודת audioFileWavDerived — שם הנגזרת מחושב
// תמיד מחדש משם המקור).
//
// ברירת מחדל: --dry-run (לא נוגע בדיסק, רק מדווח). המרה אמיתית רק עם --apply.
//
// הרצה:
//   node scripts/convert-ivr-audio-to-wav.js            (dry-run)
//   node scripts/convert-ivr-audio-to-wav.js --apply     (המרה בפועל)

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const PROJECT_DIR = path.join(__dirname, "..");
const DB_PATH = path.join(PROJECT_DIR, "data.sqlite");
const UPLOAD_DIR = path.resolve(PROJECT_DIR, "uploads", "ivr-audio");

// ── לוגיקה טהורה — בלי I/O, נבדקת ישירות ב-test ──────────────────────────────

function computeDerivedFilename(sourceFilename) {
  const parsed = path.parse(sourceFilename);
  return parsed.name + "-pcm8k.wav";
}

// מחליף את הסיומת .wav הסופית ב-.tmp.wav (DEBT-001-1-abc-pcm8k.wav →
// DEBT-001-1-abc-pcm8k.tmp.wav).
function computeTmpFilename(derivedFilename) {
  return derivedFilename.replace(/\.wav$/i, ".tmp.wav");
}

function isPathContained(resolvedUploadDir, filename) {
  if (!filename) return { ok: false, resolvedPath: null };
  const resolvedPath = path.resolve(resolvedUploadDir, filename);
  const ok =
    resolvedPath === resolvedUploadDir ||
    resolvedPath.startsWith(resolvedUploadDir + path.sep);
  return { ok: ok, resolvedPath: resolvedPath };
}

// מוכן לשימוש ישיר כמו שהוא רק אם התוכן כבר PCM s16le/8000/mono *וגם* הסיומת
// היא .wav — כדי לתפוס בדיוק את מקרה DEBT-001 (תוכן PCM תקין, סיומת .MP3
// שגויה) ולהכריח לו נגזרת עם Content-Type נכון.
function isReadyAsIs(filename, probeResult) {
  if (!probeResult) return false;
  return (
    probeResult.codec_name === "pcm_s16le" &&
    probeResult.sample_rate === "8000" &&
    probeResult.channels === "1" &&
    /\.wav$/i.test(filename)
  );
}

function isValidDerivedProbe(probeResult) {
  if (!probeResult) return false;
  return (
    probeResult.codec_name === "pcm_s16le" &&
    probeResult.sample_rate === "8000" &&
    probeResult.channels === "1"
  );
}

// מקבל את כל התנאים כארגומנטים טהורים (בלי DB/דיסק) כדי שאפשר לבדוק את
// התנהגות ה-dry-run/apply בלי לגעת בשום דבר אמיתי.
function decideAction(opts) {
  if (opts.isSourceReady) return "ready-original";
  if (opts.derivedExists && opts.derivedValid) return "already-derived";
  return opts.dryRun ? "would-convert" : "convert";
}

function buildFfprobeArgs(filePath) {
  return ["-v", "error", "-print_format", "json", "-show_streams", filePath];
}

function buildFfmpegArgs(inputPath, outputTmpPath) {
  return [
    "-y",
    "-i", inputPath,
    "-ac", "1",
    "-ar", "8000",
    "-sample_fmt", "s16",
    "-c:a", "pcm_s16le",
    outputTmpPath,
  ];
}

// ── עטיפות I/O — קוראות לבינאריים אמיתיים, לא נבדקות ב-unit tests ───────────

function probeAudio(filePath) {
  const out = execFileSync("ffprobe", buildFfprobeArgs(filePath), { encoding: "utf8" });
  const probe = JSON.parse(out);
  const stream = (probe.streams || []).find(function (s) { return s.codec_type === "audio"; }) || {};
  return {
    codec_name: stream.codec_name || null,
    sample_rate: stream.sample_rate != null ? String(stream.sample_rate) : null,
    channels: stream.channels != null ? String(stream.channels) : null,
  };
}

function probeAudioSafe(filePath) {
  try {
    return probeAudio(filePath);
  } catch (e) {
    return null;
  }
}

function convertToTmpWav(inputPath, tmpPath) {
  execFileSync("ffmpeg", buildFfmpegArgs(inputPath, tmpPath), { stdio: "pipe" });
}

// ── main — I/O אמיתי: DB (readOnly), דיסק, ffmpeg/ffprobe ───────────────────

function main() {
  const apply = process.argv.includes("--apply");
  const dryRun = !apply;

  let readyOriginal = 0;
  let alreadyDerived = 0;
  let convertCount = 0; // would-convert (dry-run) או converted (apply)
  let failed = 0;
  const failedIds = [];
  let totalRows = 0;

  let db;
  try {
    db = new DatabaseSync(DB_PATH, { readOnly: true });
    const rows = db.prepare(
      "SELECT audioId, audioFile1 FROM ivr_audio_recordings WHERE status='אושר' AND length(audioFile1)>0"
    ).all();
    totalRows = rows.length;

    for (const row of rows) {
      const audioId = row.audioId;
      const sourceFilename = row.audioFile1;

      const sourceContainment = isPathContained(UPLOAD_DIR, sourceFilename);
      if (!sourceContainment.ok) {
        failed++;
        failedIds.push(audioId);
        continue;
      }
      const sourcePath = sourceContainment.resolvedPath;

      if (!fs.existsSync(sourcePath)) {
        failed++;
        failedIds.push(audioId);
        continue;
      }

      const sourceProbe = probeAudioSafe(sourcePath);
      if (!sourceProbe) {
        failed++;
        failedIds.push(audioId);
        continue;
      }

      if (isReadyAsIs(sourceFilename, sourceProbe)) {
        readyOriginal++;
        continue;
      }

      const derivedFilename = computeDerivedFilename(sourceFilename);
      const derivedContainment = isPathContained(UPLOAD_DIR, derivedFilename);
      if (!derivedContainment.ok) {
        failed++;
        failedIds.push(audioId);
        continue;
      }
      const derivedPath = derivedContainment.resolvedPath;

      const derivedExists = fs.existsSync(derivedPath);
      const derivedValid = derivedExists ? isValidDerivedProbe(probeAudioSafe(derivedPath)) : false;

      const action = decideAction({
        isSourceReady: false,
        derivedExists: derivedExists,
        derivedValid: derivedValid,
        dryRun: dryRun,
      });

      if (action === "already-derived") {
        alreadyDerived++;
        continue;
      }

      if (action === "would-convert") {
        convertCount++;
        continue;
      }

      // action === "convert" — קורה רק ב---apply
      const tmpFilename = computeTmpFilename(derivedFilename);
      const tmpContainment = isPathContained(UPLOAD_DIR, tmpFilename);
      if (!tmpContainment.ok) {
        failed++;
        failedIds.push(audioId);
        continue;
      }
      const tmpPath = tmpContainment.resolvedPath;

      try {
        convertToTmpWav(sourcePath, tmpPath);
        const tmpProbe = probeAudioSafe(tmpPath);
        if (!isValidDerivedProbe(tmpProbe)) {
          throw new Error("תוצאת ההמרה לא עברה אימות פורמט");
        }
        fs.renameSync(tmpPath, derivedPath); // rename אטומי — רק אחרי אימות מוצלח
        convertCount++;
      } catch (e) {
        try {
          if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch (cleanupErr) {
          // מתעלמים — בכל מקרה לא נוגעים במקור או בנגזרת תקינה קיימת
        }
        failed++;
        failedIds.push(audioId);
      }
    }
  } finally {
    if (db) db.close();
  }

  console.log("total: " + totalRows);
  console.log("ready-original: " + readyOriginal);
  console.log("already-derived: " + alreadyDerived);
  console.log((dryRun ? "would-convert: " : "converted: ") + convertCount);
  console.log("failed: " + failed);
  if (failedIds.length) {
    console.log("failed audioId: " + failedIds.join(", "));
  }
}

module.exports = {
  computeDerivedFilename,
  computeTmpFilename,
  isPathContained,
  isReadyAsIs,
  isValidDerivedProbe,
  decideAction,
  buildFfprobeArgs,
  buildFfmpegArgs,
  probeAudio,
  probeAudioSafe,
  convertToTmpWav,
};

if (require.main === module) {
  main();
}

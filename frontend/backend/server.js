require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const express     = require("express");
const path        = require("path");
const helmet      = require("helmet");
const cors        = require("cors");
const rateLimit   = require("express-rate-limit");
const multer      = require("multer");

const fs     = require("fs");
const crypto = require("crypto");
const logger = require("./logger");

const {
  DB_PATH,
  defaultPasswordForRole,
  getWorkers,
  findWorkerById,
  createWorkerInDb,
  deleteWorkerById,
  updateWorkerPasswordHash,
  clearMustChangePassword,
  upsertDonor,
  upsertPhoneLookup,
  getIvrDonations,
  getCallSessions,
  getCallLogsByCallId,
  insertCallLog,
  logClick2Call,
  getClick2CallLogs,
  getRecentClick2CallLogs,
  getDashboardStats,
  getIvrMonitorStats,
  getIvrAlerts,
  getAppState,
  setAppState,
  getAppStateUpdatedAt,
  backupDatabase,
  restoreFromBackup,
  dbHealthCheck,
  getPayments,
  getPaymentById,
  getPaymentStats,
  markDonationPaidManually,
  cancelManualDonationPayment,
  recordManualPartialPayment,
  insertAuditLog,
  getAuditLogs,
  insertSyncLog,
  getSyncLogs,
  insertAlfonPending,
  getAlfonPending,
  getAlfonPendingById,
  updateAlfonPendingStatus,
  normalizePhoneForDb,
  createWorkerSession,
  heartbeatSession,
  closeWorkerSession,
  getSessionBySessionId,
  forceLogoutSession,
  getLastActionsByWorker,
  getAuditLogsByWorker,
  countAuditLogsByWorker,
  getActiveSessions,
  getSessionHistory,
  PREGREETING_AUDIO_ID,
  setPregreetingEnabled,
  setPregreetingSchedule,
  resetPregreetingFileState,
  listIvrVoiceMessages,
  getIvrVoiceMessageById,
  updateIvrVoiceMessageStatus,
  IVR_VOICE_MESSAGE_STATUSES,
  upsertSoftphoneCall,
  getSoftphoneCalls,
  getSoftphoneCallById,
  deleteSoftphoneCall,
  getSoftphoneContacts,
  createSoftphoneContact,
  updateSoftphoneContact,
  deleteSoftphoneContact,
  findSoftphoneContactByAnyPhone,
} = require("./db");

const { parseCsv, buildPreview, applySync, normPhone } = require("./sync.service");
const CITY_MAP = require("./city_map");
const { queryAI } = require("./ai");
const { recordAiQuery } = require("./ai/audit");
const aiCapabilities    = require("./ai/capabilities");
const { searchDonors }  = require("./ai/search");
const aiActions         = require("./ai/actions");
require("./ai/actions/lowrisk");  // self-registers Phase F low-risk actions
require("./ai/actions/highrisk"); // self-registers Phase G actions, disabled by default

const {
  ROLES,
  loginWorker,
  renewToken,
  hashPassword,
  comparePassword,
  requireAuth,
  requireRole,
} = require("./auth.service");

const { handleIvrQuery, ivrErrorResponse } = require("./ivr.service");
const { getDonorForIvr, normalizePhone, normalizeIdNumber, allAppDonors, getAllDonorPhones } = require("./donor.service");
const callClassifier = require("../js/softphone-call-classifier.js");

// Isolated Technoline fileLink/fileName trial (OPEN-001 experiment) — see
// ivr-audio-trial.route.js header. Deliberately does NOT touch ivr.js,
// ivr.service.js, donor.service.js, or any DB/donor/payment code path.
const { trialHandler: ivrAudioTrialHandler } = require("./ivr-audio-trial.route");

// settings.html "ניהול הקלטות" tab — staging/management tool only. Does NOT
// touch ivr.js / ivr.service.js / Technoline; see ivr-audio.service.js header.
const {
  isValidStatus:            isValidIvrAudioStatus,
  isValidSlot:              isValidIvrAudioSlot,
  sanitizeAudioIdForFilename,
  runStartupMigration:      runIvrAudioStartupMigration,
  importRows:               importIvrAudioRows,
  getIvrAudioRecordings,
  getIvrAudioRecordingById,
  createIvrAudioRecording,
  updateIvrAudioRecording,
  setIvrAudioRecordingSlots,
} = require("./ivr-audio.service");

// PAYMSG (S3000-S3023 Technoline systemMessages) 3-slot lifecycle — admin
// UI only in this step. See docs/ivr-audio/ivr-audio-paymsg-v1.0-DRAFT.md §9.
const { createPaymsgLifecycle } = require("./ivr-audio-paymsg-lifecycle.service");
const { createIvrAudioSlotRoutes } = require("./ivr-audio-paymsg.routes");
const paymsgLock = require("./ivr-audio-paymsg-lock.service");
const {
  isPathContained:      convIsPathContained,
  computeDerivedFilename: convComputeDerivedFilename,
  computeTmpFilename:   convComputeTmpFilename,
  isReadyAsIs:          convIsReadyAsIs,
  isValidDerivedProbe:  convIsValidDerivedProbe,
  probeAudioSafe:       convProbeAudioSafe,
  convertToTmpWav:      convConvertToTmpWav,
} = require("./scripts/convert-ivr-audio-to-wav");
const { mirrorLogEntriesToAuditLog } = require("./data-audit-mirror.service");

// Temporary pre-greeting IVR message (plays once before OPEN-001) — reuses
// the exact same upload/lock/lifecycle machinery wired above; only the
// enabled/schedule gate and its 5 admin routes are new. See
// ivr-pregreeting.service.js.
const {
  isPregreetingActiveNow,
  isValidScheduleValue,
  nowInJerusalem,
} = require("./ivr-pregreeting.service");

const PORT         = Number(process.env.PORT || 3000);
const IVR_KEY      = process.env.IVR_KEY || "";
const FRONTEND_DIR = path.join(__dirname, "..");

// settings.html "ניהול הקלטות" — uploaded audio files live here, served
// statically below. Separate from FRONTEND_DIR; not part of the donor UI.
const IVR_AUDIO_UPLOADS_DIR = path.join(__dirname, "uploads", "ivr-audio");
if (!fs.existsSync(IVR_AUDIO_UPLOADS_DIR)) fs.mkdirSync(IVR_AUDIO_UPLOADS_DIR, { recursive: true });

// PAYMSG 3-slot lifecycle (audioFile1=active, audioFile2=previous,
// audioFile3=pending) — see docs/ivr-audio/ivr-audio-paymsg-v1.0-DRAFT.md §9.12.
// Real fs/ffmpeg wiring here; the module itself is fully dependency-injected
// and has no idea any of this is Express/SQLite/ffmpeg.
const paymsgLifecycle = createPaymsgLifecycle({
  getRecordByAudioId:    getIvrAudioRecordingById,
  setSlots:              setIvrAudioRecordingSlots,
  uploadDir:             IVR_AUDIO_UPLOADS_DIR,
  isPathContained:       convIsPathContained,
  computeDerivedFilename: convComputeDerivedFilename,
  computeTmpFilename:    convComputeTmpFilename,
  fileExists:            fs.existsSync,
  probeAudioSafe:        convProbeAudioSafe,
  isValidDerivedProbe:   convIsValidDerivedProbe,
  isReadyAsIs:           convIsReadyAsIs,
  convertToTmpWav:       convConvertToTmpWav,
  rename:                fs.renameSync,
  unlink:                fs.unlinkSync,
  log:                   console.warn,
});

// Runs at most once per DB (idempotent — see db.js ensureIvrAudioRecordingsUpToDate
// for the exact rules). Logged in full so the migration report is visible in
// server logs even without a dedicated UI for it.
var ivrAudioMigrationReport = runIvrAudioStartupMigration();
console.log("[IVR-Audio] startup migration report:", JSON.stringify(ivrAudioMigrationReport));

if (!IVR_KEY && process.env.NODE_ENV === "production") {
  console.error("FATAL: IVR_KEY is not set. The server will not start without it in production.");
  process.exit(1);
}

const app = express();

app.set("trust proxy", 1);

// ── Security headers ─────────────────────────────────────────────────────────
app.use(
  helmet({
    // A real (non-false) CSP. The frontend still relies on inline <script>
    // blocks/onclick handlers and inline style="" across ~20 legacy pages
    // (no nonces), so script-src/style-src keep 'unsafe-inline' rather than
    // breaking every page — a full nonce-based rewrite is a separate,
    // larger effort. What this DOES lock down: no plugins (object-src),
    // no framing by other sites (frame-ancestors), no unexpected <base>
    // hijack (base-uri), and no resource loading from arbitrary origins
    // except the specific external hosts the app actually uses today
    // (Google Fonts on softphone.html, the jsDelivr CDN fallback for
    // jssip/jquery, and the SIP server's own wss:// endpoint, which is
    // admin-configurable and not known in advance).
    contentSecurityPolicy: {
      directives: {
        defaultSrc:     ["'self'"],
        scriptSrc:      ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
        // helmet defaults script-src-attr to 'none' regardless of script-src
        // — would silently block every onclick="..." attribute in the app
        // (confirmed present, e.g. ivr-monitor.html) if left unset here.
        scriptSrcAttr:  ["'unsafe-inline'"],
        styleSrc:       ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc:        ["'self'", "https://fonts.gstatic.com", "data:"],
        imgSrc:         ["'self'", "data:"],
        connectSrc:     ["'self'", "wss:", "https:"],
        objectSrc:      ["'none'"],
        baseUri:        ["'self'"],
        frameAncestors: ["'self'"],
        formAction:     ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

// ── CORS — same-origin only (frontend served by this server) ─────────────────
app.use(
  cors({
    origin: false,
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ── Body parsing ─────────────────────────────────────────────────────────────
// Per-route limits instead of one blanket 5mb for every endpoint (#34).
// A path-scoped express.json() that successfully parses a body sets an
// internal req._body flag — a later express.json() covering the same
// request (the general default below) sees that flag and skips re-parsing,
// so registering the larger-limit bulk-import parsers first and a smaller
// default afterward is safe and doesn't double-parse (verified empirically
// against this Express/body-parser version before relying on it here).
//
// Bulk data import — donors/tasks/logs/settings/approvals blobs and CSV
// donor-list imports can legitimately be a few MB; unchanged from before.
app.use("/api/data", express.json({ limit: "5mb" }));
app.use("/api/sync/preview", express.json({ limit: "5mb" }));
app.use("/api/sync/apply", express.json({ limit: "5mb" }));
// Everything else — regular API calls (login, worker/task/reminder CRUD,
// campaign triggers, sip-config, etc.) never legitimately need more than a
// few KB; 256kb leaves generous headroom without leaving every endpoint as
// open to a multi-MB request body as the bulk-import routes above.
app.use(express.json({ limit: "256kb" }));

// ── Request logging ───────────────────────────────────────────────────────────
app.use(function (req, res, next) {
  const ts = new Date().toISOString();
  res.on("finish", function () {
    if (req.path !== "/health") {
      console.log("[" + ts + "] " + req.method + " " + req.path + " → " + res.statusCode);
    }
  });
  next();
});

// ── Static frontend ───────────────────────────────────────────────────────────
// Our own JS/CSS: no-cache — changes on every deploy, must always be fresh.
// Vendor libs (/lib): ETag caching — large, never change between deploys.
// HTML: no-cache — already handled below.
const _noCacheHeaders = function (res) {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
};

app.use("/js",  express.static(path.join(FRONTEND_DIR, "js"),  { setHeaders: _noCacheHeaders }));
app.use("/css", express.static(path.join(FRONTEND_DIR, "css"), { setHeaders: _noCacheHeaders }));

// FRONTEND_DIR is the parent of this very folder (frontend/), so the blanket
// express.static below would otherwise also serve frontend/backend/* itself —
// source code, data.sqlite, .env, backups. Block it before the static handler
// ever sees a /backend request. (Legitimate public assets — /js, /css, /lib,
// /uploads/ivr-audio — are all mounted on their own explicit routes and are
// unaffected by this.)
app.use("/backend", function (req, res) {
  res.status(404).json({ error: "Not found" });
});

app.use(express.static(FRONTEND_DIR, {
  setHeaders(res, filePath) {
    if (filePath.endsWith(".html")) {
      _noCacheHeaders(res);
    }
  }
}));

// Explicit route for /lib so client-side libraries are always reachable
app.use("/lib", express.static(path.join(__dirname, "..", "lib")));

// Uploaded IVR-audio files (settings.html "ניהול הקלטות" tab) — static GET,
// no auth (same trust level as images/logo.png); management endpoints below
// that create/modify rows are admin-only.
app.use("/uploads/ivr-audio", express.static(IVR_AUDIO_UPLOADS_DIR));

// ── Rate limiters ─────────────────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "יותר מדי ניסיונות כניסה. נסה שוב עוד 15 דקות." },
});

const ivrLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Rate limit exceeded" },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests" },
});

const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "יותר מדי ניסיונות שינוי סיסמה. נסה שוב עוד 15 דקות." },
});

// ── IVR key middleware ────────────────────────────────────────────────────────

function maskSecret(value) {
  if (!value) return "<empty>";
  var s = String(value);
  if (s.length <= 12) return s[0] + "***" + s[s.length - 1];
  return s.slice(0, 6) + "..." + s.slice(-6);
}

// Timing-safe string equality — prevents timing-based key oracle attacks
function timingSafeEq(a, b) {
  try {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch (_) {
    return false;
  }
}

const IVR_LOG_SENSITIVE_KEYS = ["ivrKey", "PBXphone", "selfIdentInput", "beneficiaryIdentInput", "amount", "CONFIRM_payment"];

// Every IVR request/rejection used to be logged with the full raw query
// string (phones, ivrKey, amounts, confirmation numbers) — this redacts the
// sensitive fields before anything reaches server logs / PM2 logs, since
// nginx's `access_log off` for /ivr only protects the nginx log, not this one.
// Unconditional — previously skipped whenever NODE_ENV wasn't exactly
// "production" or IVR_DEBUG=true was set, which is exactly the situation a
// live debugging session runs under, so the one time this mattered most it
// didn't apply. Diagnostic fields (callId, step names, param keys) were
// never in IVR_LOG_SENSITIVE_KEYS and still print in full everywhere else in
// this file — only actual PII/secrets are ever withheld here.
function sanitizeIvrQueryForLog(query) {
  var out = {};
  Object.keys(query || {}).forEach(function (key) {
    out[key] = IVR_LOG_SENSITIVE_KEYS.indexOf(key) !== -1 ? "[REDACTED]" : query[key];
  });
  return out;
}

function requireIvrKey(req, res, next) {
  if (!IVR_KEY) {
    // Fail closed: an unset IVR_KEY must never mean "let everyone through".
    // The startup check above only guarantees IVR_KEY when NODE_ENV is
    // exactly "production" — any other/misconfigured NODE_ENV value used to
    // fall through here and accept every request unauthenticated.
    if (process.env.ALLOW_INSECURE_IVR === "true") {
      console.warn("[IVR] IVR_KEY not configured — ALLOW_INSECURE_IVR=true, allowing unrestricted access. Never use this outside local testing.");
      return next();
    }
    console.error("[IVR] IVR_KEY not configured — rejecting all IVR requests. Set IVR_KEY in .env (or ALLOW_INSECURE_IVR=true for local testing only).");
    return res.status(503).json({ error: "IVR not configured" });
  }
  // Technoline sends the key as a query param (ivrKey=...).
  // Also accept it from the x-ivr-key header for direct API calls.
  const provided = req.headers["x-ivr-key"] || req.query.ivrKey || "";
  if (!timingSafeEq(provided, IVR_KEY)) {
    console.warn("[IVR] Rejected request with invalid IVR key", {
      hasHeader:   !!req.headers["x-ivr-key"],
      hasQueryKey: !!req.query.ivrKey,
      provided:    maskSecret(provided),
      expected:    maskSecret(IVR_KEY),
      path:        req.path,
      query:       sanitizeIvrQueryForLog(req.query),
    });
    return res.status(403).json({ error: "Invalid IVR key" });
  }
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

app.get("/health", function (req, res) {
  var db = dbHealthCheck();
  if (!db.ok) {
    return res.status(500).json({ ok: false, database: "error", error: db.error });
  }
  res.json({ ok: true, database: "connected", ts: new Date().toISOString() });
});

app.get("/", function (req, res) {
  res.sendFile(path.join(FRONTEND_DIR, "index.html"));
});

// ── Auth ──────────────────────────────────────────────────────────────────────

app.post("/api/login", loginLimiter, async function (req, res, next) {
  try {
    const { workerId, password } = req.body || {};

    if (!workerId || !password) {
      return res.status(400).json({ error: "workerId and password are required" });
    }

    const result = await loginWorker(Number(workerId), String(password));

    if (!result) {
      try { insertAuditLog({ action: "login_failed", entityType: "worker", entityId: String(workerId), details: "כניסה נכשלה", ip: req.ip }); } catch (_) {}
      return res.status(401).json({ error: "Invalid credentials" });
    }

    try { insertAuditLog({ action: "login", entityType: "worker", entityId: String(result.user.id), entityName: result.user.name, details: "כניסה למערכת", workerId: result.user.id, workerName: result.user.name, ip: req.ip }); } catch (_) {}
    var sessionId = null;
    try { sessionId = createWorkerSession(result.user.id, result.user.name, req.ip, req.headers["user-agent"]); } catch (_) {}
    res.json(Object.assign({}, result, { sessionId }));
  } catch (err) {
    next(err);
  }
});

app.post("/api/logout", requireAuth, function (req, res, next) {
  try {
    var sessionId = (req.body || {}).sessionId;
    if (sessionId) closeWorkerSession(String(sessionId), "logout");
    try { insertAuditLog({ action: "logout", entityType: "worker", entityId: String(req.user.id), entityName: req.user.name, details: "יציאה מהמערכת", workerId: req.user.id, workerName: req.user.name, ip: req.ip }); } catch (_) {}
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post("/api/sessions/heartbeat", requireAuth, function (req, res, next) {
  try {
    var sessionId = (req.body || {}).sessionId;
    if (sessionId) heartbeatSession(String(sessionId));
    // An admin may have force-logged-out this session from the sessions screen —
    // tell the client so it can redirect to login instead of silently drifting.
    var session = sessionId ? getSessionBySessionId(String(sessionId)) : null;
    if (session && session.status === "forced_logout") {
      return res.json({ ok: true, forceLogout: true });
    }
    // Silent renewal — every successful heartbeat re-signs the JWT with a
    // fresh JWT_TTL_DAYS window, so a session that keeps heartbeating (any
    // tab open at least once within that window) never actually hits its
    // token expiry. requireAuth already re-validated the worker still exists
    // and is active, so req.user is safe to re-sign as-is.
    var freshToken = renewToken(req.user);
    res.json({ ok: true, token: freshToken });
  } catch (err) {
    next(err);
  }
});

app.get("/api/admin/sessions", requireRole([ROLES.ADMIN]), function (req, res, next) {
  try {
    var active      = getActiveSessions();
    var history     = getSessionHistory(200);
    var lastActions = getLastActionsByWorker();
    active.forEach(function (s)  { s.lastAction = lastActions[s.workerId] || null; });
    history.forEach(function (s) { s.lastAction = lastActions[s.workerId] || null; });
    res.json({ active: active, history: history });
  } catch (err) {
    next(err);
  }
});

// Admin-only remote disconnect of another worker's live session.
app.post("/api/admin/sessions/:sessionId/force-logout", apiLimiter, requireRole([ROLES.ADMIN]), function (req, res, next) {
  try {
    var sessionId = String(req.params.sessionId || "").trim();
    if (!sessionId) return res.status(400).json({ error: "sessionId חסר" });

    var session = getSessionBySessionId(sessionId);
    if (!session) return res.status(404).json({ error: "session לא נמצא" });
    if (session.status !== "active") return res.status(400).json({ error: "המשתמש כבר אינו מחובר" });
    if (Number(session.workerId) === Number(req.user.id)) {
      return res.status(400).json({ error: "לא ניתן לנתק את המשתמש המחובר של עצמך" });
    }

    var closed = forceLogoutSession(sessionId);
    if (!closed) return res.status(409).json({ error: "המשתמש כבר אינו מחובר" });

    try {
      insertAuditLog({
        action:     "force_logout",
        entityType: "worker",
        entityId:   session.workerId,
        entityName: session.workerName,
        details:    "המשתמש " + req.user.name + " ניתק מרחוק את " + session.workerName,
        workerId:   req.user.id,
        workerName: req.user.name,
        ip:         req.ip,
      });
    } catch (_) {}

    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Admin-only — last N audit-log entries for one worker (the "פעילות אחרונה" modal).
app.get("/api/admin/workers/:workerId/audit-log", requireRole([ROLES.ADMIN]), function (req, res, next) {
  try {
    var workerId = Number(req.params.workerId);
    if (!workerId) return res.status(400).json({ error: "workerId לא תקין" });
    var limit = Math.min(Number(req.query.limit) || 10, 50);
    res.json({
      logs:  getAuditLogsByWorker(workerId, limit),
      total: countAuditLogsByWorker(workerId),
    });
  } catch (err) {
    next(err);
  }
});

// ── IVR Audio Recordings — settings.html "ניהול הקלטות" tab ──────────────────
// Staging/management tool for the future Yiddish IVR recordings. Admin-only.
// Does NOT call Technoline and does NOT touch ivr.js / ivr.service.js.
app.use("/api/admin/ivr-audio", apiLimiter, requireRole([ROLES.ADMIN]));

app.get("/api/admin/ivr-audio", function (req, res, next) {
  try {
    res.json(getIvrAudioRecordings());
  } catch (err) {
    next(err);
  }
});

// Read-only — lets an admin confirm what the last startup migration actually
// did without needing server-log/SSH access.
app.get("/api/admin/ivr-audio/migration-report", function (req, res) {
  res.json(ivrAudioMigrationReport || { mode: "unknown" });
});

// Import rows parsed client-side from הקלטות_א_בלאט_גמרא_מעוצב.xlsx (both
// sheets, combined) — safe merge only, see ivr-audio.service.js importRows().
app.post("/api/admin/ivr-audio/import", function (req, res, next) {
  try {
    var rows = (req.body && req.body.rows) || [];
    if (!Array.isArray(rows)) return res.status(400).json({ error: "rows חייב להיות מערך" });

    var result = importIvrAudioRows(rows);

    try {
      insertAuditLog({
        action: "ivr_audio_import", entityType: "ivr_audio_recording", entityId: null, entityName: null,
        details: "ייבוא מאקסל: " + result.inserted + " חדשים, " + result.merged + " עודכנו, " + result.skipped + " דולגו",
        workerId: req.user.id, workerName: req.user.name, ip: req.ip,
      });
    } catch (_) {}

    res.json(Object.assign({ ok: true }, result));
  } catch (err) {
    next(err);
  }
});

app.post("/api/admin/ivr-audio", function (req, res, next) {
  try {
    var audioId = String((req.body && req.body.audioId) || "").trim();
    if (!audioId) return res.status(400).json({ error: "audioId הוא שדה חובה" });

    var created = createIvrAudioRecording(audioId);
    if (!created) return res.status(409).json({ error: "מזהה זה כבר קיים" });

    try {
      insertAuditLog({
        action: "ivr_audio_create", entityType: "ivr_audio_recording", entityId: audioId, entityName: audioId,
        details: "נוספה שורת הקלטה חדשה: " + audioId,
        workerId: req.user.id, workerName: req.user.name, ip: req.ip,
      });
    } catch (_) {}

    res.json({ ok: true, recording: created });
  } catch (err) {
    next(err);
  }
});

var ivrAudioUpload = multer({
  storage: multer.diskStorage({
    destination: function (req, file, cb) { cb(null, IVR_AUDIO_UPLOADS_DIR); },
    filename: function (req, file, cb) {
      var ext = path.extname(file.originalname) || ".mp3";
      // Random suffix so filenames aren't guessable from the (public,
      // human-readable) audioId — this endpoint is served by express.static
      // with no auth (native <audio> playback in settings.js can't send a
      // Bearer token), so unguessable names are the access control here.
      var rand = crypto.randomBytes(8).toString("hex");
      cb(null, sanitizeAudioIdForFilename(req.params.id) + "-" + req.params.slot + "-" + rand + ext);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: function (req, file, cb) {
    var ok = /^audio\//.test(file.mimetype) || /\.(mp3|wav|m4a|ogg|aac|flac)$/i.test(file.originalname);
    cb(ok ? null : new Error("סוג קובץ לא נתמך — יש להעלות קובץ שמע"), ok);
  },
}).single("audio");

// ── Pregreeting — temporary pre-opening IVR message ─────────────────────────
// All 5 routes below sit under the same "/api/admin/ivr-audio" prefix as
// everything else in this section, so they're already covered by the
// apiLimiter + requireRole([ROLES.ADMIN]) applied once at the top of this
// section (line ~524) — no separate auth wiring needed. None of their path
// shapes ("pregreeting", "pregreeting/upload", "pregreeting/enabled",
// "pregreeting/schedule") can ever collide with the generic ":id"-based
// slot routes mounted right after this block.
//
// Reuses the exact same multer instance, format-conversion
// (paymsgLifecycle.convertUploadedFile), atomic slot-write
// (commitStagedUpload/approvePending) and per-audioId lock (paymsgLock) as
// every other recording's upload — see ivr-audio-paymsg-lifecycle.service.js.
// The only difference from a normal recording: upload auto-approves in the
// same request (no separate "אשר" step — this is a simple on/off temporary
// message, not a reviewed catalog sentence), and DELETE clears the active
// slot too (a normal recording's DELETE never touches slot 1/2 — see
// ivr-audio-paymsg.routes.js — but here "delete" means "remove the whole
// temporary message", which by definition includes whatever's currently
// active).

// Best-effort delete of `filename` + its derived (-pcm8k.wav) counterpart —
// mirrors ivr-audio-paymsg-lifecycle.service.js's internal safeUnlink, which
// isn't exported (private to that module's closure). Never throws.
function safeUnlinkPregreetingFile(filename) {
  if (!filename) return;
  [filename, convComputeDerivedFilename(filename)].forEach(function (name) {
    var containment = convIsPathContained(IVR_AUDIO_UPLOADS_DIR, name);
    if (!containment.ok) return;
    try {
      if (fs.existsSync(containment.resolvedPath)) fs.unlinkSync(containment.resolvedPath);
    } catch (e) {
      console.warn("[pregreeting] מחיקת קובץ ישן נכשלה, נדרש ניקוי ידני: " + containment.resolvedPath + " — " + e.message);
    }
  });
}

app.get("/api/admin/ivr-audio/pregreeting", function (req, res, next) {
  try {
    var row = getIvrAudioRecordingById(PREGREETING_AUDIO_ID);
    if (!row) return res.status(404).json({ error: "שורת ההודעה הזמנית לא נמצאה" });
    res.json({
      audioId: row.audioId,
      hasFile: !!row.audioFile1,
      fileUrl: row.audioFile1 ? "/uploads/ivr-audio/" + encodeURIComponent(row.audioFile1) : null,
      status: row.status,
      enabled: !!row.enabled,
      startAt: row.startAt || null,
      endAt: row.endAt || null,
      active: isPregreetingActiveNow(row),
      updatedAt: row.updatedAt,
      now: nowInJerusalem(),
    });
  } catch (err) {
    next(err);
  }
});

app.post("/api/admin/ivr-audio/pregreeting/upload", function (req, res, next) {
  // Reuses the shared ivrAudioUpload multer instance exactly as-is — it
  // derives the stored filename from req.params.id/req.params.slot, which
  // this route (unlike the generic :id/:slot ones) doesn't naturally have,
  // so they're set explicitly before handing off to the same middleware.
  req.params.id = PREGREETING_AUDIO_ID;
  req.params.slot = "3";

  if (!paymsgLock.tryLock(PREGREETING_AUDIO_ID)) {
    return res.status(409).json({ error: "פעולה אחרת כבר מתבצעת על ההודעה הזמנית, נסו שוב בעוד רגע" });
  }

  ivrAudioUpload(req, res, function (err) {
    try {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: "לא נשלח קובץ שמע" });

      var converted = paymsgLifecycle.convertUploadedFile(req.file.filename);
      if (!converted.ok) return res.status(422).json({ error: converted.error });

      var staged = paymsgLifecycle.commitStagedUpload(PREGREETING_AUDIO_ID, req.file.filename);
      if (!staged.ok) return res.status(staged.status || 400).json({ error: staged.error });

      // Auto-approve in the same request — a temporary message has no
      // separate editorial review step; upload IS the replace action. Does
      // NOT touch enabled/startAt/endAt — uploading/replacing the file never
      // changes whether it's turned on or its schedule (separate concerns,
      // separate routes below).
      var approved = paymsgLifecycle.approvePending(PREGREETING_AUDIO_ID);
      if (!approved.ok) return res.status(approved.status || 400).json({ error: approved.error });

      try {
        insertAuditLog({
          action: "ivr_pregreeting_upload", entityType: "ivr_audio_recording", entityId: PREGREETING_AUDIO_ID, entityName: PREGREETING_AUDIO_ID,
          details: "הועלה/הוחלף קובץ ההודעה הזמנית לפני הפתיח",
          workerId: req.user.id, workerName: req.user.name, ip: req.ip,
        });
      } catch (_) {}

      res.json({ ok: true, recording: approved.recording });
    } finally {
      paymsgLock.unlock(PREGREETING_AUDIO_ID);
    }
  });
});

app.delete("/api/admin/ivr-audio/pregreeting", function (req, res, next) {
  try {
    if (!paymsgLock.tryLock(PREGREETING_AUDIO_ID)) {
      return res.status(409).json({ error: "פעולה אחרת כבר מתבצעת על ההודעה הזמנית, נסו שוב בעוד רגע" });
    }
    try {
      // DB-first, disk-after — same ordering as every other delete in this
      // file: the row must stop pointing at the files BEFORE they're
      // unlinked, so a crash between the two steps never leaves a dangling
      // reference to a missing file.
      var result = resetPregreetingFileState();
      [result.before.audioFile1, result.before.audioFile2, result.before.audioFile3]
        .filter(Boolean)
        .forEach(safeUnlinkPregreetingFile);

      try {
        insertAuditLog({
          action: "ivr_pregreeting_delete", entityType: "ivr_audio_recording", entityId: PREGREETING_AUDIO_ID, entityName: PREGREETING_AUDIO_ID,
          details: "נמחקה ההודעה הזמנית לפני הפתיח (הפתיח הקבוע לא נפגע)",
          workerId: req.user.id, workerName: req.user.name, ip: req.ip,
        });
      } catch (_) {}

      res.json({ ok: true, recording: result.after });
    } finally {
      paymsgLock.unlock(PREGREETING_AUDIO_ID);
    }
  } catch (err) {
    next(err);
  }
});

app.put("/api/admin/ivr-audio/pregreeting/enabled", function (req, res, next) {
  try {
    var enabled = !!(req.body || {}).enabled;
    var row = getIvrAudioRecordingById(PREGREETING_AUDIO_ID);
    if (!row) return res.status(404).json({ error: "שורת ההודעה הזמנית לא נמצאה" });
    if (enabled && (!row.audioFile1 || row.status !== "אושר")) {
      return res.status(400).json({ error: "אין קובץ הודעה זמינה להפעלה — יש להעלות קובץ קודם" });
    }

    var updated = setPregreetingEnabled(enabled);

    try {
      insertAuditLog({
        action: "ivr_pregreeting_enable", entityType: "ivr_audio_recording", entityId: PREGREETING_AUDIO_ID, entityName: PREGREETING_AUDIO_ID,
        details: enabled ? "ההודעה הזמנית לפני הפתיח הופעלה" : "ההודעה הזמנית לפני הפתיח כובתה",
        workerId: req.user.id, workerName: req.user.name, ip: req.ip,
      });
    } catch (_) {}

    res.json({ ok: true, recording: updated, active: isPregreetingActiveNow(updated) });
  } catch (err) {
    next(err);
  }
});

app.put("/api/admin/ivr-audio/pregreeting/schedule", function (req, res, next) {
  try {
    var body = req.body || {};
    var startAt = body.startAt ? String(body.startAt).trim() : "";
    var endAt   = body.endAt   ? String(body.endAt).trim()   : "";

    if (!isValidScheduleValue(startAt) || !isValidScheduleValue(endAt)) {
      return res.status(400).json({ error: "תאריך/שעה לא תקינים — פורמט נדרש: YYYY-MM-DDTHH:mm" });
    }
    if (startAt && endAt && startAt >= endAt) {
      return res.status(400).json({ error: "מועד ההתחלה חייב להיות לפני מועד הסיום" });
    }

    var row = getIvrAudioRecordingById(PREGREETING_AUDIO_ID);
    if (!row) return res.status(404).json({ error: "שורת ההודעה הזמנית לא נמצאה" });

    var updated = setPregreetingSchedule(startAt || null, endAt || null);

    try {
      insertAuditLog({
        action: "ivr_pregreeting_schedule", entityType: "ivr_audio_recording", entityId: PREGREETING_AUDIO_ID, entityName: PREGREETING_AUDIO_ID,
        details: (startAt || endAt)
          ? "נקבע טווח הפעלה להודעה הזמנית: " + (startAt || "ללא התחלה") + " — " + (endAt || "ללא סיום")
          : "טווח ההפעלה של ההודעה הזמנית הוסר (חזרה להפעלה/כיבוי ידניים)",
        workerId: req.user.id, workerName: req.user.name, ip: req.ip,
      });
    } catch (_) {}

    res.json({ ok: true, recording: updated, active: isPregreetingActiveNow(updated) });
  } catch (err) {
    next(err);
  }
});

// PUT /:id (approve branch + plain field-update fallback), POST
// /:id/audio/:slot (stage a pending upload), DELETE /:id/audio/:slot
// (reject a pending upload), POST /:id/restore-previous (swap
// active<->previous) — applies to every category (see
// ivr-audio-paymsg.routes.js header). Extracted verbatim into
// ivr-audio-paymsg.routes.js so the exact same route code can be mounted
// with fake deps + hit with real HTTP requests in a test. See
// ivr-audio-paymsg.routes.test.js.
app.use("/api/admin/ivr-audio", createIvrAudioSlotRoutes({
  getIvrAudioRecordingById: getIvrAudioRecordingById,
  updateIvrAudioRecording: updateIvrAudioRecording,
  isValidStatus: isValidIvrAudioStatus,
  isValidSlot: isValidIvrAudioSlot,
  insertAuditLog: insertAuditLog,
  paymsgLock: paymsgLock,
  paymsgLifecycle: paymsgLifecycle,
  ivrAudioUpload: ivrAudioUpload,
}));

// ── Workers — protected CRUD ──────────────────────────────────────────────────
app.use("/api/workers", apiLimiter);

// Public list for login dropdown — active workers only, minimal fields
app.get("/api/workers/list", function (req, res) {
  const workers = getWorkers()
    .filter(function (w) { return w.status === "פעיל"; })
    .map(function (w) { return { id: w.id, name: w.name }; });
  res.json(workers);
});

app.get("/api/workers", requireRole([ROLES.ADMIN, ROLES.SECRETARY]), function (req, res) {
  const workers = getWorkers().map(function (w) {
    return { id: w.id, name: w.name, role: w.role, status: w.status, createdAt: w.createdAt, updatedAt: w.updatedAt };
  });
  res.json(workers);
});

app.post("/api/workers", requireRole([ROLES.ADMIN]), async function (req, res, next) {
  try {
    const { name, role, status, password } = req.body || {};

    if (!name || !role) {
      return res.status(400).json({ error: "name and role are required" });
    }

    const workerName = String(name).trim();
    const allWorkers = getWorkers();

    if (allWorkers.some(function (w) { return w.name === workerName; })) {
      return res.status(409).json({ error: "Worker with this name already exists" });
    }

    const defaultPass = defaultPasswordForRole(role);
    const passToHash  = password ? String(password) : defaultPass;
    const passwordHash = await hashPassword(passToHash);

    const id = createWorkerInDb(
      workerName,
      String(role).trim(),
      status ? String(status).trim() : "פעיל",
      passwordHash
    );

    try { insertAuditLog({ action: "worker_create", entityType: "worker", entityId: String(id), entityName: workerName, details: "תפקיד: " + role, workerId: req.user && req.user.id, workerName: req.user && req.user.name, ip: req.ip }); } catch (_) {}
    res.status(201).json({ id, name: workerName, role, status: status || "פעיל" });
  } catch (err) {
    next(err);
  }
});

app.delete("/api/workers/:id", requireRole([ROLES.ADMIN]), function (req, res, next) {
  try {
    const id = Number(req.params.id);
    const worker = findWorkerById(id);

    if (!worker) {
      return res.status(404).json({ error: "Worker not found" });
    }

    const allWorkers = getWorkers();
    const adminCount = allWorkers.filter(function (w) { return w.role === "מנהל"; }).length;

    if (worker.role === "מנהל" && adminCount <= 1) {
      return res.status(400).json({ error: "Cannot delete the last admin" });
    }

    deleteWorkerById(id);
    try { insertAuditLog({ action: "worker_delete", entityType: "worker", entityId: String(id), entityName: worker.name, details: "תפקיד: " + worker.role, workerId: req.user && req.user.id, workerName: req.user && req.user.name, ip: req.ip }); } catch (_) {}
    res.json({ deleted: true, id });
  } catch (err) {
    next(err);
  }
});

// Self-service: any authenticated worker can change their own password
// MUST be defined before /:id/password so Express doesn't treat "me" as an id
app.put("/api/workers/me/password", passwordLimiter, requireAuth, async function (req, res, next) {
  try {
    const { currentPassword, newPassword } = req.body || {};

    if (!newPassword || String(newPassword).length < 4) {
      return res.status(400).json({ error: "Password must be at least 4 characters" });
    }

    const worker = findWorkerById(req.user.id);
    if (!worker || !worker.passwordHash) {
      return res.status(404).json({ error: "Worker not found" });
    }

    // currentPassword is always required — except for the forced first-login change
    const mustChange = worker.must_change_password === 1;
    if (!mustChange) {
      if (!currentPassword) {
        return res.status(400).json({ error: "יש לספק את הסיסמה הנוכחית" });
      }
      const valid = await comparePassword(String(currentPassword), worker.passwordHash);
      if (!valid) {
        return res.status(401).json({ error: "הסיסמה הנוכחית שגויה" });
      }
    }

    const hash = await hashPassword(String(newPassword));
    updateWorkerPasswordHash(worker.id, hash);
    clearMustChangePassword(worker.id);

    try { insertAuditLog({ action: "password_change", entityType: "worker", entityId: String(worker.id), entityName: worker.name, details: "שינוי סיסמה עצמי", workerId: worker.id, workerName: worker.name, ip: req.ip }); } catch (_) {}
    res.json({ updated: true });
  } catch (err) {
    next(err);
  }
});

app.put("/api/workers/:id/password", passwordLimiter, requireRole([ROLES.ADMIN]), async function (req, res, next) {
  try {
    const id = Number(req.params.id);
    const { newPassword } = req.body || {};

    if (!newPassword || String(newPassword).length < 4) {
      return res.status(400).json({ error: "Password must be at least 4 characters" });
    }

    const worker = findWorkerById(id);
    if (!worker) {
      return res.status(404).json({ error: "Worker not found" });
    }

    const hash = await hashPassword(String(newPassword));
    updateWorkerPasswordHash(id, hash);
    clearMustChangePassword(id);

    try { insertAuditLog({ action: "password_reset", entityType: "worker", entityId: String(id), entityName: worker.name, details: "איפוס סיסמה על ידי מנהל", workerId: req.user && req.user.id, workerName: req.user && req.user.name, ip: req.ip }); } catch (_) {}
    res.json({ updated: true });
  } catch (err) {
    next(err);
  }
});

// ── App data (donors, tasks, logs, settings, approvals) ──────────────────────
app.use("/api/data", apiLimiter);

// ── Minimal server-side sanity checks for the generic app_state blob store ──────
// donors/approvals are saved wholesale from the client (see setAppState below), so
// there is no per-field schema on this endpoint. These checks only reject clearly
// invalid values (non-numeric/negative/absurd amounts, unknown approval status) —
// they intentionally do not require every optional field to be present, so existing
// records and existing save flows keep working unchanged.
const MAX_SANE_AMOUNT = 100000000; // 100,000,000 ₪ — sanity ceiling, not a business cap

function validateDonorsPayload(donors) {
  if (!Array.isArray(donors)) return "donors must be an array";
  for (var i = 0; i < donors.length; i++) {
    var d = donors[i];
    if (!d || typeof d !== "object") return "רשומת תורם לא תקינה במיקום " + i;
    if (d.fullName != null && typeof d.fullName !== "string") return "שם תורם לא תקין (מזהה " + d.id + ")";
    if (d.phone != null && typeof d.phone !== "string") return "טלפון תורם לא תקין (מזהה " + d.id + ")";
    if (Array.isArray(d.donations)) {
      for (var j = 0; j < d.donations.length; j++) {
        var don = d.donations[j];
        if (!don || typeof don !== "object") return "רשומת תרומה לא תקינה עבור תורם " + d.id;
        if (don.amount != null) {
          var amt = Number(don.amount);
          if (!isFinite(amt) || amt < 0 || amt > MAX_SANE_AMOUNT) {
            return "סכום תרומה לא תקין עבור תורם " + (d.fullName || d.id);
          }
        }
        if (don.remainingDebt != null) {
          var rem = Number(don.remainingDebt);
          if (!isFinite(rem) || rem < 0 || rem > MAX_SANE_AMOUNT) {
            return "סכום חוב לא תקין עבור תורם " + (d.fullName || d.id);
          }
        }
      }
    }
  }
  return null;
}

const ALLOWED_APPROVAL_STATUSES = new Set(["טיוטה", "אושר", "בוטל"]);
function validateApprovalsPayload(approvals) {
  if (!Array.isArray(approvals)) return "approvals must be an array";
  for (var i = 0; i < approvals.length; i++) {
    var a = approvals[i];
    if (!a || typeof a !== "object") return "רשומת אישור לא תקינה במיקום " + i;
    if (a.status != null && !ALLOWED_APPROVAL_STATUSES.has(a.status)) {
      return "סטטוס אישור לא חוקי: " + a.status;
    }
    if (a.amount != null) {
      var amt = Number(a.amount);
      if (!isFinite(amt) || amt < 0 || amt > MAX_SANE_AMOUNT) {
        return "סכום אישור לא תקין";
      }
    }
  }
  return null;
}

// Deliberately content-free: a count (or "עודכן" for a non-array blob like
// settings/sip_config) is the only thing derived from the payload itself.
// Never inspect field values here — this summary is what lands in
// server_audit_log, so it must stay safe by construction even for keys that
// hold phone numbers, addresses or free-text notes (donors/tasks/approvals).
function summarizeDataSaveForAudit(body) {
  return Array.isArray(body) ? body.length + " רשומות" : "עודכן";
}

app.get("/api/data/:key", requireRole([ROLES.ADMIN, ROLES.SECRETARY]), function (req, res, next) {
  try {
    const key  = req.params.key;
    const data = getAppState(key);

    if (data === null) {
      return res.status(400).json({ error: "Unknown data key: " + key });
    }

    // Exposed so the client can echo it back on save — used only to log a
    // warning below if a save turns out to be based on stale data. Never blocks.
    var updatedAt = getAppStateUpdatedAt(key);
    if (updatedAt) res.set("X-Data-Updated-At", updatedAt);

    res.json(data);
  } catch (err) {
    next(err);
  }
});

app.post("/api/data/:key", requireRole([ROLES.ADMIN, ROLES.SECRETARY]), function (req, res, next) {
  try {
    const key  = req.params.key;
    const body = req.body;

    if (!Array.isArray(body) && typeof body !== "object") {
      return res.status(400).json({ error: "Body must be an array or object" });
    }

    if (key === "donors") {
      var donorsErr = validateDonorsPayload(body);
      if (donorsErr) return res.status(400).json({ error: donorsErr });
    } else if (key === "approvals") {
      var approvalsErr = validateApprovalsPayload(body);
      if (approvalsErr) return res.status(400).json({ error: approvalsErr });
    }

    // Snapshot the previous "logs" blob before it's overwritten below, so any
    // newly-appended AuditLog.record() entries can be mirrored into the
    // tamper-resistant server_audit_log table (see data-audit-mirror.service.js).
    var previousLogs = key === "logs" ? getAppState("logs") : null;

    // Optimistic concurrency check — if the client tells us what version it
    // last read (X-Expected-Updated-At) and the stored data has moved on
    // since, reject the save instead of silently overwriting whatever the
    // other session wrote. The client (js/database.js _pushToServer) treats
    // this the same way it already treats a failed push: log a warning and
    // refresh its local copy, no blocking UI.
    var expectedUpdatedAt = req.get("X-Expected-Updated-At");
    if (expectedUpdatedAt) {
      var currentUpdatedAt = getAppStateUpdatedAt(key);
      if (currentUpdatedAt && currentUpdatedAt !== expectedUpdatedAt) {
        console.warn("[LostUpdate] key=" + key +
          " worker=" + (req.user && req.user.name || "?") +
          " rejected stale save — expected updatedAt " + expectedUpdatedAt +
          " but found " + currentUpdatedAt + ". Another session saved first.");
        return res.status(409).json({
          error:            "הנתונים השתנו בשרת מאז שנטענו — רענן ונסה שוב",
          currentUpdatedAt: currentUpdatedAt,
        });
      }
    }

    const ok = setAppState(key, body);

    if (!ok) {
      return res.status(400).json({ error: "Unknown data key: " + key });
    }

    // Baseline trace for EVERY successful save through this endpoint, for
    // EVERY key — independent of whether the client also separately saved a
    // matching entry to "logs" (the mirror below). This is what guarantees a
    // save can never pass through the server untraced just because a buggy
    // or compromised client skipped AuditLog.record(): who (from the
    // verified JWT), what key, when, from which IP, and a safe count-only
    // summary — never the record content itself.
    try {
      insertAuditLog({
        action:     "data_save",
        entityType: key,
        entityId:   null,
        entityName: null,
        details:    summarizeDataSaveForAudit(body),
        workerId:   req.user.id,
        workerName: req.user.name,
        ip:         req.ip,
      });
    } catch (_) {}

    // Richer, per-entity detail (action/entityType/entityId/entityName/
    // changed fields) is still mirrored from the client's own AuditLog trail
    // when available — see data-audit-mirror.service.js. This is additive to
    // the baseline row above, not a replacement for it.
    if (key === "logs") {
      try {
        mirrorLogEntriesToAuditLog(
          previousLogs,
          body,
          { workerId: req.user.id, workerName: req.user.name, ip: req.ip },
          insertAuditLog
        );
      } catch (_) {}
    }

    var newUpdatedAt = getAppStateUpdatedAt(key);
    if (newUpdatedAt) res.set("X-Data-Updated-At", newUpdatedAt);

    res.json({ saved: true, key });
  } catch (err) {
    next(err);
  }
});

// ── Payments (CRM payments screen) ───────────────────────────────────────────
app.get(
  "/api/payments/stats",
  requireRole([ROLES.ADMIN, ROLES.SECRETARY]),
  function (req, res, next) {
    try { res.json(getPaymentStats()); } catch (err) { next(err); }
  }
);

app.get(
  "/api/payments/:id",
  requireRole([ROLES.ADMIN, ROLES.SECRETARY]),
  function (req, res, next) {
    try {
      var id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ error: "Invalid id" });
      var row = getPaymentById(id);
      if (!row) return res.status(404).json({ error: "Not found" });
      res.json(row);
    } catch (err) { next(err); }
  }
);

app.get(
  "/api/payments",
  requireRole([ROLES.ADMIN, ROLES.SECRETARY]),
  function (req, res, next) {
    try {
      var limit   = Math.min(Number(req.query.limit) || 500, 2000);
      var donorId = req.query.donorId ? Number(req.query.donorId) : null;
      var phone   = req.query.phone ? String(req.query.phone) : null;
      res.json(getPayments({ limit: limit, donorId: donorId, phone: phone }));
    } catch (err) { next(err); }
  }
);

// Marks one donation "שולם" AND records a real payment row for it as a
// single atomic server-side operation (donor.js saveDonationEdit() no longer
// creates the payment and then separately hopes a fire-and-forget
// Database.save() catches up the donation fields — see
// markDonationPaidManually() in db.js for why "atomic" here means one
// BEGIN/COMMIT covering both the payments insert and the app_state
// read-modify-write, with rollback if either half fails).
//
// idempotencyKey is required and caller-supplied (donor.js generates one per
// edit session) — a retried/duplicated request with the same key returns the
// original result instead of charging twice. Two different concurrent
// requests for the *same* donation (two admins clicking "mark paid" around
// the same time) are safe for a different reason: the charge amount is
// always computed from the donation's current stored state, never trusted
// from the client, so whichever request commits first zeroes the balance and
// the second is rejected with 409 rather than double-charging.
app.post(
  "/api/donors/:donorId/donations/:donationId/mark-paid",
  requireRole([ROLES.ADMIN, ROLES.SECRETARY]),
  function (req, res, next) {
    try {
      var appDonorId = parseInt(req.params.donorId, 10);
      var donationId = parseInt(req.params.donationId, 10);
      if (!appDonorId || !donationId) return res.status(400).json({ error: "מזהה תורם/תרומה לא תקין" });

      var amount = Number(req.body && req.body.amount);
      if (!isFinite(amount) || amount <= 0 || amount > MAX_SANE_AMOUNT) {
        return res.status(400).json({ error: "סכום לא תקין" });
      }

      var idempotencyKey = req.body && req.body.idempotencyKey ? String(req.body.idempotencyKey).trim() : "";
      if (!idempotencyKey) return res.status(400).json({ error: "חסר מפתח idempotency" });

      var result = markDonationPaidManually({
        appDonorId:    appDonorId,
        donationId:    donationId,
        amount:        amount,
        phone:         req.body && req.body.phone,
        donorName:     req.body && req.body.donorName,
        paymentMethod: req.body && req.body.paymentMethod,
        idempotencyKey: idempotencyKey,
        workerId:   req.user && req.user.id,
        workerName: req.user && req.user.name,
        ip:         req.ip,
      });

      res.json({ ok: true, idempotent: !!result.idempotent, donation: result.donation, payment: result.payment });
    } catch (err) {
      if (err && err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
      next(err);
    }
  }
);

// Reverses exactly the payment donor.js's mark-paid call above created for
// this donation (donation.lastPaymentId — see cancelManualDonationPayment())
// — never an IVR payment or any other donation's payment. The row is kept
// forever with status='cancelled', never deleted, so payment history/reports
// stay a complete record; the donation is restored to whatever paidPartial
// it had before that specific payment (0 if it was fully unpaid, or its
// prior partial amount if a partial donation was completed manually).
app.post(
  "/api/donors/:donorId/donations/:donationId/cancel-manual-payment",
  requireRole([ROLES.ADMIN, ROLES.SECRETARY]),
  function (req, res, next) {
    try {
      var appDonorId = parseInt(req.params.donorId, 10);
      var donationId = parseInt(req.params.donationId, 10);
      if (!appDonorId || !donationId) return res.status(400).json({ error: "מזהה תורם/תרומה לא תקין" });

      var result = cancelManualDonationPayment({
        appDonorId: appDonorId,
        donationId: donationId,
        workerId:   req.user && req.user.id,
        workerName: req.user && req.user.name,
        ip:         req.ip,
      });

      res.json({ ok: true, donation: result.donation, payment: result.payment });
    } catch (err) {
      if (err && err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
      next(err);
    }
  }
);

// Records a genuine partial payment (does not necessarily fully close the
// donation) as a single atomic server-side operation with a real payments
// row — same idempotency/rollback contract as mark-paid above, via
// recordManualPartialPayment() in db.js. Used by the donor-card "תשלום
// חלקי" flow, which calls this once per affected open debt (each with its
// own idempotency key derived from one client-side session key), and by
// "add donation already paid" for the full amount of a single new donation.
app.post(
  "/api/donors/:donorId/donations/:donationId/partial-payment",
  requireRole([ROLES.ADMIN, ROLES.SECRETARY]),
  function (req, res, next) {
    try {
      var appDonorId = parseInt(req.params.donorId, 10);
      var donationId = parseInt(req.params.donationId, 10);
      if (!appDonorId || !donationId) return res.status(400).json({ error: "מזהה תורם/תרומה לא תקין" });

      var amount = Number(req.body && req.body.amount);
      if (!isFinite(amount) || amount <= 0 || amount > MAX_SANE_AMOUNT) {
        return res.status(400).json({ error: "סכום לא תקין" });
      }

      var idempotencyKey = req.body && req.body.idempotencyKey ? String(req.body.idempotencyKey).trim() : "";
      if (!idempotencyKey) return res.status(400).json({ error: "חסר מפתח idempotency" });

      var result = recordManualPartialPayment({
        appDonorId:    appDonorId,
        donationId:    donationId,
        amount:        amount,
        phone:         req.body && req.body.phone,
        donorName:     req.body && req.body.donorName,
        paymentMethod: req.body && req.body.paymentMethod,
        idempotencyKey: idempotencyKey,
        workerId:   req.user && req.user.id,
        workerName: req.user && req.user.name,
        ip:         req.ip,
      });

      res.json({ ok: true, idempotent: !!result.idempotent, donation: result.donation, payment: result.payment });
    } catch (err) {
      if (err && err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
      next(err);
    }
  }
);

// ── IVR donations list ────────────────────────────────────────────────────────
app.get(
  "/api/ivr/donations",
  requireRole([ROLES.ADMIN, ROLES.SECRETARY, ROLES.IVR_SYSTEM]),
  function (req, res) {
    res.json(getIvrDonations());
  }
);

// ── IVR call sessions (audit log) ─────────────────────────────────────────────
app.get(
  "/api/ivr/sessions",
  requireRole([ROLES.ADMIN, ROLES.SECRETARY]),
  function (req, res, next) {
    try {
      var limit = Math.min(Number(req.query.limit) || 100, 500);
      res.json(getCallSessions(limit));
    } catch (err) {
      next(err);
    }
  }
);

// ── IVR call log for a specific callId ───────────────────────────────────────
app.get(
  "/api/ivr/sessions/:callId/logs",
  requireRole([ROLES.ADMIN, ROLES.SECRETARY]),
  function (req, res, next) {
    try {
      var callId = String(req.params.callId).trim();
      if (!callId) return res.status(400).json({ error: "callId is required" });
      res.json(getCallLogsByCallId(callId));
    } catch (err) {
      next(err);
    }
  }
);

// ── IVR Voice Messages (caller-left voicemails) ───────────────────────────────
app.get(
  "/api/ivr/voice-messages",
  requireRole([ROLES.ADMIN, ROLES.SECRETARY]),
  function (req, res, next) {
    try {
      var status = req.query.status ? String(req.query.status) : undefined;
      res.json(listIvrVoiceMessages({ status: status, limit: req.query.limit }));
    } catch (err) {
      next(err);
    }
  }
);

app.patch(
  "/api/ivr/voice-messages/:id",
  requireRole([ROLES.ADMIN, ROLES.SECRETARY]),
  function (req, res, next) {
    try {
      var id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: "invalid id" });

      var status = String((req.body || {}).status || "").trim();
      if (IVR_VOICE_MESSAGE_STATUSES.indexOf(status) === -1) {
        return res.status(400).json({ error: "סטטוס לא תקין. חייב להיות אחד מ: " + IVR_VOICE_MESSAGE_STATUSES.join(", ") });
      }

      var updated = updateIvrVoiceMessageStatus(id, status);
      if (!updated) return res.status(404).json({ error: "הודעה לא נמצאה" });

      insertAuditLog({
        action:     "ivr_voice_message_status",
        entityType: "ivr_voice_message",
        entityId:   id,
        entityName: null,
        details:    "סטטוס הודעה קולית עודכן ל-" + status,
        workerId:   req.user && req.user.id,
        workerName: req.user && req.user.name,
        ip:         req.ip,
      });

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

// Streams the recording's audio bytes from Technoline through our own
// server — the browser never sees TECHNOLINE_API_KEY or Technoline's URL
// directly (see ivrExtensionsApiDocs.html: ivrFilesApi.php requires apiKey;
// the /ivr callback endpoint itself also runs over plain HTTP — neither
// belongs anywhere near the browser).
app.get(
  "/api/ivr/voice-messages/:id/audio",
  requireRole([ROLES.ADMIN, ROLES.SECRETARY]),
  async function (req, res, next) {
    try {
      var id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: "invalid id" });

      var msg = getIvrVoiceMessageById(id);
      if (!msg) return res.status(404).json({ error: "הודעה לא נמצאה" });

      var apiKey = process.env.TECHNOLINE_API_KEY || "";
      if (!apiKey) return res.status(503).json({ error: "TECHNOLINE_API_KEY לא מוגדר בשרת" });

      // fileName+extension is the PRIMARY lookup — confirmed against the real
      // production account: fileName+extension returned a genuine audio/mp3
      // file (ID3 signature, ~113KB), while audio=<technolineAudio> returned
      // HTTP 200 with content-type text/html and a 54-byte body (Technoline's
      // JSON-shaped error, mislabeled) for the SAME row. The doc's claim that
      // `audio` is "the most precise way" does not hold for this account —
      // trust the measured result, not the doc wording. technolineAudio is
      // kept only as a secondary fallback attempt, and even then a "success"
      // is never assumed from HTTP 200 alone — only an actual audio/* body
      // counts, exactly as fileName's own primary attempt is judged.
      var lookupAttempts = [
        { label: "fileName", params: { fileName: msg.fileName, extension: msg.extension || "" } },
      ];
      if (msg.technolineAudio) {
        lookupAttempts.push({ label: "audio", params: { audio: msg.technolineAudio } });
      }

      var techRes = null, lastFailLog = null;
      for (var i = 0; i < lookupAttempts.length; i++) {
        var attempt = lookupAttempts[i];
        var params = new URLSearchParams(Object.assign({
          action: "fileDownload",
          apiKey: apiKey,
          play:   "1",
        }, attempt.params));

        logger.info("IvrVoiceMessage", "→ fileDownload | id:", id, "| attempt:", attempt.label,
                    "| params:", JSON.stringify(attempt.params));
        var r;
        try {
          r = await fetch("https://app.ipsales.co.il/ivrFilesApi.php?" + params.toString(), {
            method: "GET",
            signal: AbortSignal.timeout(20000),
          });
        } catch (fetchErr) {
          // Network failure / timeout reaching Technoline itself (as opposed
          // to Technoline answering with "file not found") — same safe,
          // clear message as the not-found case, never a raw 500. Not
          // attempt-specific, so stop entirely rather than retry the
          // fallback against an unreachable host.
          logger.warn("IvrVoiceMessage", "← fileDownload network error | id:", id, "| attempt:", attempt.label,
                      "| " + fetchErr.message);
          return res.status(502).json({ error: "לא ניתן היה להתחבר לשרת ההקלטות כרגע. נסה שוב מאוחר יותר." });
        }

        var ct = r.headers.get("content-type") || "";
        // Technoline returns HTTP 200 with a non-audio body even when the
        // file doesn't exist / the lookup key is wrong — Content-Type
        // actually being audio/* is the only reliable success signal (see
        // ivrExtensionsApiDocs.html §fileDownload, confirmed by production
        // testing above).
        if (r.ok && ct.indexOf("audio") !== -1) {
          techRes = r;
          break;
        }

        // fetch's .text() already decodes the body as UTF-8 regardless of
        // the (often wrong/misleading) declared Content-Type — Technoline's
        // error responses are JSON ({"status":"ERROR","note":"..."}) even
        // though they're served as text/html, so try that first for a clean
        // reading; JSON.stringify() on the raw text is the fallback so any
        // genuinely non-JSON body still prints as an unambiguous, safely
        // escaped string instead of raw (possibly control-character-laden)
        // bytes dumped straight into the log.
        var rawFailText = "";
        try { rawFailText = (await r.text()).slice(0, 500); } catch (_) {}
        try { lastFailLog = JSON.stringify(JSON.parse(rawFailText)); } catch (_) { lastFailLog = JSON.stringify(rawFailText); }
        logger.warn("IvrVoiceMessage", "← fileDownload failed | id:", id, "| attempt:", attempt.label,
                    "| HTTP", r.status, "| content-type:", ct, "| body:", lastFailLog);
      }

      if (!techRes) {
        return res.status(404).json({ error: "ההקלטה אינה זמינה (ייתכן שנמחקה או שפג תוקפה)" });
      }

      var buf = Buffer.from(await techRes.arrayBuffer());
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "private, max-age=3600");
      return res.send(buf);
    } catch (err) {
      next(err);
    }
  }
);

// ── Click-to-Call (Technoline) ────────────────────────────────────────────────
app.post(
  "/api/technoline/click2call",
  apiLimiter,
  requireRole([ROLES.ADMIN, ROLES.SECRETARY]),
  async function (req, res, next) {
    try {
      var body      = req.body || {};
      var rawPhone  = String(body.phone     || "").trim();
      var phone     = normalizePhone(rawPhone);
      var donorName = String(body.donorName || "").trim();
      var donorId   = body.donorId  || null;
      var extension = String(body.extension || process.env.TECHNOLINE_AGENT_EXTENSION || "").trim();
      var apiKey    = process.env.TECHNOLINE_API_KEY || "";

      if (!apiKey) {
        return res.status(503).json({ error: "TECHNOLINE_API_KEY לא מוגדר בשרת" });
      }
      if (!extension) {
        return res.status(400).json({ error: "נדרשת שלוחת מזכיר. הגדר TECHNOLINE_AGENT_EXTENSION ב-.env או שלח extension בגוף הבקשה" });
      }
      if (!phone) {
        return res.status(400).json({ error: "מספר טלפון חסר" });
      }
      if (phone.length < 9 || phone.length > 15) {
        return res.status(400).json({ error: "מספר טלפון לא תקין: " + rawPhone });
      }

      var click2callCallerId = resolveClick2CallCallerId();
      if (click2callCallerId.error) {
        logger.error("Click2Call", click2callCallerId.error);
        return res.status(500).json({ error: click2callCallerId.error });
      }

      const techParamsObj = {
        action:     "click2call",
        apiKey:     apiKey,
        extension:  extension,
        target:     phone,
        targetName: donorName || phone,
        ringSec:    30,
      };
      if (click2callCallerId.callerId) techParamsObj.callerId = click2callCallerId.callerId;
      const techParams = new URLSearchParams(techParamsObj);

      // Log exactly what we send (apiKey + donor phone/name redacted)
      logger.info("Click2Call", "→ Technoline request:", JSON.stringify(Object.assign({}, techParamsObj, {
        apiKey:     maskSecret(apiKey),
        target:     logger.redact(phone),
        targetName: logger.redact(donorName || phone),
      })));

      console.log("[Click2Call] → URL: https://app.ipsales.co.il/ivrFilesApi.php");
      var techRes  = await fetch("https://app.ipsales.co.il/ivrFilesApi.php", {
        method:  "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body:    techParams.toString(),
        signal:  AbortSignal.timeout(15000),
      });

      var techHttpStatus = techRes.status;
      var rawText = await techRes.text();
      logger.info("Click2Call", "← Technoline HTTP", techHttpStatus, "| body:", logger.redact(rawText));
      var techBody;
      try {
        techBody = JSON.parse(rawText);
      } catch (_) {
        logger.error("Click2Call", "← תגובה לא-JSON מטכנוליין:", logger.redact(rawText.slice(0, 500)));
        return res.status(502).json({ error: "תגובה לא תקינה מטכנוליין (לא JSON). בדוק לוגי שרת." });
      }

      var success  = techBody && String(techBody.status).toUpperCase() === "OK";

      try {
        logClick2Call({
          pbxCallId:      success ? (techBody.callId || null) : null,
          workerId:       req.user ? req.user.id   : null,
          workerName:     req.user ? req.user.name : null,
          donorId:        donorId,
          donorName:      donorName || null,
          donorPhone:     phone,
          agentExtension: extension,
          status:         success ? "success" : "error",
          errorCode:      success ? null : (techBody.errorCode != null ? techBody.errorCode : null),
          errorNote:      success ? null : (techBody.note || null),
        });
        insertAuditLog({
          action:     success ? "click2call" : "click2call_failed",
          entityType: "donor",
          entityId:   donorId,
          entityName: donorName || null,
          details:    (success ? "חיוג ישיר בוצע ל-" : "חיוג ישיר נכשל עבור ") + phone + (success ? "" : " — " + (techBody.note || techBody.message || "")),
          workerId:   req.user && req.user.id,
          workerName: req.user && req.user.name,
          ip:         req.ip,
        });
      } catch (logErr) {
        console.error("[Click2Call] Failed to write log — call result unaffected:", logErr.message);
      }

      if (!success) {
        var errMsg = techBody.note || techBody.message || techBody.error || ("שגיאה " + (techBody.errorCode ?? techHttpStatus));
        console.error("[Click2Call] Technoline rejected call | error:", errMsg);
        return res.status(400).json({ error: "טכנוליין: " + errMsg });
      }

      logger.info("Click2Call", "initiated | donor:", logger.redact(donorName), "| phone:", logger.redact(phone),
                  "| ext:", extension, "| callId:", techBody.callId);
      return res.json({ ok: true, callId: techBody.callId, extension: extension, target: techBody.target });
    } catch (err) {
      next(err);
    }
  }
);

// ── Donor IVR approved phones ─────────────────────────────────────────────────
app.put(
  "/api/donors/:id/ivr-approved-phones",
  requireRole([ROLES.ADMIN, ROLES.SECRETARY]),
  function (req, res, next) {
    try {
      var id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: "invalid id" });

      var phones = req.body.phones;
      if (!Array.isArray(phones)) return res.status(400).json({ error: "phones must be an array" });

      var donors = getAppState("donors") || [];
      var donor = null;
      for (var i = 0; i < donors.length; i++) {
        if (donors[i].id === id) { donor = donors[i]; break; }
      }
      if (!donor) return res.status(404).json({ error: "donor not found" });

      donor.ivrApprovedPhones = phones.filter(function (p) {
        return typeof p === "string" && p.trim();
      });
      setAppState("donors", donors);

      return res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

// ── Technoline Mailing List sync ─────────────────────────────────────────────
app.post(
  "/api/technoline/mailing-list/sync",
  apiLimiter,
  requireRole([ROLES.ADMIN]),
  async function (req, res, next) {
    try {
      var apiKey       = process.env.TECHNOLINE_API_KEY        || "";
      var mailingListId = process.env.TECHNOLINE_MAILING_LIST_ID || "";

      if (!apiKey)        return res.status(503).json({ error: "TECHNOLINE_API_KEY לא מוגדר בשרת" });
      if (!mailingListId) return res.status(503).json({ error: "TECHNOLINE_MAILING_LIST_ID לא מוגדר בשרת" });

      var donors   = getAppState("donors") || [];
      var contacts = [];

      for (var i = 0; i < donors.length; i++) {
        var d      = donors[i];
        var phones = d.ivrApprovedPhones || [];
        if (phones.length === 0) continue;
        var first = (d.firstName || "").trim();
        var last  = (d.lastName  || d.fullName || "").trim();
        for (var j = 0; j < phones.length; j++) {
          contacts.push({ phone: phones[j], firstName: first, lastName: last, status: 0 });
        }
      }

      if (contacts.length === 0) {
        return res.json({ ok: true, synced: 0, message: "אין מספרים מאושרים לסינכרון" });
      }

      var techParams = new URLSearchParams({
        action:      "uplodePhones",
        apiKey:      apiKey,
        mailingList: mailingListId,
        insertType:  "all",
        phones:      JSON.stringify(contacts),
      });

      console.log("[MailingList] syncing", contacts.length, "contacts to list", mailingListId);

      var techRes  = await fetch("https://app.ipsales.co.il/mailingListsApi.php", {
        method:  "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body:    techParams.toString(),
        signal:  AbortSignal.timeout(30000),
      });
      var techBody = await techRes.json();

      console.log("[MailingList] response:", logger.redact(JSON.stringify(techBody)));

      return res.json({
        ok:     true,
        synced: contacts.length,
        result: techBody,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── Donor Click2Call logs ─────────────────────────────────────────────────────
app.get(
  "/api/donors/:id/click2call-logs",
  requireRole([ROLES.ADMIN, ROLES.SECRETARY]),
  function (req, res, next) {
    try {
      var appId = Number(req.params.id);
      if (!appId) return res.status(400).json({ error: "invalid id" });

      // Resolve app-level JSON id → SQLite id + primary phone via app_state
      var sqliteId = null;
      var primaryPhone = null;
      var appDonors = getAppState("donors");
      if (Array.isArray(appDonors)) {
        var appDonor = appDonors.find(function (d) { return d.id === appId; });
        if (appDonor && appDonor.phone) {
          primaryPhone = normalizePhoneForDb(appDonor.phone);
          var row = require("./db").findDonorByPhone(appDonor.phone);
          if (row) sqliteId = row.id;
        }
      }

      var logs = getClick2CallLogs(sqliteId, 30, primaryPhone);
      return res.json(logs);
    } catch (err) {
      next(err);
    }
  }
);

// ── Technoline Campaign Management ───────────────────────────────────────────

function techCampaignFetch(action, extraParams) {
  var apiKey = process.env.TECHNOLINE_API_KEY || "";
  if (!apiKey) throw new Error("TECHNOLINE_API_KEY לא מוגדר בשרת");
  var params = new URLSearchParams(Object.assign({ action: action, apiKey: apiKey }, extraParams || {}));
  return fetch("https://app.ipsales.co.il/campaignApi.php", {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    params.toString(),
    signal:  AbortSignal.timeout(30000),
  }).then(function (r) { return r.json(); });
}

function campaignErrMsg(body) {
  if (body.errorCode === -99) return "IP השרת אינו ברשימת ההיתרים של טכנוליין — יש לפנות לתמיכה.";
  return body.note || body.error || ("שגיאה " + (body.errorCode || ""));
}

// Shared Israeli-phone format check for both outbound-caller-id env vars below.
var TECHNOLINE_CALLER_ID_RE = /^0\d{8,9}$/;

// Outbound Caller-ID for tzintuk/missed-call campaigns ONLY (campaignApi.php
// action=campaignRun, param `callId` per Technoline's campaignApi.md docs —
// "Outbound Caller-ID. Must be a phone previously registered via addDid.
// Omit to use the account's default DID."). Must never be applied to
// Click2Call, IVR identification, SIP, or any other Technoline action.
function resolveTzintukCallerId() {
  var raw = String(process.env.TECHNOLINE_TZINTUK_CALLER_ID || "").trim();
  if (!raw) return { callId: null, error: null };
  if (!TECHNOLINE_CALLER_ID_RE.test(raw)) {
    return { callId: null, error: "TECHNOLINE_TZINTUK_CALLER_ID לא תקין (מצופה מספר ישראלי המתחיל ב-0): " + raw };
  }
  return { callId: raw, error: null };
}

// Outbound Caller-ID for the "התקשר לתורם" Click-to-Call button ONLY
// (ivrFilesApi.php action=click2call, param `callerId` per Technoline's
// click2callApiDocs.md — "Outbound caller ID shown to the target when the
// PBX dials out. Must be one of the account's approved outbound numbers...
// Omitted → the extension's configured display number is used."). This is a
// distinct parameter from campaignRun's `callId` above — must never be mixed
// up with it, and must never be applied to SIP/softphone, IVR identification,
// or tzintuk campaigns.
function resolveClick2CallCallerId() {
  var raw = String(process.env.TECHNOLINE_CLICK2CALL_CALLER_ID || "").trim();
  if (!raw) return { callerId: null, error: null };
  if (!TECHNOLINE_CALLER_ID_RE.test(raw)) {
    return { callerId: null, error: "TECHNOLINE_CLICK2CALL_CALLER_ID לא תקין (מצופה מספר ישראלי המתחיל ב-0): " + raw };
  }
  return { callerId: raw, error: null };
}

// Helper: build phone list from donors, filtered by recipientFilter.
// Filters: "all" | "debt" | "city:<name>" | "tag:<tag>" | "donor:<id>" | "ids:<id,id,...>"
// Phone resolution order:
//   1. d.ivrApprovedPhones (explicitly approved)
//   2. d.phone auto-included when ivrApprovedPhones was never configured (null/undefined)
//   3. d.phone as fallback when opts.fallbackToPrimary=true and ivrApprovedPhones is []
// Returns { phones, donorCount, ivrDonorCount, fallbackDonorCount, ivrPhoneCount, fallbackPhoneCount, donors }
// `donors` lists every included donor with the phones actually queued for them — used to
// write a Timeline entry per donor after a send, without re-deriving the filter logic.
function buildPhoneList(recipientFilter, opts) {
  var fallbackToPrimary = !!(opts && opts.fallbackToPrimary);
  var donors = getAppState("donors") || [];
  var filter = String(recipientFilter || "all").trim();
  var ivrPhones      = [];
  var fallbackPhones = [];
  var donorCount = 0, ivrDonorCount = 0, fallbackDonorCount = 0;
  var includedDonors = [];
  var idSet = filter.startsWith("ids:")
    ? filter.slice(4).split(",").map(function (s) { return Number(s.trim()); }).filter(function (n) { return !isNaN(n); })
    : null;

  // "debt:<maxDebt>" — bounded-debt campaigns (e.g. "debt:200"), distinct from
  // the legacy uncapped "debt" filter below which stays byte-for-byte
  // unchanged for backward compatibility. Only this new bounded path gets the
  // stricter active-donor + phone-format rules — every other filter
  // ("all"/"tag:"/"city:"/"donor:"/"ids:"/plain "debt") is untouched.
  var isBoundedDebtFilter = filter.startsWith("debt:");
  var maxDebtCap = isBoundedDebtFilter ? Number(filter.slice(5)) : null;
  var strictPhoneMode = isBoundedDebtFilter;
  var ISRAELI_PHONE_RE = /^0\d{8,9}$/;

  for (var i = 0; i < donors.length; i++) {
    var d       = donors[i];
    var primary = normalizePhone(d.phone || "");
    // null/undefined ivrApprovedPhones → never configured → auto-include primary phone.
    // An explicit [] means admin cleared all approvals intentionally.
    var approved = (d.ivrApprovedPhones != null)
      ? d.ivrApprovedPhones
      : (primary ? [primary] : []);

    // Must have at least one phone source
    if (approved.length === 0 && !(fallbackToPrimary && primary)) continue;

    // Apply filter
    var include = false;
    if (filter === "all") {
      include = true;
    } else if (filter === "debt") {
      // Legacy behavior — unchanged: any positive debt on any single
      // donation, no cap, no active-donor restriction.
      include = (d.donations || []).some(function (don) { return (don.remainingDebt || 0) > 0; });
    } else if (isBoundedDebtFilter) {
      // Same "total outstanding debt" formula used everywhere else in the
      // app (donors.js getDonorDebt / donor.js getDebtTotal): sum of
      // remainingDebt across every donation — not a single-donation check.
      var donorTotalDebt = (d.donations || []).reduce(function (sum, don) {
        return sum + Number(don.remainingDebt || 0);
      }, 0);
      include = d.status !== "לא פעיל" && donorTotalDebt > 0 &&
        !isNaN(maxDebtCap) && donorTotalDebt <= maxDebtCap;
    } else if (filter.startsWith("city:")) {
      include = (d.city || "").trim() === filter.slice(5).trim();
    } else if (filter.startsWith("tag:")) {
      var tag = filter.slice(4).trim();
      include = (d.tags || []).indexOf(tag) !== -1;
    } else if (filter.startsWith("donor:")) {
      include = d.id === Number(filter.slice(6));
    } else if (idSet) {
      include = idSet.indexOf(d.id) !== -1;
    } else {
      include = true;
    }
    if (!include) continue;

    donorCount++;
    var donorPhones = [];
    if (approved.length > 0) {
      ivrDonorCount++;
      for (var j = 0; j < approved.length; j++) {
        var p = normalizePhone(approved[j]);
        if (!p) continue;
        if (strictPhoneMode && !ISRAELI_PHONE_RE.test(p)) continue;
        donorPhones.push(p);
        if (ivrPhones.indexOf(p) === -1 && fallbackPhones.indexOf(p) === -1) ivrPhones.push(p);
      }
    } else {
      // fallbackToPrimary guaranteed true here
      fallbackDonorCount++;
      if (primary && !(strictPhoneMode && !ISRAELI_PHONE_RE.test(primary))) {
        donorPhones.push(primary);
        if (ivrPhones.indexOf(primary) === -1 && fallbackPhones.indexOf(primary) === -1) fallbackPhones.push(primary);
      }
    }
    if (donorPhones.length > 0) {
      includedDonors.push({ id: d.id, name: d.fullName || ("תורם #" + d.id), phones: donorPhones });
    }
  }

  return {
    phones:             ivrPhones.concat(fallbackPhones),
    donorCount:         donorCount,
    ivrDonorCount:      ivrDonorCount,
    fallbackDonorCount: fallbackDonorCount,
    ivrPhoneCount:      ivrPhones.length,
    fallbackPhoneCount: fallbackPhones.length,
    donors:             includedDonors,
  };
}

// Give the AI low-risk action module access to buildPhoneList/
// validateDonorsPayload without duplicating either — both are module-private
// to server.js, so this is a one-time injection at startup rather than a
// circular require.
require("./ai/actions/lowrisk").injectServices({ buildPhoneList, validateDonorsPayload });

// GET /api/technoline/send/recipient-count?filter=<filter>[&fallback=1]
app.get(
  "/api/technoline/send/recipient-count",
  requireRole([ROLES.ADMIN, ROLES.SECRETARY]),
  function (req, res, next) {
    try {
      var fallback = req.query.fallback === "1" && req.userRole === ROLES.ADMIN;
      var result   = buildPhoneList(req.query.filter || "all", { fallbackToPrimary: fallback });
      return res.json({
        count:              result.phones.length,
        donorCount:         result.donorCount,
        ivrPhoneCount:      result.ivrPhoneCount,
        fallbackPhoneCount: result.fallbackPhoneCount,
        ivrDonorCount:      result.ivrDonorCount,
        fallbackDonorCount: result.fallbackDonorCount,
      });
    } catch (err) { next(err); }
  }
);

// GET /api/technoline/send/recipient-debug?filter=<filter>  — admin-only diagnostic
app.get(
  "/api/technoline/send/recipient-debug",
  requireRole([ROLES.ADMIN]),
  function (req, res, next) {
    try {
      var donors   = getAppState("donors") || [];
      var filter   = String(req.query.filter || "debt").trim();
      var fallback = req.query.fallback === "1";
      var included = [], excluded = [];
      var idSet = filter.startsWith("ids:")
        ? filter.slice(4).split(",").map(function (s) { return Number(s.trim()); }).filter(function (n) { return !isNaN(n); })
        : null;

      for (var i = 0; i < donors.length; i++) {
        var d        = donors[i];
        var primary  = d.phone ? String(d.phone).trim() : "";
        // Match buildPhoneList: null/undefined → auto-include primary; explicit [] → respect it
        var approved = (d.ivrApprovedPhones != null)
          ? d.ivrApprovedPhones
          : (primary ? [primary] : []);
        var hasDebt  = (d.donations || []).some(function (don) { return (don.remainingDebt || 0) > 0; });
        var name     = d.fullName || ("תורם #" + d.id);

        // Gate 1: approved is [] only when ivrApprovedPhones was explicitly cleared or donor has no primary phone
        if (approved.length === 0) {
          var wasCleared = d.ivrApprovedPhones != null;
          if (wasCleared && fallback && primary) {
            // cleared + fallback=on → use primary, fall through
          } else {
            var anyPhone = !!(d.phone2 || d.phone3 || d.phone4 || (d.phones || []).length);
            excluded.push({
              id: d.id, name: name,
              reason: wasCleared ? "ivr_phones_cleared" : "no_phone_at_all",
              detail: wasCleared
                ? "ivrApprovedPhones נוקה ידנית" + (primary ? " — הפעל fallback לכלול phone ראשי" : " — אין phone ראשי")
                : (anyPhone ? "אין מספר ראשי (phone ריק), יש phone2/3/4" : "אין מספר טלפון כלל"),
              hasPhone: !!(primary || anyPhone), hasDebt: hasDebt,
            });
            continue;
          }
        }

        // Gate 2: filter-specific
        var include = false;
        var filterFail = null;
        if (filter === "all") {
          include = true;
        } else if (filter === "debt") {
          include = hasDebt;
          if (!include) filterFail = "אין חוב פתוח";
        } else if (filter.startsWith("city:")) {
          include = (d.city || "").trim() === filter.slice(5).trim();
          if (!include) filterFail = "עיר לא תואמת (" + (d.city || "—") + ")";
        } else if (filter.startsWith("tag:")) {
          var tag = filter.slice(4).trim();
          include = (d.tags || []).indexOf(tag) !== -1;
          if (!include) filterFail = "תגית לא תואמת";
        } else if (filter.startsWith("donor:")) {
          include = d.id === Number(filter.slice(6));
          if (!include) filterFail = "תורם אחר";
        } else if (idSet) {
          include = idSet.indexOf(d.id) !== -1;
          if (!include) filterFail = "לא ברשימת הנבחרים";
        } else {
          include = true;
        }

        if (include) {
          var wasCleared  = d.ivrApprovedPhones != null;
          var useFallback = wasCleared && approved.length === 0 && fallback && !!primary;
          included.push({
            id: d.id, name: name,
            phones: useFallback ? [primary] : approved,
            source: useFallback ? "phone_fallback"
                  : (d.ivrApprovedPhones != null ? "ivr_approved" : "primary_phone_auto"),
          });
        } else {
          excluded.push({
            id: d.id, name: name,
            reason: "filter_mismatch",
            detail: filterFail || "לא תואם לפילטר",
            hasPhone: true, hasDebt: hasDebt,
            ivrApprovedPhones: approved,
          });
        }
      }

      return res.json({
        filter:         filter,
        totalDonors:    donors.length,
        includedCount:  included.length,
        excludedCount:  excluded.length,
        phoneCount:     included.reduce(function (s, d) { return s + d.phones.length; }, 0),
        included:       included,
        excluded:       excluded,
        tip: included.length === 0 && excluded.some(function (e) { return e.reason === "ivr_phones_cleared"; })
          ? "חלק מהתורמים נוקה להם ivrApprovedPhones ידנית. הפעל fallback לשלוח לmain phone."
          : null,
      });
    } catch (err) { next(err); }
  }
);

// GET /api/technoline/send/recent-logs — recent per-recipient success/failure log (all donors)
app.get(
  "/api/technoline/send/recent-logs",
  requireRole([ROLES.ADMIN, ROLES.SECRETARY]),
  function (req, res, next) {
    try {
      var limit = Math.min(Number(req.query.limit) || 30, 200);
      return res.json(getRecentClick2CallLogs(limit));
    } catch (err) { next(err); }
  }
);

// GET /api/technoline/send/audience-options — tags, cities, debt count for the send screen
app.get(
  "/api/technoline/send/audience-options",
  requireRole([ROLES.ADMIN, ROLES.SECRETARY]),
  function (req, res, next) {
    try {
      var donors = getAppState("donors") || [];
      var cities  = {}, tags = {};
      var debtCount = 0;
      donors.forEach(function (d) {
        var effectivePhones = (d.ivrApprovedPhones != null) ? d.ivrApprovedPhones : (d.phone ? [d.phone] : []);
        var hasPhone = effectivePhones.length > 0;
        var hasDebt  = (d.donations || []).some(function (don) { return (don.remainingDebt || 0) > 0; });
        if (hasPhone && hasDebt)                debtCount++;
        if (hasPhone && d.city)                 cities[d.city.trim()] = true;
        if (hasPhone && Array.isArray(d.tags))  d.tags.forEach(function (t) { if (t) tags[t.trim()] = true; });
      });
      return res.json({
        debtCount: debtCount,
        cities:    Object.keys(cities).sort(),
        tags:      Object.keys(tags).sort(),
      });
    } catch (err) { next(err); }
  }
);

// POST /api/technoline/send/manual — admin-only single-phone test (no donor, no ivrApprovedPhones)
app.post(
  "/api/technoline/send/manual",
  apiLimiter,
  requireRole([ROLES.ADMIN]),
  async function (req, res, next) {
    try {
      var apiKey = process.env.TECHNOLINE_API_KEY || "";
      if (!apiKey) return res.status(503).json({ error: "TECHNOLINE_API_KEY לא מוגדר בשרת" });

      var body        = req.body || {};
      var rawPhone    = String(body.phone || "").trim();
      var phone       = normalizePhone(rawPhone);
      var messageKind = String(body.messageKind || "ivr").trim();
      var messageText = String(body.messageText || "").trim();
      var donorId     = body.donorId   || null;
      var donorName   = body.donorName ? String(body.donorName).trim() : null;

      if (!phone) return res.status(400).json({ error: "יש לציין מספר טלפון" });
      if (phone.length < 9 || phone.length > 15) return res.status(400).json({ error: "מספר טלפון לא תקין: " + rawPhone });

      var ivrExtension = String(process.env.TECHNOLINE_IVR_EXTENSION || body.extension || "9263").trim();
      if (messageKind === "ivr" && !ivrExtension) {
        return res.status(503).json({ error: "TECHNOLINE_IVR_EXTENSION לא מוגדר בשרת" });
      }
      if (messageKind === "text" && !messageText) {
        return res.status(400).json({ error: "יש להזין טקסט להודעה" });
      }

      var tzintukCallerIdManual = resolveTzintukCallerId();
      if (tzintukCallerIdManual.error) {
        logger.error("Campaign/Manual", tzintukCallerIdManual.error);
        return res.status(500).json({ error: tzintukCallerIdManual.error });
      }

      var params = {
        action:          "campaignRun",
        apiKey:          apiKey,
        phones:          JSON.stringify([phone]),
        betweenRetries:  30,
        callLength:      25,
        dialRetries:     2,
        reasonableHours: "no",
        title:           "בדיקה ידנית - " + phone,
      };
      if (tzintukCallerIdManual.callId) params.callId = tzintukCallerIdManual.callId;
      if (messageKind === "ivr") {
        params.messagesType        = "extensionActivation";
        params.extensionActivation = ivrExtension;
      } else {
        params.audioText = messageText;
      }

      var urlParams = new URLSearchParams(params);
      // apiKey + the donor phone (both the "phones" field and the title,
      // which embeds it too) are redacted in the logged copy only.
      var logParamsManual = Object.assign({}, params, {
        apiKey: maskSecret(params.apiKey),
        phones: logger.redact(params.phones),
        title:  logger.redact(params.title),
      });
      logger.info("Campaign/Manual", "→ URL: https://app.ipsales.co.il/campaignApi.php");
      logger.info("Campaign/Manual", "→ payload:", JSON.stringify(logParamsManual));

      var techRes  = await fetch("https://app.ipsales.co.il/campaignApi.php", {
        method:  "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body:    urlParams.toString(),
        signal:  AbortSignal.timeout(30000),
      });
      var rawTextManual = await techRes.text();
      logger.info("Campaign/Manual", "← HTTP", techRes.status, "| body:", logger.redact(rawTextManual));
      var techBody;
      try {
        techBody = JSON.parse(rawTextManual);
      } catch (_) {
        logger.error("Campaign/Manual", "← תגובה לא-JSON מטכנוליין:", logger.redact(rawTextManual.slice(0, 500)));
        return res.status(502).json({ error: "תגובה לא תקינה מטכנוליין (לא JSON). בדוק לוגי שרת." });
      }

      var sendOk = String(techBody.status).toUpperCase() === "OK";

      // Timeline + audit trail — best-effort, never blocks the Technoline response.
      try {
        logClick2Call({
          pbxCallId:      sendOk && techBody.campaignId ? "campaign:" + techBody.campaignId : null,
          workerId:       req.user ? req.user.id   : null,
          workerName:     req.user ? req.user.name : null,
          donorId:        donorId,
          donorName:      donorName,
          donorPhone:     phone,
          agentExtension: messageKind === "ivr" ? ivrExtension : "text",
          status:         sendOk ? "success" : "error",
          errorCode:      sendOk ? null : (techBody.errorCode != null ? techBody.errorCode : null),
          errorNote:      sendOk ? null : campaignErrMsg(techBody),
        });
        insertAuditLog({
          action:     sendOk ? "campaign_send_single" : "campaign_send_single_failed",
          entityType: "donor",
          entityId:   donorId,
          entityName: donorName,
          details:    (sendOk ? "צינתוק בודד שוגר ל-" : "צינתוק בודד נכשל עבור ") + phone + (sendOk ? "" : " — " + campaignErrMsg(techBody)),
          workerId:   req.user && req.user.id,
          workerName: req.user && req.user.name,
          ip:         req.ip,
        });
      } catch (logErr) {
        console.error("[Campaign/Manual] Failed to write log — send result unaffected:", logErr.message);
      }

      if (!sendOk) {
        return res.status(400).json({ error: campaignErrMsg(techBody), errorCode: techBody.errorCode, techBody: techBody });
      }

      return res.json({
        ok:         true,
        campaignId: techBody.campaignId,
        phone:      phone,
        techBody:   techBody,
      });
    } catch (err) { next(err); }
  }
);

// Duplicate-send protection for the campaign send route below. Only the
// client-side confirm() dialog + button-disable guarded against a repeated
// submission before — a second tab, a fast double-click before disabled
// took effect, or a retried request after a perceived timeout could still
// trigger a real duplicate send to donors. Rather than a blanket
// same-filter-within-N-seconds lock (which would also block two
// legitimately different campaigns that happen to share an audience filter,
// e.g. two separate "debt:200" urgent sends on different days), this
// follows the same idempotency-key pattern already used by the manual
// payment endpoints: the client generates one key per send action and
// resends it on retry; a request that reuses a key already completed
// successfully gets back the original result instead of sending again.
// Requests with no key (or a key never seen before) are unaffected.
var _campaignSendIdempotency = new Map(); // idempotencyKey -> { at, response }
var CAMPAIGN_SEND_IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;

function getCachedCampaignSend(key) {
  if (!key) return null;
  var entry = _campaignSendIdempotency.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CAMPAIGN_SEND_IDEMPOTENCY_TTL_MS) {
    _campaignSendIdempotency.delete(key);
    return null;
  }
  return entry.response;
}

function cacheCampaignSend(key, response) {
  if (!key) return;
  // Opportunistic cleanup so this map doesn't grow unbounded over a long
  // PM2 uptime — bounded by TTL, not by size, so this only matters on an
  // unusually long-running process with heavy campaign traffic.
  if (_campaignSendIdempotency.size > 500) {
    var now = Date.now();
    _campaignSendIdempotency.forEach(function (entry, k) {
      if (now - entry.at > CAMPAIGN_SEND_IDEMPOTENCY_TTL_MS) _campaignSendIdempotency.delete(k);
    });
  }
  _campaignSendIdempotency.set(key, { at: Date.now(), response: response });
}

// POST /api/technoline/send  (simplified send screen — hides all campaign API details)
// POST /api/technoline/campaign/run  (legacy alias kept for backward compat)
app.post(
  ["/api/technoline/send", "/api/technoline/campaign/run"],
  apiLimiter,
  requireRole([ROLES.ADMIN]),
  async function (req, res, next) {
    try {
      var apiKey = process.env.TECHNOLINE_API_KEY || "";
      if (!apiKey) return res.status(503).json({ error: "TECHNOLINE_API_KEY לא מוגדר בשרת" });

      var body               = req.body || {};
      var sendIdempotencyKey = body.idempotencyKey ? String(body.idempotencyKey).trim() : "";
      if (sendIdempotencyKey) {
        var cached = getCachedCampaignSend(sendIdempotencyKey);
        if (cached) {
          return res.json(Object.assign({}, cached, { idempotent: true }));
        }
      }

      var title              = String(body.title           || "").trim();
      var messageKind        = String(body.messageKind     || "ivr").trim();   // "ivr" | "text"
      var messageText        = String(body.messageText     || "").trim();
      var recipientFilter    = String(body.recipientFilter || "all").trim();
      var sendTime           = body.sendTime || null;
      var quietHours         = body.quietHours !== false;   // default true
      var fallbackToPrimary  = !!(body.fallbackToPrimary); // admin-only; default false

      // Resolve IVR extension: use env, fallback to body.extension for advanced callers
      var ivrExtension = String(
        process.env.TECHNOLINE_IVR_EXTENSION || body.extension || "9263"
      ).trim();

      // Build phone list using filter
      var phonesOverride = body.phones || null;
      var phones, listResult;
      if (Array.isArray(phonesOverride) && phonesOverride.length > 0) {
        phones = phonesOverride;
        listResult = { ivrPhoneCount: phones.length, fallbackPhoneCount: 0, fallbackDonorCount: 0 };
      } else {
        listResult = buildPhoneList(recipientFilter, { fallbackToPrimary: fallbackToPrimary });
        phones = listResult.phones;
      }

      if (phones.length === 0) {
        return res.status(400).json({ error: "אין מספרי טלפון מאושרים לשליחה עם הסינון הנבחר" });
      }

      if (messageKind === "ivr" && !ivrExtension) {
        return res.status(503).json({ error: "TECHNOLINE_IVR_EXTENSION לא מוגדר בשרת" });
      }
      if (messageKind === "text" && !messageText) {
        return res.status(400).json({ error: "יש להזין טקסט להודעה" });
      }

      var tzintukCallerId = resolveTzintukCallerId();
      if (tzintukCallerId.error) {
        logger.error("Campaign", tzintukCallerId.error);
        return res.status(500).json({ error: tzintukCallerId.error });
      }

      // Smart defaults — hidden from UI
      var params = {
        action:          "campaignRun",
        apiKey:          apiKey,
        phones:          JSON.stringify(phones),
        betweenRetries:  30,
        callLength:      25,
        dialRetries:     2,
        reasonableHours: quietHours ? "yes" : "no",
      };
      if (title)    params.title    = title;
      if (sendTime) params.sendTime = sendTime;
      if (tzintukCallerId.callId) params.callId = tzintukCallerId.callId;

      if (messageKind === "ivr") {
        params.messagesType        = "extensionActivation";
        params.extensionActivation = ivrExtension;
      } else {
        params.audioText = messageText;
      }

      var urlParams = new URLSearchParams(params);
      // apiKey + the full recipient phone list are redacted in the logged
      // copy only — this can be the entire campaign's donor phone numbers.
      var logParamsCampaign = Object.assign({}, params, {
        apiKey: maskSecret(params.apiKey),
        phones: logger.redact(params.phones),
      });
      logger.info("Campaign", "→ URL: https://app.ipsales.co.il/campaignApi.php");
      logger.info("Campaign", "→ payload:", JSON.stringify(logParamsCampaign));
      logger.info("Campaign", "launching", phones.length, "phones | title:", title, "| kind:", messageKind,
        listResult.fallbackPhoneCount > 0 ? "| fallback phones: " + listResult.fallbackPhoneCount : "");

      var techRes  = await fetch("https://app.ipsales.co.il/campaignApi.php", {
        method:  "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body:    urlParams.toString(),
        signal:  AbortSignal.timeout(30000),
      });
      var rawTextCampaign = await techRes.text();
      logger.info("Campaign", "← HTTP", techRes.status, "| body:", logger.redact(rawTextCampaign));
      var techBody;
      try {
        techBody = JSON.parse(rawTextCampaign);
      } catch (_) {
        logger.error("Campaign", "← תגובה לא-JSON מטכנוליין:", logger.redact(rawTextCampaign.slice(0, 500)));
        return res.status(502).json({ error: "תגובה לא תקינה מטכנוליין (לא JSON). בדוק לוגי שרת." });
      }

      var sendOk = String(techBody.status).toUpperCase() === "OK";

      if (!sendOk) {
        var totalFailMsg = campaignErrMsg(techBody);
        try {
          insertAuditLog({
            action:     "campaign_send_failed",
            entityType: "campaign",
            details:    "שיגור נכשל | פילטר: " + recipientFilter + " | " + totalFailMsg,
            workerId:   req.user && req.user.id,
            workerName: req.user && req.user.name,
            ip:         req.ip,
          });
        } catch (_) {}

        // Timeline — record the failed attempt for every donor that would have been
        // included, so a total rejection from Technoline doesn't vanish silently.
        if (Array.isArray(listResult.donors)) {
          listResult.donors.forEach(function (d) {
            d.phones.forEach(function (p) {
              try {
                logClick2Call({
                  pbxCallId:      null,
                  workerId:       req.user ? req.user.id   : null,
                  workerName:     req.user ? req.user.name : null,
                  donorId:        d.id,
                  donorName:      d.name,
                  donorPhone:     p,
                  agentExtension: messageKind === "ivr" ? ivrExtension : "text",
                  status:         "error",
                  errorCode:      techBody.errorCode != null ? techBody.errorCode : null,
                  errorNote:      totalFailMsg,
                });
              } catch (logErr) {
                console.error("[Campaign] Failed to write failure timeline entry for donor", d.id, ":", logErr.message);
              }
            });
          });
        }

        return res.status(400).json({ error: totalFailMsg, errorCode: techBody.errorCode });
      }

      var acceptedCount = Number(techBody.phones) || phones.length;
      var failedCount   = (Number(techBody.errorPhones) || 0) + (Number(techBody.blockedPhones) || 0);

      // General audit trail — every bulk send, not just ones using phone fallback.
      try {
        insertAuditLog({
          action:     "campaign_send",
          entityType: "campaign",
          entityId:   techBody.campaignId,
          details:    "שיגור צינתוקים | פילטר: " + recipientFilter + " | נשלחו: " + phones.length +
                      " | הצליחו: " + acceptedCount + " | נכשלו: " + failedCount +
                      (listResult.fallbackPhoneCount > 0 ? " | כולל " + listResult.fallbackPhoneCount + " מספרי fallback" : ""),
          workerId:   req.user && req.user.id,
          workerName: req.user && req.user.name,
          ip:         req.ip,
        });
      } catch (_) {}

      // Timeline — one entry per donor whose phone was included in this send. Best-effort,
      // skipped for the raw phonesOverride path (no donor list available there).
      // Technoline only returns aggregate errorPhones/blockedPhones counts, never a
      // per-recipient outcome — so when any failures occurred we cannot label individual
      // recipients "success" (misleading); we mark them with a distinct, honest status.
      var perRecipientStatusUnknown = failedCount > 0;
      if (Array.isArray(listResult.donors)) {
        listResult.donors.forEach(function (d) {
          d.phones.forEach(function (p) {
            try {
              logClick2Call({
                pbxCallId:      "campaign:" + techBody.campaignId,
                workerId:       req.user ? req.user.id   : null,
                workerName:     req.user ? req.user.name : null,
                donorId:        d.id,
                donorName:      d.name,
                donorPhone:     p,
                agentExtension: messageKind === "ivr" ? ivrExtension : "text",
                status:         perRecipientStatusUnknown ? "sent_unknown" : "success",
                errorCode:      null,
                errorNote:      perRecipientStatusUnknown
                                  ? "נשלח לקמפיין — סטטוס פרטני לא זמין (" + failedCount + " כשלים בשיגור מצטבר)"
                                  : null,
              });
            } catch (logErr) {
              console.error("[Campaign] Failed to write timeline entry for donor", d.id, ":", logErr.message);
            }
          });
        });
      }

      var successResponse = {
        ok:                 true,
        campaignId:         techBody.campaignId,
        phones:             techBody.phones,
        errorPhones:        techBody.errorPhones,
        blockedPhones:      techBody.blockedPhones,
        billing:            techBody.billing,
        ivrPhoneCount:      listResult.ivrPhoneCount,
        fallbackPhoneCount: listResult.fallbackPhoneCount,
        sentCount:          phones.length,
        successCount:       acceptedCount,
        failedCount:        failedCount,
      };
      if (sendIdempotencyKey) cacheCampaignSend(sendIdempotencyKey, successResponse);
      return res.json(successResponse);
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/technoline/campaign/history
app.get(
  "/api/technoline/campaign/history",
  requireRole([ROLES.ADMIN, ROLES.SECRETARY]),
  async function (req, res, next) {
    try {
      var extra = {};
      if (req.query.fromDate) extra.fromDate = req.query.fromDate;
      if (req.query.toDate)   extra.toDate   = req.query.toDate;
      var body = await techCampaignFetch("campaignsHistory", extra);
      if (String(body.status).toUpperCase() !== "OK") {
        return res.status(400).json({ error: campaignErrMsg(body) });
      }
      return res.json(body);
    } catch (err) { next(err); }
  }
);

// GET /api/technoline/campaign/:id/report
app.get(
  "/api/technoline/campaign/:id/report",
  requireRole([ROLES.ADMIN, ROLES.SECRETARY]),
  async function (req, res, next) {
    try {
      var body = await techCampaignFetch("campaignReport", { campaignId: req.params.id });
      return res.json(body);
    } catch (err) { next(err); }
  }
);

// POST /api/technoline/campaign/:id/hold
app.post(
  "/api/technoline/campaign/:id/hold",
  requireRole([ROLES.ADMIN]),
  async function (req, res, next) {
    try {
      var body = await techCampaignFetch("campaignHold", { campaignId: req.params.id });
      return res.json(body);
    } catch (err) { next(err); }
  }
);

// POST /api/technoline/campaign/:id/resume
app.post(
  "/api/technoline/campaign/:id/resume",
  requireRole([ROLES.ADMIN]),
  async function (req, res, next) {
    try {
      var body = await techCampaignFetch("campaignResumption", { campaignId: req.params.id });
      return res.json(body);
    } catch (err) { next(err); }
  }
);

// POST /api/technoline/campaign/:id/stop
app.post(
  "/api/technoline/campaign/:id/stop",
  requireRole([ROLES.ADMIN]),
  async function (req, res, next) {
    try {
      var body = await techCampaignFetch("campaignStop", { campaignId: req.params.id });
      return res.json(body);
    } catch (err) { next(err); }
  }
);

// ── Donor sync ────────────────────────────────────────────────────────────────
app.post(
  "/api/donors/sync",
  requireRole([ROLES.ADMIN, ROLES.SECRETARY]),
  function (req, res) {
    const list = req.body;

    if (!Array.isArray(list)) {
      return res.status(400).json({ error: "body must be an array" });
    }

    var ok = 0, skipped = 0;

    list.forEach(function (item) {
      if (!item || !item.phone || !item.fullName) { skipped += 1; return; }
      upsertDonor(item.phone, item.fullName);

      // Persist secondary phones to lookup table so IVR can find donor by any phone
      var donorRow = require("./db").findDonorByPhone(item.phone);
      if (donorRow) {
        var extras = [item.phone2, item.phone3, item.phone4]
          .concat(Array.isArray(item.ivrApprovedPhones) ? item.ivrApprovedPhones : [])
          .filter(Boolean);
        if (extras.length) upsertPhoneLookup(donorRow.id, extras);
      }

      ok += 1;
    });

    res.json({ synced: ok, skipped });
  }
);

// ── Dashboard ─────────────────────────────────────────────────────────────────
app.get(
  "/api/dashboard",
  requireRole([ROLES.ADMIN, ROLES.SECRETARY]),
  function (req, res) {
    res.json(getDashboardStats());
  }
);

// ── IVR Monitor (admin only) ──────────────────────────────────────────────────
app.get(
  "/api/admin/ivr-monitor",
  apiLimiter,
  requireRole([ROLES.ADMIN]),
  function (req, res, next) {
    try {
      var sessLimit = Math.min(Number(req.query.limit) || 50, 200);
      res.json({
        stats:    getIvrMonitorStats(),
        alerts:   getIvrAlerts(30),
        sessions: getCallSessions(sessLimit),
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── Server audit log (admin only) ────────────────────────────────────────────
app.get(
  "/api/admin/audit-log",
  apiLimiter,
  requireRole([ROLES.ADMIN]),
  function (req, res, next) {
    try {
      var limit = Math.min(Number(req.query.limit) || 200, 1000);
      res.json(getAuditLogs(limit));
    } catch (err) { next(err); }
  }
);

// ── Softphone: SIP config ────────────────────────────────────────────────────
// SECURITY NOTE: SIP_PASS is a PBX credential. Access is intentionally
// restricted to ADMIN and SECRETARY because those are the only roles that
// use the softphone. If a sip_user role is introduced in future, add it here.
app.get(
  "/api/sip-config",
  requireRole([ROLES.ADMIN, ROLES.SECRETARY]),
  function (req, res) {
    var dbCfg  = getAppState("sip_config");
    var fromDb = dbCfg && typeof dbCfg === "object" && !Array.isArray(dbCfg);
    res.json({
      server: (fromDb && dbCfg.server) || process.env.SIP_SERVER || "",
      ext:    (fromDb && dbCfg.ext)    || process.env.SIP_EXT    || "",
      user:   (fromDb && dbCfg.user)   || process.env.SIP_USER   || "",
      pass:   (fromDb && dbCfg.pass)   || process.env.SIP_PASS   || "",
    });
  }
);

app.put("/api/sip-config", requireRole([ROLES.ADMIN]), function (req, res) {
  var server = String(req.body.server || "").trim();
  var ext    = String(req.body.ext    || "").trim();
  var user   = String(req.body.user   || "").trim();
  var pass   = String(req.body.pass   || "").trim();
  if (!server || !pass) {
    return res.status(400).json({ error: "שדות חובה: server ו-pass" });
  }
  setAppState("sip_config", { server, ext, user, pass });
  insertAuditLog({
    action: "SIP_CONFIG_SAVED",
    details: "server=" + server + " ext=" + ext + " user=" + user,
    workerId:   req.user.id,
    workerName: req.user.name,
    ip: req.ip,
  });
  res.json({ ok: true });
});

// ── Softphone: caller context (donor lookup by phone number) ──────────────────
app.get("/api/softphone/context", requireAuth, function (req, res, next) {
  try {
    var phone = normalizePhone(req.query.phone || "");
    if (!phone) return res.json({ context: null });
    var donor = getDonorForIvr(phone);
    if (!donor) return res.json({ context: null });
    res.json({
      context: {
        phone:   donor.phone,
        name:    donor.fullName,
        debt:    donor.currentDebt ? donor.currentDebt.amount  : 0,
        purpose: donor.currentDebt ? donor.currentDebt.purpose : "",
      },
    });
  } catch (err) { next(err); }
});

// ── Softphone: outgoing caller-ID selection (browser SIP calls) ──────────────
// IMPORTANT — see docs/softphone-caller-id-technoline-question.md: Technoline
// has NO documented mechanism (as of this writing) for selecting a per-call
// outbound Caller-ID on a registered SIP/WebRTC extension (unlike callId on
// campaignRun or callerId on click2call, which ARE documented HTTP-API
// parameters). This selection is therefore stored as the operator's request
// only — nothing here modifies the SIP INVITE. Do not treat storage of this
// value as proof it changes what the donor's phone displays.
var SOFTPHONE_ALLOWED_CALLER_IDS = [
  { number: "023766193", label: "מספר ראשי" },
  { number: "025378787", label: "מספר חדש" },
];
var SOFTPHONE_ALLOWED_CALLER_ID_SET = {};
SOFTPHONE_ALLOWED_CALLER_IDS.forEach(function (c) { SOFTPHONE_ALLOWED_CALLER_ID_SET[c.number] = true; });

app.get("/api/softphone/caller-ids", requireRole([ROLES.ADMIN, ROLES.SECRETARY]), function (req, res) {
  res.json({ options: SOFTPHONE_ALLOWED_CALLER_IDS });
});

// Matches a normalized phone to an app donor (by any phone field) or a
// custom softphone contact (by primary/additional phone) — used to attach
// donorId/donorName/contactId/contactName to a call-history row server-side,
// so the frontend never has to be trusted for that link.
function matchSoftphoneCallerIdentity(normalizedPhone) {
  if (!normalizedPhone) return {};
  var donors = allAppDonors();
  for (var i = 0; i < donors.length; i++) {
    if (getAllDonorPhones(donors[i]).indexOf(normalizedPhone) !== -1) {
      return {
        donorId:   donors[i].id != null ? donors[i].id : null,
        donorName: donors[i].fullName || null,
      };
    }
  }
  var contact = findSoftphoneContactByAnyPhone(normalizedPhone);
  if (contact) {
    return { contactId: contact.id, contactName: contact.name };
  }
  return {};
}

// ── Softphone: call-history lifecycle events ─────────────────────────────────
// The browser posts one event per JsSIP RTCSession lifecycle stage (created /
// progress / accepted / ended / failed); classification into the final
// status happens client-side (softphone-call-classifier.js, exercised by the
// same module in tests) — this endpoint only validates + persists, upserting
// by sipCallId so repeated events for one session never duplicate a row.
app.post(
  "/api/softphone/calls/event",
  apiLimiter,
  requireRole([ROLES.ADMIN, ROLES.SECRETARY]),
  function (req, res, next) {
    try {
      var body = req.body || {};
      var direction = body.direction === "incoming" ? "incoming" : "outgoing";
      var remotePhone = normalizePhone(body.remotePhone || "");
      if (!remotePhone) return res.status(400).json({ error: "remotePhone חסר או לא תקין" });
      var status = String(body.status || "").trim();
      if (callClassifier.STATUSES.indexOf(status) === -1) {
        return res.status(400).json({ error: "סטטוס שיחה לא תקין" });
      }

      var selectedCallerId = body.selectedCallerId ? String(body.selectedCallerId).trim() : null;
      if (selectedCallerId && !SOFTPHONE_ALLOWED_CALLER_ID_SET[selectedCallerId]) {
        return res.status(400).json({ error: "מזהה מתקשר יוצא לא מאושר: " + selectedCallerId });
      }

      var identity = matchSoftphoneCallerIdentity(remotePhone);

      var row = upsertSoftphoneCall({
        sipCallId:        String(body.sipCallId || "").trim(),
        direction:        direction,
        remotePhone:      remotePhone,
        donorId:          identity.donorId,
        donorName:        identity.donorName,
        contactId:        identity.contactId,
        contactName:      identity.contactName,
        selectedCallerId: selectedCallerId,
        workerId:         req.user.id,
        workerName:       req.user.name,
        startedAt:        body.startedAt  || null,
        ringingAt:        body.ringingAt  || null,
        answeredAt:       body.answeredAt || null,
        endedAt:          body.endedAt    || null,
        status:           status,
        rawSipCause:      body.rawSipCause ? String(body.rawSipCause).slice(0, 200) : null,
      });

      res.json({ ok: true, call: row });
    } catch (err) {
      if (err && err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
      next(err);
    }
  }
);

app.get(
  "/api/softphone/calls",
  requireRole([ROLES.ADMIN, ROLES.SECRETARY]),
  function (req, res, next) {
    try {
      var result = getSoftphoneCalls({
        statusGroup: req.query.statusGroup,
        search:      req.query.search,
        page:        req.query.page,
        pageSize:    req.query.pageSize,
      });
      res.json(result);
    } catch (err) { next(err); }
  }
);

app.delete(
  "/api/softphone/calls/:id",
  requireRole([ROLES.ADMIN]),
  function (req, res, next) {
    try {
      var id = Number(req.params.id);
      var existing = getSoftphoneCallById(id);
      if (!existing) return res.status(404).json({ error: "רשומת שיחה לא נמצאה" });
      deleteSoftphoneCall(id);
      insertAuditLog({
        action:     "softphone_call_deleted",
        entityType: "softphone_call",
        entityId:   id,
        entityName: existing.remotePhone,
        details:    "נמחקה רשומת היסטוריית שיחה (" + existing.direction + ", " + existing.status + ")",
        workerId:   req.user.id,
        workerName: req.user.name,
        ip:         req.ip,
      });
      res.json({ ok: true });
    } catch (err) { next(err); }
  }
);

// ── Softphone: contacts (donors merged live + custom contacts) ───────────────

app.get(
  "/api/softphone/contacts",
  requireRole([ROLES.ADMIN, ROLES.SECRETARY]),
  function (req, res, next) {
    try {
      var search = req.query.search ? String(req.query.search).trim() : "";
      var searchLower = search.toLowerCase();
      var searchDigits = search.replace(/\D/g, ""); // for ID-number matching only
      // "0253...", "02-53...", "+972-2-53...", and an already-normalized
      // number must all find the same contact — run the search term through
      // the exact same phone normalization used for stored donor phones
      // (leading zero preserved, 972-prefix converted), not just digit-strip.
      var searchPhoneDigits = normalizePhone(search);

      var donorContacts = allAppDonors()
        .filter(function (d) { return d.id !== undefined && d.id !== null && d.id !== ""; })
        .filter(function (d) {
          if (!search) return true;
          var name = (d.fullName || "").toLowerCase();
          if (name.indexOf(searchLower) !== -1) return true;
          if (d.city && String(d.city).toLowerCase().indexOf(searchLower) !== -1) return true;
          if (d.address && String(d.address).toLowerCase().indexOf(searchLower) !== -1) return true;
          if (searchDigits && d.idNumber && normalizeIdNumber(d.idNumber).indexOf(searchDigits) !== -1) return true;
          if (searchPhoneDigits && getAllDonorPhones(d).some(function (p) { return p.indexOf(searchPhoneDigits) !== -1; })) return true;
          return false;
        })
        .map(function (d) {
          return {
            type:    "donor",
            id:      d.id,
            name:    d.fullName || "",
            phones:  getAllDonorPhones(d),
            city:    d.city    || "",
            address: d.address || "",
          };
        });

      var customContacts = getSoftphoneContacts(search).map(function (c) {
        return {
          type:   "custom",
          id:     c.id,
          name:   c.name,
          phones: [c.primaryPhone].concat(c.additionalPhones),
          notes:  c.notes,
        };
      });

      res.json({ contacts: donorContacts.concat(customContacts) });
    } catch (err) { next(err); }
  }
);

app.post(
  "/api/softphone/contacts",
  requireRole([ROLES.ADMIN, ROLES.SECRETARY]),
  function (req, res, next) {
    try {
      var body = req.body || {};
      var contact = createSoftphoneContact({
        name:             body.name,
        primaryPhone:     body.primaryPhone,
        additionalPhones: body.additionalPhones,
        notes:            body.notes,
      }, req.user);
      insertAuditLog({
        action:     "softphone_contact_created",
        entityType: "softphone_contact",
        entityId:   contact.id,
        entityName: contact.name,
        details:    "איש קשר חדש נוצר: " + contact.name,
        workerId:   req.user.id,
        workerName: req.user.name,
        ip:         req.ip,
      });
      res.json({ ok: true, contact: contact });
    } catch (err) {
      if (err && err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
      next(err);
    }
  }
);

app.put(
  "/api/softphone/contacts/:id",
  requireRole([ROLES.ADMIN, ROLES.SECRETARY]),
  function (req, res, next) {
    try {
      var body = req.body || {};
      var contact = updateSoftphoneContact(Number(req.params.id), {
        name:             body.name,
        primaryPhone:     body.primaryPhone,
        additionalPhones: body.additionalPhones,
        notes:            body.notes,
      });
      insertAuditLog({
        action:     "softphone_contact_updated",
        entityType: "softphone_contact",
        entityId:   contact.id,
        entityName: contact.name,
        details:    "איש קשר עודכן: " + contact.name,
        workerId:   req.user.id,
        workerName: req.user.name,
        ip:         req.ip,
      });
      res.json({ ok: true, contact: contact });
    } catch (err) {
      if (err && err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
      next(err);
    }
  }
);

app.delete(
  "/api/softphone/contacts/:id",
  requireRole([ROLES.ADMIN, ROLES.SECRETARY]),
  function (req, res, next) {
    try {
      var id = Number(req.params.id);
      var existing = getSoftphoneContacts().find(function (c) { return c.id === id; });
      var deleted = deleteSoftphoneContact(id);
      if (!deleted) return res.status(404).json({ error: "איש קשר לא נמצא" });
      insertAuditLog({
        action:     "softphone_contact_deleted",
        entityType: "softphone_contact",
        entityId:   id,
        entityName: existing ? existing.name : null,
        details:    "איש קשר נמחק" + (existing ? ": " + existing.name : ""),
        workerId:   req.user.id,
        workerName: req.user.name,
        ip:         req.ip,
      });
      res.json({ ok: true });
    } catch (err) { next(err); }
  }
);

// ── IVR webhook (Technoline PBX) ──────────────────────────────────────────────
// Technoline sends all accumulated query params on every step.
// The route stays stateless: only req.query and SQLite are used.
app.get("/ivr", ivrLimiter, requireIvrKey, function (req, res) {
  try {
    console.log("[IVR] QUERY:", JSON.stringify(sanitizeIvrQueryForLog(req.query)));
    console.log("[IVR] mainChoice =", req.query.mainChoice, "| payChoice =", req.query.payChoice, "| debtChoice =", req.query.debtChoice);
    var q      = req.query || {};
    var result = handleIvrQuery(q);

    if (result.hangup) {
      return res.status(200).end();
    }

    // Log the JSON we're sending back to the PBX (visible in debug panel)
    var debugId    = String(q.PBXcallId  || "").trim() || (String(q.PBXphone || "").trim() + "-" + Date.now());
    var debugPhone = String(q.PBXphone   || "").trim() || null;
    try { insertCallLog(debugId, debugPhone, "response_json", { modules: result.response }); } catch (_) {}

    return res
      .status(200)
      .set("Content-Type", "application/json; charset=utf-8")
      .json(result.response);
  } catch (err) {
    console.error("[IVR] Request failed:", err && err.message ? err.message : err);
    return res
      .status(200)
      .set("Content-Type", "application/json; charset=utf-8")
      .json(ivrErrorResponse());
  }
});

// ── IVR Audio trial (Technoline fileLink/fileName experiment) ─────────────────
// Isolated, temporary, self-contained — see ivr-audio-trial.route.js header
// for the full auth/scenario design. Does not touch /ivr, extension 9263,
// ivr.js, ivr.service.js, donors, payments, or the ivr_audio_recordings table.
// Reuses the same ivrLimiter as the production /ivr route.
app.get("/ivr-audio-trial", ivrLimiter, ivrAudioTrialHandler);

// ── Address-book sync (admin only) ───────────────────────────────────────────

app.post("/api/sync/preview", requireRole([ROLES.ADMIN]), function (req, res) {
  try {
    var content  = String(req.body.content  || "");
    if (!content) return res.status(400).json({ error: "תוכן קובץ ריק" });

    var parsed = parseCsv(content);
    if (parsed.errors.length) return res.status(400).json({ error: parsed.errors[0] });

    var existingDonors = getAppState("donors");
    if (!Array.isArray(existingDonors)) existingDonors = [];

    var preview = buildPreview(parsed.rows, existingDonors);

    var counts = { create: 0, update: 0, unchanged: 0, skip: 0 };
    preview.forEach(function (r) {
      if (r.action === "create")    counts.create++;
      else if (r.action === "update")    counts.update++;
      else if (r.action === "unchanged") counts.unchanged++;
      else counts.skip++;
    });

    res.json({ counts: counts, preview: preview.slice(0, 200) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/sync/apply", requireRole([ROLES.ADMIN]), function (req, res) {
  try {
    var content  = String(req.body.content  || "");
    var filename = String(req.body.filename || "");
    if (!content) return res.status(400).json({ error: "תוכן קובץ ריק" });

    var parsed = parseCsv(content);
    if (parsed.errors.length) return res.status(400).json({ error: parsed.errors[0] });

    var existingDonors = getAppState("donors");
    if (!Array.isArray(existingDonors)) existingDonors = [];

    var preview = buildPreview(parsed.rows, existingDonors);
    var result  = applySync(preview, existingDonors, upsertDonor);

    setAppState("donors", result.donors);

    insertSyncLog({
      filename:   filename,
      added:      result.added,
      updated:    result.updated,
      skipped:    result.skipped,
      failed:     result.failed,
      workerName: req.user.name,
    });
    insertAuditLog({
      action:     "SYNC_ALPHON",
      entityType: "donors",
      details:    "added=" + result.added + " updated=" + result.updated + " skipped=" + result.skipped,
      workerId:   req.user.id,
      workerName: req.user.name,
      ip:         req.ip,
    });

    res.json({ ok: true, added: result.added, updated: result.updated, skipped: result.skipped, failed: result.failed });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/sync/logs", requireRole([ROLES.ADMIN]), function (req, res) {
  res.json(getSyncLogs(50));
});

// ── Alfon API fetch (server pulls from external alfon API) ───────────────────

var ALFON_API_URL = (process.env.ALFON_API_URL || "").trim() ||
  "https://utilitiesphone.com/persons/dashboard/data.php?type_data=get_persons&filter=approval=1";

// Returns city map merged from DB (admin-editable) + city_map.js file (fallback)
function getCombinedCityMap() {
  var dbMap = getAppState("alfon_city_map");
  if (!dbMap || typeof dbMap !== "object" || Array.isArray(dbMap)) dbMap = {};
  return Object.assign({}, CITY_MAP, dbMap); // DB overrides file
}

// Returns raw city ID string (digits only) or "" for non-numeric / missing
function getCityRawId(p) {
  var raw = "";
  if (p.city !== null && p.city !== undefined) {
    raw = typeof p.city === "object"
      ? String(p.city.id || p.city.city_id || "")
      : String(p.city);
  } else if (p.city_id !== null && p.city_id !== undefined) {
    raw = String(p.city_id);
  }
  raw = raw.trim();
  return /^\d+$/.test(raw) && raw !== "0" ? raw : "";
}

// Returns resolved Hebrew city name.
// This API provides city_description (e.g. "בית שמש") alongside numeric city field.
function resolveCity(p, cityMap) {
  // 1. city_description is the authoritative Hebrew name from this API
  var desc = String(p.city_description || "").trim();
  if (desc && !/^\d+$/.test(desc)) return desc;

  // 2. Other explicit text name fields (generic fallback for future APIs)
  var textCandidates = ["city_name", "city_title", "city_label", "city_text"];
  for (var i = 0; i < textCandidates.length; i++) {
    var v = String(p[textCandidates[i]] || "").trim();
    if (v && !/^\d+$/.test(v)) return v;
  }

  // 3. city field is already a non-numeric name (some APIs)
  if (p.city && typeof p.city === "string" && !/^\d+$/.test(p.city.trim())) {
    return p.city.trim();
  }

  // 4. Last resort: numeric ID → look up in admin-configured city map
  var rawId = getCityRawId(p);
  if (rawId) return (cityMap || {})[rawId] || "";

  return "";
}

// Collects all unique normalized phones from all phone-like fields
var PHONE_FIELDS_PRIORITY = [
  "telephone", "phone", "mobile",
  "phone2", "phone3", "phone4",
  "mobile2", "mobile3",
  "father_phone", "mother_phone",
];
function collectPersonPhones(person) {
  var candidates = PHONE_FIELDS_PRIORITY.slice();
  // Auto-detect any additional field whose name contains phone/tel/mobile
  Object.keys(person).forEach(function (k) {
    if (/phone|tel|mobile/i.test(k) && !candidates.includes(k)) candidates.push(k);
  });
  var seen = {};
  var phones = [];
  candidates.forEach(function (field) {
    var n = normPhone(String(person[field] || ""));
    if (n && !seen[n]) { seen[n] = true; phones.push(n); }
  });
  return phones; // normalized, deduped, in priority order
}

function personsJsonToCsv(persons, cityMap) {
  var headers = [
    "מספר סידורי","מ.ס.","שם פרטי","שם משפחה","תעודת זהות",
    "תואר לפני","תואר לאחר","שם אב","קטגוריה",
    "ישוב","שכונה","רחוב","מספר בית","דירה","כניסה",
    "פלאפון א","פלאפון ב","טלפון ביתי","פלאפון נוסף",
  ];
  var lines = [headers.map(function (h) { return '"' + h + '"'; }).join(",")];
  (Array.isArray(persons) ? persons : []).forEach(function (p) {
    var phones = collectPersonPhones(p);
    var row = [
      p.person_id    || "",
      p.serial       || "",
      p.first_name   || "",
      p.last_name    || "",
      p.id_number    || "",
      p.before_name  || "",
      p.after_name   || "",
      p.father_name  || "",
      p.category     || "",
      resolveCity(p, cityMap),
      (p.neighborhood_description && !/^\d+$/.test(p.neighborhood_description))
        ? p.neighborhood_description : "",
      p.street       || "",
      p.house_number || "",
      p.house_in_building || p.apartment || "",
      p.enter        || p.entrance     || "",
      phones[0]      || "",
      phones[1]      || "",
      phones[2]      || "",
      phones[3]      || "",
    ];
    lines.push(row.map(function (v) {
      return '"' + String(v).replace(/"/g, '""') + '"';
    }).join(","));
  });
  return "﻿" + lines.join("\r\n");
}

// Get/save city map (DB-backed, editable from UI)
app.get("/api/sync/city-map", requireRole([ROLES.ADMIN]), function (req, res) {
  res.json(getCombinedCityMap());
});

app.put("/api/sync/city-map", requireRole([ROLES.ADMIN]), function (req, res) {
  var incoming = req.body;
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    return res.status(400).json({ error: "גוף הבקשה חייב להיות אובייקט {id: שם}" });
  }
  // Sanitize: keys must be digit strings, values non-empty strings
  var clean = {};
  Object.keys(incoming).forEach(function (k) {
    var v = String(incoming[k] || "").trim();
    if (/^\d+$/.test(k) && v) clean[k] = v;
  });
  setAppState("alfon_city_map", clean);
  insertAuditLog({
    action: "CITY_MAP_SAVED", entityType: "settings",
    details: "entries=" + Object.keys(clean).length,
    workerId: req.user.id, workerName: req.user.name, ip: req.ip,
  });
  res.json({ ok: true, entries: Object.keys(clean).length });
});

app.post("/api/sync/alfon-api-fetch", requireRole([ROLES.ADMIN]), async function (req, res) {
  try {
    var apiRes = await fetch(ALFON_API_URL, { headers: { Accept: "application/json" } });
    if (!apiRes.ok) return res.status(502).json({ error: "API returned " + apiRes.status });

    var persons = await apiRes.json();
    if (!Array.isArray(persons)) {
      persons = persons.data || persons.persons || persons.results || Object.values(persons);
    }
    if (!Array.isArray(persons)) return res.status(502).json({ error: "API לא החזיר מערך" });

    var cityMap = getCombinedCityMap();

    // Build city report: rawId → { mapped: resolved_name|null, count }
    var cityReport = {};
    persons.forEach(function (p) {
      var rawId   = getCityRawId(p);
      if (!rawId) return;
      var resolved = resolveCity(p, cityMap) || null;
      if (!cityReport[rawId]) cityReport[rawId] = { mapped: resolved, count: 0 };
      cityReport[rawId].count++;
    });
    var unknownCityIds = Object.keys(cityReport).filter(function (id) { return !cityReport[id].mapped; });
    if (unknownCityIds.length) {
      console.warn("[alfon-api] city IDs without mapping:", unknownCityIds.join(", "));
    }

    var csvContent = personsJsonToCsv(persons, cityMap);
    var filename   = "alfon_api_" + new Date().toISOString().slice(0, 10) + ".csv";

    var parsed         = parseCsv(csvContent);
    var existingDonors = getAppState("donors") || [];
    var preview        = buildPreview(parsed.rows, existingDonors);

    var counts = {
      create:    preview.filter(function (r) { return r.action === "create";    }).length,
      update:    preview.filter(function (r) { return r.action === "update";    }).length,
      unchanged: preview.filter(function (r) { return r.action === "unchanged"; }).length,
      skip:      preview.filter(function (r) { return r.action === "skip";      }).length,
    };

    var pendingId = insertAlfonPending({
      filename,
      csvContent,
      previewAdded:   counts.create,
      previewUpdated: counts.update,
      previewSkipped: counts.skip,
    });

    insertAuditLog({
      action: "ALFON_API_FETCH", entityType: "donors",
      details: "pendingId=" + pendingId + " persons=" + persons.length,
      workerId: req.user.id, workerName: req.user.name, ip: req.ip,
    });

    res.json({ pendingId, counts, total: persons.length, unknownCityIds, cityReport });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Alfon auto-sync (local agent → server) ───────────────────────────────────

var alfonLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: "Rate limit exceeded" },
});

function requireAlfonKey(req, res, next) {
  var key = (process.env.ALFON_SYNC_KEY || "").trim();
  if (!key) return res.status(503).json({ error: "ALFON_SYNC_KEY not configured on server" });
  if (!timingSafeEq(req.headers["x-alfon-key"] || "", key)) return res.status(401).json({ error: "Invalid API key" });
  next();
}

// Agent uploads CSV → stored as pending (no auto-apply)
app.post("/api/sync/alfon-auto", alfonLimiter, requireAlfonKey, function (req, res) {
  try {
    var content  = String(req.body.content  || "");
    var filename = String(req.body.filename || "alfon_auto.csv");
    if (!content) return res.status(400).json({ error: "content required" });

    var parsed = parseCsv(content);
    if (parsed.errors.length) return res.status(400).json({ error: parsed.errors[0] });

    var existingDonors = getAppState("donors");
    if (!Array.isArray(existingDonors)) existingDonors = [];
    var preview = buildPreview(parsed.rows, existingDonors);

    var counts = { create: 0, update: 0, unchanged: 0, skip: 0 };
    preview.forEach(function (r) { counts[r.action] = (counts[r.action] || 0) + 1; });

    var pendingId = insertAlfonPending({
      filename:       filename,
      csvContent:     content,
      previewAdded:   counts.create,
      previewUpdated: counts.update,
      previewSkipped: counts.skip + counts.unchanged,
    });

    console.log("[Alfon] Agent upload accepted. pendingId=" + pendingId +
      " new=" + counts.create + " update=" + counts.update);

    res.json({ ok: true, pendingId: pendingId, counts: counts });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: list pending uploads
app.get("/api/sync/alfon-pending", requireRole([ROLES.ADMIN]), function (req, res) {
  res.json(getAlfonPending());
});

// Admin: live preview of a specific pending upload
app.get("/api/sync/alfon-pending/:id/preview", requireRole([ROLES.ADMIN]), function (req, res) {
  try {
    var record = getAlfonPendingById(req.params.id);
    if (!record) return res.status(404).json({ error: "לא נמצא" });
    if (record.status !== "pending") return res.status(400).json({ error: "כבר טופל (" + record.status + ")" });

    var parsed = parseCsv(record.csvContent);
    var existingDonors = getAppState("donors");
    if (!Array.isArray(existingDonors)) existingDonors = [];
    var preview = buildPreview(parsed.rows, existingDonors);

    var counts = { create: 0, update: 0, unchanged: 0, skip: 0 };
    preview.forEach(function (r) { counts[r.action] = (counts[r.action] || 0) + 1; });

    res.json({
      id: record.id, createdAt: record.createdAt, filename: record.filename,
      counts: counts, preview: preview.slice(0, 200),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: approve → apply sync
app.post("/api/sync/alfon-pending/:id/approve", requireRole([ROLES.ADMIN]), function (req, res) {
  try {
    var record = getAlfonPendingById(req.params.id);
    if (!record) return res.status(404).json({ error: "לא נמצא" });
    if (record.status !== "pending") return res.status(400).json({ error: "כבר טופל (" + record.status + ")" });

    var parsed = parseCsv(record.csvContent);
    var existingDonors = getAppState("donors");
    if (!Array.isArray(existingDonors)) existingDonors = [];
    var preview = buildPreview(parsed.rows, existingDonors);
    var result  = applySync(preview, existingDonors, upsertDonor);

    setAppState("donors", result.donors);
    updateAlfonPendingStatus(record.id, "approved", req.user.name);

    insertSyncLog({
      filename:   record.filename,
      added:      result.added,
      updated:    result.updated,
      skipped:    result.skipped,
      failed:     result.failed,
      workerName: req.user.name,
    });
    insertAuditLog({
      action:     "ALFON_SYNC_APPROVED",
      entityType: "donors",
      details:    "pendingId=" + record.id + " added=" + result.added + " updated=" + result.updated,
      workerId:   req.user.id,
      workerName: req.user.name,
      ip: req.ip,
    });

    res.json({ ok: true, added: result.added, updated: result.updated,
               skipped: result.skipped, failed: result.failed });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: reject → discard without applying
app.post("/api/sync/alfon-pending/:id/reject", requireRole([ROLES.ADMIN]), function (req, res) {
  try {
    var record = getAlfonPendingById(req.params.id);
    if (!record) return res.status(404).json({ error: "לא נמצא" });
    if (record.status !== "pending") return res.status(400).json({ error: "כבר טופל" });

    updateAlfonPendingStatus(record.id, "rejected", req.user.name);
    insertAuditLog({
      action: "ALFON_SYNC_REJECTED", entityType: "donors",
      details: "pendingId=" + record.id + " file=" + record.filename,
      workerId: req.user.id, workerName: req.user.name, ip: req.ip,
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── AI Assistant (read-only) ──────────────────────────────────────────────────
app.post(
  "/api/ai/query",
  apiLimiter,
  requireRole([ROLES.ADMIN, ROLES.SECRETARY]),
  async function (req, res, next) {
    try {
      var body        = req.body || {};
      var question    = String(body.question || "").trim();
      var donorId     = body.donorId ? Number(body.donorId) : null;
      var history     = Array.isArray(body.history) ? body.history.slice(-10) : [];
      var pageContext = String(body.pageContext || "global");

      if (!question) {
        return res.status(400).json({ error: "שאלה ריקה" });
      }
      if (question.length > 500) {
        return res.status(400).json({ error: "שאלה ארוכה מדי (מקסימום 500 תווים)" });
      }

      var result = await queryAI({ question, donorId, history, pageContext });

      recordAiQuery({
        worker:      req.user,
        ip:          req.ip,
        question:    question,
        donorId:     donorId,
        pageContext: pageContext,
        intent:      result.intent,
        model:       result.model || "local",
        confidence:  result.debug && result.debug.confidence,
        fallback:    result.fallback || false,
      });

      return res.json({
        answer:      result.answer,
        intent:      result.intent,
        model:       result.model || "local",
        fallback:    result.fallback || false,
        suggestions: result.suggestions || [],
        debug:       result.debug || null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/ai/capabilities — machine-readable capability list, filtered to
// what the requesting worker's role is actually allowed to see. A SECRETARY
// must never learn that an ADMIN-only capability id/description even
// exists — so filtering happens server-side, not by hiding buttons in the UI.
app.get(
  "/api/ai/capabilities",
  apiLimiter,
  requireRole([ROLES.ADMIN, ROLES.SECRETARY]),
  function (req, res, next) {
    try {
      var caps = aiCapabilities.listCapabilities({ role: req.userRole });
      res.json({ role: req.userRole, capabilities: caps });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/ai/search?q=...&field=name|phone|idNumber|city|any — Phase C:
// global donor search + explicit disambiguation. Read-only; matches the
// same field set frontend/js/donors.js already searches.
app.get(
  "/api/ai/search",
  apiLimiter,
  requireRole([ROLES.ADMIN, ROLES.SECRETARY]),
  function (req, res, next) {
    try {
      var q = String(req.query.q || "").trim();
      if (!q) return res.status(400).json({ error: "פרמטר q (מונח חיפוש) חסר" });
      if (q.length > 100) return res.status(400).json({ error: "מונח חיפוש ארוך מדי" });
      var result = searchDonors(q, { field: req.query.field, limit: req.query.limit });
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ── AI action framework (Phase F) — prepare → confirm → execute ───────────────
// Every stage requires the same auth as the rest of the AI routes; the
// framework itself (ai/actions/index.js) does the finer-grained per-action
// role/status check, since different actions may allow different roles.
app.post(
  "/api/ai/actions/prepare",
  apiLimiter,
  requireRole([ROLES.ADMIN, ROLES.SECRETARY]),
  async function (req, res, next) {
    try {
      var body = req.body || {};
      var result = await aiActions.prepareAction({
        actionId: String(body.actionId || ""),
        params: body.params || {},
        worker: req.user,
        ip: req.ip,
        idempotencyKey: body.idempotencyKey ? String(body.idempotencyKey) : null,
      });
      if (result.error) return res.status(400).json(result);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

app.post(
  "/api/ai/actions/confirm",
  apiLimiter,
  requireRole([ROLES.ADMIN, ROLES.SECRETARY]),
  function (req, res, next) {
    try {
      var body = req.body || {};
      var result = aiActions.confirmAction({
        token: String(body.token || ""),
        worker: req.user,
        ip: req.ip,
      });
      if (result.error) return res.status(400).json(result);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

app.post(
  "/api/ai/actions/execute",
  apiLimiter,
  requireRole([ROLES.ADMIN, ROLES.SECRETARY]),
  async function (req, res, next) {
    try {
      var body = req.body || {};
      var result = await aiActions.executeAction({
        token: String(body.token || ""),
        worker: req.user,
        ip: req.ip,
      });
      if (result.error) return res.status(400).json(result);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ── Server backup management (admin only) ────────────────────────────────────
// Must stay registered before the catch-all 404 below — Express matches
// routes in registration order, so anything placed after the 404 handler
// is unreachable dead code.

const BACKUP_DIR = path.join(__dirname, "backups");

app.get(
  "/api/admin/backups/list",
  apiLimiter,
  requireRole([ROLES.ADMIN]),
  function (req, res, next) {
    try {
      if (!fs.existsSync(BACKUP_DIR)) return res.json([]);
      const files = fs.readdirSync(BACKUP_DIR)
        .filter(function (f) { return f.endsWith(".sqlite"); })
        .sort()
        .reverse()
        .map(function (f) {
          var stat = fs.statSync(path.join(BACKUP_DIR, f));
          return { name: f, size: stat.size, mtime: stat.mtime.toISOString() };
        });
      res.json(files);
    } catch (err) { next(err); }
  }
);

app.post(
  "/api/admin/backups/run",
  apiLimiter,
  requireRole([ROLES.ADMIN]),
  function (req, res, next) {
    try {
      if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
      const dest  = path.join(BACKUP_DIR, "data-" + stamp + ".sqlite");
      backupDatabase(dest);
      insertAuditLog({ action: "BACKUP_RUN", entityType: "system", entityId: "", entityName: "manual backup", details: dest, workerId: req.user && req.user.id, workerName: req.user && req.user.name, ip: req.ip });
      res.json({ ok: true, name: path.basename(dest) });
    } catch (err) { next(err); }
  }
);

app.post(
  "/api/admin/backups/restore/:filename",
  apiLimiter,
  requireRole([ROLES.ADMIN]),
  function (req, res, next) {
    try {
      const filename = path.basename(req.params.filename); // strip any path traversal
      if (!filename.endsWith(".sqlite") || filename.includes("..")) {
        return res.status(400).json({ error: "שם קובץ לא תקין" });
      }
      const srcPath = path.join(BACKUP_DIR, filename);
      if (!fs.existsSync(srcPath)) return res.status(404).json({ error: "גיבוי לא נמצא" });
      const restoredCounts = restoreFromBackup(srcPath);
      const tableSummary = Object.keys(restoredCounts)
        .map(function (t) { return t + "=" + restoredCounts[t]; })
        .join(", ");
      insertAuditLog({ action: "BACKUP_RESTORED", entityType: "system", entityId: "", entityName: filename, details: "כל הטבלאות שוחזרו: " + tableSummary, workerId: req.user && req.user.id, workerName: req.user && req.user.name, ip: req.ip });
      res.json({ ok: true, restored: restoredCounts });
    } catch (err) { next(err); }
  }
);

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use(function (req, res) {
  res.status(404).json({ error: "Not found" });
});

// ── Global error handler ──────────────────────────────────────────────────────
// Catches errors from every route in the app (donor/payment/worker/IVR data
// included) — routed through the logger at ERROR level for consistency with
// the rest of the "sensitive places" clean-up (#30). The error itself is not
// redacted here (its shape is unknown ahead of time), only classified.
app.use(function (err, req, res, _next) {
  logger.error("Server", "Unhandled error on " + req.method + " " + req.path + ":", err);
  // body-parser's "request entity too large" (from the new per-route limits,
  // #34) sets its own status/statusCode (413) — preserve that instead of
  // always answering 500, so an oversized request gets an accurate error.
  // Falls back to 500 for every other kind of error exactly as before.
  var status = (err && (err.status || err.statusCode)) || 500;
  res.status(status).json({ error: status === 413 ? "הבקשה גדולה מדי" : "Internal server error" });
});

// ─────────────────────────────────────────────────────────────────────────────

// Exported unconditionally so tests can `require("./server")` to get the
// Express app and drive it with their own ephemeral http server (same
// pattern already used by ivr-audio-paymsg.routes.test.js), without ever
// binding the real PORT or running the backup job below. Has no effect on
// production: PM2 always launches this file as `node server.js`
// (pm2.ecosystem.config.js: script: "server.js"), so require.main === module
// there and the guarded block always runs exactly as before.
module.exports = app;

if (require.main === module) {
  app.listen(PORT, function () {
    console.log("[" + new Date().toISOString() + "] Server running on port " + PORT + " (NODE_ENV=" + (process.env.NODE_ENV || "development") + ")");
  });

  // ── Daily SQLite backup ─────────────────────────────────────────────────────
  (function scheduleDailyBackup() {
    const BACKUP_DIR   = path.join(__dirname, "backups");
    const MAX_AGE_DAYS = 30; // README_PRODUCTION.md documents "~30 days" of backups

    function todayDateStamp() {
      return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    }

    // A frequent restart/deploy day used to create a fresh backup every single
    // time (this function also runs once immediately on startup, below) — skip
    // if today's backup already exists instead of piling up several per day.
    function hasBackupForToday() {
      if (!fs.existsSync(BACKUP_DIR)) return false;
      const today = todayDateStamp();
      return fs.readdirSync(BACKUP_DIR).some(function (f) {
        return f.indexOf("data-" + today) === 0 && f.endsWith(".sqlite");
      });
    }

    function runBackup() {
      if (!fs.existsSync(BACKUP_DIR)) {
        try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); } catch (e) {
          console.error("[Backup] Cannot create backup dir:", e.message);
          return;
        }
      }

      if (hasBackupForToday()) {
        console.log("[Backup] Already have a backup for today — skipping.");
      } else {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
        const dest  = path.join(BACKUP_DIR, "data-" + stamp + ".sqlite");
        try {
          backupDatabase(dest);
          console.log("[Backup] Created:", dest);
        } catch (e) {
          console.error("[Backup] Failed:", e.message);
        }
      }

      // Prune by age (matches the ~30-days retention already documented in
      // README_PRODUCTION.md), not by file count — a count-based prune deletes
      // backups faster than 30 calendar days on any day with several restarts.
      try {
        const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
        fs.readdirSync(BACKUP_DIR)
          .filter(function (f) { return f.endsWith(".sqlite"); })
          .forEach(function (f) {
            const full = path.join(BACKUP_DIR, f);
            let stat;
            try { stat = fs.statSync(full); } catch (_) { return; }
            if (stat.mtimeMs < cutoff) {
              try { fs.unlinkSync(full); } catch (_) {}
            }
          });
      } catch (e) {
        console.error("[Backup] Prune failed:", e.message);
      }
    }

    runBackup();
    setInterval(runBackup, 24 * 60 * 60 * 1000);
  }());
}

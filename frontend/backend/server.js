require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const express     = require("express");
const path        = require("path");
const helmet      = require("helmet");
const cors        = require("cors");
const rateLimit   = require("express-rate-limit");

const fs = require("fs");

const {
  DB_PATH,
  getWorkers,
  findWorkerById,
  createWorkerInDb,
  deleteWorkerById,
  updateWorkerPasswordHash,
  clearMustChangePassword,
  upsertDonor,
  getIvrDonations,
  getCallSessions,
  getCallLogsByCallId,
  insertCallLog,
  logClick2Call,
  getDashboardStats,
  getIvrMonitorStats,
  getIvrAlerts,
  getAppState,
  setAppState,
  backupDatabase,
  dbHealthCheck,
  getPayments,
  getPaymentById,
  getPaymentStats,
  insertAuditLog,
  getAuditLogs,
} = require("./db");

const {
  ROLES,
  loginWorker,
  hashPassword,
  comparePassword,
  requireAuth,
  requireRole,
} = require("./auth.service");

const { handleIvrQuery, ivrErrorResponse } = require("./ivr.service");
const { getDonorForIvr, normalizePhone }   = require("./donor.service");

const PORT         = Number(process.env.PORT || 3000);
const IVR_KEY      = process.env.IVR_KEY || "";
const FRONTEND_DIR = path.join(__dirname, "..");

const app = express();

app.set("trust proxy", 1);

// ── Security headers ─────────────────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: false,
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
app.use(express.json({ limit: "5mb" }));

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

app.use(express.static(FRONTEND_DIR, {
  setHeaders(res, filePath) {
    if (filePath.endsWith(".html")) {
      _noCacheHeaders(res);
    }
  }
}));

// Explicit route for /lib so client-side libraries are always reachable
app.use("/lib", express.static(path.join(__dirname, "..", "lib")));

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

function requireIvrKey(req, res, next) {
  if (!IVR_KEY) {
    console.warn("[IVR] IVR_KEY not configured — access is unrestricted. Set IVR_KEY in .env.");
    return next();
  }
  // Technoline sends the key as a query param (ivrKey=...).
  // Also accept it from the x-ivr-key header for direct API calls.
  const provided = req.headers["x-ivr-key"] || req.query.ivrKey || "";
  if (provided !== IVR_KEY) {
    console.warn("[IVR] Rejected request with invalid IVR key", {
      hasHeader:   !!req.headers["x-ivr-key"],
      hasQueryKey: !!req.query.ivrKey,
      provided:    maskSecret(provided),
      expected:    maskSecret(IVR_KEY),
      originalUrl: req.originalUrl,
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

    try { insertAuditLog({ action: "login", entityType: "worker", entityId: String(result.id), entityName: result.name, details: "כניסה למערכת", workerId: result.id, workerName: result.name, ip: req.ip }); } catch (_) {}
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── Workers — protected CRUD ──────────────────────────────────────────────────
app.use("/api/workers", apiLimiter);

// Public list for login dropdown (no auth required)
app.get("/api/workers/list", function (req, res) {
  const workers = getWorkers().map(function (w) {
    return { id: w.id, name: w.name, role: w.role, status: w.status };
  });
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

    const defaultPass = role === "מנהל" ? "1234" : "1111";
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

    if (currentPassword) {
      const valid = await comparePassword(String(currentPassword), worker.passwordHash);
      if (!valid) {
        return res.status(401).json({ error: "Current password is incorrect" });
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

app.get("/api/data/:key", requireRole([ROLES.ADMIN, ROLES.SECRETARY]), function (req, res, next) {
  try {
    const key  = req.params.key;
    const data = getAppState(key);

    if (data === null) {
      return res.status(400).json({ error: "Unknown data key: " + key });
    }

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

    const ok = setAppState(key, body);

    if (!ok) {
      return res.status(400).json({ error: "Unknown data key: " + key });
    }

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
      res.json(getPayments({ limit: limit, donorId: donorId }));
    } catch (err) { next(err); }
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

// ── Click-to-Call (Technoline) ────────────────────────────────────────────────
app.post(
  "/api/technoline/click2call",
  apiLimiter,
  requireRole([ROLES.ADMIN, ROLES.SECRETARY]),
  async function (req, res, next) {
    try {
      var body      = req.body || {};
      var phone     = String(body.phone     || "").trim();
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

      const techParams = new URLSearchParams({
        action:     "click2call",
        apiKey:     apiKey,
        extension:  extension,
        target:     phone,
        targetName: donorName || phone,
        ringSec:    30,
      });

      // Log exactly what we send (apiKey masked)
      console.log("[Click2Call] → Technoline request:", JSON.stringify({
        action:     "click2call",
        apiKey:     maskSecret(apiKey),
        extension:  extension,
        target:     phone,
        targetName: donorName || phone,
        ringSec:    30,
      }));

      var techRes  = await fetch("https://app.ipsales.co.il/ivrFilesApi.php", {
        method:  "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body:    techParams.toString(),
        signal:  AbortSignal.timeout(15000),
      });

      var techHttpStatus = techRes.status;
      var techBody = await techRes.json();

      // Always log the full Technoline response for diagnostics
      console.log("[Click2Call] ← Technoline HTTP", techHttpStatus, "| body:", JSON.stringify(techBody));

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
      } catch (logErr) {
        console.error("[Click2Call] Failed to write log — call result unaffected:", logErr.message);
      }

      if (!success) {
        var errMsg = techBody.note || techBody.message || techBody.error || ("שגיאה " + (techBody.errorCode ?? techHttpStatus));
        console.error("[Click2Call] Technoline rejected call | error:", errMsg);
        return res.status(400).json({ error: "טכנוליין: " + errMsg });
      }

      console.log("[Click2Call] initiated | donor:", donorName, "| phone:", phone,
                  "| ext:", extension, "| callId:", techBody.callId);
      return res.json({ ok: true, callId: techBody.callId, extension: extension, target: techBody.target });
    } catch (err) {
      next(err);
    }
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

// ── Softphone: SIP config (served to authenticated workers) ──────────────────
app.get("/api/sip-config", requireAuth, function (req, res) {
  res.json({
    server: process.env.SIP_SERVER || "",
    ext:    process.env.SIP_EXT    || "",
    user:   process.env.SIP_USER   || "",
    pass:   process.env.SIP_PASS   || "",
  });
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

// ── IVR webhook (Technoline PBX) ──────────────────────────────────────────────
// Technoline sends all accumulated query params on every step.
// The route stays stateless: only req.query and SQLite are used.
app.get("/ivr", ivrLimiter, requireIvrKey, function (req, res) {
  try {
    console.log("[IVR] QUERY:", JSON.stringify(req.query));
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

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use(function (req, res) {
  res.status(404).json({ error: "Not found" });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use(function (err, req, res, _next) {
  const ts = new Date().toISOString();
  console.error("[" + ts + "] Unhandled error on " + req.method + " " + req.path + ":", err);
  res.status(500).json({ error: "Internal server error" });
});

// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, function () {
  console.log("[" + new Date().toISOString() + "] Server running on port " + PORT + " (NODE_ENV=" + (process.env.NODE_ENV || "development") + ")");
});

// ── Daily SQLite backup ───────────────────────────────────────────────────────
(function scheduleDailyBackup() {
  const BACKUP_DIR  = path.join(__dirname, "backups");
  const MAX_BACKUPS = 30;

  function runBackup() {
    if (!fs.existsSync(BACKUP_DIR)) {
      try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); } catch (e) {
        console.error("[Backup] Cannot create backup dir:", e.message);
        return;
      }
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
    const dest  = path.join(BACKUP_DIR, "data-" + stamp + ".sqlite");

    try {
      backupDatabase(dest);
      console.log("[Backup] Created:", dest);

      // Prune oldest backups, keep MAX_BACKUPS most recent
      const files = fs.readdirSync(BACKUP_DIR)
        .filter(function (f) { return f.endsWith(".sqlite"); })
        .sort();

      while (files.length > MAX_BACKUPS) {
        try { fs.unlinkSync(path.join(BACKUP_DIR, files.shift())); } catch (_) {}
      }
    } catch (e) {
      console.error("[Backup] Failed:", e.message);
    }
  }

  runBackup();
  setInterval(runBackup, 24 * 60 * 60 * 1000);
}());

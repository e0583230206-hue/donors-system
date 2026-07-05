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
  getClick2CallLogs,
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
  insertSyncLog,
  getSyncLogs,
  insertAlfonPending,
  getAlfonPending,
  getAlfonPendingById,
  updateAlfonPendingStatus,
  normalizePhoneForDb,
} = require("./db");

const { parseCsv, buildPreview, applySync, normPhone } = require("./sync.service");
const CITY_MAP = require("./city_map");
const { queryAI } = require("./ai");

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

      console.log("[MailingList] response:", JSON.stringify(techBody));

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
      var id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: "invalid id" });
      var logs = getClick2CallLogs(id, 30);
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

// Helper: build phone list from donors with ivrApprovedPhones, filtered by recipientFilter.
// Filters: "all" | "debt" | "city:<name>" | "tag:<tag>" | "donor:<id>"
function buildPhoneList(recipientFilter) {
  var donors = getAppState("donors") || [];
  var filter = String(recipientFilter || "all").trim();
  var phones = [];
  for (var i = 0; i < donors.length; i++) {
    var d        = donors[i];
    var approved = d.ivrApprovedPhones || [];
    if (approved.length === 0) continue;
    var include  = false;
    if (filter === "all") {
      include = true;
    } else if (filter === "debt") {
      include = (d.donations || []).some(function (don) { return (don.remainingDebt || 0) > 0; });
    } else if (filter.startsWith("city:")) {
      include = (d.city || "").trim() === filter.slice(5).trim();
    } else if (filter.startsWith("tag:")) {
      var tag = filter.slice(4).trim();
      include = (d.tags || []).indexOf(tag) !== -1;
    } else if (filter.startsWith("donor:")) {
      include = d.id === Number(filter.slice(6));
    } else {
      include = true;
    }
    if (!include) continue;
    for (var j = 0; j < approved.length; j++) {
      if (phones.indexOf(approved[j]) === -1) phones.push(approved[j]);
    }
  }
  return phones;
}

// GET /api/technoline/send/recipient-count?filter=<filter>
app.get(
  "/api/technoline/send/recipient-count",
  requireRole([ROLES.ADMIN, ROLES.SECRETARY]),
  function (req, res, next) {
    try {
      var phones = buildPhoneList(req.query.filter || "all");
      return res.json({ count: phones.length });
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
        var hasApproved = (d.ivrApprovedPhones || []).length > 0;
        var hasDebt     = (d.donations || []).some(function (don) { return (don.remainingDebt || 0) > 0; });
        if (hasApproved && hasDebt)                debtCount++;
        if (hasApproved && d.city)                 cities[d.city.trim()] = true;
        if (hasApproved && Array.isArray(d.tags))  d.tags.forEach(function (t) { if (t) tags[t.trim()] = true; });
      });
      return res.json({
        debtCount: debtCount,
        cities:    Object.keys(cities).sort(),
        tags:      Object.keys(tags).sort(),
      });
    } catch (err) { next(err); }
  }
);

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

      var body            = req.body || {};
      var title           = String(body.title           || "").trim();
      var messageKind     = String(body.messageKind     || "ivr").trim();   // "ivr" | "text"
      var messageText     = String(body.messageText     || "").trim();
      var recipientFilter = String(body.recipientFilter || "all").trim();
      var sendTime        = body.sendTime || null;
      var quietHours      = body.quietHours !== false;   // default true

      // Resolve IVR extension: use env, fallback to body.extension for advanced callers
      var ivrExtension = String(
        process.env.TECHNOLINE_IVR_EXTENSION || body.extension || ""
      ).trim();

      // Build phone list using filter
      var phonesOverride = body.phones || null;
      var phones;
      if (Array.isArray(phonesOverride) && phonesOverride.length > 0) {
        phones = phonesOverride;
      } else {
        phones = buildPhoneList(recipientFilter);
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

      if (messageKind === "ivr") {
        params.messagesType        = "extensionActivation";
        params.extensionActivation = ivrExtension;
      } else {
        params.audioText = messageText;
      }

      var urlParams = new URLSearchParams(params);
      console.log("[Campaign] launching", phones.length, "phones | title:", title, "| kind:", messageKind);

      var techRes  = await fetch("https://app.ipsales.co.il/campaignApi.php", {
        method:  "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body:    urlParams.toString(),
        signal:  AbortSignal.timeout(30000),
      });
      var techBody = await techRes.json();

      console.log("[Campaign] response:", JSON.stringify(techBody));

      if (String(techBody.status).toUpperCase() !== "OK") {
        return res.status(400).json({ error: campaignErrMsg(techBody), errorCode: techBody.errorCode });
      }

      return res.json({
        ok:            true,
        campaignId:    techBody.campaignId,
        phones:        techBody.phones,
        errorPhones:   techBody.errorPhones,
        blockedPhones: techBody.blockedPhones,
        billing:       techBody.billing,
      });
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

// ── Softphone: SIP config (requires valid session) ────────────────────────────
app.get("/api/sip-config", requireAuth, function (req, res) {
  var dbCfg = getAppState("sip_config");
  var fromDb = dbCfg && typeof dbCfg === "object" && !Array.isArray(dbCfg);
  res.json({
    server: (fromDb && dbCfg.server) || process.env.SIP_SERVER || "",
    ext:    (fromDb && dbCfg.ext)    || process.env.SIP_EXT    || "",
    user:   (fromDb && dbCfg.user)   || process.env.SIP_USER   || "",
    pass:   (fromDb && dbCfg.pass)   || process.env.SIP_PASS   || "",
  });
});

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
  if (req.headers["x-alfon-key"] !== key) return res.status(401).json({ error: "Invalid API key" });
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
      var body     = req.body || {};
      var question = String(body.question || "").trim();
      var donorId  = body.donorId ? Number(body.donorId) : null;
      var history  = Array.isArray(body.history) ? body.history.slice(-10) : [];

      if (!question) {
        return res.status(400).json({ error: "שאלה ריקה" });
      }
      if (question.length > 500) {
        return res.status(400).json({ error: "שאלה ארוכה מדי (מקסימום 500 תווים)" });
      }

      var result = await queryAI({ question, donorId, history });

      return res.json({
        answer:      result.answer,
        intent:      result.intent,
        model:       result.model || "local",
        fallback:    result.fallback || false,
        suggestions: result.suggestions || [],
      });
    } catch (err) {
      next(err);
    }
  }
);

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

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
  getDashboardStats,
  getAppState,
  setAppState,
  backupDatabase,
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
app.use(express.static(FRONTEND_DIR));

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

// ── IVR key middleware ────────────────────────────────────────────────────────
function requireIvrKey(req, res, next) {
  if (!IVR_KEY) {
    console.warn("[IVR] IVR_KEY not configured — access is unrestricted. Set IVR_KEY in .env.");
    return next();
  }
  const provided = req.headers["x-ivr-key"] || req.query.ivrKey || "";
  if (provided !== IVR_KEY) {
    console.warn("[IVR] Rejected request with invalid IVR key from " + req.ip);
    return res.status(403).json({ error: "Invalid IVR key" });
  }
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

app.get("/health", function (req, res) {
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
      return res.status(401).json({ error: "Invalid credentials" });
    }

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
    res.json({ deleted: true, id });
  } catch (err) {
    next(err);
  }
});

// Self-service: any authenticated worker can change their own password
// MUST be defined before /:id/password so Express doesn't treat "me" as an id
app.put("/api/workers/me/password", requireAuth, async function (req, res, next) {
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

    res.json({ updated: true });
  } catch (err) {
    next(err);
  }
});

app.put("/api/workers/:id/password", requireRole([ROLES.ADMIN]), async function (req, res, next) {
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

// ── IVR donations list ────────────────────────────────────────────────────────
app.get(
  "/api/ivr/donations",
  requireRole([ROLES.ADMIN, ROLES.SECRETARY, ROLES.IVR_SYSTEM]),
  function (req, res) {
    res.json(getIvrDonations());
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

// ── IVR webhook (Technoline PBX) ──────────────────────────────────────────────
// Technoline sends all accumulated query params on every step.
// The route stays stateless: only req.query and SQLite are used.
app.get("/ivr", ivrLimiter, requireIvrKey, function (req, res) {
  try {
    var result = handleIvrQuery(req.query || {});

    if (result.hangup) {
      return res.status(200).end();
    }

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
  const MAX_BACKUPS = 7;

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

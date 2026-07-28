require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const jwt      = require("jsonwebtoken");
const bcrypt   = require("bcryptjs");
const { findWorkerById } = require("./db");

const SALT_ROUNDS = 10;

const JWT_SECRET = (function () {
  const s = process.env.JWT_SECRET || "";
  if (!s || s.startsWith("REPLACE_WITH")) {
    console.error(
      "SECURITY ERROR: JWT_SECRET is not set or is a placeholder. " +
      "Set a strong secret in .env before running in production."
    );
    if (process.env.NODE_ENV === "production") {
      process.exit(1);
    }
    return "INSECURE_DEV_ONLY_SECRET_DO_NOT_USE_IN_PRODUCTION";
  }
  return s;
}());

// JWT lifetime — deliberately long and independent of SESSION_TIMEOUT_HOURS
// (that env var used to drive an 8h forced logout; removed by design — see
// requireLogin() in frontend/js/auth.js). A user stays logged in indefinitely
// as long as their browser keeps sending heartbeats (every 60s while a tab is
// open — see /api/sessions/heartbeat), which silently re-signs and returns a
// fresh token on every call. This TTL is only the fallback: how long a token
// stays valid if the browser/computer is off and heartbeats stop entirely.
const JWT_TTL_DAYS    = Number(process.env.JWT_TTL_DAYS || 30);
const JWT_TTL_SECONDS = JWT_TTL_DAYS * 24 * 3600;

const ROLES = {
  ADMIN:      "ADMIN",
  SECRETARY:  "SECRETARY",
  IVR_SYSTEM: "IVR_SYSTEM",
};

function normalizeRole(role) {
  const v = String(role || "").trim().toUpperCase();
  if (v === "ADMIN"      || role === "מנהל")  return ROLES.ADMIN;
  if (v === "SECRETARY"  || role === "מזכיר") return ROLES.SECRETARY;
  if (v === "IVR_SYSTEM" || v === "IVR")      return ROLES.IVR_SYSTEM;
  return "";
}

async function loginWorker(workerId, password) {
  const worker = findWorkerById(workerId);

  if (!worker || worker.status !== "פעיל") return null;
  if (!worker.passwordHash) return null;

  const valid = await bcrypt.compare(String(password), worker.passwordHash);
  if (!valid) return null;

  const role  = normalizeRole(worker.role);
  const token = signToken({ id: worker.id, name: worker.name, role });

  return {
    token,
    user:              { id: worker.id, name: worker.name, role },
    expiresIn:         JWT_TTL_SECONDS * 1000,
    mustChangePassword: !!worker.must_change_password,
  };
}

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_TTL_SECONDS + "s" });
}

// Silent renewal — called from the heartbeat route so an active session's
// token keeps sliding forward and never actually hits JWT_TTL_DAYS in
// practice. Re-derives the payload from the verified request user rather
// than trusting anything client-supplied.
function renewToken(user) {
  return signToken({ id: user.id, name: user.name, role: user.role });
}

async function comparePassword(plain, hash) {
  return bcrypt.compare(String(plain), hash);
}

async function hashPassword(password) {
  return bcrypt.hash(String(password), SALT_ROUNDS);
}

// Routes exempt from the must_change_password block (exact matches only)
const MUST_CHANGE_EXEMPT = new Set(["/api/workers/me/password"]);

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const token = header.slice(7);

  try {
    req.user     = jwt.verify(token, JWT_SECRET);
    req.userRole = req.user.role;

    // Tokens are long-lived now (see JWT_TTL_DAYS), so a deleted or disabled
    // ("blocked") worker must be rejected on every request, not just at
    // login — otherwise their still-cryptographically-valid token would keep
    // working until it naturally expires, up to JWT_TTL_DAYS from now.
    const worker = findWorkerById(req.user.id);
    if (!worker || worker.status !== "פעיל") {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Server-side enforcement of must_change_password
    if (worker.must_change_password === 1) {
      if (!MUST_CHANGE_EXEMPT.has(req.path)) {
        return res.status(403).json({
          error:   "must_change_password",
          message: "יש לשנות סיסמה לפני הגישה למערכת",
        });
      }
    }

    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

function requireRole(allowedRoles) {
  return [
    requireAuth,
    function (req, res, next) {
      if (!allowedRoles.includes(req.userRole)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      next();
    },
  ];
}

module.exports = {
  ROLES,
  normalizeRole,
  loginWorker,
  renewToken,
  hashPassword,
  comparePassword,
  requireAuth,
  requireRole,
};

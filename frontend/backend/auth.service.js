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

const SESSION_HOURS = Number(process.env.SESSION_TIMEOUT_HOURS || 8);

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
  const token = jwt.sign(
    { id: worker.id, name: worker.name, role },
    JWT_SECRET,
    { expiresIn: SESSION_HOURS + "h" }
  );

  return {
    token,
    user:              { id: worker.id, name: worker.name, role },
    expiresIn:         SESSION_HOURS * 3600 * 1000,
    mustChangePassword: !!worker.must_change_password,
  };
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

    // Server-side enforcement of must_change_password
    const worker = findWorkerById(req.user.id);
    if (worker && worker.must_change_password === 1) {
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
  hashPassword,
  comparePassword,
  requireAuth,
  requireRole,
};

require("dotenv").config();
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const bcrypt = require("bcryptjs");

const DB_PATH = process.env.DB_PATH
  ? path.resolve(__dirname, process.env.DB_PATH)
  : path.join(__dirname, "data.sqlite");

const db = new DatabaseSync(DB_PATH);
const SALT_ROUNDS = 10;

function nowIso() {
  return new Date().toISOString();
}

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workers (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT    NOT NULL,
      role         TEXT    NOT NULL,
      status       TEXT    NOT NULL,
      passwordHash TEXT,
      createdAt    TEXT    NOT NULL,
      updatedAt    TEXT    NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS donors (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      phone     TEXT    NOT NULL UNIQUE,
      fullName  TEXT    NOT NULL,
      updatedAt TEXT    NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS ivr_donations (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      callId    TEXT    NOT NULL UNIQUE,
      phone     TEXT    NOT NULL,
      amount    REAL    NOT NULL,
      donorId   INTEGER REFERENCES donors(id),
      createdAt TEXT    NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS payments (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      callId    TEXT    UNIQUE,
      phone     TEXT,
      donorId   INTEGER REFERENCES donors(id),
      amount    REAL    NOT NULL,
      status    TEXT    NOT NULL,
      source    TEXT    NOT NULL,
      createdAt TEXT    NOT NULL,
      timestamp TEXT    NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS ivr_call_logs (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      callId    TEXT,
      phone     TEXT,
      step      TEXT    NOT NULL,
      payload   TEXT,
      createdAt TEXT    NOT NULL,
      timestamp TEXT    NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS app_state (
      key       TEXT PRIMARY KEY,
      value     TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )
  `);

  // ── Migrations ──────────────────────────────────────────────────
  try { db.exec("ALTER TABLE workers ADD COLUMN passwordHash TEXT"); } catch (_) {}
  try { db.exec("ALTER TABLE ivr_donations ADD COLUMN donorId INTEGER REFERENCES donors(id)"); } catch (_) {}
  try { db.exec("ALTER TABLE ivr_call_logs ADD COLUMN timestamp TEXT"); } catch (_) {}

  try {
    const missing = db.prepare("SELECT COUNT(*) AS count FROM ivr_call_logs WHERE timestamp IS NULL").get();
    if (missing.count > 0) {
      db.exec("UPDATE ivr_call_logs SET timestamp = createdAt WHERE timestamp IS NULL");
    }
  } catch (_) {}

  // ── Indexes ─────────────────────────────────────────────────────
  db.exec("CREATE INDEX IF NOT EXISTS idx_donors_phone          ON donors(phone)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_ivr_call_logs_callId  ON ivr_call_logs(callId)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_ivr_call_logs_phone   ON ivr_call_logs(phone)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_ivr_call_logs_ts      ON ivr_call_logs(timestamp)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_ivr_donations_callId  ON ivr_donations(callId)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_ivr_donations_phone   ON ivr_donations(phone)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_payments_callId       ON payments(callId)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_payments_phone        ON payments(phone)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_payments_ts           ON payments(timestamp)");

  // ── Backfill payments from legacy ivr_donations ─────────────────
  const missingPayments = db.prepare(`
    SELECT COUNT(*) AS count
    FROM ivr_donations d
    LEFT JOIN payments p ON p.callId = d.callId
    WHERE p.id IS NULL
  `).get();

  if (missingPayments.count > 0) {
    db.exec(`
      INSERT OR IGNORE INTO payments
        (callId, phone, donorId, amount, status, source, createdAt, timestamp)
      SELECT callId, phone, donorId, amount, 'success', 'ivr', createdAt, createdAt
      FROM ivr_donations
    `);
  }

  // ── Default admin worker ─────────────────────────────────────────
  const defaultWorker = db.prepare("SELECT id FROM workers WHERE name = ? LIMIT 1").get("מנהל מערכת");
  if (!defaultWorker) {
    const hash = bcrypt.hashSync("1234", SALT_ROUNDS);
    const now = nowIso();
    db.prepare(
      "INSERT INTO workers (name, role, status, passwordHash, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("מנהל מערכת", "מנהל", "פעיל", hash, now, now);
  }

  // ── Set bcrypt passwords for workers that only have legacy SHA-256 or no hash ──
  const workersWithoutBcrypt = db.prepare(
    "SELECT id, role FROM workers WHERE passwordHash IS NULL OR passwordHash NOT LIKE '$2%'"
  ).all();

  for (const worker of workersWithoutBcrypt) {
    const defaultPass = worker.role === "מנהל" ? "1234" : "1111";
    const hash = bcrypt.hashSync(defaultPass, SALT_ROUNDS);
    db.prepare("UPDATE workers SET passwordHash = ?, updatedAt = ? WHERE id = ?")
      .run(hash, nowIso(), worker.id);
  }
}

// ── Workers ─────────────────────────────────────────────────────────────────

function getWorkers() {
  return db.prepare(
    "SELECT id, name, role, status, createdAt, updatedAt FROM workers ORDER BY id"
  ).all();
}

function findWorkerById(id) {
  return db.prepare("SELECT * FROM workers WHERE id = ? LIMIT 1").get(Number(id));
}

function createWorkerInDb(name, role, status, passwordHash) {
  const now = nowIso();
  const result = db.prepare(
    "INSERT INTO workers (name, role, status, passwordHash, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(String(name).trim(), String(role).trim(), String(status).trim(), passwordHash, now, now);
  return result.lastInsertRowid;
}

function deleteWorkerById(id) {
  return db.prepare("DELETE FROM workers WHERE id = ?").run(Number(id));
}

function updateWorkerPasswordHash(id, passwordHash) {
  return db.prepare("UPDATE workers SET passwordHash = ?, updatedAt = ? WHERE id = ?")
    .run(passwordHash, nowIso(), Number(id));
}

// ── Donors ──────────────────────────────────────────────────────────────────

function findDonorByPhone(phone) {
  if (!phone) return undefined;
  return db.prepare("SELECT id, phone, fullName FROM donors WHERE phone = ? LIMIT 1")
    .get(String(phone).trim());
}

function upsertDonor(phone, fullName) {
  db.prepare(`
    INSERT INTO donors (phone, fullName, updatedAt)
    VALUES (?, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET
      fullName  = excluded.fullName,
      updatedAt = excluded.updatedAt
  `).run(String(phone).trim(), String(fullName).trim(), nowIso());
}

// ── IVR Donations ────────────────────────────────────────────────────────────

function findIvrDonationByCallId(callId) {
  if (!callId) return undefined;
  return db.prepare(
    "SELECT id, callId, phone, amount, donorId, createdAt FROM ivr_donations WHERE callId = ? LIMIT 1"
  ).get(String(callId).trim());
}

function recordIvrDonation(callId, phone, amount, donorId) {
  return db.prepare(`
    INSERT OR IGNORE INTO ivr_donations (callId, phone, amount, donorId, createdAt)
    VALUES (?, ?, ?, ?, ?)
  `).run(String(callId).trim(), String(phone).trim(), amount, donorId || null, nowIso());
}

function getIvrDonations() {
  return db.prepare(`
    SELECT d.id, d.callId, d.phone, d.amount, d.createdAt, d.donorId, dn.fullName AS donorName
    FROM ivr_donations d
    LEFT JOIN donors dn ON dn.id = d.donorId
    ORDER BY d.id DESC
  `).all();
}

function getLastDonationAmountByPhone(phone) {
  if (!phone) return null;
  const row = db.prepare(`
    SELECT amount FROM ivr_donations
    WHERE phone = ?
    ORDER BY datetime(createdAt) DESC, id DESC
    LIMIT 1
  `).get(String(phone).trim());
  return row ? row.amount : null;
}

// ── Payments (with transaction for atomicity) ────────────────────────────────

function findPaymentByCallId(callId) {
  if (!callId) return undefined;
  return db.prepare(
    "SELECT id, callId, phone, donorId, amount, status, source, createdAt, timestamp FROM payments WHERE callId = ? LIMIT 1"
  ).get(String(callId).trim());
}

function recordPayment(payment) {
  const stamp = nowIso();
  return db.prepare(`
    INSERT OR IGNORE INTO payments
      (callId, phone, donorId, amount, status, source, createdAt, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    payment.callId ? String(payment.callId).trim() : null,
    payment.phone  ? String(payment.phone).trim()  : null,
    payment.donorId || null,
    payment.amount,
    payment.status  || "success",
    payment.source  || "ivr",
    stamp,
    stamp
  );
}

function savePaymentInTransaction(callId, phone, amount, donorId) {
  const cid = String(callId).trim();
  const ph  = String(phone).trim();

  db.exec("BEGIN");
  try {
    const existingDonation = db.prepare(
      "SELECT id FROM ivr_donations WHERE callId = ? LIMIT 1"
    ).get(cid);

    const existingPayment = db.prepare(
      "SELECT id FROM payments WHERE callId = ? LIMIT 1"
    ).get(cid);

    if (!existingDonation) {
      db.prepare(
        "INSERT OR IGNORE INTO ivr_donations (callId, phone, amount, donorId, createdAt) VALUES (?, ?, ?, ?, ?)"
      ).run(cid, ph, amount, donorId || null, nowIso());
    }

    if (!existingPayment) {
      const stamp = nowIso();
      db.prepare(
        "INSERT OR IGNORE INTO payments (callId, phone, donorId, amount, status, source, createdAt, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(cid, ph, donorId || null, amount, "success", "ivr", stamp, stamp);
    }

    db.exec("COMMIT");
    return { duplicate: !!(existingDonation || existingPayment) };
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch (_) {}
    throw err;
  }
}

// ── Call Logs ────────────────────────────────────────────────────────────────

function insertCallLog(callId, phone, step, payload) {
  var payloadText;
  try {
    payloadText = JSON.stringify(payload || {});
  } catch (_) {
    payloadText = JSON.stringify({ error: "payload_json_failed" });
  }
  const stamp = nowIso();
  return db.prepare(`
    INSERT INTO ivr_call_logs (callId, phone, step, payload, createdAt, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    callId ? String(callId).trim() : null,
    phone  ? String(phone).trim()  : null,
    step   || "unknown",
    payloadText,
    stamp,
    stamp
  );
}

// ── App State (key-value store for frontend data) ────────────────────────────

const ALLOWED_APP_STATE_KEYS = new Set([
  "donors", "tasks", "logs", "settings", "approvals", "reminders", "callbacks",
]);

function getAppState(key) {
  if (!ALLOWED_APP_STATE_KEYS.has(key)) return null;
  const row = db.prepare("SELECT value FROM app_state WHERE key = ? LIMIT 1").get(String(key));
  if (!row) return [];
  try {
    return JSON.parse(row.value);
  } catch (_) {
    return [];
  }
}

function setAppState(key, data) {
  if (!ALLOWED_APP_STATE_KEYS.has(key)) return false;
  db.prepare(`
    INSERT INTO app_state (key, value, updatedAt)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value     = excluded.value,
      updatedAt = excluded.updatedAt
  `).run(String(key), JSON.stringify(data), nowIso());
  return true;
}

// ── Dashboard ────────────────────────────────────────────────────────────────

function getDashboardStats() {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());

  const donorRow        = db.prepare("SELECT COUNT(*) AS count FROM donors").get();
  const paymentRow      = db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount FROM payments WHERE status = 'success'").get();
  const legacyPayRow    = db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount FROM ivr_donations").get();
  const callsTodayRow   = db.prepare("SELECT COUNT(*) AS count FROM ivr_call_logs WHERE substr(COALESCE(timestamp, createdAt), 1, 10) = ? AND step != 'payment_success'").get(today);
  const failedCallsRow  = db.prepare("SELECT COUNT(*) AS count FROM ivr_call_logs WHERE step = 'error'").get();
  const successCallsRow = db.prepare("SELECT COUNT(*) AS count FROM ivr_call_logs WHERE step = 'payment_success'").get();
  const totalCallsRow   = db.prepare("SELECT COUNT(*) AS count FROM ivr_call_logs WHERE step != 'payment_success'").get();

  const totalPayments      = paymentRow.count   || legacyPayRow.count  || 0;
  const totalPaymentAmount = paymentRow.amount  || legacyPayRow.amount || 0;
  const totalCalls         = totalCallsRow.count || 0;
  const successCount       = successCallsRow.count || 0;

  return {
    totalDonors:        donorRow.count || 0,
    totalPayments:      totalPayments,
    totalPaymentAmount: totalPaymentAmount,
    callsToday:         callsTodayRow.count || 0,
    failedCalls:        failedCallsRow.count || 0,
    successRate:        totalCalls > 0 ? Math.round((successCount / totalCalls) * 10000) / 100 : 0,
  };
}

// ── Init ─────────────────────────────────────────────────────────────────────

initDatabase();

module.exports = {
  // Workers
  getWorkers,
  findWorkerById,
  createWorkerInDb,
  deleteWorkerById,
  updateWorkerPasswordHash,
  // Donors
  findDonorByPhone,
  upsertDonor,
  getIvrDonations,
  getLastDonationAmountByPhone,
  // Payments
  recordIvrDonation,
  findIvrDonationByCallId,
  recordPayment,
  findPaymentByCallId,
  savePaymentInTransaction,
  // Logs
  insertCallLog,
  // App state
  getAppState,
  setAppState,
  // Dashboard
  getDashboardStats,
};

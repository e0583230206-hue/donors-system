require("dotenv").config({ path: require("path").join(__dirname, ".env") });
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
    CREATE TABLE IF NOT EXISTS ivr_call_sessions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      callId      TEXT    NOT NULL UNIQUE,
      phone       TEXT    NOT NULL,
      donorId     INTEGER REFERENCES donors(id),
      donorName   TEXT,
      startedAt   TEXT    NOT NULL,
      endedAt     TEXT,
      durationSec INTEGER,
      outcome     TEXT,
      amountPaid  REAL,
      createdAt   TEXT    NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS click2call_logs (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      pbxCallId      TEXT,
      workerId       INTEGER,
      workerName     TEXT,
      donorId        INTEGER REFERENCES donors(id),
      donorName      TEXT,
      donorPhone     TEXT NOT NULL,
      agentExtension TEXT NOT NULL,
      status         TEXT NOT NULL,
      errorCode      INTEGER,
      errorNote      TEXT,
      createdAt      TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS app_state (
      key       TEXT PRIMARY KEY,
      value     TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS server_audit_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      createdAt  TEXT    NOT NULL,
      action     TEXT    NOT NULL,
      entityType TEXT,
      entityId   TEXT,
      entityName TEXT,
      details    TEXT,
      workerId   INTEGER,
      workerName TEXT,
      ip         TEXT
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_audit_log_createdAt ON server_audit_log(createdAt)");

  // ── Migrations ──────────────────────────────────────────────────
  try { db.exec("ALTER TABLE workers ADD COLUMN passwordHash TEXT"); } catch (_) {}
  try { db.exec("ALTER TABLE workers ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0"); } catch (_) {}
  try { db.exec("ALTER TABLE ivr_donations ADD COLUMN donorId INTEGER REFERENCES donors(id)"); } catch (_) {}
  try { db.exec("ALTER TABLE ivr_call_logs ADD COLUMN timestamp TEXT"); } catch (_) {}
  try { db.exec("ALTER TABLE payments ADD COLUMN confirmationNumber TEXT"); } catch (_) {}

  try {
    const missing = db.prepare("SELECT COUNT(*) AS count FROM ivr_call_logs WHERE timestamp IS NULL").get();
    if (missing.count > 0) {
      db.exec("UPDATE ivr_call_logs SET timestamp = createdAt WHERE timestamp IS NULL");
    }
  } catch (_) {}

  // ── Indexes ─────────────────────────────────────────────────────
  db.exec("CREATE INDEX IF NOT EXISTS idx_donors_phone             ON donors(phone)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_ivr_call_logs_callId     ON ivr_call_logs(callId)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_ivr_call_logs_phone      ON ivr_call_logs(phone)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_ivr_call_logs_ts         ON ivr_call_logs(timestamp)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_ivr_donations_callId     ON ivr_donations(callId)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_ivr_donations_phone      ON ivr_donations(phone)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_payments_callId          ON payments(callId)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_payments_phone           ON payments(phone)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_payments_ts              ON payments(timestamp)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_call_sessions_callId     ON ivr_call_sessions(callId)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_call_sessions_phone      ON ivr_call_sessions(phone)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_call_sessions_startedAt  ON ivr_call_sessions(startedAt)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_click2call_donorPhone    ON click2call_logs(donorPhone)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_click2call_createdAt     ON click2call_logs(createdAt)");

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
      "INSERT INTO workers (name, role, status, passwordHash, must_change_password, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("מנהל מערכת", "מנהל", "פעיל", hash, 1, now, now);
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

  // ── Flag workers still using their default password (must change on next login) ──
  const workersToCheck = db.prepare(
    "SELECT id, role, passwordHash FROM workers WHERE must_change_password = 0"
  ).all();

  for (const w of workersToCheck) {
    const defaultPass = w.role === "מנהל" ? "1234" : "1111";
    if (w.passwordHash && bcrypt.compareSync(defaultPass, w.passwordHash)) {
      db.prepare("UPDATE workers SET must_change_password = 1, updatedAt = ? WHERE id = ?")
        .run(nowIso(), w.id);
    }
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
    "INSERT INTO workers (name, role, status, passwordHash, must_change_password, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(String(name).trim(), String(role).trim(), String(status).trim(), passwordHash, 1, now, now);
  return result.lastInsertRowid;
}

function clearMustChangePassword(id) {
  return db.prepare("UPDATE workers SET must_change_password = 0, updatedAt = ? WHERE id = ?")
    .run(nowIso(), Number(id));
}

function deleteWorkerById(id) {
  return db.prepare("DELETE FROM workers WHERE id = ?").run(Number(id));
}

function updateWorkerPasswordHash(id, passwordHash) {
  return db.prepare("UPDATE workers SET passwordHash = ?, updatedAt = ? WHERE id = ?")
    .run(passwordHash, nowIso(), Number(id));
}

// ── Donors ──────────────────────────────────────────────────────────────────

// Strips all formatting (dashes, spaces, parens, +) and resolves 972/00 prefix
// so that "052-1234-567", "+972-52-1234567", "0521234567" all become "0521234567".
function normalizePhoneForDb(phone) {
  var digits = String(phone || "").trim().replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("00"))  digits = digits.slice(2);
  if (digits.startsWith("972") && digits.length >= 11) return "0" + digits.slice(3);
  // Excel sometimes drops the leading 0 (stores number, not text): 9 digits → add 0
  if (digits.length === 9 && !digits.startsWith("0")) return "0" + digits;
  return digits;
}

// SQL expression that strips common separators from a stored phone column
var STRIP_PHONE_SQL = "REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,'-',''),' ',''),'+',''),'(',''),')','')";

function findDonorByPhone(phone) {
  var normalized = normalizePhoneForDb(phone);
  if (!normalized) return undefined;
  // Also prepare the international variant (e.g. "972521234567") in case
  // the stored phone was synced in 972-prefixed format.
  var intl = (normalized.startsWith("0") && normalized.length >= 9)
    ? "972" + normalized.slice(1)
    : null;
  if (intl) {
    return db.prepare(
      "SELECT id, phone, fullName FROM donors WHERE " + STRIP_PHONE_SQL + " IN (?,?) LIMIT 1"
    ).get(normalized, intl);
  }
  return db.prepare(
    "SELECT id, phone, fullName FROM donors WHERE " + STRIP_PHONE_SQL + " = ? LIMIT 1"
  ).get(normalized);
}

function upsertDonor(phone, fullName) {
  var normalized = normalizePhoneForDb(phone);
  if (!normalized) return;
  var name = String(fullName).trim();
  // Migrate any existing row stored with a non-normalized version of this phone
  var existing = db.prepare(
    "SELECT id FROM donors WHERE " + STRIP_PHONE_SQL + " IN (?,?) AND phone != ? LIMIT 1"
  ).get(normalized,
    normalized.startsWith("0") && normalized.length >= 9 ? "972" + normalized.slice(1) : normalized,
    normalized);
  if (existing) {
    try {
      db.prepare("UPDATE donors SET phone = ?, fullName = ?, updatedAt = ? WHERE id = ?")
        .run(normalized, name, nowIso(), existing.id);
    } catch (_) {
      // Normalized phone already exists as a separate row — just update name
      db.prepare("UPDATE donors SET fullName = ?, updatedAt = ? WHERE id = ?")
        .run(name, nowIso(), existing.id);
    }
    return;
  }
  db.prepare(`
    INSERT INTO donors (phone, fullName, updatedAt)
    VALUES (?, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET
      fullName  = excluded.fullName,
      updatedAt = excluded.updatedAt
  `).run(normalized, name, nowIso());
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
      (callId, phone, donorId, amount, status, source, confirmationNumber, createdAt, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    payment.callId ? String(payment.callId).trim() : null,
    payment.phone  ? String(payment.phone).trim()  : null,
    payment.donorId || null,
    payment.amount,
    payment.status  || "success",
    payment.source  || "ivr",
    payment.confirmationNumber || null,
    stamp,
    stamp
  );
}

function savePaymentInTransaction(callId, phone, amount, donorId, confirmationNumber) {
  const cid = String(callId).trim();
  const ph  = String(phone).trim();

  try {
    db.exec("BEGIN");

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
        "INSERT OR IGNORE INTO payments (callId, phone, donorId, amount, status, source, confirmationNumber, createdAt, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(cid, ph, donorId || null, amount, "success", "ivr", confirmationNumber || null, stamp, stamp);
    }

    db.exec("COMMIT");
    return { duplicate: !!(existingDonation || existingPayment) };
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch (_) {}
    throw err;
  }
}

// ── Payments list / single / stats (for CRM payments screen) ─────────────────

function getPayments(opts) {
  var options = (typeof opts === "object" && opts !== null) ? opts : { limit: opts };
  var limit   = Math.min(Number(options.limit) || 500, 2000);
  var donorId = options.donorId ? Number(options.donorId) : null;

  var base = `
    SELECT p.id, p.callId, p.phone, p.donorId, p.amount, p.status, p.source,
           p.confirmationNumber, p.createdAt, p.timestamp,
           d.fullName AS donorName
    FROM   payments p
    LEFT JOIN donors d ON d.id = p.donorId
  `;
  if (donorId) {
    return db.prepare(base + " WHERE p.donorId = ? ORDER BY p.id DESC LIMIT ?").all(donorId, limit);
  }
  return db.prepare(base + " ORDER BY p.id DESC LIMIT ?").all(limit);
}

function getPaymentById(id) {
  return db.prepare(`
    SELECT p.id, p.callId, p.phone, p.donorId, p.amount, p.status, p.source,
           p.confirmationNumber, p.createdAt, p.timestamp,
           d.fullName AS donorName
    FROM   payments p
    LEFT JOIN donors d ON d.id = p.donorId
    WHERE  p.id = ?
  `).get(Number(id));
}

function getPaymentStats() {
  var fmt   = { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" };
  var now   = new Date();
  var today = new Intl.DateTimeFormat("en-CA", fmt).format(now);

  var dow         = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Jerusalem" })).getDay();
  var daysFromMon = dow === 0 ? 6 : dow - 1;
  var mon         = new Date(now);
  mon.setDate(mon.getDate() - daysFromMon);
  var weekStart   = new Intl.DateTimeFormat("en-CA", fmt).format(mon);
  var monthStart  = today.slice(0, 7) + "-01";

  var base = "SELECT COUNT(*) AS count, COALESCE(SUM(amount),0) AS total FROM payments WHERE status='success' AND substr(COALESCE(timestamp,createdAt),1,10)";
  var tRow = db.prepare(base + "=?").get(today);
  var wRow = db.prepare(base + ">=?").get(weekStart);
  var mRow = db.prepare(base + ">=?").get(monthStart);

  return {
    today: { count: tRow.count, total: tRow.total },
    week:  { count: wRow.count, total: wRow.total },
    month: { count: mRow.count, total: mRow.total },
  };
}

// ── Debt update after IVR payment ────────────────────────────────────────────
//
// After Technoline confirms a successful charge, reduce the donor's open debts
// in app_state (newest first — same order the IVR presents to the caller).
// Returns { donorFound, updated, affectedDebts?, reason? } for logging.

function updateDonorDebtAfterPayment(phone, paidAmount) {
  var normalizedPhone = normalizePhoneForDb(phone);
  if (!normalizedPhone || !(paidAmount > 0)) {
    return { donorFound: false, updated: false, reason: "invalid_args" };
  }

  var donors = getAppState("donors");
  if (!Array.isArray(donors) || donors.length === 0) {
    return { donorFound: false, updated: false, reason: "no_donors_in_state" };
  }

  var donorIdx = -1;
  for (var di = 0; di < donors.length; di++) {
    if (normalizePhoneForDb(donors[di].phone) === normalizedPhone) {
      donorIdx = di;
      break;
    }
  }
  if (donorIdx === -1) {
    return { donorFound: false, updated: false, reason: "donor_not_in_state" };
  }

  var donor = donors[donorIdx];
  if (!Array.isArray(donor.donations) || donor.donations.length === 0) {
    return { donorFound: true, updated: false, reason: "no_donations" };
  }

  // Open debts sorted newest first — matches IVR presentation order
  var openDebts = donor.donations
    .filter(function(d) { return !d.paid && Number(d.remainingDebt || 0) > 0; })
    .sort(function(a, b) {
      return new Date(b.date || b.createdAt || 0) - new Date(a.date || a.createdAt || 0);
    });

  if (openDebts.length === 0) {
    return { donorFound: true, updated: false, reason: "no_open_debts" };
  }

  var remaining = paidAmount;
  var affectedDebts = 0;
  var now = nowIso();

  for (var i = 0; i < openDebts.length && remaining > 0.005; i++) {
    var debt = openDebts[i];
    var debtAmt = Math.round(Number(debt.remainingDebt || 0) * 100) / 100;
    if (debtAmt <= 0) continue;

    if (remaining >= debtAmt - 0.005) {
      // Full payment of this debt
      remaining = Math.round((remaining - debtAmt) * 100) / 100;
      debt.remainingDebt = 0;
      debt.paid = true;
      debt.paidAt = now;
      debt.paidVia = "ivr";
      affectedDebts++;
    } else {
      // Partial payment — reduce remaining debt
      debt.remainingDebt = Math.round((debtAmt - remaining) * 100) / 100;
      remaining = 0;
      affectedDebts++;
    }
  }

  if (affectedDebts === 0) {
    return { donorFound: true, updated: false, reason: "no_change" };
  }

  setAppState("donors", donors);
  return { donorFound: true, updated: true, affectedDebts: affectedDebts };
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

// ── Call Sessions ────────────────────────────────────────────────────────────

function startCallSession(callId, phone) {
  const now = nowIso();
  const result = db.prepare(`
    INSERT OR IGNORE INTO ivr_call_sessions (callId, phone, startedAt, createdAt)
    VALUES (?, ?, ?, ?)
  `).run(String(callId).trim(), String(phone).trim(), now, now);
  return result.changes > 0; // true if new session was created
}

function updateCallSessionDonor(callId, donorId, donorName) {
  db.prepare(`
    UPDATE ivr_call_sessions
    SET donorId = ?, donorName = ?
    WHERE callId = ? AND donorId IS NULL
  `).run(donorId || null, donorName || null, String(callId).trim());
}

function endCallSession(callId, outcome, amountPaid) {
  const now = nowIso();
  db.prepare(`
    UPDATE ivr_call_sessions
    SET endedAt     = ?,
        durationSec = CAST((julianday(?) - julianday(startedAt)) * 86400 AS INTEGER),
        outcome     = ?,
        amountPaid  = ?
    WHERE callId = ? AND endedAt IS NULL
  `).run(now, now, outcome || "hangup", amountPaid || null, String(callId).trim());
}

function getCallSessions(limit) {
  return db.prepare(`
    SELECT s.id, s.callId, s.phone, s.donorId, s.donorName,
           s.startedAt, s.endedAt, s.durationSec,
           s.outcome, s.amountPaid, s.createdAt
    FROM ivr_call_sessions s
    ORDER BY s.startedAt DESC
    LIMIT ?
  `).all(Number(limit) || 100);
}

function getCallLogsByCallId(callId) {
  return db.prepare(`
    SELECT id, callId, phone, step, payload, timestamp
    FROM ivr_call_logs
    WHERE callId = ?
    ORDER BY id ASC
  `).all(String(callId).trim());
}

// ── Click-to-Call Logs ───────────────────────────────────────────────────────

function logClick2Call({ pbxCallId, workerId, workerName, donorId, donorName, donorPhone, agentExtension, status, errorCode, errorNote }) {
  // donorId from the frontend is the app-level JSON id, not necessarily the SQLite donors.id.
  // Strategy: try SQLite id first, then fall back to phone lookup.
  var safeDonorId = null;
  if (donorId != null) {
    var donorRow = db.prepare("SELECT id FROM donors WHERE id = ? LIMIT 1").get(Number(donorId));
    if (donorRow) {
      safeDonorId = Number(donorId);
    } else if (donorPhone) {
      var normalized = normalizePhoneForDb(donorPhone);
      var byPhone = normalized
        ? db.prepare("SELECT id FROM donors WHERE " + STRIP_PHONE_SQL + " = ? LIMIT 1").get(normalized)
        : null;
      if (byPhone) {
        safeDonorId = byPhone.id;
      } else {
        console.log("[DB] logClick2Call: donor not found by id=" + donorId + " or phone=" + donorPhone + " (app-level id, not synced to SQLite) — FK stored as NULL");
      }
    } else {
      console.log("[DB] logClick2Call: donorId " + donorId + " not in donors table and no phone provided — FK stored as NULL");
    }
  }

  return db.prepare(`
    INSERT INTO click2call_logs
      (pbxCallId, workerId, workerName, donorId, donorName, donorPhone, agentExtension, status, errorCode, errorNote, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    pbxCallId      || null,
    workerId       || null,
    workerName     || null,
    safeDonorId,
    donorName      || null,
    String(donorPhone).trim(),
    String(agentExtension).trim(),
    String(status).trim(),
    errorCode != null ? Number(errorCode) : null,
    errorNote      || null,
    nowIso()
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

// ── Backup ───────────────────────────────────────────────────────────────────

function backupDatabase(destPath) {
  db.exec("VACUUM INTO '" + String(destPath).replace(/'/g, "''") + "'");
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

// ── IVR Monitor ──────────────────────────────────────────────────────────────

function getIvrMonitorStats() {
  var today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());

  var callsRow = db.prepare(
    "SELECT COUNT(DISTINCT callId) AS count FROM ivr_call_sessions WHERE substr(startedAt,1,10)=?"
  ).get(today);

  var paymentsRow = db.prepare(
    "SELECT COUNT(*) AS count, COALESCE(SUM(amount),0) AS total FROM payments WHERE status='success' AND substr(COALESCE(timestamp,createdAt),1,10)=?"
  ).get(today);

  var voicemailsRow = db.prepare(
    "SELECT COUNT(*) AS count FROM ivr_call_sessions WHERE outcome='voice_message' AND substr(startedAt,1,10)=?"
  ).get(today);

  var errorsRow = db.prepare(
    "SELECT COUNT(*) AS count FROM ivr_call_logs WHERE step='error' AND substr(COALESCE(timestamp,createdAt),1,10)=?"
  ).get(today);

  return {
    date:          today,
    calls:         callsRow.count      || 0,
    payments:      paymentsRow.count   || 0,
    paymentsTotal: paymentsRow.total   || 0,
    voicemails:    voicemailsRow.count || 0,
    errors:        errorsRow.count     || 0,
  };
}

function getIvrAlerts(limit) {
  var n = Math.min(Number(limit) || 30, 100);

  var voicemails = db.prepare(`
    SELECT 'voice_message' AS alertType, phone,
           COALESCE(donorName, phone) AS donor, startedAt AS time, callId
    FROM ivr_call_sessions WHERE outcome = 'voice_message'
    ORDER BY startedAt DESC LIMIT ?
  `).all(n);

  var errors = db.prepare(`
    SELECT 'system_error' AS alertType, COALESCE(phone,'—') AS phone,
           COALESCE(phone,'—') AS donor,
           COALESCE(timestamp, createdAt) AS time, callId
    FROM ivr_call_logs WHERE step = 'error'
    ORDER BY COALESCE(timestamp, createdAt) DESC LIMIT ?
  `).all(n);

  var failedPayments = db.prepare(`
    SELECT 'payment_failed' AS alertType, phone,
           COALESCE(donorName, phone) AS donor, startedAt AS time, callId
    FROM ivr_call_sessions WHERE outcome = 'payment_failed'
    ORDER BY startedAt DESC LIMIT ?
  `).all(n);

  var interrupted = db.prepare(`
    SELECT 'interrupted' AS alertType, s.phone,
           COALESCE(s.donorName, s.phone) AS donor, s.startedAt AS time, s.callId
    FROM ivr_call_sessions s
    WHERE s.outcome = 'hangup'
      AND EXISTS (
        SELECT 1 FROM ivr_call_logs l WHERE l.callId = s.callId
          AND l.step IN ('menu_selection','payment_submenu','debt_submenu','amount_entered')
      )
    ORDER BY s.startedAt DESC LIMIT ?
  `).all(n);

  var all = voicemails.concat(errors).concat(failedPayments).concat(interrupted);
  all.sort(function(a, b) { return b.time < a.time ? -1 : b.time > a.time ? 1 : 0; });
  return all.slice(0, n);
}

// ── Server Audit Log ─────────────────────────────────────────────────────────

function insertAuditLog({ action, entityType, entityId, entityName, details, workerId, workerName, ip }) {
  return db.prepare(`
    INSERT INTO server_audit_log (createdAt, action, entityType, entityId, entityName, details, workerId, workerName, ip)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    nowIso(),
    String(action || "").trim(),
    entityType  || null,
    entityId    != null ? String(entityId) : null,
    entityName  || null,
    details     || null,
    workerId    || null,
    workerName  || null,
    ip          || null
  );
}

function getAuditLogs(limit) {
  return db.prepare(`
    SELECT id, createdAt, action, entityType, entityId, entityName, details, workerId, workerName, ip
    FROM server_audit_log
    ORDER BY id DESC
    LIMIT ?
  `).all(Math.min(Number(limit) || 200, 1000));
}

// ── Health check ─────────────────────────────────────────────────────────────

function dbHealthCheck() {
  try {
    db.prepare("SELECT 1 AS ok").get();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────

initDatabase();

module.exports = {
  DB_PATH,
  // Workers
  getWorkers,
  findWorkerById,
  createWorkerInDb,
  deleteWorkerById,
  updateWorkerPasswordHash,
  clearMustChangePassword,
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
  updateDonorDebtAfterPayment,
  getPayments,
  getPaymentById,
  getPaymentStats,
  // Logs
  insertCallLog,
  // Call Sessions
  startCallSession,
  updateCallSessionDonor,
  endCallSession,
  getCallSessions,
  getCallLogsByCallId,
  // Click-to-Call
  logClick2Call,
  // App state
  getAppState,
  setAppState,
  // Backup
  backupDatabase,
  // Dashboard
  getDashboardStats,
  // IVR Monitor
  getIvrMonitorStats,
  getIvrAlerts,
  // Health
  dbHealthCheck,
  // Audit log
  insertAuditLog,
  getAuditLogs,
};

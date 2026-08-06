require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const path   = require("path");
const fs     = require("fs");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const bcrypt = require("bcryptjs");
const logger = require("./logger");
const callClassifier = require("../js/softphone-call-classifier.js");

// How recent a heartbeat has to be for a still-logged-in session to be shown
// as "online" on the admin sessions screen. Purely a display concern — unlike
// the old SESSION_TIMEOUT_HOURS, it never closes the session or logs anyone
// out; a worker who stops heartbeating just shows as offline while staying
// logged in (see getActiveSessions()). Configurable so tests don't need to
// sleep for real minutes to observe the online -> offline transition.
const SESSION_ONLINE_THRESHOLD_MS = Number(process.env.SESSION_ONLINE_THRESHOLD_MS || 3 * 60 * 1000);

const DB_PATH = process.env.DB_PATH
  ? path.resolve(__dirname, process.env.DB_PATH)
  : path.join(__dirname, "data.sqlite");

const db = new DatabaseSync(DB_PATH);
const SALT_ROUNDS = 10;

function nowIso() {
  return new Date().toISOString();
}

// Single source of truth for the seeded/reset default password by role —
// was previously duplicated (db.js x2, server.js) with the same ternary.
function defaultPasswordForRole(role) {
  return role === "מנהל" ? "1234" : "1111";
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
    CREATE TABLE IF NOT EXISTS ivr_voice_messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      pbxCallId       TEXT    UNIQUE,
      phone           TEXT    NOT NULL,
      donorAppId      INTEGER,
      donorName       TEXT,
      fileName        TEXT    NOT NULL,
      technolineAudio TEXT,
      extension       TEXT,
      fileId          TEXT,
      filePath        TEXT,
      durationSec     REAL,
      sizeMb          REAL,
      status          TEXT    NOT NULL DEFAULT 'ממתין',
      createdAt       TEXT    NOT NULL
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      createdAt  TEXT    NOT NULL,
      filename   TEXT,
      added      INTEGER NOT NULL DEFAULT 0,
      updated    INTEGER NOT NULL DEFAULT 0,
      skipped    INTEGER NOT NULL DEFAULT 0,
      failed     INTEGER NOT NULL DEFAULT 0,
      workerName TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS donor_phone_lookup (
      phone    TEXT PRIMARY KEY,
      donorId  INTEGER NOT NULL REFERENCES donors(id) ON DELETE CASCADE
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_phone_lookup_donorId ON donor_phone_lookup(donorId)");

  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_sessions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      sessionId     TEXT    NOT NULL UNIQUE,
      workerId      INTEGER NOT NULL,
      workerName    TEXT    NOT NULL,
      loginAt       TEXT    NOT NULL,
      lastHeartbeat TEXT    NOT NULL,
      logoutAt      TEXT,
      userAgent     TEXT,
      ip            TEXT,
      status        TEXT    NOT NULL DEFAULT 'active'
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_worker_sessions_status ON worker_sessions(status)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_worker_sessions_loginAt ON worker_sessions(loginAt)");

  // ── Browser softphone (JsSIP/WebRTC) call history — distinct from
  // ivr_call_sessions (IVR self-service calls) and click2call_logs (server-
  // bridged Technoline click2call). One row per SIP session, upserted by
  // sipCallId (JsSIP RTCSession.id = call_id+from_tag, a stable per-dialog
  // identifier) so repeated lifecycle events for the same session never
  // create duplicate rows. See softphone-call-classifier.js for the status
  // values written here.
  db.exec(`
    CREATE TABLE IF NOT EXISTS softphone_calls (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      sipCallId        TEXT    NOT NULL UNIQUE,
      direction        TEXT    NOT NULL,
      remotePhone      TEXT    NOT NULL,
      -- NOT a FK to donors(id): this is the app_state.donors[].id (app-level
      -- donor id, what donor.html?id= expects), a different id space than
      -- the thin SQLite donors table's own id — see donor.service.js's
      -- "appDonorId" comment. A real REFERENCES here would wrongly reject
      -- every donor match (and does, under node:sqlite's default
      -- foreign_keys=ON, unlike other sqlite libraries used elsewhere here).
      donorId          INTEGER,
      donorName        TEXT,
      contactId        INTEGER REFERENCES softphone_contacts(id),
      contactName      TEXT,
      selectedCallerId TEXT,
      workerId         INTEGER,
      workerName       TEXT,
      startedAt        TEXT    NOT NULL,
      ringingAt        TEXT,
      answeredAt       TEXT,
      endedAt          TEXT,
      ringDurationSec  INTEGER,
      talkDurationSec  INTEGER,
      status           TEXT    NOT NULL,
      failureReason    TEXT,
      rawSipCause      TEXT,
      createdAt        TEXT    NOT NULL,
      updatedAt        TEXT    NOT NULL
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_softphone_calls_startedAt ON softphone_calls(startedAt)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_softphone_calls_status    ON softphone_calls(status)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_softphone_calls_direction ON softphone_calls(direction)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_softphone_calls_remote    ON softphone_calls(remotePhone)");

  // ── Softphone custom contacts (people who are NOT donors). Donor contacts
  // are never copied in here — they are always read live from app_state.donors
  // (the donor source of truth, via donor.service.js's allAppDonors()) and
  // merged in at the API layer. This table only holds non-donor entries.
  db.exec(`
    CREATE TABLE IF NOT EXISTS softphone_contacts (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      name               TEXT    NOT NULL,
      primaryPhone       TEXT    NOT NULL,
      additionalPhones    TEXT,
      notes              TEXT,
      normalizedPhoneKey TEXT    NOT NULL UNIQUE,
      createdAt          TEXT    NOT NULL,
      updatedAt          TEXT    NOT NULL,
      createdByWorkerId  INTEGER,
      createdByWorkerName TEXT
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_softphone_contacts_name ON softphone_contacts(name)");

  // ── Migrations ──────────────────────────────────────────────────
  try { db.exec("ALTER TABLE workers ADD COLUMN passwordHash TEXT"); } catch (_) {}
  try { db.exec("ALTER TABLE workers ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0"); } catch (_) {}
  try { db.exec("ALTER TABLE ivr_donations ADD COLUMN donorId INTEGER REFERENCES donors(id)"); } catch (_) {}
  try { db.exec("ALTER TABLE ivr_call_logs ADD COLUMN timestamp TEXT"); } catch (_) {}
  try { db.exec("ALTER TABLE payments ADD COLUMN confirmationNumber TEXT"); } catch (_) {}
  // Lets a manual payment be reversed (status='cancelled') without ever
  // deleting the row — financial history must stay intact. See
  // cancelManualDonationPayment().
  try { db.exec("ALTER TABLE payments ADD COLUMN cancelledAt TEXT"); } catch (_) {}

  // ── Caller-identification redesign: payer (who called/identified
  // themselves) vs beneficiary (existing donorId — whose debt is paid) ──────
  try { db.exec("ALTER TABLE payments ADD COLUMN payerDonorId INTEGER REFERENCES donors(id)"); } catch (_) {}
  try { db.exec("ALTER TABLE payments ADD COLUMN payerPhone TEXT"); } catch (_) {}
  try { db.exec("ALTER TABLE payments ADD COLUMN identificationMethod TEXT"); } catch (_) {}
  try { db.exec("ALTER TABLE payments ADD COLUMN isSelfPayment INTEGER"); } catch (_) {}
  try { db.exec("ALTER TABLE ivr_donations ADD COLUMN payerDonorId INTEGER REFERENCES donors(id)"); } catch (_) {}
  try { db.exec("ALTER TABLE ivr_donations ADD COLUMN payerPhone TEXT"); } catch (_) {}
  try { db.exec("ALTER TABLE ivr_donations ADD COLUMN identificationMethod TEXT"); } catch (_) {}
  try { db.exec("ALTER TABLE ivr_donations ADD COLUMN isSelfPayment INTEGER"); } catch (_) {}
  try { db.exec("ALTER TABLE ivr_call_sessions ADD COLUMN payerDonorId INTEGER REFERENCES donors(id)"); } catch (_) {}
  try { db.exec("ALTER TABLE ivr_call_sessions ADD COLUMN payerDonorName TEXT"); } catch (_) {}
  try { db.exec("ALTER TABLE ivr_call_sessions ADD COLUMN payerIdentMethod TEXT"); } catch (_) {}
  // Tracks whether the one-time "donor_identified"/"unknown_caller" call-log
  // step has already been written for this call, independent of which HTTP
  // request of the call first reaches beneficiary resolution (identification
  // now happens on an earlier request — see resolveBeneficiary() callers).
  try { db.exec("ALTER TABLE ivr_call_sessions ADD COLUMN identificationLogged INTEGER NOT NULL DEFAULT 0"); } catch (_) {}
  // Technoline's own name for the saved recording (FILE_voiceMessage) —
  // added after production testing showed the file it creates only STARTS
  // WITH our requested fileName, not matches it exactly, breaking
  // fileName-based downloads for rows saved before this column existed.
  try { db.exec("ALTER TABLE ivr_voice_messages ADD COLUMN technolineAudio TEXT"); } catch (_) {}

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
  db.exec("CREATE INDEX IF NOT EXISTS idx_voice_messages_phone     ON ivr_voice_messages(phone)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_voice_messages_status    ON ivr_voice_messages(status)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_voice_messages_createdAt ON ivr_voice_messages(createdAt)");

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
    const hash = bcrypt.hashSync(defaultPasswordForRole("מנהל"), SALT_ROUNDS);
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
    const defaultPass = defaultPasswordForRole(worker.role);
    const hash = bcrypt.hashSync(defaultPass, SALT_ROUNDS);
    db.prepare("UPDATE workers SET passwordHash = ?, updatedAt = ? WHERE id = ?")
      .run(hash, nowIso(), worker.id);
  }

  // ── Flag workers still using their default password (must change on next login) ──
  const workersToCheck = db.prepare(
    "SELECT id, role, passwordHash FROM workers WHERE must_change_password = 0"
  ).all();

  for (const w of workersToCheck) {
    const defaultPass = defaultPasswordForRole(w.role);
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

// Disables ("blocks") a worker without deleting them — status becomes
// anything other than "פעיל", which both loginWorker() and requireAuth()
// already treat as not allowed to authenticate or keep an existing session.
function setWorkerStatus(id, status) {
  return db.prepare("UPDATE workers SET status = ?, updatedAt = ? WHERE id = ?")
    .run(String(status).trim(), nowIso(), Number(id));
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
  var intl = (normalized.startsWith("0") && normalized.length >= 9)
    ? "972" + normalized.slice(1)
    : null;

  // Fast path: upsertDonor always stores phone already stripped of separators,
  // so a plain equality check matches the vast majority of rows and can use
  // idx_donors_phone. Wrapping the column in REPLACE() (below) is not
  // sargable — SQLite can't use the index and falls back to a full table
  // scan on every call, which matters here because this runs on every single
  // IVR call to identify the caller. Try the indexed lookup first and only
  // pay for the full-scan fallback for legacy rows that predate normalization.
  var fast = intl
    ? db.prepare("SELECT id, phone, fullName FROM donors WHERE phone IN (?,?) LIMIT 1").get(normalized, intl)
    : db.prepare("SELECT id, phone, fullName FROM donors WHERE phone = ? LIMIT 1").get(normalized);
  if (fast) return fast;

  // Primary phone column (fallback for rows stored with separators)
  var row = intl
    ? db.prepare("SELECT id, phone, fullName FROM donors WHERE " + STRIP_PHONE_SQL + " IN (?,?) LIMIT 1").get(normalized, intl)
    : db.prepare("SELECT id, phone, fullName FROM donors WHERE " + STRIP_PHONE_SQL + " = ? LIMIT 1").get(normalized);
  if (row) return row;

  // Secondary phones via lookup table
  var lookup = db.prepare(
    "SELECT d.id, d.phone, d.fullName FROM donor_phone_lookup l JOIN donors d ON d.id = l.donorId WHERE l.phone IN (?,?) LIMIT 1"
  ).get(normalized, intl || normalized);
  return lookup || undefined;
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

// Stores secondary/extra phones for a donor in the lookup table.
// sqliteId: the donors.id row; phones: array of raw phone strings.
function upsertPhoneLookup(sqliteId, phones) {
  if (!sqliteId || !Array.isArray(phones)) return;
  var stmt = db.prepare(
    "INSERT INTO donor_phone_lookup (phone, donorId) VALUES (?,?) ON CONFLICT(phone) DO UPDATE SET donorId=excluded.donorId"
  );
  phones.forEach(function (p) {
    var n = normalizePhoneForDb(p);
    if (n) { try { stmt.run(n, Number(sqliteId)); } catch (_) {} }
  });
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

// details: { callId, phone, amount, donorId, confirmationNumber, payerDonorId,
//            payerPhone, identificationMethod, isSelfPayment }
// donorId is always the BENEFICIARY (whose debt is paid) — unchanged meaning.
function savePaymentInTransaction(details) {
  const cid = String(details.callId).trim();
  const ph  = String(details.phone).trim();
  const amount               = details.amount;
  const donorId              = details.donorId              || null;
  const confirmationNumber   = details.confirmationNumber   || null;
  const payerDonorId         = details.payerDonorId         || null;
  const payerPhone           = details.payerPhone           || null;
  const identificationMethod = details.identificationMethod || null;
  const isSelfPayment        = details.isSelfPayment ? 1 : 0;

  try {
    db.exec("BEGIN");

    const existingDonation = db.prepare(
      "SELECT id FROM ivr_donations WHERE callId = ? LIMIT 1"
    ).get(cid);

    const existingPayment = db.prepare(
      "SELECT id FROM payments WHERE callId = ? LIMIT 1"
    ).get(cid);

    if (!existingDonation) {
      db.prepare(`
        INSERT OR IGNORE INTO ivr_donations
          (callId, phone, amount, donorId, payerDonorId, payerPhone, identificationMethod, isSelfPayment, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(cid, ph, amount, donorId, payerDonorId, payerPhone, identificationMethod, isSelfPayment, nowIso());
    }

    if (!existingPayment) {
      const stamp = nowIso();
      db.prepare(`
        INSERT OR IGNORE INTO payments
          (callId, phone, donorId, amount, status, source, confirmationNumber, payerDonorId, payerPhone, identificationMethod, isSelfPayment, createdAt, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(cid, ph, donorId, amount, "success", "ivr", confirmationNumber, payerDonorId, payerPhone, identificationMethod, isSelfPayment, stamp, stamp);
    }

    db.exec("COMMIT");
    return { duplicate: !!(existingDonation || existingPayment) };
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch (_) {}
    throw err;
  }
}

// ── Payments list / single / stats (for CRM payments screen) ─────────────────

// donorId here is the SQL donors(id) — the phone-keyed IVR identity table —
// which is NOT the same id space as the CRM's frontend donor.id (see
// findDonorByPhone/upsertDonor). The optional `phone` filter exists because
// callers on the CRM side (e.g. donor.html) only know the donor by their
// app-level id/phone, not this table's id, and normalizing by phone is the
// one thing both id spaces agree on.
//
// attachAppDonorId() below resolves that other, app-level id (app_state
// donors[].id — what donor.html?id= actually expects) via phone, the one
// thing both id spaces agree on. Bug history: the payments screen used to
// link donor.html?id=<p.donorId>, i.e. this SQL table's id, which almost
// never equals any real app_state donor id — hence "לא נמצא תורם" on click.

// normalizedPhone -> app_state donor id, or `false` if that phone is shared
// by more than one app-level donor (ambiguous — must not guess which one).
// Mirrors donorHasPhone() in updateDonorDebtAfterPayment (same field set:
// phone/phone2/phone3/phone4/phones[]/ivrApprovedPhones[]).
function buildAppDonorPhoneMap() {
  var donors = getAppState("donors");
  var map = Object.create(null);
  if (!Array.isArray(donors)) return map;

  donors.forEach(function (d) {
    // app_state is a hand-rolled JSON blob, not a schema-enforced table —
    // normalize d.id to a real number here so a stray string id (or a
    // Number(...) vs raw mismatch) can never produce a value that fails the
    // strict === donor.js does against Number(params.get("id")).
    var appId = Number(d.id);
    if (!appId && appId !== 0) return; // NaN / missing id -> unusable, skip this donor entirely

    var fields = [d.phone, d.phone2, d.phone3, d.phone4]
      .concat(Array.isArray(d.phones) ? d.phones : [])
      .concat(Array.isArray(d.ivrApprovedPhones) ? d.ivrApprovedPhones : []);
    var seenOnThisDonor = Object.create(null);
    fields.forEach(function (raw) {
      var n = normalizePhoneForDb(raw);
      if (!n || seenOnThisDonor[n]) return;
      seenOnThisDonor[n] = true;
      if (!(n in map)) map[n] = appId;
      else if (map[n] !== appId) map[n] = false;
    });
  });
  return map;
}

function attachAppDonorId(row, phoneMap) {
  if (!row) return row;
  var n = row.phone ? normalizePhoneForDb(row.phone) : "";
  var resolved = n ? phoneMap[n] : undefined;
  row.appDonorId = (resolved || resolved === 0) ? resolved : null;
  return row;
}

function getPayments(opts) {
  var options = (typeof opts === "object" && opts !== null) ? opts : { limit: opts };
  var limit   = Math.min(Number(options.limit) || 500, 2000);
  var donorId = options.donorId ? Number(options.donorId) : null;
  var phone   = options.phone ? normalizePhoneForDb(options.phone) : null;

  var base = `
    SELECT p.id, p.callId, p.phone, p.donorId, p.amount, p.status, p.source,
           p.confirmationNumber, p.createdAt, p.timestamp, p.cancelledAt,
           d.fullName AS donorName
    FROM   payments p
    LEFT JOIN donors d ON d.id = p.donorId
  `;

  var where  = [];
  var params = [];
  if (donorId) { where.push("p.donorId = ?"); params.push(donorId); }
  if (phone)   { where.push(STRIP_PHONE_SQL.replace(/\bphone\b/g, "p.phone") + " = ?"); params.push(phone); }

  var sql  = base + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY p.id DESC LIMIT ?";
  var stmt = db.prepare(sql);
  var rows = stmt.all.apply(stmt, params.concat([limit]));
  var phoneMap = buildAppDonorPhoneMap();
  rows.forEach(function (row) { attachAppDonorId(row, phoneMap); });
  return rows;
}

function getPaymentById(id) {
  var row = db.prepare(`
    SELECT p.id, p.callId, p.phone, p.donorId, p.amount, p.status, p.source,
           p.confirmationNumber, p.createdAt, p.timestamp, p.cancelledAt,
           d.fullName AS donorName
    FROM   payments p
    LEFT JOIN donors d ON d.id = p.donorId
    WHERE  p.id = ?
  `).get(Number(id));
  return attachAppDonorId(row, buildAppDonorPhoneMap());
}

function cancelPaymentById(id) {
  db.prepare("UPDATE payments SET status = 'cancelled', cancelledAt = ? WHERE id = ?").run(nowIso(), Number(id));
}

function httpError(status, message) {
  var err = new Error(message);
  err.httpStatus = status;
  return err;
}

// ── Manual payment: mark-paid / cancel, both atomic (see
// manual-payment.routes.test.js) ─────────────────────────────────────────────
//
// donors (with nested donations) live as one JSON blob in app_state, not a
// per-row SQL table, so "atomic" here means: the payments-table write and the
// app_state read-modify-write happen inside one BEGIN/COMMIT (same manual
// transaction style as savePaymentInTransaction above) — either both land or
// neither does. node:sqlite's DatabaseSync is fully synchronous and Node is
// single-threaded, so no other request's code can run between the statements
// in this function; the transaction protects against a thrown error or crash
// mid-way, not against interleaving from a concurrent request (that risk
// doesn't exist here for the same reason).
//
// idempotencyKey is caller-supplied (donor.js generates one per edit
// session, reused across retries of the same click) and is stored as the
// payment's callId (UNIQUE) — a request replayed with the same key after a
// timeout/retry finds the already-created payment and returns it rather than
// charging twice.
function markDonationPaidManually(params) {
  var callId = "manual:" + String(params.idempotencyKey).trim();

  var existing = findPaymentByCallId(callId);
  if (existing) {
    var donorsNow = getAppState("donors");
    var donorNow = donorsNow.find(function (d) { return Number(d.id) === Number(params.appDonorId); });
    var donationNow = donorNow ? (donorNow.donations || []).find(function (d) { return Number(d.id) === Number(params.donationId); }) : null;
    return { idempotent: true, payment: existing, donation: donationNow || null };
  }

  try {
    db.exec("BEGIN");

    var donors = getAppState("donors");
    var donor = donors.find(function (d) { return Number(d.id) === Number(params.appDonorId); });
    if (!donor) throw httpError(404, "תורם לא נמצא");
    var donation = (donor.donations || []).find(function (d) { return Number(d.id) === Number(params.donationId); });
    if (!donation) throw httpError(404, "תרומה לא נמצאה");

    var existingPaidPartial = Number(donation.paidPartial || 0);
    var amount = Number(params.amount);
    if (!isFinite(amount) || amount <= 0) throw httpError(400, "סכום לא תקין");
    if (amount < existingPaidPartial) {
      throw httpError(400, "אי אפשר להקטין את סכום התרומה מתחת לסכום שכבר שולם");
    }

    // Server-computed from the CURRENT stored state, never trusted from the
    // client — this is what makes two concurrent "mark as paid" requests for
    // the same donation safe: whichever commits first zeroes remainingDebt,
    // so the second (running strictly after, per the note above) sees
    // chargeAmount <= 0 here and is rejected instead of charging again.
    var chargeAmount = amount - existingPaidPartial;
    if (chargeAmount <= 0) {
      throw httpError(409, "התרומה כבר משולמת במלואה — ייתכן שתשלום מקביל כבר נקלט");
    }

    var phone = params.phone ? String(params.phone).trim().slice(0, 30) : "";
    var donorName = params.donorName ? String(params.donorName).trim().slice(0, 200) : "";
    var paymentMethod = params.paymentMethod ? String(params.paymentMethod).trim().slice(0, 50) : "";

    var sqlDonorId = null;
    if (phone) {
      if (donorName) { try { upsertDonor(phone, donorName); } catch (_) {} }
      var resolved = findDonorByPhone(phone);
      if (resolved) sqlDonorId = resolved.id;
    }

    var result = recordPayment({
      callId:             callId,
      phone:              phone,
      donorId:            sqlDonorId,
      amount:             chargeAmount,
      status:             "success",
      source:             "manual",
      confirmationNumber: null,
    });
    var payment = getPaymentById(result.lastInsertRowid);

    // Test-only fault injection to exercise the rollback path over real HTTP
    // (see manual-payment.routes.test.js) — inert unless a test explicitly
    // sets this env var before requiring server.js; never set in deploy.
    if (process.env.TEST_FORCE_MANUAL_PAYMENT_FAILURE === "1") {
      throw new Error("[test-only] forced failure between payment insert and donation update");
    }

    donation.amount = amount;
    donation.paidPartial = amount;
    donation.remainingDebt = 0;
    donation.paid = true;
    if (paymentMethod) {
      donation.paymentMethod = paymentMethod;
      donation.lastPaymentMethod = paymentMethod;
    }
    donation.lastPaymentId = payment.id;
    donation.updatedAt = nowIso();
    donor.updatedAt = nowIso();

    setAppState("donors", donors);

    try {
      insertAuditLog({
        action:     "create",
        entityType: "payment",
        entityId:   params.appDonorId,
        entityName: donorName || null,
        details:    "תשלום ידני נרשם בסך " + chargeAmount + " ₪" + (paymentMethod ? " (" + paymentMethod + ")" : ""),
        workerId:   params.workerId,
        workerName: params.workerName,
        ip:         params.ip,
      });
    } catch (_) {}

    db.exec("COMMIT");
    return { idempotent: false, payment: payment, donation: donation };
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch (_) {}
    throw err;
  }
}

// Reverses exactly the payment this donation's own manual mark-paid action
// created (donation.lastPaymentId — never an arbitrary/IVR payment) by
// flipping its status to 'cancelled' (never deleting it) and restoring the
// donation to whatever paidPartial it had immediately before that specific
// payment — correctly returning a donation that was partially paid and then
// completed manually back to its partial state, not to zero.
function cancelManualDonationPayment(params) {
  try {
    db.exec("BEGIN");

    var donors = getAppState("donors");
    var donor = donors.find(function (d) { return Number(d.id) === Number(params.appDonorId); });
    if (!donor) throw httpError(404, "תורם לא נמצא");
    var donation = (donor.donations || []).find(function (d) { return Number(d.id) === Number(params.donationId); });
    if (!donation) throw httpError(404, "תרומה לא נמצאה");

    var paymentId = donation.lastPaymentId;
    if (!paymentId) throw httpError(400, "אין תשלום ידני מקושר לביטול עבור תרומה זו");

    var payment = getPaymentById(paymentId);
    if (!payment) throw httpError(404, "רשומת התשלום לא נמצאה");
    if (payment.source !== "manual") {
      throw httpError(400, "ניתן לבטל רק תשלום ידני שנוצר מפעולת עריכה זו — לא תשלום IVR או תשלום אחר");
    }
    if (payment.status === "cancelled") throw httpError(409, "התשלום כבר בוטל");

    cancelPaymentById(paymentId);

    var reduceBy = Number(payment.amount || 0);
    var newPaidPartial = Number(donation.paidPartial || 0) - reduceBy;
    if (newPaidPartial < 0) newPaidPartial = 0; // defensive floor — should never trigger given the invariants above

    donation.paidPartial = newPaidPartial;
    donation.remainingDebt = Number(donation.amount || 0) - newPaidPartial;
    donation.paid = donation.remainingDebt <= 0;
    donation.lastPaymentId = null;
    donation.updatedAt = nowIso();
    donor.updatedAt = nowIso();

    setAppState("donors", donors);

    try {
      insertAuditLog({
        action:     "payment_cancel",
        entityType: "payment",
        entityId:   params.appDonorId,
        entityName: null,
        details:    "תשלום ידני מס' " + paymentId + " בוטל (" + reduceBy + " ₪) — אושר במפורש ע\"י המשתמש",
        workerId:   params.workerId,
        workerName: params.workerName,
        ip:         params.ip,
      });
    } catch (_) {}

    db.exec("COMMIT");
    return { donation: donation, payment: getPaymentById(paymentId) };
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch (_) {}
    throw err;
  }
}

// Records a genuine PARTIAL manual payment against one donation — unlike
// markDonationPaidManually (which always drives a donation to fully paid,
// remainingDebt=0), this applies exactly params.amount against the
// donation's current remainingDebt and may leave it partially open. Used
// both by the donor-card "partial payment across several open debts" flow
// (called once per affected donation, one real payments row each — see
// server.js) and by "add donation already paid" (called once, for the full
// amount, immediately after the donation itself is created unpaid).
//
// Same atomicity/idempotency contract as markDonationPaidManually: one
// BEGIN/COMMIT covering the payments-table insert and the app_state
// read-modify-write, and a caller-supplied idempotencyKey stored as the
// payment's callId so a retried request after a timeout/error is recognized
// as the same logical payment instead of charging twice.
// cancelManualDonationPayment (above) already reverses either kind of
// payment generically via donation.lastPaymentId + payment.amount, so no
// separate cancel path is needed for partial payments.
function recordManualPartialPayment(params) {
  var callId = "manual-partial:" + String(params.idempotencyKey).trim();

  var existing = findPaymentByCallId(callId);
  if (existing) {
    var donorsNow = getAppState("donors");
    var donorNow = donorsNow.find(function (d) { return Number(d.id) === Number(params.appDonorId); });
    var donationNow = donorNow ? (donorNow.donations || []).find(function (d) { return Number(d.id) === Number(params.donationId); }) : null;
    return { idempotent: true, payment: existing, donation: donationNow || null };
  }

  try {
    db.exec("BEGIN");

    var donors = getAppState("donors");
    var donor = donors.find(function (d) { return Number(d.id) === Number(params.appDonorId); });
    if (!donor) throw httpError(404, "תורם לא נמצא");
    var donation = (donor.donations || []).find(function (d) { return Number(d.id) === Number(params.donationId); });
    if (!donation) throw httpError(404, "תרומה לא נמצאה");

    var chargeAmount = Number(params.amount);
    if (!isFinite(chargeAmount) || chargeAmount <= 0) throw httpError(400, "סכום לא תקין");

    // Server-computed from the CURRENT stored remainingDebt, never trusted
    // from the client — same concurrency guarantee as markDonationPaidManually:
    // a stale/concurrent request that would overpay this specific donation is
    // rejected rather than driving remainingDebt negative.
    var currentRemaining = Number(donation.remainingDebt || 0);
    if (chargeAmount > currentRemaining) {
      throw httpError(409, "סכום התשלום גדול מיתרת החוב הנוכחית של התרומה — ייתכן שהיא כבר עודכנה");
    }

    var phone = params.phone ? String(params.phone).trim().slice(0, 30) : "";
    var donorName = params.donorName ? String(params.donorName).trim().slice(0, 200) : "";
    var paymentMethod = params.paymentMethod ? String(params.paymentMethod).trim().slice(0, 50) : "";

    var sqlDonorId = null;
    if (phone) {
      if (donorName) { try { upsertDonor(phone, donorName); } catch (_) {} }
      var resolved = findDonorByPhone(phone);
      if (resolved) sqlDonorId = resolved.id;
    }

    var result = recordPayment({
      callId:             callId,
      phone:              phone,
      donorId:            sqlDonorId,
      amount:             chargeAmount,
      status:             "success",
      source:             "manual",
      confirmationNumber: null,
    });
    var payment = getPaymentById(result.lastInsertRowid);

    donation.paidPartial = Number(donation.paidPartial || 0) + chargeAmount;
    donation.remainingDebt = currentRemaining - chargeAmount;
    donation.paid = donation.remainingDebt <= 0;
    if (paymentMethod) {
      donation.paymentMethod = donation.paymentMethod || paymentMethod;
      donation.lastPaymentMethod = paymentMethod;
    }
    donation.lastPaymentId = payment.id;
    donation.updatedAt = nowIso();
    donor.updatedAt = nowIso();

    setAppState("donors", donors);

    try {
      insertAuditLog({
        action:     "create",
        entityType: "payment",
        entityId:   params.appDonorId,
        entityName: donorName || null,
        details:    "תשלום חלקי ידני נרשם בסך " + chargeAmount + " ₪" + (paymentMethod ? " (" + paymentMethod + ")" : ""),
        workerId:   params.workerId,
        workerName: params.workerName,
        ip:         params.ip,
      });
    } catch (_) {}

    db.exec("COMMIT");
    return { idempotent: false, payment: payment, donation: donation };
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch (_) {}
    throw err;
  }
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
//
// appDonorId: the exact app_state.donors[].id already resolved during caller
// identification (donor.service.js's appDonorId) — preferred over phone
// matching so this never touches a different donor that happens to share the
// same phone number. phone is kept only as a fallback for the rare case no
// donorId could be resolved upstream (e.g. legacy record with no id field).
function updateDonorDebtAfterPayment(appDonorId, phone, paidAmount) {
  var normalizedPhone = normalizePhoneForDb(phone);
  if (!(paidAmount > 0)) {
    return { donorFound: false, updated: false, reason: "invalid_args" };
  }

  var donors = getAppState("donors");
  if (!Array.isArray(donors) || donors.length === 0) {
    return { donorFound: false, updated: false, reason: "no_donors_in_state" };
  }

  var hasAppDonorId = appDonorId !== null && appDonorId !== undefined && appDonorId !== "";
  var donorIdx = -1;

  if (hasAppDonorId) {
    for (var dj = 0; dj < donors.length; dj++) {
      if (donors[dj].id === appDonorId) {
        donorIdx = dj;
        break;
      }
    }
  } else {
    // Fallback only when no donorId was resolved upstream at all — matches
    // by ANY phone field: phone, phone2, phone3, phone4, phones[], ivrApprovedPhones[]
    if (!normalizedPhone) {
      return { donorFound: false, updated: false, reason: "invalid_args" };
    }
    function donorHasPhone(d, n) {
      var fields = [d.phone, d.phone2, d.phone3, d.phone4];
      for (var fi = 0; fi < fields.length; fi++) {
        if (normalizePhoneForDb(fields[fi]) === n) return true;
      }
      var extra = (d.phones || []).concat(d.ivrApprovedPhones || []);
      for (var ei = 0; ei < extra.length; ei++) {
        if (normalizePhoneForDb(extra[ei]) === n) return true;
      }
      return false;
    }
    for (var di = 0; di < donors.length; di++) {
      if (donorHasPhone(donors[di], normalizedPhone)) {
        donorIdx = di;
        break;
      }
    }
  }

  if (donorIdx === -1) {
    return { donorFound: false, updated: false, reason: hasAppDonorId ? "donor_id_not_in_state" : "donor_not_in_state" };
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
  var touchedDebts = [];
  var now = nowIso();

  for (var i = 0; i < openDebts.length && remaining > 0.005; i++) {
    var debt = openDebts[i];
    var debtAmt = Math.round(Number(debt.remainingDebt || 0) * 100) / 100;
    if (debtAmt <= 0) continue;

    if (remaining >= debtAmt - 0.005) {
      // Full payment of this debt
      remaining = Math.round((remaining - debtAmt) * 100) / 100;
      debt.paidPartial = Math.round(((Number(debt.paidPartial) || 0) + debtAmt) * 100) / 100;
      debt.remainingDebt = 0;
      debt.paid = true;
      debt.paidAt = now;
      debt.paidVia = "ivr";
      affectedDebts++;
      touchedDebts.push(debt);
    } else {
      // Partial payment — reduce remaining debt
      debt.paidPartial = Math.round(((Number(debt.paidPartial) || 0) + remaining) * 100) / 100;
      debt.remainingDebt = Math.round((debtAmt - remaining) * 100) / 100;
      remaining = 0;
      affectedDebts++;
      touchedDebts.push(debt);
    }
  }

  if (affectedDebts === 0) {
    return { donorFound: true, updated: false, reason: "no_change" };
  }

  setAppState("donors", donors);
  reconcileApprovalDraftsForDonor(donor.id, touchedDebts, now);
  return { donorFound: true, updated: true, affectedDebts: affectedDebts };
}

// Keeps existing approval drafts (approvals.html, app_state key "approvals") in sync
// when an IVR payment changes a donation's remainingDebt — only updates/cancels an
// existing "טיוטה" draft, never creates or approves a real charge.
function reconcileApprovalDraftsForDonor(donorId, touchedDebts, now) {
  if (!touchedDebts || touchedDebts.length === 0) return;
  var approvals = getAppState("approvals");
  if (!Array.isArray(approvals) || approvals.length === 0) return;

  var changed = false;
  touchedDebts.forEach(function (debt) {
    var draft = approvals.find(function (a) {
      return a.donorId === donorId && a.donationId === debt.id && a.status === "טיוטה";
    });
    if (!draft) return;

    var remainingDebt = Number(debt.remainingDebt || 0);
    if (remainingDebt <= 0) {
      draft.status = "בוטל";
      draft.cancelledAt = now;
      draft.updatedAt = now;
    } else {
      draft.amount = remainingDebt;
      draft.updatedAt = now;
    }
    changed = true;
  });

  if (changed) setAppState("approvals", approvals);
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

// Idempotent, single-fire gate for the "donor_identified"/"unknown_caller"
// call-log step: returns true only the first time it's called for a given
// callId, so callers can log the step exactly once regardless of how many
// requests happen after beneficiary resolution.
function markIdentificationLogged(callId) {
  var result = db.prepare(`
    UPDATE ivr_call_sessions
    SET identificationLogged = 1
    WHERE callId = ? AND identificationLogged = 0
  `).run(String(callId).trim());
  return result.changes > 0;
}

// Same idempotency pattern as updateCallSessionDonor — records who CALLED
// and identified themselves (payer), independent of donorId which (as of
// the caller-identification redesign) always means the BENEFICIARY.
function updateCallSessionPayer(callId, payerDonorId, payerDonorName, payerIdentMethod) {
  db.prepare(`
    UPDATE ivr_call_sessions
    SET payerDonorId = ?, payerDonorName = ?, payerIdentMethod = ?
    WHERE callId = ? AND payerDonorId IS NULL
  `).run(payerDonorId || null, payerDonorName || null, payerIdentMethod || null, String(callId).trim());
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
           s.payerDonorId, s.payerDonorName,
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
        logger.warn("DB", "logClick2Call: donor not found by id=" + donorId + " or phone=" + logger.redact(donorPhone) + " (app-level id, not synced to SQLite) — FK stored as NULL");
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

// Accepts sqliteDonorId (may be null/wrong) AND phone as fallback.
// Returns logs that match either condition, deduped by id.
function getClick2CallLogs(sqliteDonorId, limit, phone) {
  var n = limit || 50;
  if (sqliteDonorId && phone) {
    var normalizedPhone = normalizePhoneForDb(phone);
    return db.prepare(`
      SELECT id, pbxCallId, workerName, donorPhone, agentExtension, status, errorNote, createdAt
      FROM click2call_logs
      WHERE donorId = ? OR donorPhone = ?
      ORDER BY createdAt DESC
      LIMIT ?
    `).all(Number(sqliteDonorId), normalizedPhone || phone, n);
  }
  if (sqliteDonorId) {
    return db.prepare(`
      SELECT id, pbxCallId, workerName, donorPhone, agentExtension, status, errorNote, createdAt
      FROM click2call_logs
      WHERE donorId = ?
      ORDER BY createdAt DESC
      LIMIT ?
    `).all(Number(sqliteDonorId), n);
  }
  if (phone) {
    var np = normalizePhoneForDb(phone);
    return db.prepare(`
      SELECT id, pbxCallId, workerName, donorPhone, agentExtension, status, errorNote, createdAt
      FROM click2call_logs
      WHERE donorPhone = ?
      ORDER BY createdAt DESC
      LIMIT ?
    `).all(np || phone, n);
  }
  return [];
}

// Latest click2call_logs rows across all donors — used by the campaigns screen
// to show a system-wide success/failure log (as opposed to per-donor timeline).
function getRecentClick2CallLogs(limit) {
  var n = Math.min(Number(limit) || 30, 200);
  return db.prepare(`
    SELECT id, pbxCallId, workerName, donorId, donorName, donorPhone, agentExtension, status, errorNote, createdAt
    FROM click2call_logs
    ORDER BY id DESC
    LIMIT ?
  `).all(n);
}

// ── IVR voice messages (caller-left voicemails, recorded via the "record"
// module and fetched on demand from Technoline's fileDownload action —
// nothing here stores the audio bytes themselves, only enough to locate and
// display them) ───────────────────────────────────────────────────────────

// Same INSERT-OR-IGNORE-by-unique-key idempotency pattern as
// savePaymentInTransaction() above — pbxCallId is UNIQUE, so a callback
// Technoline resends for the same call (its documented retry behavior on
// every module API request) never creates a second row.
var IVR_VOICE_MESSAGE_STATUSES = ["ממתין", "טופל"];

function saveIvrVoiceMessageOnce(details) {
  var pbxCallId = String(details.pbxCallId || "").trim();
  if (!pbxCallId) throw new Error("pbxCallId is required");

  var existing = db.prepare("SELECT id FROM ivr_voice_messages WHERE pbxCallId = ? LIMIT 1").get(pbxCallId);
  if (existing) return { duplicate: true, id: existing.id };

  var info = db.prepare(`
    INSERT INTO ivr_voice_messages
      (pbxCallId, phone, donorAppId, donorName, fileName, technolineAudio, extension, fileId, filePath, durationSec, sizeMb, status, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    pbxCallId,
    String(details.phone || "").trim(),
    details.donorAppId != null ? details.donorAppId : null,
    details.donorName || null,
    String(details.fileName || "").trim(),
    details.technolineAudio || null,
    details.extension || null,
    details.fileId || null,
    details.filePath || null,
    details.durationSec != null ? Number(details.durationSec) : null,
    details.sizeMb != null ? Number(details.sizeMb) : null,
    IVR_VOICE_MESSAGE_STATUSES[0],
    nowIso()
  );
  return { duplicate: false, id: info.lastInsertRowid };
}

function listIvrVoiceMessages(opts) {
  var options = opts || {};
  var limit = Math.min(Number(options.limit) || 200, 1000);
  var where = [];
  var params = [];
  if (options.status) { where.push("status = ?"); params.push(String(options.status)); }
  var sql = "SELECT * FROM ivr_voice_messages" +
    (where.length ? " WHERE " + where.join(" AND ") : "") +
    " ORDER BY id DESC LIMIT ?";
  var stmt = db.prepare(sql);
  return stmt.all.apply(stmt, params.concat([limit]));
}

function getIvrVoiceMessageById(id) {
  return db.prepare("SELECT * FROM ivr_voice_messages WHERE id = ?").get(Number(id));
}

function updateIvrVoiceMessageStatus(id, status) {
  if (IVR_VOICE_MESSAGE_STATUSES.indexOf(status) === -1) {
    throw httpError(400, "סטטוס לא תקין: " + status);
  }
  var info = db.prepare("UPDATE ivr_voice_messages SET status = ? WHERE id = ?").run(status, Number(id));
  return info.changes > 0;
}

// ── App State (key-value store for frontend data) ────────────────────────────

const ALLOWED_APP_STATE_KEYS = new Set([
  "donors", "tasks", "logs", "settings", "approvals", "reminders", "callbacks",
  "sip_config", "alfon_city_map",
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
  var stamp = nowIso();
  db.prepare(`
    INSERT INTO app_state (key, value, updatedAt)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value     = excluded.value,
      updatedAt = excluded.updatedAt
  `).run(String(key), JSON.stringify(data), stamp);
  return true;
}

// Cheap lookup used only to warn (never block) when a client saves a blob
// based on a version that's no longer current — see /api/data/:key in server.js.
function getAppStateUpdatedAt(key) {
  if (!ALLOWED_APP_STATE_KEYS.has(key)) return null;
  const row = db.prepare("SELECT updatedAt FROM app_state WHERE key = ? LIMIT 1").get(String(key));
  return row ? row.updatedAt : null;
}

// ── Backup ───────────────────────────────────────────────────────────────────

function backupDatabase(destPath) {
  // SQLite has no parameterized form of VACUUM INTO, so the path must be
  // interpolated into the SQL string — quote-escaping alone prevents breaking
  // out of the string, but this also rejects anything that isn't a plain
  // absolute .sqlite path, so a future caller can't pass through something
  // unexpected (e.g. a raw request param) without it being caught here too.
  const resolved = path.resolve(String(destPath));
  if (!resolved.endsWith(".sqlite") || resolved.indexOf("\0") !== -1) {
    throw new Error("backupDatabase: invalid destPath");
  }
  db.exec("VACUUM INTO '" + resolved.replace(/'/g, "''") + "'");
}

// Opens srcPath as a read-only SQLite DB and replaces every real table's
// contents in the live DB with the backup's — not just app_state (which is
// what this restored until now: only 9 of the ~17 real tables, silently
// leaving workers/payments/ivr_call_logs/server_audit_log/worker_sessions/
// etc. completely untouched on "restore", giving false confidence in
// disaster recovery).
//
// Table set is the intersection of both databases' own sqlite_master
// (deliberately excludes sqlite's internal sqlite_% tables and any one-off
// migration snapshot table matching "*_backup_*", e.g. the timestamped
// table ensureIvrAudioRecordingsUpToDate() creates before a schema change —
// those are point-in-time artifacts, not part of the regular restore set).
// Column set per table is the intersection of both schemas' own columns, so
// a backup taken before/after a column was added doesn't hard-fail the
// whole restore.
//
// Foreign keys are temporarily disabled for the duration (SQLite requires
// this outside of BEGIN/COMMIT, not inside it) because tables are cleared
// and reloaded one at a time, not in dependency order — safe specifically
// because the whole operation is one atomic transaction: either every
// table ends up fully restored and internally consistent together, or
// nothing changes at all on any error.
//
// IMPORTANT: this function does not by itself decide when it's safe to
// call — see the /api/admin/backups/restore/:filename route in server.js
// and README_PRODUCTION.md for the required pm2 stop / pre-restore backup
// steps around it. This function itself has been verified only against a
// standalone copy of data.sqlite, never against the live production file.
function restoreFromBackup(srcPath) {
  const { DatabaseSync: DS } = require("node:sqlite");
  const bk = new DS(srcPath, { readOnly: true });
  var restoredCounts = {};
  var fkWasOn = true;
  try {
    var TABLE_LIST_SQL =
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%\\_backup\\_%' ESCAPE '\\' ORDER BY name";
    var liveTables   = db.prepare(TABLE_LIST_SQL).all().map(function (r) { return r.name; });
    var backupTables = bk.prepare(TABLE_LIST_SQL).all().map(function (r) { return r.name; });
    var tablesToRestore = liveTables.filter(function (t) { return backupTables.indexOf(t) !== -1; });

    try {
      var fkRow = db.prepare("PRAGMA foreign_keys").get();
      fkWasOn = !!(fkRow && Number(fkRow.foreign_keys) === 1);
    } catch (_) {}
    if (fkWasOn) db.exec("PRAGMA foreign_keys = OFF");

    db.exec("BEGIN");
    try {
      tablesToRestore.forEach(function (table) {
        var liveCols   = db.prepare('PRAGMA table_info("' + table + '")').all().map(function (c) { return c.name; });
        var backupCols = bk.prepare('PRAGMA table_info("' + table + '")').all().map(function (c) { return c.name; });
        var cols = liveCols.filter(function (c) { return backupCols.indexOf(c) !== -1; });
        if (cols.length === 0) { restoredCounts[table] = 0; return; }

        var colList = cols.map(function (c) { return '"' + c + '"'; }).join(", ");
        db.prepare('DELETE FROM "' + table + '"').run();

        var rows = bk.prepare("SELECT " + colList + ' FROM "' + table + '"').all();
        if (rows.length > 0) {
          var placeholders = cols.map(function () { return "?"; }).join(", ");
          var insertStmt = db.prepare('INSERT INTO "' + table + '" (' + colList + ") VALUES (" + placeholders + ")");
          rows.forEach(function (row) {
            insertStmt.run.apply(insertStmt, cols.map(function (c) { return row[c]; }));
          });
        }
        restoredCounts[table] = rows.length;
      });
      db.exec("COMMIT");
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch (_) {}
      throw err;
    } finally {
      if (fkWasOn) { try { db.exec("PRAGMA foreign_keys = ON"); } catch (_) {} }
    }

    return restoredCounts;
  } finally {
    try { bk.close(); } catch (_) {}
  }
}

// ── Dashboard ────────────────────────────────────────────────────────────────

function getDashboardStats() {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());

  var _appDonors = getAppState("donors");
  var _donorCount = Array.isArray(_appDonors) ? _appDonors.length : 0;
  const paymentRow      = db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount FROM payments WHERE status = 'success'").get();
  const legacyPayRow    = db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount FROM ivr_donations").get();
  const callsTodayRow   = db.prepare("SELECT COUNT(*) AS count FROM ivr_call_logs WHERE substr(COALESCE(timestamp, createdAt), 1, 10) = ? AND step != 'payment_success'").get(today);
  const failedCallsRow  = db.prepare("SELECT COUNT(*) AS count FROM ivr_call_logs WHERE step = 'error'").get();
  const successCallsRow = db.prepare("SELECT COUNT(*) AS count FROM ivr_call_logs WHERE step = 'payment_success'").get();
  const totalCallsRow   = db.prepare("SELECT COUNT(*) AS count FROM ivr_call_logs WHERE step != 'payment_success'").get();

  // Click2Call calls this week (Mon..today in Asia/Jerusalem)
  const weekStart = (function () {
    const now = new Date(new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Jerusalem",
      year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date()));
    const d = new Date(today);
    const day = d.getDay(); // 0=Sun
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((day + 6) % 7));
    return monday.toISOString().slice(0, 10);
  }());
  const click2callWeekRow = db.prepare(
    "SELECT COUNT(*) AS count FROM click2call_logs WHERE substr(createdAt,1,10) >= ? AND substr(createdAt,1,10) <= ?"
  ).get(weekStart, today);

  const totalPayments      = paymentRow.count   || legacyPayRow.count  || 0;
  const totalPaymentAmount = paymentRow.amount  || legacyPayRow.amount || 0;
  const totalCalls         = totalCallsRow.count || 0;
  const successCount       = successCallsRow.count || 0;

  return {
    totalDonors:           _donorCount,
    totalPayments:         totalPayments,
    totalPaymentAmount:    totalPaymentAmount,
    callsToday:            callsTodayRow.count || 0,
    failedCalls:           failedCallsRow.count || 0,
    successRate:           totalCalls > 0 ? Math.round((successCount / totalCalls) * 10000) / 100 : 0,
    click2callThisWeek:    click2callWeekRow.count || 0,
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

// ── Worker Sessions ───────────────────────────────────────────────────────────

function createWorkerSession(workerId, workerName, ip, userAgent) {
  var sessionId = crypto.randomBytes(16).toString("hex");
  var now = nowIso();
  db.prepare(`
    INSERT INTO worker_sessions (sessionId, workerId, workerName, loginAt, lastHeartbeat, ip, userAgent, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
  `).run(sessionId, Number(workerId), String(workerName), now, now, ip || null, userAgent ? String(userAgent).slice(0, 300) : null);
  return sessionId;
}

function heartbeatSession(sessionId) {
  if (!sessionId) return;
  db.prepare("UPDATE worker_sessions SET lastHeartbeat = ? WHERE sessionId = ? AND status = 'active'")
    .run(nowIso(), String(sessionId));
}

function closeWorkerSession(sessionId, reason) {
  if (!sessionId) return;
  var status = reason === "logout" ? "logout" : "timeout";
  db.prepare("UPDATE worker_sessions SET logoutAt = ?, status = ? WHERE sessionId = ? AND status = 'active'")
    .run(nowIso(), status, String(sessionId));
}

function getSessionBySessionId(sessionId) {
  if (!sessionId) return null;
  return db.prepare("SELECT * FROM worker_sessions WHERE sessionId = ? LIMIT 1").get(String(sessionId));
}

// Admin-initiated remote disconnect. Distinct from closeWorkerSession (self logout / auto-timeout)
// so the session history can tell them apart.
function forceLogoutSession(sessionId) {
  if (!sessionId) return false;
  var result = db.prepare("UPDATE worker_sessions SET logoutAt = ?, status = 'forced_logout' WHERE sessionId = ? AND status = 'active'")
    .run(nowIso(), String(sessionId));
  return result.changes > 0;
}

// Most recent server_audit_log entry per workerId — used to show "פעולה אחרונה"
// on the sessions screen without fabricating data when none exists.
function getLastActionsByWorker() {
  var rows = db.prepare(`
    SELECT a.workerId, a.action, a.details, a.createdAt
    FROM server_audit_log a
    INNER JOIN (
      SELECT workerId, MAX(id) AS maxId
      FROM server_audit_log
      WHERE workerId IS NOT NULL
      GROUP BY workerId
    ) latest ON latest.workerId = a.workerId AND latest.maxId = a.id
  `).all();
  var map = {};
  rows.forEach(function (r) {
    map[r.workerId] = { action: r.action, details: r.details, createdAt: r.createdAt };
  });
  return map;
}

// Last N server_audit_log entries for one worker — backs the "פעילות אחרונה" modal.
function getAuditLogsByWorker(workerId, limit) {
  if (!workerId) return [];
  return db.prepare(`
    SELECT id, createdAt, action, details
    FROM server_audit_log
    WHERE workerId = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(Number(workerId), Math.min(Number(limit) || 10, 50));
}

// Most recent server_audit_log rows for one (entityType, entityId) pair —
// backs the AI action framework's durable idempotency (ai/actions/
// idempotency.js): reusing this table as the persistence layer for
// claim/resolve markers means idempotency survives a process restart
// without a new table. No index exists on (entityType, entityId) — this is
// a plain filtered scan, acceptable given server_audit_log's expected
// volume and that idempotency lookups are not a hot path; a dedicated index
// would need its own migration and isn't added here.
function getAuditLogsByEntity(entityType, entityId, limit) {
  if (!entityType || entityId == null) return [];
  return db.prepare(`
    SELECT id, createdAt, action, entityType, entityId, entityName, details, workerId, workerName, ip
    FROM server_audit_log
    WHERE entityType = ? AND entityId = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(String(entityType), String(entityId), Math.min(Number(limit) || 50, 500));
}

// Cheap total count for the same worker — lets the modal show "X מתוך Y" without
// pulling every row. Single indexed-column COUNT, negligible cost either way.
function countAuditLogsByWorker(workerId) {
  if (!workerId) return 0;
  var row = db.prepare("SELECT COUNT(*) AS c FROM server_audit_log WHERE workerId = ?").get(Number(workerId));
  return row ? row.c : 0;
}

function getActiveSessions() {
  // Sessions never auto-close from inactivity anymore — a login stays valid
  // (per this app's design) until explicit logout, admin force-logout, or the
  // worker being deleted/disabled. "online" here is a pure display flag based
  // on the most recent heartbeat, so the admin screen can still tell an
  // actively-working user apart from one who's logged in but has their
  // browser closed, without ending either session.
  var onlineCutoff = new Date(Date.now() - SESSION_ONLINE_THRESHOLD_MS).toISOString();

  return db.prepare(`
    SELECT ws.id, ws.sessionId, ws.workerId, ws.workerName, ws.loginAt, ws.lastHeartbeat,
           ws.ip, ws.userAgent, ws.status, w.role AS workerRole,
           (ws.lastHeartbeat >= ?) AS online
    FROM worker_sessions ws
    LEFT JOIN workers w ON w.id = ws.workerId
    WHERE ws.status = 'active'
    ORDER BY ws.loginAt DESC
  `).all(onlineCutoff);
}

function getSessionHistory(limit) {
  return db.prepare(`
    SELECT ws.id, ws.sessionId, ws.workerId, ws.workerName, ws.loginAt, ws.lastHeartbeat,
           ws.logoutAt, ws.ip, ws.userAgent, ws.status, w.role AS workerRole
    FROM worker_sessions ws
    LEFT JOIN workers w ON w.id = ws.workerId
    ORDER BY ws.loginAt DESC
    LIMIT ?
  `).all(Number(limit) || 200);
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

// ── Alfon Pending (agent upload queue) ───────────────────────────────────────

function initAlfonPending() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS alfon_pending (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      createdAt      TEXT NOT NULL,
      filename       TEXT,
      csvContent     TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'pending',
      previewAdded   INTEGER DEFAULT 0,
      previewUpdated INTEGER DEFAULT 0,
      previewSkipped INTEGER DEFAULT 0,
      reviewedBy     TEXT,
      reviewedAt     TEXT
    )
  `);
}
initAlfonPending();

function insertAlfonPending({ filename, csvContent, previewAdded, previewUpdated, previewSkipped }) {
  var result = db.prepare(
    "INSERT INTO alfon_pending (createdAt, filename, csvContent, previewAdded, previewUpdated, previewSkipped) VALUES (?,?,?,?,?,?)"
  ).run(nowIso(), filename || "", csvContent || "", previewAdded || 0, previewUpdated || 0, previewSkipped || 0);
  return result.lastInsertRowid;
}

function getAlfonPending() {
  return db.prepare(
    "SELECT id, createdAt, filename, status, previewAdded, previewUpdated, previewSkipped, reviewedBy, reviewedAt FROM alfon_pending ORDER BY id DESC LIMIT 30"
  ).all();
}

function getAlfonPendingById(id) {
  return db.prepare("SELECT * FROM alfon_pending WHERE id = ?").get(Number(id));
}

function updateAlfonPendingStatus(id, status, reviewedBy) {
  db.prepare("UPDATE alfon_pending SET status=?, reviewedBy=?, reviewedAt=? WHERE id=?")
    .run(status, reviewedBy || "", nowIso(), Number(id));
}

// ── Sync Log ──────────────────────────────────────────────────────────────────

function insertSyncLog({ filename, added, updated, skipped, failed, workerName }) {
  return db.prepare(
    "INSERT INTO sync_log (createdAt, filename, added, updated, skipped, failed, workerName) VALUES (?,?,?,?,?,?,?)"
  ).run(nowIso(), filename || "", added || 0, updated || 0, skipped || 0, failed || 0, workerName || "");
}

function getSyncLogs(limit) {
  return db.prepare("SELECT * FROM sync_log ORDER BY id DESC LIMIT ?").all(Number(limit) || 50);
}

// ── IVR Audio Recordings (settings.html "ניהול הקלטות" tab) ─────────────────
// Self-contained, like alfon_pending above — does not touch any donor/payment/
// worker table. Status validation lives in ivr-audio.service.js, not here.
//
// Source of truth is הקלטות_א_בלאט_גמרא_מעוצב.xlsx (2 sheets: גיליון1 = fixed
// sentences, גיליון2 = numbers/currency — 29 + 44 = 73 rows). Columns:
// Audio ID, טקסט מקור בעברית, תרגום, הסבר שימוש, קובץ הקלטה 1/2/3, סטטוס.

const IVR_AUDIO_CANONICAL_RECORDINGS = [
  // ── גיליון1 — משפטים קבועים (29) ──────────────────────────────────────────
  { audioId: "OPEN-001", category: "open", sourceTextHe: "שלום וברכה, הגעתם למערכת תשלומים של א בלאט גמרא.", usageDescription: "פתיחת כל שיחה" },
  { audioId: "MENU-001", category: "menu", sourceTextHe: "למעבר לתשלום הקישו 1. לשמיעת חובות קודמים הקישו 2. להשארת הודעה הקישו 3.", usageDescription: "תפריט ראשי מלא" },
  { audioId: "MENU-002", category: "menu", sourceTextHe: "למעבר לתשלום הקישו 1. להשארת הודעה הקישו 3.", usageDescription: "יש חוב, אין חובות קודמים" },
  { audioId: "MENU-003", category: "menu", sourceTextHe: "לתרומה הקישו 1. להשארת הודעה הקישו 3.", usageDescription: "אין חוב, אפשר לתרום" },
  { audioId: "MENU-004", category: "menu", sourceTextHe: "להשארת הודעה הקישו 3.", usageDescription: "רק השארת הודעה" },
  { audioId: "MENU-005", category: "menu", sourceTextHe: "למעבר לתשלום הקישו 1.", usageDescription: "רק תשלום" },
  { audioId: "MENU-006", category: "menu", sourceTextHe: "לתרומה הקישו 1.", usageDescription: "רק תרומה" },
  { audioId: "DEBT-001", category: "debt", sourceTextHe: "יש לך חוב על סכום", usageDescription: "פתיח לפני הקראת סכום חוב" },
  { audioId: "DEBT-002", category: "debt", sourceTextHe: "שקלים עבור", usageDescription: "מחבר בין סכום למטרה" },
  { audioId: "DEBT-003", category: "debt", sourceTextHe: "לא נמצא חוב פתוח.", usageDescription: "אין חוב פתוח" },
  { audioId: "DEBT-004", category: "debt", sourceTextHe: "לא נמצאו חובות קודמים.", usageDescription: "אין חובות קודמים" },
  { audioId: "DEBT-005", category: "debt", sourceTextHe: "לתשלום כל החובות הקישו 1. לתשלום סכום אחר הקישו 2. לסיום הקישו 9.", usageDescription: "תפריט אחרי שמיעת חובות" },
  { audioId: "DEBT-006", category: "debt", sourceTextHe: "הסכום גבוה, אנא פנו לנציג.", usageDescription: "חוב מעל 99,999" },
  { audioId: "PAY-001", category: "pay", sourceTextHe: "לתשלום הסכום המלא,", usageDescription: "פתיח לפני סכום לתשלום מלא" },
  { audioId: "PAY-002", category: "pay", sourceTextHe: "שקלים, הקישו 1. לתשלום סכום אחר הקישו 2.", usageDescription: "המשך תפריט תשלום" },
  { audioId: "PAY-003", category: "pay", sourceTextHe: "אנא הזינו את הסכום בשקלים ולחצו סולמית.", usageDescription: "בקשת הזנת סכום" },
  { audioId: "PAY-004", category: "pay", sourceTextHe: "הסכום שהוזן אינו תקין. אנא נסו שוב.", usageDescription: "סכום לא תקין" },
  { audioId: "PAY-005", category: "pay", sourceTextHe: "הסכום שהוזן גבוה מדי. אנא פנו לנציג.", usageDescription: "סכום תשלום גבוה מדי" },
  { audioId: "PAY-006", category: "pay", sourceTextHe: "התשלום התקבל בהצלחה. תודה רבה.", usageDescription: "אישור תשלום הצליח" },
  { audioId: "PAY-007", category: "pay", sourceTextHe: "התשלום לא הושלם. אנא נסו שוב מאוחר יותר.", usageDescription: "תשלום נכשל" },
  { audioId: "PAY-008", category: "pay", sourceTextHe: "התשלום בכרטיס אשראי אינו זמין כרגע. נציג ייצור איתך קשר בהקדם. תודה.", usageDescription: "אין אפשרות תשלום כרגע" },
  { audioId: "VM-001", category: "voicemail", sourceTextHe: "אנא השאירו הודעתכם לאחר הצליל.", usageDescription: "לפני הקלטת הודעה" },
  { audioId: "VM-002", category: "voicemail", sourceTextHe: "הודעתכם התקבלה. תודה.", usageDescription: "אחרי השארת הודעה" },
  { audioId: "SYS-001", category: "system", sourceTextHe: "תודה על התקשרותך. להתראות.", usageDescription: "סיום שיחה" },
  { audioId: "SYS-002", category: "system", sourceTextHe: "אירעה שגיאה. אנא נסו שוב מאוחר יותר.", usageDescription: "שגיאת מערכת" },
  { audioId: "PURP-001", category: "purpose", sourceTextHe: "גליון מתאחדת", usageDescription: "מטרת חוב / תרומה" },
  { audioId: "PURP-002", category: "purpose", sourceTextHe: "פרנס", usageDescription: "מטרת חוב / תרומה" },
  { audioId: "PURP-003", category: "purpose", sourceTextHe: "כללי", usageDescription: "ברירת מחדל כשאין מטרה" },
  { audioId: "PURP-004", category: "purpose", sourceTextHe: "המטרה הרשומה בכרטיסכם", usageDescription: "מטרה חופשית / אחר" },
  // ── גיליון2 — מספרים ומטבע (44) ─────────────────────────────────────────
  { audioId: "NUM-DIGIT-000", category: "number", sourceTextHe: "אפס", usageDescription: "ספרה" },
  { audioId: "NUM-DIGIT-001", category: "number", sourceTextHe: "אחד", usageDescription: "ספרה / סכום" },
  { audioId: "NUM-DIGIT-002", category: "number", sourceTextHe: "שניים", usageDescription: "ספרה / סכום" },
  { audioId: "NUM-DIGIT-003", category: "number", sourceTextHe: "שלושה", usageDescription: "ספרה / סכום" },
  { audioId: "NUM-DIGIT-004", category: "number", sourceTextHe: "ארבעה", usageDescription: "ספרה / סכום" },
  { audioId: "NUM-DIGIT-005", category: "number", sourceTextHe: "חמישה", usageDescription: "ספרה / סכום" },
  { audioId: "NUM-DIGIT-006", category: "number", sourceTextHe: "שישה", usageDescription: "ספרה / סכום" },
  { audioId: "NUM-DIGIT-007", category: "number", sourceTextHe: "שבעה", usageDescription: "ספרה / סכום" },
  { audioId: "NUM-DIGIT-008", category: "number", sourceTextHe: "שמונה", usageDescription: "ספרה / סכום" },
  { audioId: "NUM-DIGIT-009", category: "number", sourceTextHe: "תשעה", usageDescription: "ספרה / סכום" },
  { audioId: "NUM-TEEN-010", category: "number", sourceTextHe: "עשרה", usageDescription: "מספר" },
  { audioId: "NUM-TEEN-011", category: "number", sourceTextHe: "אחד עשר", usageDescription: "מספר" },
  { audioId: "NUM-TEEN-012", category: "number", sourceTextHe: "שנים עשר", usageDescription: "מספר" },
  { audioId: "NUM-TEEN-013", category: "number", sourceTextHe: "שלושה עשר", usageDescription: "מספר" },
  { audioId: "NUM-TEEN-014", category: "number", sourceTextHe: "ארבעה עשר", usageDescription: "מספר" },
  { audioId: "NUM-TEEN-015", category: "number", sourceTextHe: "חמישה עשר", usageDescription: "מספר" },
  { audioId: "NUM-TEEN-016", category: "number", sourceTextHe: "שישה עשר", usageDescription: "מספר" },
  { audioId: "NUM-TEEN-017", category: "number", sourceTextHe: "שבעה עשר", usageDescription: "מספר" },
  { audioId: "NUM-TEEN-018", category: "number", sourceTextHe: "שמונה עשר", usageDescription: "מספר" },
  { audioId: "NUM-TEEN-019", category: "number", sourceTextHe: "תשעה עשר", usageDescription: "מספר" },
  { audioId: "NUM-TENS-020", category: "number", sourceTextHe: "עשרים", usageDescription: "מספר" },
  { audioId: "NUM-TENS-030", category: "number", sourceTextHe: "שלושים", usageDescription: "מספר" },
  { audioId: "NUM-TENS-040", category: "number", sourceTextHe: "ארבעים", usageDescription: "מספר" },
  { audioId: "NUM-TENS-050", category: "number", sourceTextHe: "חמישים", usageDescription: "מספר" },
  { audioId: "NUM-TENS-060", category: "number", sourceTextHe: "שישים", usageDescription: "מספר" },
  { audioId: "NUM-TENS-070", category: "number", sourceTextHe: "שבעים", usageDescription: "מספר" },
  { audioId: "NUM-TENS-080", category: "number", sourceTextHe: "שמונים", usageDescription: "מספר" },
  { audioId: "NUM-TENS-090", category: "number", sourceTextHe: "תשעים", usageDescription: "מספר" },
  { audioId: "NUM-HUNDRED-100", category: "number", sourceTextHe: "מאה", usageDescription: "מאות" },
  { audioId: "NUM-HUNDRED-200", category: "number", sourceTextHe: "מאתיים", usageDescription: "מאות" },
  { audioId: "NUM-HUNDRED-300", category: "number", sourceTextHe: "שלוש מאות", usageDescription: "מאות" },
  { audioId: "NUM-HUNDRED-400", category: "number", sourceTextHe: "ארבע מאות", usageDescription: "מאות" },
  { audioId: "NUM-HUNDRED-500", category: "number", sourceTextHe: "חמש מאות", usageDescription: "מאות" },
  { audioId: "NUM-HUNDRED-600", category: "number", sourceTextHe: "שש מאות", usageDescription: "מאות" },
  { audioId: "NUM-HUNDRED-700", category: "number", sourceTextHe: "שבע מאות", usageDescription: "מאות" },
  { audioId: "NUM-HUNDRED-800", category: "number", sourceTextHe: "שמונה מאות", usageDescription: "מאות" },
  { audioId: "NUM-HUNDRED-900", category: "number", sourceTextHe: "תשע מאות", usageDescription: "מאות" },
  { audioId: "NUM-THOUSAND-001", category: "number", sourceTextHe: "אלף", usageDescription: "אלפים" },
  { audioId: "NUM-THOUSAND-002", category: "number", sourceTextHe: "אלפיים", usageDescription: "אלפים" },
  { audioId: "NUM-THOUSAND-PLURAL", category: "number", sourceTextHe: "אלפים", usageDescription: "אלפים רבים" },
  { audioId: "CUR-001", category: "currency", sourceTextHe: "שקל", usageDescription: "מטבע יחיד" },
  { audioId: "CUR-002", category: "currency", sourceTextHe: "שקלים", usageDescription: "מטבע רבים" },
  { audioId: "CUR-003", category: "currency", sourceTextHe: "שקל אחד", usageDescription: "סכום 1 ₪" },
  { audioId: "CUR-004", category: "currency", sourceTextHe: "שני שקלים", usageDescription: "סכום 2 ₪" },
];

// Old (unpadded) → new (Excel-authoritative, zero-padded) Audio ID map — the
// 30 number IDs that were seeded wrong before the Excel structure was known.
const IVR_AUDIO_ID_RENAME_MAP = {};
for (let d = 0; d <= 9; d++) IVR_AUDIO_ID_RENAME_MAP["NUM-DIGIT-" + d] = "NUM-DIGIT-" + String(d).padStart(3, "0");
for (let t = 10; t <= 19; t++) IVR_AUDIO_ID_RENAME_MAP["NUM-TEEN-" + t] = "NUM-TEEN-" + String(t).padStart(3, "0");
[20, 30, 40, 50, 60, 70, 80, 90].forEach(function (t) {
  IVR_AUDIO_ID_RENAME_MAP["NUM-TENS-" + t] = "NUM-TENS-" + String(t).padStart(3, "0");
});
IVR_AUDIO_ID_RENAME_MAP["NUM-THOUSAND-1"] = "NUM-THOUSAND-001";
IVR_AUDIO_ID_RENAME_MAP["NUM-THOUSAND-2"] = "NUM-THOUSAND-002";

function initIvrAudioRecordings() {
  // Fresh installs get the target (Excel-shaped) schema directly.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ivr_audio_recordings (
      audioId          TEXT PRIMARY KEY,
      category         TEXT NOT NULL DEFAULT '',
      sourceTextHe     TEXT NOT NULL DEFAULT '',
      translation      TEXT NOT NULL DEFAULT '',
      usageDescription TEXT NOT NULL DEFAULT '',
      audioFile1       TEXT NOT NULL DEFAULT '',
      audioFile2       TEXT NOT NULL DEFAULT '',
      audioFile3       TEXT NOT NULL DEFAULT '',
      status           TEXT NOT NULL DEFAULT 'חסר',
      notes            TEXT NOT NULL DEFAULT '',
      createdAt        TEXT NOT NULL,
      updatedAt        TEXT NOT NULL
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_ivr_audio_status ON ivr_audio_recordings(status)");

  // enabled/startAt/endAt — added for the temporary "pre-greeting" message
  // (see ivr-pregreeting.service.js). Generic columns on every row for the
  // same reason audioFile2/audioFile3 are: adding them once here is simpler
  // than a second table, and they are meaningless/unused for every row
  // except PREGREETING-001 — nothing else in the system reads them.
  try { db.exec("ALTER TABLE ivr_audio_recordings ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0"); } catch (_) {}
  try { db.exec("ALTER TABLE ivr_audio_recordings ADD COLUMN startAt TEXT"); } catch (_) {}
  try { db.exec("ALTER TABLE ivr_audio_recordings ADD COLUMN endAt TEXT"); } catch (_) {}
}
initIvrAudioRecordings();

// ── Pregreeting (temporary pre-opening IVR message) ─────────────────────────
// A single fixed row, reusing the exact same audioFile1/2/3+status lifecycle
// (upload/convert/approve/delete) as every other ivr_audio_recordings row —
// see ivr-pregreeting.service.js and ivr-audio-paymsg.routes.js. "PREGREETING-001"
// is duplicated as a literal (not imported) in ivr-pregreeting.service.js too,
// same reasoning as ivr-audio-resolver.service.js's GENERIC_FALLBACK_TEXT:
// keeps that file's pure core DB-free without a circular require back here.
const PREGREETING_AUDIO_ID = "PREGREETING-001";

function ensurePregreetingRowExists() {
  if (getIvrAudioRecordingById(PREGREETING_AUDIO_ID)) return;
  const now = nowIso();
  db.prepare(`
    INSERT INTO ivr_audio_recordings
      (audioId, category, sourceTextHe, translation, usageDescription, audioFile1, audioFile2, audioFile3, status, notes, enabled, startAt, endAt, createdAt, updatedAt)
    VALUES (?, 'pregreeting', ?, '', ?, '', '', '', 'חסר', '', 0, NULL, NULL, ?, ?)
  `).run(
    PREGREETING_AUDIO_ID,
    "הודעה זמנית לפני הפתיח",
    "מושמעת (כשהיא פעילה) פעם אחת לפני OPEN-001, בתחילת השיחה בלבד",
    now, now
  );
}
ensurePregreetingRowExists();

function setPregreetingEnabled(enabled) {
  db.prepare("UPDATE ivr_audio_recordings SET enabled=?, updatedAt=? WHERE audioId=?")
    .run(enabled ? 1 : 0, nowIso(), PREGREETING_AUDIO_ID);
  return getIvrAudioRecordingById(PREGREETING_AUDIO_ID);
}

function setPregreetingSchedule(startAt, endAt) {
  db.prepare("UPDATE ivr_audio_recordings SET startAt=?, endAt=?, updatedAt=? WHERE audioId=?")
    .run(startAt || null, endAt || null, nowIso(), PREGREETING_AUDIO_ID);
  return getIvrAudioRecordingById(PREGREETING_AUDIO_ID);
}

// Full reset — clears the active/previous/pending audio slots, status,
// enabled flag and schedule together in one atomic UPDATE. Used only by the
// pregreeting "delete" action (DELETE /api/admin/ivr-audio/pregreeting),
// which — unlike the generic 3-slot lifecycle's delete (slot 3/pending
// only) — intentionally clears the ACTIVE slot too: this row isn't a
// permanent catalog sentence, it's an optional temporary message the admin
// can fully remove. Returns the row's PRE-reset file names so the caller can
// best-effort unlink them from disk.
function resetPregreetingFileState() {
  const before = getIvrAudioRecordingById(PREGREETING_AUDIO_ID);
  db.prepare(`
    UPDATE ivr_audio_recordings
    SET audioFile1='', audioFile2='', audioFile3='', status='חסר', enabled=0, startAt=NULL, endAt=NULL, updatedAt=?
    WHERE audioId=?
  `).run(nowIso(), PREGREETING_AUDIO_ID);
  return { before: before, after: getIvrAudioRecordingById(PREGREETING_AUDIO_ID) };
}

// Runs at most once. Three possible outcomes:
//  - table has the OLD schema (audioFilename/yiddishText columns) → full
//    backup + migration (rename columns, fix the 30 mismatched IDs, sync
//    sourceTextHe/usageDescription/category to the Excel — translation,
//    status and all 3 audio file slots are NEVER touched).
//  - table is empty (fresh install, already has the new schema) → seed all
//    73 canonical rows, nothing to preserve.
//  - table already has data in the new schema → no-op. Per explicit
//    instruction: once migrated, the DB is its own source of truth and this
//    function must never create, change, or overwrite rows again.
function ensureIvrAudioRecordingsUpToDate() {
  const cols = db.prepare("PRAGMA table_info(ivr_audio_recordings)").all().map(function (c) { return c.name; });
  const hasOldSchema = cols.indexOf("audioFilename") !== -1 || cols.indexOf("yiddishText") !== -1;

  if (!hasOldSchema) {
    const count = countIvrAudioRecordings();
    if (count > 0) {
      return { mode: "noop", totalBefore: count, totalAfter: count };
    }
    // Fresh install — seed all 73 canonical rows.
    const now = nowIso();
    const insert = db.prepare(`
      INSERT INTO ivr_audio_recordings
        (audioId, category, sourceTextHe, translation, usageDescription, audioFile1, audioFile2, audioFile3, status, notes, createdAt, updatedAt)
      VALUES (?, ?, ?, '', ?, '', '', '', 'חסר', '', ?, ?)
    `);
    for (const rec of IVR_AUDIO_CANONICAL_RECORDINGS) {
      insert.run(rec.audioId, rec.category, rec.sourceTextHe, rec.usageDescription, now, now);
    }
    return { mode: "seeded", totalBefore: 0, totalAfter: IVR_AUDIO_CANONICAL_RECORDINGS.length };
  }

  // ── Old schema present → full migration ──────────────────────────────────
  const before = db.prepare("SELECT * FROM ivr_audio_recordings").all();
  const totalBefore = before.length;

  // 1. Backup — both a queryable in-DB copy and a portable JSON file.
  const stamp = nowIso().replace(/[:.]/g, "-");
  const backupTable = "ivr_audio_recordings_backup_" + stamp.replace(/-/g, "_");
  db.exec('CREATE TABLE "' + backupTable + '" AS SELECT * FROM ivr_audio_recordings');

  const backupsDir = path.join(__dirname, "backups");
  if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });
  const jsonBackupPath = path.join(backupsDir, "ivr-audio-recordings-pre-migration-" + stamp + ".json");
  fs.writeFileSync(jsonBackupPath, JSON.stringify(before, null, 2), "utf8");

  // 2. Schema: rename columns to the Excel-shaped names, add the 2 new file slots.
  if (cols.indexOf("audioFilename") !== -1 && cols.indexOf("audioFile1") === -1) {
    db.exec("ALTER TABLE ivr_audio_recordings RENAME COLUMN audioFilename TO audioFile1");
  }
  if (cols.indexOf("yiddishText") !== -1 && cols.indexOf("translation") === -1) {
    db.exec("ALTER TABLE ivr_audio_recordings RENAME COLUMN yiddishText TO translation");
  }
  const colsAfterRename = db.prepare("PRAGMA table_info(ivr_audio_recordings)").all().map(function (c) { return c.name; });
  if (colsAfterRename.indexOf("audioFile2") === -1) db.exec("ALTER TABLE ivr_audio_recordings ADD COLUMN audioFile2 TEXT NOT NULL DEFAULT ''");
  if (colsAfterRename.indexOf("audioFile3") === -1) db.exec("ALTER TABLE ivr_audio_recordings ADD COLUMN audioFile3 TEXT NOT NULL DEFAULT ''");

  // 3. Fix the 30 mismatched Audio IDs (rename only — every other column,
  //    including translation/status/audio files, travels with the row).
  let idsRenamed = 0;
  for (const oldId in IVR_AUDIO_ID_RENAME_MAP) {
    const newId = IVR_AUDIO_ID_RENAME_MAP[oldId];
    const oldRow = db.prepare("SELECT audioId FROM ivr_audio_recordings WHERE audioId = ?").get(oldId);
    if (!oldRow) continue;
    const newExists = db.prepare("SELECT audioId FROM ivr_audio_recordings WHERE audioId = ?").get(newId);
    if (newExists) continue; // safety: never clobber if both somehow exist
    db.prepare("UPDATE ivr_audio_recordings SET audioId = ?, updatedAt = ? WHERE audioId = ?").run(newId, nowIso(), oldId);
    idsRenamed++;
  }

  // 4. Excel is the source of truth for sourceTextHe/usageDescription/category
  //    only — translation, status and the 3 audio files are never written here.
  let recordsChanged = 0;
  let translationsPreserved = 0;
  let audioFilesPreserved = 0;
  for (const canon of IVR_AUDIO_CANONICAL_RECORDINGS) {
    const row = db.prepare("SELECT * FROM ivr_audio_recordings WHERE audioId = ?").get(canon.audioId);
    if (!row) {
      const now = nowIso();
      db.prepare(`
        INSERT INTO ivr_audio_recordings
          (audioId, category, sourceTextHe, translation, usageDescription, audioFile1, audioFile2, audioFile3, status, notes, createdAt, updatedAt)
        VALUES (?, ?, ?, '', ?, '', '', '', 'חסר', '', ?, ?)
      `).run(canon.audioId, canon.category, canon.sourceTextHe, canon.usageDescription, now, now);
      recordsChanged++;
      continue;
    }
    const needsUpdate = row.sourceTextHe !== canon.sourceTextHe || row.usageDescription !== canon.usageDescription || row.category !== canon.category;
    if (needsUpdate) {
      db.prepare("UPDATE ivr_audio_recordings SET sourceTextHe=?, usageDescription=?, category=?, updatedAt=? WHERE audioId=?")
        .run(canon.sourceTextHe, canon.usageDescription, canon.category, nowIso(), canon.audioId);
      recordsChanged++;
    }
    if (row.translation && row.translation.trim()) translationsPreserved++;
    if ((row.audioFile1 && row.audioFile1.trim()) || (row.audioFile2 && row.audioFile2.trim()) || (row.audioFile3 && row.audioFile3.trim())) {
      audioFilesPreserved++;
    }
  }

  const totalAfter = countIvrAudioRecordings();
  return {
    mode: "migrated",
    totalBefore, totalAfter,
    idsRenamed, recordsChanged, translationsPreserved, audioFilesPreserved,
    backupTable, jsonBackupPath,
  };
}

function getIvrAudioRecordings() {
  return db.prepare("SELECT * FROM ivr_audio_recordings ORDER BY audioId").all();
}

function getIvrAudioRecordingById(audioId) {
  return db.prepare("SELECT * FROM ivr_audio_recordings WHERE audioId = ?").get(String(audioId));
}

function countIvrAudioRecordings() {
  return db.prepare("SELECT COUNT(*) AS count FROM ivr_audio_recordings").get().count;
}

// Manual "+ שורה חדשה" — returns null if the id already exists.
function createIvrAudioRecording(audioId) {
  if (getIvrAudioRecordingById(audioId)) return null;
  const now = nowIso();
  db.prepare(`
    INSERT INTO ivr_audio_recordings (audioId, createdAt, updatedAt)
    VALUES (?, ?, ?)
  `).run(audioId, now, now);
  return getIvrAudioRecordingById(audioId);
}

// Merge-update: only fields present in `fields` are changed.
function updateIvrAudioRecording(audioId, fields) {
  const existing = getIvrAudioRecordingById(audioId);
  if (!existing) return null;
  const next = {
    category:         fields.category         !== undefined ? String(fields.category)         : existing.category,
    sourceTextHe:      fields.sourceTextHe      !== undefined ? String(fields.sourceTextHe)      : existing.sourceTextHe,
    translation:       fields.translation       !== undefined ? String(fields.translation)       : existing.translation,
    usageDescription:  fields.usageDescription  !== undefined ? String(fields.usageDescription)  : existing.usageDescription,
    status:            fields.status            !== undefined ? String(fields.status)            : existing.status,
    notes:             fields.notes             !== undefined ? String(fields.notes)             : existing.notes,
  };
  db.prepare(`
    UPDATE ivr_audio_recordings
    SET category=?, sourceTextHe=?, translation=?, usageDescription=?, status=?, notes=?, updatedAt=?
    WHERE audioId=?
  `).run(next.category, next.sourceTextHe, next.translation, next.usageDescription, next.status, next.notes, nowIso(), String(audioId));
  return getIvrAudioRecordingById(audioId);
}

var IVR_AUDIO_FILE_COLUMNS = { 1: "audioFile1", 2: "audioFile2", 3: "audioFile3" };

function setIvrAudioRecordingFileSlot(audioId, slot, filename, status) {
  const col = IVR_AUDIO_FILE_COLUMNS[slot];
  if (!col) throw new Error("סלוט קובץ לא תקין: " + slot);
  db.prepare("UPDATE ivr_audio_recordings SET " + col + "=?, status=?, updatedAt=? WHERE audioId=?")
    .run(filename, status, nowIso(), String(audioId));
  return getIvrAudioRecordingById(audioId);
}

function clearIvrAudioRecordingFileSlot(audioId, slot) {
  const col = IVR_AUDIO_FILE_COLUMNS[slot];
  if (!col) throw new Error("סלוט קובץ לא תקין: " + slot);
  db.prepare("UPDATE ivr_audio_recordings SET " + col + "='', updatedAt=? WHERE audioId=?")
    .run(nowIso(), String(audioId));
  return getIvrAudioRecordingById(audioId);
}

// Writes all 3 file slots + status together in ONE UPDATE — used by the
// PAYMSG 3-slot lifecycle (ivr-audio-paymsg-lifecycle.service.js) for its
// approve/restore state transitions, which must each be a single atomic
// write (never a partial multi-step change visible to a concurrent read).
function setIvrAudioRecordingSlots(audioId, fields) {
  db.prepare(
    "UPDATE ivr_audio_recordings SET audioFile1=?, audioFile2=?, audioFile3=?, status=?, updatedAt=? WHERE audioId=?"
  ).run(
    String(fields.audioFile1 || ""),
    String(fields.audioFile2 || ""),
    String(fields.audioFile3 || ""),
    String(fields.status || ""),
    nowIso(),
    String(audioId)
  );
  return getIvrAudioRecordingById(audioId);
}

// ── Softphone (JsSIP/WebRTC) call history ────────────────────────────────────

var SOFTPHONE_STATUS_SET = {};
callClassifier.STATUSES.forEach(function (s) { SOFTPHONE_STATUS_SET[s] = true; });

// Upserts one row per SIP session, keyed by sipCallId (JsSIP RTCSession.id).
// Each call posts multiple partial events over the session's lifetime
// (created -> ringing -> answered -> ended, or created -> failed); this never
// creates more than one row per sipCallId — later events refill only the
// fields they know about, via COALESCE, except `status` (always the latest
// classification) and the terminal `endedAt`/duration fields (always the
// newest computed value once known).
function upsertSoftphoneCall(fields) {
  var status = String(fields.status || "").trim();
  if (!SOFTPHONE_STATUS_SET[status]) {
    throw httpError(400, "סטטוס שיחה לא תקין: " + status);
  }
  var direction = fields.direction === "incoming" ? "incoming" : "outgoing";
  var sipCallId = String(fields.sipCallId || "").trim();
  if (!sipCallId) throw httpError(400, "sipCallId חסר");
  var remotePhone = String(fields.remotePhone || "").trim();
  if (!remotePhone) throw httpError(400, "remotePhone חסר");

  // Duration math must use the MERGED timestamps (this event's fields
  // COALESCEd with whatever the row already has from earlier events for the
  // same sipCallId) — using only this event's own fields would recompute
  // ring duration from startedAt instead of the already-known ringingAt on
  // every later event that doesn't repeat it (e.g. the terminal
  // ended/failed event usually only carries endedAt).
  var existing = db.prepare("SELECT * FROM softphone_calls WHERE sipCallId = ?").get(sipCallId);
  var durations = callClassifier.computeDurations({
    startedAt:  fields.startedAt  || (existing && existing.startedAt)  || null,
    ringingAt:  fields.ringingAt  || (existing && existing.ringingAt)  || null,
    answeredAt: fields.answeredAt || (existing && existing.answeredAt) || null,
    endedAt:    fields.endedAt    || (existing && existing.endedAt)    || null,
  });
  var now = nowIso();

  db.prepare(`
    INSERT INTO softphone_calls (
      sipCallId, direction, remotePhone, donorId, donorName, contactId, contactName,
      selectedCallerId, workerId, workerName, startedAt, ringingAt, answeredAt, endedAt,
      ringDurationSec, talkDurationSec, status, failureReason, rawSipCause, createdAt, updatedAt
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(sipCallId) DO UPDATE SET
      donorId          = COALESCE(excluded.donorId, donorId),
      donorName        = COALESCE(excluded.donorName, donorName),
      contactId        = COALESCE(excluded.contactId, contactId),
      contactName      = COALESCE(excluded.contactName, contactName),
      selectedCallerId = COALESCE(excluded.selectedCallerId, selectedCallerId),
      ringingAt        = COALESCE(ringingAt, excluded.ringingAt),
      answeredAt       = COALESCE(answeredAt, excluded.answeredAt),
      endedAt          = COALESCE(excluded.endedAt, endedAt),
      ringDurationSec  = COALESCE(excluded.ringDurationSec, ringDurationSec),
      talkDurationSec  = COALESCE(excluded.talkDurationSec, talkDurationSec),
      status           = excluded.status,
      failureReason    = COALESCE(excluded.failureReason, failureReason),
      rawSipCause      = COALESCE(excluded.rawSipCause, rawSipCause),
      updatedAt        = excluded.updatedAt
  `).run(
    sipCallId,
    direction,
    remotePhone,
    fields.donorId != null ? Number(fields.donorId) : null,
    fields.donorName || null,
    fields.contactId != null ? Number(fields.contactId) : null,
    fields.contactName || null,
    fields.selectedCallerId || null,
    fields.workerId != null ? Number(fields.workerId) : null,
    fields.workerName || null,
    fields.startedAt || now,
    fields.ringingAt || null,
    fields.answeredAt || null,
    fields.endedAt || null,
    durations.ringDurationSec,
    durations.talkDurationSec,
    status,
    fields.failureReason || callClassifier.safeFailureReason(status),
    fields.rawSipCause || null,
    now,
    now
  );

  return db.prepare("SELECT * FROM softphone_calls WHERE sipCallId = ?").get(sipCallId);
}

// filters: { statusGroup: "all"|"missed"|"incoming"|"outgoing"|"failed", search, page, pageSize }
function getSoftphoneCalls(filters) {
  filters = filters || {};
  var page     = Math.max(1, Number(filters.page) || 1);
  var pageSize = Math.min(200, Math.max(1, Number(filters.pageSize) || 25));
  var where  = [];
  var params = [];

  var group = String(filters.statusGroup || "all").trim();
  if (group === "missed") {
    where.push("status IN ('incoming_missed')");
  } else if (group === "incoming") {
    where.push("direction = 'incoming'");
  } else if (group === "outgoing") {
    where.push("direction = 'outgoing'");
  } else if (group === "failed") {
    where.push("status IN ('incoming_rejected','outgoing_rejected','outgoing_failed','outgoing_unanswered','cancelled')");
  }

  if (filters.search) {
    var s = "%" + String(filters.search).trim() + "%";
    where.push("(remotePhone LIKE ? OR donorName LIKE ? OR contactName LIKE ?)");
    params.push(s, s, s);
  }

  var whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  var stmtCount = db.prepare("SELECT COUNT(*) AS count FROM softphone_calls " + whereSql);
  var total = stmtCount.get.apply(stmtCount, params);
  var stmtRows = db.prepare(
    "SELECT * FROM softphone_calls " + whereSql + " ORDER BY startedAt DESC, id DESC LIMIT ? OFFSET ?"
  );
  var rows = stmtRows.all.apply(stmtRows, params.concat([pageSize, (page - 1) * pageSize]));

  return { rows: rows, total: total.count, page: page, pageSize: pageSize };
}

function getSoftphoneCallById(id) {
  return db.prepare("SELECT * FROM softphone_calls WHERE id = ?").get(Number(id));
}

function deleteSoftphoneCall(id) {
  var info = db.prepare("DELETE FROM softphone_calls WHERE id = ?").run(Number(id));
  return info.changes > 0;
}

// ── Softphone custom contacts (non-donor entries only) ───────────────────────

function normalizeContactPhoneKey(phone) {
  return normalizePhoneForDb(phone);
}

function findSoftphoneContactByNormalizedPhone(normalizedPhone) {
  if (!normalizedPhone) return undefined;
  return db.prepare("SELECT * FROM softphone_contacts WHERE normalizedPhoneKey = ?").get(normalizedPhone);
}

// Matches primaryPhone OR any entry in additionalPhones — used to auto-link
// an incoming/outgoing softphone call to a custom contact.
function findSoftphoneContactByAnyPhone(normalizedPhone) {
  if (!normalizedPhone) return undefined;
  var byPrimary = findSoftphoneContactByNormalizedPhone(normalizedPhone);
  if (byPrimary) return parseContactRow(byPrimary);
  var all = db.prepare("SELECT * FROM softphone_contacts").all();
  for (var i = 0; i < all.length; i++) {
    var extra = JSON.parse(all[i].additionalPhones || "[]");
    if (extra.indexOf(normalizedPhone) !== -1) return parseContactRow(all[i]);
  }
  return undefined;
}

function parseContactRow(row) {
  if (!row) return row;
  return Object.assign({}, row, {
    additionalPhones: row.additionalPhones ? JSON.parse(row.additionalPhones) : [],
  });
}

function getSoftphoneContacts(search) {
  var rows;
  if (search) {
    var raw = String(search).trim();
    var s = "%" + raw + "%";
    // Phone fields are stored already-normalized (digits + leading zero, no
    // separators) — so "02-53...", "+972-2-53...", etc. must go through the
    // same normalization as stored phones before matching, same requirement
    // as the donor-phone search above (not just a raw digit-strip).
    var digits = normalizePhoneForDb(raw);
    if (digits) {
      var d = "%" + digits + "%";
      rows = db.prepare(
        "SELECT * FROM softphone_contacts WHERE name LIKE ? OR notes LIKE ? OR primaryPhone LIKE ? OR additionalPhones LIKE ? ORDER BY name"
      ).all(s, s, d, d);
    } else {
      rows = db.prepare(
        "SELECT * FROM softphone_contacts WHERE name LIKE ? OR notes LIKE ? ORDER BY name"
      ).all(s, s);
    }
  } else {
    rows = db.prepare("SELECT * FROM softphone_contacts ORDER BY name").all();
  }
  return rows.map(parseContactRow);
}

// Throws httpError(409) if primaryPhone or any additionalPhone collides with
// an existing contact's primaryPhone or additionalPhones (normalized).
function createSoftphoneContact(fields, worker) {
  var name = String(fields.name || "").trim();
  if (!name) throw httpError(400, "שם חסר");
  var primaryPhone = normalizeContactPhoneKey(fields.primaryPhone);
  if (!primaryPhone) throw httpError(400, "טלפון ראשי לא תקין");
  var additionalPhones = (Array.isArray(fields.additionalPhones) ? fields.additionalPhones : [])
    .map(normalizeContactPhoneKey)
    .filter(Boolean);

  assertNoContactPhoneCollision(primaryPhone, additionalPhones, null);

  var now = nowIso();
  var info = db.prepare(`
    INSERT INTO softphone_contacts
      (name, primaryPhone, additionalPhones, notes, normalizedPhoneKey, createdAt, updatedAt, createdByWorkerId, createdByWorkerName)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    primaryPhone,
    JSON.stringify(additionalPhones),
    fields.notes ? String(fields.notes).trim() : null,
    primaryPhone,
    now,
    now,
    worker && worker.id   || null,
    worker && worker.name || null
  );
  return parseContactRow(db.prepare("SELECT * FROM softphone_contacts WHERE id = ?").get(info.lastInsertRowid));
}

function updateSoftphoneContact(id, fields) {
  var existing = db.prepare("SELECT * FROM softphone_contacts WHERE id = ?").get(Number(id));
  if (!existing) throw httpError(404, "איש קשר לא נמצא");

  var name = fields.name !== undefined ? String(fields.name).trim() : existing.name;
  if (!name) throw httpError(400, "שם חסר");
  var primaryPhone = fields.primaryPhone !== undefined
    ? normalizeContactPhoneKey(fields.primaryPhone)
    : existing.primaryPhone;
  if (!primaryPhone) throw httpError(400, "טלפון ראשי לא תקין");
  var additionalPhones = fields.additionalPhones !== undefined
    ? (Array.isArray(fields.additionalPhones) ? fields.additionalPhones : []).map(normalizeContactPhoneKey).filter(Boolean)
    : JSON.parse(existing.additionalPhones || "[]");

  assertNoContactPhoneCollision(primaryPhone, additionalPhones, Number(id));

  var now = nowIso();
  db.prepare(`
    UPDATE softphone_contacts
    SET name = ?, primaryPhone = ?, additionalPhones = ?, notes = ?, normalizedPhoneKey = ?, updatedAt = ?
    WHERE id = ?
  `).run(
    name,
    primaryPhone,
    JSON.stringify(additionalPhones),
    fields.notes !== undefined ? (fields.notes ? String(fields.notes).trim() : null) : existing.notes,
    primaryPhone,
    now,
    Number(id)
  );
  return parseContactRow(db.prepare("SELECT * FROM softphone_contacts WHERE id = ?").get(Number(id)));
}

// Checks the given primary+additional phones against every OTHER contact's
// primaryPhone/additionalPhones (excluding excludeId, used by update).
function assertNoContactPhoneCollision(primaryPhone, additionalPhones, excludeId) {
  var allPhones = [primaryPhone].concat(additionalPhones);
  var others = excludeId != null
    ? db.prepare("SELECT * FROM softphone_contacts WHERE id != ?").all(excludeId)
    : db.prepare("SELECT * FROM softphone_contacts").all();
  for (var i = 0; i < others.length; i++) {
    var otherPhones = [others[i].primaryPhone].concat(JSON.parse(others[i].additionalPhones || "[]"));
    for (var j = 0; j < allPhones.length; j++) {
      if (otherPhones.indexOf(allPhones[j]) !== -1) {
        throw httpError(409, "מספר הטלפון " + allPhones[j] + " כבר קיים באיש קשר אחר: " + others[i].name);
      }
    }
  }
}

function deleteSoftphoneContact(id) {
  var info = db.prepare("DELETE FROM softphone_contacts WHERE id = ?").run(Number(id));
  return info.changes > 0;
}

// ── Init ─────────────────────────────────────────────────────────────────────

initDatabase();

module.exports = {
  DB_PATH,
  defaultPasswordForRole,
  // Workers
  getWorkers,
  findWorkerById,
  createWorkerInDb,
  deleteWorkerById,
  setWorkerStatus,
  updateWorkerPasswordHash,
  clearMustChangePassword,
  // Donors
  findDonorByPhone,
  upsertDonor,
  upsertPhoneLookup,
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
  cancelPaymentById,
  markDonationPaidManually,
  cancelManualDonationPayment,
  recordManualPartialPayment,
  // Logs
  insertCallLog,
  // Call Sessions
  startCallSession,
  updateCallSessionDonor,
  updateCallSessionPayer,
  markIdentificationLogged,
  endCallSession,
  getCallSessions,
  getCallLogsByCallId,
  // Click-to-Call
  logClick2Call,
  getClick2CallLogs,
  getRecentClick2CallLogs,
  // IVR voice messages
  saveIvrVoiceMessageOnce,
  listIvrVoiceMessages,
  getIvrVoiceMessageById,
  updateIvrVoiceMessageStatus,
  IVR_VOICE_MESSAGE_STATUSES,
  // App state
  getAppState,
  setAppState,
  getAppStateUpdatedAt,
  // Backup
  backupDatabase,
  restoreFromBackup,
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
  // Sync log
  insertSyncLog,
  getSyncLogs,
  // Alfon pending (agent uploads)
  insertAlfonPending,
  getAlfonPending,
  getAlfonPendingById,
  updateAlfonPendingStatus,
  // Worker sessions
  createWorkerSession,
  heartbeatSession,
  closeWorkerSession,
  getSessionBySessionId,
  forceLogoutSession,
  getLastActionsByWorker,
  getAuditLogsByWorker,
  countAuditLogsByWorker,
  getAuditLogsByEntity,
  getActiveSessions,
  getSessionHistory,
  // Phone normalization (shared with sync service)
  normalizePhoneForDb,
  // IVR Audio Recordings
  ensureIvrAudioRecordingsUpToDate,
  getIvrAudioRecordings,
  getIvrAudioRecordingById,
  countIvrAudioRecordings,
  createIvrAudioRecording,
  updateIvrAudioRecording,
  setIvrAudioRecordingFileSlot,
  clearIvrAudioRecordingFileSlot,
  setIvrAudioRecordingSlots,
  IVR_AUDIO_CANONICAL_RECORDINGS,
  // Pregreeting (temporary pre-opening IVR message)
  PREGREETING_AUDIO_ID,
  setPregreetingEnabled,
  setPregreetingSchedule,
  resetPregreetingFileState,
  // Softphone (JsSIP/WebRTC) call history
  upsertSoftphoneCall,
  getSoftphoneCalls,
  getSoftphoneCallById,
  deleteSoftphoneCall,
  // Softphone custom contacts
  getSoftphoneContacts,
  createSoftphoneContact,
  updateSoftphoneContact,
  deleteSoftphoneContact,
  findSoftphoneContactByNormalizedPhone,
  findSoftphoneContactByAnyPhone,
  normalizeContactPhoneKey,
};

// data-audit-mirror.service.js
//
// Mirrors newly-appended entries from the app's existing client-side audit trail
// (AuditLog.record() in frontend/js/audit-log.js, persisted via
// Database.save("logs", ...) -> POST /api/data/logs) into the server-only
// server_audit_log table (see insertAuditLog in db.js).
//
// Why this exists instead of a new logging mechanism: the app already records
// action/entityType/entityId/entityName/details/changes for every donor, task,
// approval, reminder, callback and worker mutation (donors.js, donor.js,
// tasks.js, approvals.js, reminders.js, phone.js, settings.js all call
// AuditLog.record()). Its one weakness is that this trail lives entirely inside
// the "logs" app_state blob, saved wholesale through the same POST
// /api/data/:key endpoint as every other screen's data — so a buggy or
// compromised client could silently skip AuditLog.record(), or erase the whole
// history with a single POST of an empty array, and nothing server-side would
// ever notice (server_audit_log — the one store a client can never bulk-
// overwrite — didn't get a row either way). Mirroring each new "logs" entry
// into server_audit_log the instant it's saved closes that gap without adding
// a second, parallel taxonomy: action/entityType/entityId here mean exactly
// what they already mean in audit-log.js.
//
// workerId/workerName/ip must come from the caller's verified request context
// (req.user from the JWT, req.ip) — never from the client-supplied entry's own
// "user" field, which is not trustworthy for this purpose.
//
// Never mirrors entry.changes[].before/after values (could be arbitrarily long
// free-text donor notes etc.) — only the changed field *names*, so the server
// audit trail states what changed without duplicating full record contents.

const MAX_MIRRORED_ENTRIES_PER_SAVE = 50; // a normal save appends exactly 1 entry; this only guards a pathological bulk write
const MAX_FIELD_LEN = { action: 50, entityType: 50, entityId: 100, entityName: 200, details: 500 };

function truncate(value, max) {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value);
  return s.length > max ? s.slice(0, max) : s;
}

// Pure — no DB access — so it can be unit-tested without a real database.
function selectNewLogEntries(oldLogs, newLogs) {
  if (!Array.isArray(newLogs)) return { entries: [], truncated: false, totalAdded: 0 };

  const oldIds = new Set((Array.isArray(oldLogs) ? oldLogs : []).map(function (l) { return l && l.id; }));
  const added = newLogs.filter(function (l) { return l && !oldIds.has(l.id); });
  const truncated = added.length > MAX_MIRRORED_ENTRIES_PER_SAVE;

  return {
    entries: truncated ? added.slice(0, MAX_MIRRORED_ENTRIES_PER_SAVE) : added,
    truncated: truncated,
    totalAdded: added.length,
  };
}

function changedFieldsSuffix(entry) {
  if (!Array.isArray(entry.changes) || entry.changes.length === 0) return "";
  const fields = entry.changes.map(function (c) { return c && c.field; }).filter(Boolean);
  return fields.length ? " | שדות שהשתנו: " + fields.join(", ") : "";
}

// insertAuditLogFn is injected (rather than required directly) so this stays
// unit-testable without touching db.js/sqlite.
function mirrorLogEntriesToAuditLog(oldLogs, newLogs, meta, insertAuditLogFn) {
  const selection = selectNewLogEntries(oldLogs, newLogs);

  selection.entries.forEach(function (entry) {
    insertAuditLogFn({
      action:     truncate(entry.action, MAX_FIELD_LEN.action) || "system",
      entityType: truncate(entry.entityType, MAX_FIELD_LEN.entityType) || "system",
      entityId:   truncate(entry.entityId, MAX_FIELD_LEN.entityId),
      entityName: truncate(entry.entityName, MAX_FIELD_LEN.entityName),
      details:    truncate((entry.details || "") + changedFieldsSuffix(entry), MAX_FIELD_LEN.details),
      workerId:   meta.workerId,
      workerName: meta.workerName,
      ip:         meta.ip,
    });
  });

  if (selection.truncated) {
    insertAuditLogFn({
      action:     "data_save_truncated",
      entityType: "logs",
      entityId:   null,
      entityName: null,
      details:    "נוספו " + selection.totalAdded + " רשומות יומן בשמירה אחת — מוזגו רק " + MAX_MIRRORED_ENTRIES_PER_SAVE + " הראשונות",
      workerId:   meta.workerId,
      workerName: meta.workerName,
      ip:         meta.ip,
    });
  }

  return selection;
}

module.exports = { selectNewLogEntries, mirrorLogEntriesToAuditLog, MAX_MIRRORED_ENTRIES_PER_SAVE };

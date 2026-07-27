// data-audit-mirror.service.test.js — pure unit tests, no DB/network/filesystem.
// Proves selectNewLogEntries()/mirrorLogEntriesToAuditLog() correctly identify
// which "logs" entries are newly appended (by id) and forward them to
// insertAuditLog with worker identity coming from the injected meta, never
// from the entry's own payload.
//
// הרצה: node data-audit-mirror.service.test.js

const assert = require("assert");
const {
  selectNewLogEntries,
  mirrorLogEntriesToAuditLog,
  MAX_MIRRORED_ENTRIES_PER_SAVE,
} = require("./data-audit-mirror.service");

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name: name, ok: true });
  } catch (err) {
    results.push({ name: name, ok: false, error: err.stack || err.message });
  }
}

function entry(id, overrides) {
  return Object.assign({
    id: id,
    createdAt: new Date().toISOString(),
    action: "create",
    entityType: "donor",
    entityId: 42,
    entityName: "ישראל ישראלי",
    details: "נוסף תורם חדש",
  }, overrides || {});
}

// ── selectNewLogEntries ──────────────────────────────────────────────────────

check("selectNewLogEntries: מזהה רשומות חדשות בלבד (שהיו קיימות לפני נשארות בחוץ)", function () {
  const oldLogs = [entry(1), entry(2)];
  const newLogs = [entry(1), entry(2), entry(3)];
  const { entries, truncated, totalAdded } = selectNewLogEntries(oldLogs, newLogs);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].id, 3);
  assert.strictEqual(truncated, false);
  assert.strictEqual(totalAdded, 1);
});

check("selectNewLogEntries: אין הבדל -> אין רשומות חדשות", function () {
  const oldLogs = [entry(1), entry(2)];
  const newLogs = [entry(1), entry(2)];
  const { entries } = selectNewLogEntries(oldLogs, newLogs);
  assert.strictEqual(entries.length, 0);
});

check("selectNewLogEntries: לוג ישן ריק (מפתח חדש שנשמר בפעם הראשונה) -> כל הרשומות נחשבות חדשות", function () {
  const newLogs = [entry(1), entry(2)];
  const { entries } = selectNewLogEntries(null, newLogs);
  assert.strictEqual(entries.length, 2);
});

check("selectNewLogEntries: newLogs שאינו מערך -> תוצאה ריקה, לא זורק שגיאה", function () {
  const { entries, truncated, totalAdded } = selectNewLogEntries([entry(1)], { not: "an array" });
  assert.deepStrictEqual(entries, []);
  assert.strictEqual(truncated, false);
  assert.strictEqual(totalAdded, 0);
});

check("selectNewLogEntries: חריגה ממכסת המיזוג -> truncated=true ורק המכסה הראשונה מוחזרת", function () {
  const oldLogs = [];
  const newLogs = [];
  for (let i = 0; i < MAX_MIRRORED_ENTRIES_PER_SAVE + 10; i++) newLogs.push(entry(i));
  const { entries, truncated, totalAdded } = selectNewLogEntries(oldLogs, newLogs);
  assert.strictEqual(truncated, true);
  assert.strictEqual(totalAdded, MAX_MIRRORED_ENTRIES_PER_SAVE + 10);
  assert.strictEqual(entries.length, MAX_MIRRORED_ENTRIES_PER_SAVE);
});

// ── mirrorLogEntriesToAuditLog ───────────────────────────────────────────────

function collectInserts() {
  const calls = [];
  return { fn: function (row) { calls.push(row); }, calls: calls };
}

check("mirrorLogEntriesToAuditLog: זהות המשתמש מגיעה מ-meta (JWT מאומת), לא מהרשומה עצמה", function () {
  const collector = collectInserts();
  const oldLogs = [];
  const newLogs = [entry(1, { user: { id: 999, name: "מתחזה" } })]; // client-claimed identity — must be ignored
  mirrorLogEntriesToAuditLog(oldLogs, newLogs, { workerId: 1, workerName: "מנהל מערכת", ip: "127.0.0.1" }, collector.fn);

  assert.strictEqual(collector.calls.length, 1);
  assert.strictEqual(collector.calls[0].workerId, 1);
  assert.strictEqual(collector.calls[0].workerName, "מנהל מערכת");
  assert.strictEqual(collector.calls[0].ip, "127.0.0.1");
});

check("mirrorLogEntriesToAuditLog: action/entityType/entityId/entityName/details מועברים כמו שהם", function () {
  const collector = collectInserts();
  const newLogs = [entry(1, { action: "delete", entityType: "task", entityId: 7, entityName: "משימה לדוגמה", details: "נמחקה" })];
  mirrorLogEntriesToAuditLog([], newLogs, { workerId: 2, workerName: "מזכיר", ip: null }, collector.fn);

  const row = collector.calls[0];
  assert.strictEqual(row.action, "delete");
  assert.strictEqual(row.entityType, "task");
  assert.strictEqual(row.entityId, "7");
  assert.strictEqual(row.entityName, "משימה לדוגמה");
  assert.strictEqual(row.details, "נמחקה");
});

check("mirrorLogEntriesToAuditLog: entry.changes מתומצת לשמות שדות בלבד — לא ערכים (before/after לא מודלפים)", function () {
  const collector = collectInserts();
  const newLogs = [entry(1, {
    details: "עודכנו פרטי תורם",
    changes: [
      { field: "phone", label: "טלפון", before: "0500000001", after: "0500000002" },
      { field: "city",  label: "עיר",    before: "",           after: "ירושלים" },
    ],
  })];
  mirrorLogEntriesToAuditLog([], newLogs, { workerId: 1, workerName: "מנהל", ip: null }, collector.fn);

  const details = collector.calls[0].details;
  assert.ok(details.includes("שדות שהשתנו: phone, city"), "details should list changed field names: " + details);
  assert.ok(!details.includes("0500000001"), "details must NOT contain the actual before/after phone value");
  assert.ok(!details.includes("0500000002"), "details must NOT contain the actual before/after phone value");
});

check("mirrorLogEntriesToAuditLog: שדות ארוכים מדי נחתכים כדי למנוע בלואבים בלתי מוגבלים", function () {
  const collector = collectInserts();
  const longDetails = "א".repeat(2000);
  const newLogs = [entry(1, { details: longDetails })];
  mirrorLogEntriesToAuditLog([], newLogs, { workerId: 1, workerName: "מנהל", ip: null }, collector.fn);

  assert.ok(collector.calls[0].details.length <= 500, "details must be truncated to the documented max length");
});

check("mirrorLogEntriesToAuditLog: חריגה ממכסת המיזוג מוסיפה שורת סיכום אחת נוספת (data_save_truncated)", function () {
  const collector = collectInserts();
  const newLogs = [];
  for (let i = 0; i < MAX_MIRRORED_ENTRIES_PER_SAVE + 3; i++) newLogs.push(entry(i));
  mirrorLogEntriesToAuditLog([], newLogs, { workerId: 1, workerName: "מנהל", ip: null }, collector.fn);

  assert.strictEqual(collector.calls.length, MAX_MIRRORED_ENTRIES_PER_SAVE + 1); // capped entries + 1 summary row
  const summary = collector.calls[collector.calls.length - 1];
  assert.strictEqual(summary.action, "data_save_truncated");
});

check("mirrorLogEntriesToAuditLog: entry ללא action/entityType נופל בחזרה ל-'system' (לא null/undefined בטבלה)", function () {
  const collector = collectInserts();
  const newLogs = [{ id: 1, entityId: "", entityName: "", details: "" }]; // minimal/malformed entry
  mirrorLogEntriesToAuditLog([], newLogs, { workerId: 1, workerName: "מנהל", ip: null }, collector.fn);

  assert.strictEqual(collector.calls[0].action, "system");
  assert.strictEqual(collector.calls[0].entityType, "system");
  assert.strictEqual(collector.calls[0].entityId, null);
});

// ── סיכום ─────────────────────────────────────────────────────────────────────
const failed = results.filter(function (r) { return !r.ok; });
results.forEach(function (r) {
  console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : " — " + r.error));
});
console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");
process.exit(failed.length ? 1 : 0);

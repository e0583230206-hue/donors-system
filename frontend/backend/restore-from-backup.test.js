// restore-from-backup.test.js — proves restoreFromBackup() now restores
// EVERY real table, not just the 9 app_state keys it used to.
//
// Before this fix, "restore" only copied rows from the backup's app_state
// table (donors/tasks/logs/settings/approvals/reminders/callbacks/
// sip_config/alfon_city_map) — workers, payments, ivr_call_logs,
// server_audit_log, worker_sessions, click2call_logs, and every other real
// table were silently left untouched, giving an admin who clicks "Restore"
// expecting a real point-in-time rollback a false sense of disaster
// recovery. This test seeds data across multiple non-app_state tables,
// takes a real backup (VACUUM INTO, the same mechanism the live backup
// route uses), mutates the "live" data further, restores from that backup,
// and asserts every seeded table — not just app_state — is back to the
// backed-up state.
//
// SAFETY: this ONLY ever touches DB_PATH (a fresh temp sqlite file created
// below) and a second temp file used as the backup destination. It never
// opens, reads, or writes frontend/backend/data.sqlite — the real
// production database is never touched by this file, consistent with the
// "verify only on an isolated copy, never live" instruction this fix was
// built under.
//
// הרצה: node frontend/backend/restore-from-backup.test.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "restore-from-backup-test-"));
process.env.DB_PATH = path.join(tmpRoot, "test.sqlite");
delete process.env.NODE_ENV;

const db = require("./db");

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name: name, ok: true });
  } catch (err) {
    results.push({ name: name, ok: false, error: err.stack || err.message });
  }
}

async function main() {
  await check("[בטיחות] הבדיקה פועלת מול DB זמני, לא מול data.sqlite האמיתי", async function () {
    assert.ok(db.DB_PATH.indexOf(tmpRoot) === 0, "DB_PATH חייב להיות תחת תיקיית ה-tmp");
    assert.ok(db.DB_PATH.indexOf("data.sqlite") === -1 || db.DB_PATH.indexOf(tmpRoot) === 0, "לעולם לא מול data.sqlite האמיתי");
  });

  var backupPath = path.join(tmpRoot, "backup-snapshot.sqlite");
  var workerIdBeforeBackup, paymentIdBeforeBackup;

  await check("[הכנה] זריעת נתונים במספר טבלאות אמיתיות (לא רק app_state)", async function () {
    // workers — real table, was never touched by the old restore.
    workerIdBeforeBackup = db.createWorkerInDb("עובד לפני גיבוי", "SECRETARY", "פעיל", "hash-before");

    // app_state (donors) — the one part the old restore DID cover.
    db.setAppState("donors", [{ id: 1, fullName: "תורם לפני גיבוי", phone: "0501112222", donations: [] }]);

    // payments — real table, was never touched by the old restore.
    var payResult = db.recordPayment({
      callId: "restore-test-before-" + Date.now(), phone: "0501112222", donorId: null,
      amount: 111, status: "success", source: "manual", confirmationNumber: null,
    });
    paymentIdBeforeBackup = payResult.lastInsertRowid;

    // server_audit_log — real table, was never touched by the old restore.
    db.insertAuditLog({ action: "create", entityType: "test", entityId: "1", entityName: "לפני גיבוי", details: "רשומה לפני גיבוי", workerId: workerIdBeforeBackup, workerName: "עובד לפני גיבוי", ip: "127.0.0.1" });

    // click2call_logs — real table, was never touched by the old restore.
    db.logClick2Call({ pbxCallId: "before-backup-call", workerId: workerIdBeforeBackup, workerName: "עובד לפני גיבוי", donorId: null, donorName: "תורם לפני גיבוי", donorPhone: "0501112222", agentExtension: "9263", status: "success", errorCode: null, errorNote: null });

    assert.ok(workerIdBeforeBackup);
    assert.ok(paymentIdBeforeBackup);
  });

  await check("[גיבוי] יצירת גיבוי אמיתי (VACUUM INTO) מהמצב הנוכחי", async function () {
    db.backupDatabase(backupPath);
    assert.ok(fs.existsSync(backupPath), "קובץ הגיבוי חייב להיווצר בפועל");
  });

  await check("[הכנה] שינוי נוסף אחרי הגיבוי — מדמה פעילות שקרתה לפני שהוחלט לשחזר", async function () {
    db.createWorkerInDb("עובד אחרי גיבוי", "SECRETARY", "פעיל", "hash-after");
    db.setAppState("donors", [{ id: 1, fullName: "תורם אחרי גיבוי (שונה!)", phone: "0501112222", donations: [] }, { id: 2, fullName: "תורם חדש אחרי גיבוי", phone: "0509998888", donations: [] }]);
    db.recordPayment({ callId: "restore-test-after-" + Date.now(), phone: "0509998888", donorId: null, amount: 222, status: "success", source: "manual", confirmationNumber: null });
    db.insertAuditLog({ action: "create", entityType: "test", entityId: "2", entityName: "אחרי גיבוי", details: "רשומה אחרי גיבוי", workerId: null, workerName: "אחר", ip: "127.0.0.1" });

    var workersNow = db.getWorkers();
    assert.strictEqual(workersNow.length, 3, "לפני השחזור צריכים להיות 3 עובדים (המנהל שנזרע אוטומטית + לפני+אחרי הגיבוי)");
  });

  var restoredCounts;
  await check("[שחזור] restoreFromBackup מחזירה ספירה לכל טבלה, לא רק מספר אחד עבור app_state", async function () {
    restoredCounts = db.restoreFromBackup(backupPath);
    assert.strictEqual(typeof restoredCounts, "object");
    assert.ok(Object.prototype.hasOwnProperty.call(restoredCounts, "workers"), "workers חייבת להופיע ברשימת הטבלאות ששוחזרו");
    assert.ok(Object.prototype.hasOwnProperty.call(restoredCounts, "payments"), "payments חייבת להופיע ברשימת הטבלאות ששוחזרו");
    assert.ok(Object.prototype.hasOwnProperty.call(restoredCounts, "server_audit_log"), "server_audit_log חייבת להופיע ברשימת הטבלאות ששוחזרו");
    assert.ok(Object.prototype.hasOwnProperty.call(restoredCounts, "click2call_logs"), "click2call_logs חייבת להופיע ברשימת הטבלאות ששוחזרו");
    assert.ok(Object.prototype.hasOwnProperty.call(restoredCounts, "app_state"), "app_state עצמה חייבת להופיע גם כן (הטבלה הכללית, לא רק המפתחות המורשים)");
  });

  await check("[אימות] workers חזרו בדיוק למצב שהיה בזמן הגיבוי — לא רק donors", async function () {
    var workersAfterRestore = db.getWorkers();
    assert.strictEqual(workersAfterRestore.length, 2, "השחזור חייב להחזיר בדיוק ל-2 העובדים שהיו קיימים בזמן הגיבוי (מנהל שנזרע + לפני-גיבוי), לא ל-3 — זה בדיוק מה שהמנגנון הישן לא עשה בכלל");
    var seededWorker = workersAfterRestore.find(function (w) { return w.id === workerIdBeforeBackup; });
    assert.ok(seededWorker, "העובד שנוצר לפני הגיבוי חייב להיות נוכח");
    assert.strictEqual(seededWorker.name, "עובד לפני גיבוי");
    assert.ok(!workersAfterRestore.some(function (w) { return w.name === "עובד אחרי גיבוי"; }), "העובד שנוצר אחרי הגיבוי חייב להיעלם");
  });

  await check("[אימות] donors (app_state) חזרו בדיוק למצב שהיה בזמן הגיבוי", async function () {
    var donorsAfterRestore = db.getAppState("donors");
    assert.strictEqual(donorsAfterRestore.length, 1, "צריך לחזור לתורם אחד בלבד, לא שניים");
    assert.strictEqual(donorsAfterRestore[0].fullName, "תורם לפני גיבוי", "השם חייב לחזור לגרסה שהיתה בזמן הגיבוי, לא ל'שונה!'");
  });

  await check("[אימות] payments חזרו בדיוק למצב שהיה בזמן הגיבוי — טבלה שהמנגנון הישן מעולם לא נגע בה", async function () {
    var paymentsAfterRestore = db.getPayments({});
    var ids = paymentsAfterRestore.map(function (p) { return p.id; });
    assert.ok(ids.indexOf(paymentIdBeforeBackup) !== -1, "התשלום שהיה קיים בזמן הגיבוי חייב להיות נוכח");
    assert.strictEqual(paymentsAfterRestore.length, 1, "התשלום שנוצר אחרי הגיבוי (222) חייב להיעלם — השחזור מחליף, לא ממזג");
  });

  await check("[אימות] server_audit_log חזר בדיוק למצב שהיה בזמן הגיבוי", async function () {
    var logsAfterRestore = db.getAuditLogs(100);
    var beforeEntry = logsAfterRestore.find(function (l) { return l.details === "רשומה לפני גיבוי"; });
    var afterEntry  = logsAfterRestore.find(function (l) { return l.details === "רשומה אחרי גיבוי"; });
    assert.ok(beforeEntry, "הרשומה שהיתה קיימת בזמן הגיבוי חייבת להיות נוכחת");
    assert.ok(!afterEntry, "הרשומה שנוצרה אחרי הגיבוי חייבת להיעלם אחרי שחזור");
  });

  await check("[אימות] click2call_logs חזר בדיוק למצב שהיה בזמן הגיבוי (טבלה עם FK אמיתי ל-donors, בלי לשבור מגבלות)", async function () {
    var logsAfterRestore = db.getRecentClick2CallLogs(50);
    var found = logsAfterRestore.find(function (l) { return l.pbxCallId === "before-backup-call"; });
    assert.ok(found, "רשומת click2call שהיתה קיימת בזמן הגיבוי חייבת להיות נוכחת אחרי שחזור, ללא שגיאת foreign key");
  });

  await check("[תקינות] פעולת כתיבה רגילה אחרי השחזור ממשיכה לעבוד תקין (השחזור לא משאיר את ה-DB במצב שבור)", async function () {
    db.insertAuditLog({ action: "create", entityType: "test", entityId: "3", entityName: "אחרי שחזור", details: "כתיבה רגילה אחרי שחזור", workerId: null, workerName: "בדיקה", ip: "127.0.0.1" });
    var logsNow = db.getAuditLogs(100);
    assert.ok(logsNow.some(function (l) { return l.details === "כתיבה רגילה אחרי שחזור"; }), "כתיבה רגילה אחרי שחזור חייבת להצליח כרגיל");
  });

  // ── סיכום ────────────────────────────────────────────────────────────────
  const failed = results.filter(function (r) { return !r.ok; });
  results.forEach(function (r) {
    console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : "\n    " + r.error));
  });
  console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");
  process.exitCode = failed.length ? 1 : 0;
}

main();

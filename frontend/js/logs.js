let logs = [];
var logPage = 0;
var LOG_PAGE_SIZE = 50;

const logsTable = document.getElementById("logsTable");
const clearLogsButton = document.getElementById("clearLogsButton");

function setLogPage(n) { logPage = n; renderLogs(); }

function renderLogPagination(total) {
  var totalPages = Math.ceil(total / LOG_PAGE_SIZE);
  var html = "";
  if (totalPages > 1) {
    for (var i = 0; i < totalPages; i++) {
      html += '<button class="page-btn' + (i === logPage ? " active" : "") +
              '" onclick="setLogPage(' + i + ')">' + (i + 1) + '</button>';
    }
  }
  var el = document.getElementById("logsPaginationBar");
  if (el) el.innerHTML = html;
}

function saveLogs() {
  Database.save("logs", logs);
}

function formatDate(dateString) {
  return new Date(dateString).toLocaleString("he-IL");
}

function deleteLog(id) {
  logs = logs.filter(function(l) { return l.id !== id; });
  saveLogs();
  renderLogs();
}

function renderLogs() {
  var reversed = logs.slice().reverse();
  renderLogPagination(reversed.length);

  logsTable.innerHTML = "";

  if (reversed.length === 0) {
    logsTable.innerHTML = `<tr class="empty-state-row"><td colspan="3">🕒 אין עדיין פעולות ביומן</td></tr>`;
    return;
  }

  var paged = reversed.slice(logPage * LOG_PAGE_SIZE, (logPage + 1) * LOG_PAGE_SIZE);

  paged.forEach(function(log) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${formatDate(log.date)}</td>
      <td>${escapeHTML(log.text)}</td>
      <td><button class="danger-btn" onclick="deleteLog(${log.id})">מחק</button></td>
    `;
    logsTable.appendChild(row);
  });
}

function clearLogs() {
  if (!confirm("למחוק את כל היומן?")) return;
  logs = [];
  saveLogs();
  renderLogs();
}

// downloadXLSX is defined in utils.js (shared — see #28)

function exportLogsExcel() {
  if (logs.length === 0) {
    alert("אין לוגים לייצוא");
    return;
  }

  var rows = [["זמן", "פרטים"]];

  logs.slice().reverse().forEach(function (log) {
    rows.push([
      formatDate(log.date),
      log.text || "",
    ]);
  });

  var today = new Date().toISOString().slice(0, 10);
  downloadXLSX("logs-" + today + ".xlsx", "יומן מערכת", rows);
}

clearLogsButton.addEventListener("click", clearLogs);

Database.whenReady(function () {
  logs = Database.get("logs");
  renderLogs();
});

// ── Audit log (read-only, server-authoritative) ─────────────────────────────
// Reads the tamper-resistant server_audit_log directly via the existing
// admin-only /api/admin/audit-log route — this data already existed and was
// already correctly captured on every mutating action, but had no screen
// anywhere in the product; staff only ever saw the editable log above.
// Note: the mirror deliberately never stores raw before/after field values
// (only which field names changed, if any), so "פרטים" here can't show a
// full diff — that's a pre-existing, deliberate limitation of the data
// captured, not something this screen changes.

var AUDIT_ACTION_LABELS = {
  create: "יצירה",
  update: "עדכון",
  delete: "מחיקה",
  approve: "אישור",
  cancel: "ביטול",
  status: "שינוי סטטוס",
  payment: "תשלום",
  payment_cancel: "ביטול תשלום",
  import: "ייבוא",
  login: "כניסה",
  login_failed: "כניסה נכשלה",
  logout: "יציאה",
  force_logout: "ניתוק כפוי",
  password_change: "שינוי סיסמה",
  password_reset: "איפוס סיסמה",
  worker_create: "יצירת עובד",
  worker_delete: "מחיקת עובד",
  campaign_send: "שליחת קמפיין",
  campaign_send_failed: "כשל בשליחת קמפיין",
  data_save: "שמירת נתונים",
};

function auditActionLabel(action) {
  return AUDIT_ACTION_LABELS[action] || action || "";
}

function renderAuditLog(entries) {
  var table = document.getElementById("auditLogTable");
  if (!table) return;
  table.innerHTML = "";

  if (!entries || entries.length === 0) {
    table.innerHTML = '<tr class="empty-state-row"><td colspan="6">אין רשומות ביומן הביקורת</td></tr>';
    return;
  }

  entries.forEach(function (e) {
    var row = document.createElement("tr");
    row.innerHTML =
      "<td>" + formatDate(e.createdAt) + "</td>" +
      "<td>" + escapeHTML(auditActionLabel(e.action)) + "</td>" +
      "<td>" + escapeHTML(e.entityType || "") + "</td>" +
      "<td>" + escapeHTML(e.entityName || "") + "</td>" +
      "<td>" + escapeHTML(e.workerName || "") + "</td>" +
      "<td>" + escapeHTML(e.details || "") + "</td>";
    table.appendChild(row);
  });
}

async function loadAuditLog() {
  if (typeof isAdmin !== "function" || !isAdmin()) return;
  var panel = document.getElementById("auditLogPanel");
  if (panel) panel.style.display = "";
  try {
    var res = await apiFetch("/api/admin/audit-log?limit=500");
    if (!res.ok) return;
    var entries = await res.json();
    renderAuditLog(entries);
  } catch (_) {
    // Server-side role check already protects this; a fetch failure here
    // just leaves the panel empty rather than breaking the rest of the page.
  }
}

Database.whenReady(function () {
  loadAuditLog();
});

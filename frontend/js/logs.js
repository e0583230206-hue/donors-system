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

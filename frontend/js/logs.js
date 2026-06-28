let logs = Database.get("logs");

const logsTable = document.getElementById("logsTable");
const clearLogsButton = document.getElementById("clearLogsButton");

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
  logsTable.innerHTML = "";

  if (logs.length === 0) {
    logsTable.innerHTML = `<tr class="empty-state-row"><td colspan="3">🕒 אין עדיין פעולות ביומן</td></tr>`;
    return;
  }

  logs.slice().reverse().forEach(function(log) {
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

function downloadXLSX(filename, sheetName, rows) {
  var workbook = XLSX.utils.book_new();
  var worksheet = XLSX.utils.aoa_to_sheet(rows);
  worksheet["!cols"] = rows[0].map(function () { return { wch: 22 }; });
  worksheet["!rtl"] = true;
  workbook.Workbook = { Views: [{ RTL: true }] };
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  XLSX.writeFile(workbook, filename);
}

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
renderLogs();

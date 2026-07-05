let donors = Database.get("donors");
let workers = Database.get("workers");
let tasks = Database.get("tasks");

const donorsTotal = document.getElementById("donorsTotal");
const paidTotal = document.getElementById("paidTotal");
const debtTotal = document.getElementById("debtTotal");
const commitmentsTotal = document.getElementById("commitmentsTotal");

const openRemindersTotal = document.getElementById("openRemindersTotal");
const openCallbacksTotal = document.getElementById("openCallbacksTotal");
const openTasksTotal = document.getElementById("openTasksTotal");
const collectionRate = document.getElementById("collectionRate");

const financeTable = document.getElementById("financeTable");
const workersReportTable = document.getElementById("workersReportTable");

const exportDonorsButton = document.getElementById("exportDonorsButton");
const exportDebtsButton = document.getElementById("exportDebtsButton");
const exportWorkersButton = document.getElementById("exportWorkersButton");

// formatMoney is defined globally in database.js

function getAllDonations() {
  const donations = [];

  donors.forEach(function (donor) {
    if (!donor.donations) return;

    donor.donations.forEach(function (donation) {
      donations.push({
        donorId: donor.id,
        donorName: donor.fullName,
        donorPhone: donor.phone,
        donorCity: donor.city || "",
        ...donation,
      });
    });
  });

  return donations;
}

function getAllReminders() {
  const reminders = [];

  donors.forEach(function (donor) {
    if (!donor.reminders) return;

    donor.reminders.forEach(function (reminder) {
      reminders.push({
        donorId: donor.id,
        donorName: donor.fullName,
        ...reminder,
      });
    });
  });

  return reminders;
}

function getAllCallbacks() {
  const callbacks = [];

  donors.forEach(function (donor) {
    if (!donor.callbacks) return;

    donor.callbacks.forEach(function (callback) {
      callbacks.push({
        donorId: donor.id,
        donorName: donor.fullName,
        ...callback,
      });
    });
  });

  return callbacks;
}

function calculateTotals() {
  const donations = getAllDonations();
  const reminders = getAllReminders();
  const callbacks = getAllCallbacks();

  const totalCommitted = donations.reduce(function (sum, donation) {
    return sum + Number(donation.amount || 0);
  }, 0);

  const totalPaid = donations.reduce(function (sum, donation) {
    return sum + Number(donation.paidPartial || 0);
  }, 0);

  const totalDebt = donations.reduce(function (sum, donation) {
    return sum + Number(donation.remainingDebt || 0);
  }, 0);

  const openReminders = reminders.filter(function (reminder) {
    return reminder.done === false;
  }).length;

  const openCallbacks = callbacks.filter(function (callback) {
    return callback.done === false;
  }).length;

  const openTasks = tasks.filter(function (task) {
    return task.done === false;
  }).length;

  const rate =
    totalCommitted === 0 ? 0 : Math.round((totalPaid / totalCommitted) * 100);

  donorsTotal.innerText = donors.length;
  paidTotal.innerText = formatMoney(totalPaid);
  debtTotal.innerText = formatMoney(totalDebt);
  commitmentsTotal.innerText = formatMoney(totalCommitted);

  openRemindersTotal.innerText = openReminders;
  openCallbacksTotal.innerText = openCallbacks;
  openTasksTotal.innerText = openTasks;
  collectionRate.innerText = rate + "%";
}

function buildFinanceReport() {
  const donations = getAllDonations();

  const report = {};

  donations.forEach(function (donation) {
    const purpose = donation.finalPurpose || "לא מוגדר";

    if (!report[purpose]) {
      report[purpose] = {
        count: 0,
        committed: 0,
        paid: 0,
        debt: 0,
      };
    }

    report[purpose].count++;
    report[purpose].committed += Number(donation.amount || 0);
    report[purpose].paid += Number(donation.paidPartial || 0);
    report[purpose].debt += Number(donation.remainingDebt || 0);
  });

  financeTable.innerHTML = "";

  const purposes = Object.keys(report);

  if (purposes.length === 0) {
    financeTable.innerHTML = `
      <tr class="empty-state-row">
        <td colspan="6">📊 אין עדיין נתונים כספיים</td>
      </tr>
    `;
    return;
  }

  purposes.forEach(function (purpose) {
    const item = report[purpose];

    const rate =
      item.committed === 0 ? 0 : Math.round((item.paid / item.committed) * 100);

    const row = document.createElement("tr");

    row.innerHTML = `
      <td>${escapeHTML(purpose)}</td>
      <td>${item.count}</td>
      <td>${formatMoney(item.committed)}</td>
      <td class="green-text">${formatMoney(item.paid)}</td>
      <td class="red-text">${formatMoney(item.debt)}</td>
      <td>${rate}%</td>
    `;

    financeTable.appendChild(row);
  });
}

function countTasksForWorker(workerName, doneStatus) {
  return tasks.filter(function (task) {
    return task.workerName === workerName && task.done === doneStatus;
  }).length;
}

function countCallbacksForWorker(workerName, doneStatus) {
  const callbacks = getAllCallbacks();

  return callbacks.filter(function (callback) {
    return callback.workerName === workerName && callback.done === doneStatus;
  }).length;
}

function buildWorkersReport() {
  workersReportTable.innerHTML = "";

  if (workers.length === 0) {
    workersReportTable.innerHTML = `
      <tr>
        <td colspan="7">אין עובדים להצגה</td>
      </tr>
    `;
    return;
  }

  workers.forEach(function (worker) {
    const row = document.createElement("tr");

    row.innerHTML = `
      <td>${escapeHTML(worker.name)}</td>
      <td>${escapeHTML(worker.role)}</td>
      <td class="${worker.status === "פעיל" ? "green-text" : "red-text"}">
        ${escapeHTML(worker.status)}
      </td>
      <td>${countTasksForWorker(worker.name, false)}</td>
      <td>${countTasksForWorker(worker.name, true)}</td>
      <td>${countCallbacksForWorker(worker.name, false)}</td>
      <td>${countCallbacksForWorker(worker.name, true)}</td>
    `;

    workersReportTable.appendChild(row);
  });
}

// Guard against CSV/Excel formula injection (= + - @ as first char)
function sanitizeCell(v) {
  if (typeof v !== "string") return v;
  if (/^[=+\-@|]/.test(v)) return "'" + v;
  return v;
}

function downloadXLSX(filename, sheetName, rows) {
  const workbook  = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet(rows);

  worksheet["!cols"] = rows[0].map(function () { return { wch: 24 }; });
  worksheet["!rtl"]  = true;

  workbook.Workbook = { Views: [{ RTL: true }] };

  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  XLSX.writeFile(workbook, filename);
}

function exportDonors() {
  const rows = [
    ["שם", "טלפון", "עיר", "כתובת", "סטטוס", "מספר תרומות", "שולם", "חוב"],
  ];

  donors.forEach(function (donor) {
    const donations = donor.donations || [];

    const paid = donations.reduce(function (sum, donation) {
      return sum + Number(donation.paidPartial || 0);
    }, 0);

    const debt = donations.reduce(function (sum, donation) {
      return sum + Number(donation.remainingDebt || 0);
    }, 0);

    rows.push([
      sanitizeCell(donor.fullName || ""),
      sanitizeCell(donor.phone    || ""),
      sanitizeCell(donor.city     || ""),
      sanitizeCell(donor.address  || ""),
      sanitizeCell(donor.status   || ""),
      donations.length,
      paid,
      debt,
    ]);
  });

  downloadXLSX("donors.xlsx", "תורמים", rows);
}

function exportDebts() {
  const rows = [
    ["שם", "טלפון", "מטרה", "חוב", "תאריך לועזי", "תאריך עברי", "הערה"],
  ];

  donors.forEach(function (donor) {
    const donations = donor.donations || [];

    donations.forEach(function (donation) {
      const debt = Number(donation.remainingDebt || 0);

      if (debt > 0) {
        rows.push([
          sanitizeCell(donor.fullName            || ""),
          sanitizeCell(donor.phone               || ""),
          sanitizeCell(donation.finalPurpose     || ""),
          debt,
          sanitizeCell(donation.regularDate || donation.date || ""),
          sanitizeCell(donation.hebrewDate       || ""),
          sanitizeCell(donation.note             || ""),
        ]);
      }
    });
  });

  downloadXLSX("debts.xlsx", "חובות", rows);
}

function exportWorkers() {
  const rows = [
    [
      "שם",
      "תפקיד",
      "סטטוס",
      "משימות פתוחות",
      "משימות שהושלמו",
      "הודעות פתוחות",
      "הודעות שטופלו",
    ],
  ];

  workers.forEach(function (worker) {
    rows.push([
      sanitizeCell(worker.name   || ""),
      sanitizeCell(worker.role   || ""),
      sanitizeCell(worker.status || ""),
      countTasksForWorker(worker.name, false),
      countTasksForWorker(worker.name, true),
      countCallbacksForWorker(worker.name, false),
      countCallbacksForWorker(worker.name, true),
    ]);
  });

  downloadXLSX("workers.xlsx", "עובדים", rows);
}

if (exportDonorsButton) {
  exportDonorsButton.addEventListener("click", exportDonors);
}

if (exportDebtsButton) {
  exportDebtsButton.addEventListener("click", exportDebts);
}

if (exportWorkersButton) {
  exportWorkersButton.addEventListener("click", exportWorkers);
}

// ── Period / category filter ──────────────────────────────────────────────────

var periodFilter = { from: "", to: "", category: "" };

function getFilteredDonations() {
  var all = getAllDonations();
  return all.filter(function (d) {
    var dateStr = d.regularDate || d.date || d.createdAt || "";
    var date    = dateStr ? new Date(dateStr) : null;

    if (periodFilter.from && date) {
      if (date < new Date(periodFilter.from)) return false;
    }
    if (periodFilter.to && date) {
      var toEnd = new Date(periodFilter.to);
      toEnd.setHours(23, 59, 59, 999);
      if (date > toEnd) return false;
    }
    if (periodFilter.category) {
      if ((d.finalPurpose || "לא מוגדר") !== periodFilter.category) return false;
    }
    return true;
  });
}

function buildCategoryDropdown() {
  var select = document.getElementById("filterCategory");
  if (!select) return;
  var all      = getAllDonations();
  var purposes = {};
  all.forEach(function (d) {
    purposes[d.finalPurpose || "לא מוגדר"] = true;
  });
  var saved = select.value;
  select.innerHTML = '<option value="">הכל</option>';
  Object.keys(purposes).sort(function (a, b) { return a.localeCompare(b, "he"); })
    .forEach(function (p) {
      var opt = document.createElement("option");
      opt.value       = p;
      opt.textContent = p;
      if (p === saved) opt.selected = true;
      select.appendChild(opt);
    });
}

function buildPeriodReport() {
  var filtered    = getFilteredDonations();
  var periodStats = document.getElementById("periodStats");
  var periodTable = document.getElementById("periodTable");
  if (!periodStats || !periodTable) return;

  var totalCommitted = 0, totalPaid = 0, totalDebt = 0;
  filtered.forEach(function (d) {
    totalCommitted += Number(d.amount || 0);
    totalPaid      += Number(d.paidPartial || 0);
    totalDebt      += Number(d.remainingDebt || 0);
  });

  periodStats.innerHTML =
    '<div class="stat-card"><h3>📊 תרומות</h3><strong>' + filtered.length + '</strong><p>מספר רשומות</p></div>' +
    '<div class="stat-card warning"><h3>📋 התחייבו</h3><strong>' + formatMoney(totalCommitted) + '</strong><p>סה"כ התחייבויות</p></div>' +
    '<div class="stat-card success"><h3>✅ שולם</h3><strong>' + formatMoney(totalPaid) + '</strong><p>סה"כ שולם</p></div>' +
    '<div class="stat-card danger"><h3>⚠️ חוב</h3><strong>' + formatMoney(totalDebt) + '</strong><p>סה"כ חוב</p></div>';

  if (filtered.length === 0) {
    periodTable.innerHTML = '<tr class="empty-state-row"><td colspan="8">אין נתונים בתקופה זו</td></tr>';
    return;
  }

  var sorted = filtered.slice().sort(function (a, b) {
    var da = new Date(a.regularDate || a.date || a.createdAt || 0);
    var db = new Date(b.regularDate || b.date || b.createdAt || 0);
    return db - da;
  });

  periodTable.innerHTML = sorted.map(function (d) {
    return "<tr>" +
      "<td>" + escapeHTML(d.donorName  || "")          + "</td>" +
      "<td>" + escapeHTML(d.donorPhone || "")          + "</td>" +
      "<td>" + escapeHTML(d.donorCity  || "")          + "</td>" +
      "<td>" + escapeHTML(d.finalPurpose || "לא מוגדר") + "</td>" +
      "<td>" + formatMoney(d.amount || 0)              + "</td>" +
      '<td class="green-text">' + formatMoney(d.paidPartial   || 0) + "</td>" +
      '<td class="red-text">'   + formatMoney(d.remainingDebt || 0) + "</td>" +
      "<td>" + escapeHTML(d.regularDate || d.date || "") + "</td>" +
    "</tr>";
  }).join("");
}

function buildMonthlyBreakdown() {
  var all     = getAllDonations();
  var byMonth = {};

  all.forEach(function (d) {
    var dateStr = d.regularDate || d.date || d.createdAt || "";
    if (!dateStr) return;
    var dt = new Date(dateStr);
    if (isNaN(dt)) return;
    var key = dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0");
    if (!byMonth[key]) byMonth[key] = { count: 0, committed: 0, paid: 0, debt: 0 };
    byMonth[key].count++;
    byMonth[key].committed += Number(d.amount || 0);
    byMonth[key].paid      += Number(d.paidPartial   || 0);
    byMonth[key].debt      += Number(d.remainingDebt || 0);
  });

  var monthlyTable = document.getElementById("monthlyTable");
  if (!monthlyTable) return;

  var keys = Object.keys(byMonth).sort().reverse();
  if (keys.length === 0) {
    monthlyTable.innerHTML = '<tr class="empty-state-row"><td colspan="5">אין נתונים</td></tr>';
    return;
  }

  var hebrewMonths = ["ינואר","פברואר","מרץ","אפריל","מאי","יוני",
                      "יולי","אוגוסט","ספטמבר","אוקטובר","נובמבר","דצמבר"];

  monthlyTable.innerHTML = keys.map(function (key) {
    var parts = key.split("-");
    var label = hebrewMonths[Number(parts[1]) - 1] + " " + parts[0];
    var item  = byMonth[key];
    return "<tr>" +
      "<td>" + label + "</td>" +
      "<td>" + item.count + "</td>" +
      "<td>" + formatMoney(item.committed) + "</td>" +
      '<td class="green-text">' + formatMoney(item.paid) + "</td>" +
      '<td class="red-text">'   + formatMoney(item.debt) + "</td>" +
    "</tr>";
  }).join("");
}

function clearPeriodFilter() {
  periodFilter = { from: "", to: "", category: "" };
  var fromEl = document.getElementById("filterFrom");
  var toEl   = document.getElementById("filterTo");
  var catEl  = document.getElementById("filterCategory");
  if (fromEl) fromEl.value = "";
  if (toEl)   toEl.value   = "";
  if (catEl)  catEl.value  = "";
  buildPeriodReport();
}

function exportFilteredDonations() {
  var filtered = getFilteredDonations();
  var rows     = [["שם תורם","טלפון","עיר","קטגוריה","התחייב","שולם","חוב","תאריך","הערה"]];

  filtered.forEach(function (d) {
    rows.push([
      sanitizeCell(d.donorName    || ""),
      sanitizeCell(d.donorPhone   || ""),
      sanitizeCell(d.donorCity    || ""),
      sanitizeCell(d.finalPurpose || ""),
      Number(d.amount        || 0),
      Number(d.paidPartial   || 0),
      Number(d.remainingDebt || 0),
      sanitizeCell(d.regularDate || d.date || ""),
      sanitizeCell(d.note        || ""),
    ]);
  });

  var suffix = "";
  if (periodFilter.from || periodFilter.to) {
    suffix = "_" + (periodFilter.from || "start") + "_עד_" + (periodFilter.to || "end");
  }
  downloadXLSX("תרומות" + suffix + ".xlsx", "תרומות", rows);
}

(function wirePeriodFilter() {
  var fromEl  = document.getElementById("filterFrom");
  var toEl    = document.getElementById("filterTo");
  var catEl   = document.getElementById("filterCategory");
  var expBtn  = document.getElementById("exportPeriodButton");

  if (fromEl) fromEl.addEventListener("change", function () {
    periodFilter.from = this.value;
    buildPeriodReport();
  });
  if (toEl) toEl.addEventListener("change", function () {
    periodFilter.to = this.value;
    buildPeriodReport();
  });
  if (catEl) catEl.addEventListener("change", function () {
    periodFilter.category = this.value;
    buildPeriodReport();
  });
  if (expBtn) expBtn.addEventListener("click", exportFilteredDonations);
}());

function buildAdvancedStats() {
  var topDonorsList   = document.getElementById("topDonorsList");
  var avgDonationEl   = document.getElementById("avgDonation");
  var topDonorName    = document.getElementById("topDonorName");
  var topDonorAmount  = document.getElementById("topDonorAmount");
  var currentYearPaid = document.getElementById("currentYearPaid");
  var prevYearPaid    = document.getElementById("prevYearPaid");
  var currentYearLbl  = document.getElementById("currentYearLabel");
  var prevYearLbl     = document.getElementById("prevYearLabel");

  if (!topDonorsList) return;

  // Per-donor totals
  var donorTotals = donors.map(function (donor) {
    var paid = (donor.donations || []).reduce(function (s, d) { return s + Number(d.paidPartial || 0); }, 0);
    return { name: donor.fullName, paid: paid };
  }).filter(function (d) { return d.paid > 0; });

  donorTotals.sort(function (a, b) { return b.paid - a.paid; });

  // Top 5
  topDonorsList.innerHTML = donorTotals.slice(0, 5).map(function (d, i) {
    return '<li>' +
      '<span class="top-donor-rank">' + (i + 1) + '</span>' +
      '<span class="top-donor-name">' + escapeHTML(d.name) + '</span>' +
      '<span class="top-donor-amount">' + formatMoney(d.paid) + '</span>' +
    '</li>';
  }).join("") || "<li style='color:var(--muted)'>אין נתונים</li>";

  // Average donation per donor (donors with at least one donation)
  if (avgDonationEl) {
    var avg = donorTotals.length > 0
      ? Math.round(donorTotals.reduce(function (s, d) { return s + d.paid; }, 0) / donorTotals.length)
      : 0;
    avgDonationEl.innerText = formatMoney(avg);
  }

  // Top donor
  if (topDonorName && donorTotals.length > 0) {
    topDonorName.innerText = donorTotals[0].name;
    if (topDonorAmount) topDonorAmount.innerText = formatMoney(donorTotals[0].paid);
  }

  // Year-over-year (Gregorian year from donation.createdAt)
  var currentYear = new Date().getFullYear();
  var prevYear    = currentYear - 1;
  var byYear = {};
  donors.forEach(function (donor) {
    (donor.donations || []).forEach(function (d) {
      var y = d.createdAt ? new Date(d.createdAt).getFullYear() : null;
      if (!y) return;
      byYear[y] = (byYear[y] || 0) + Number(d.paidPartial || 0);
    });
  });

  if (currentYearPaid) currentYearPaid.innerText = formatMoney(byYear[currentYear] || 0);
  if (prevYearPaid)    prevYearPaid.innerText    = formatMoney(byYear[prevYear]    || 0);
  if (currentYearLbl)  currentYearLbl.innerText  = "שולם " + currentYear;
  if (prevYearLbl)     prevYearLbl.innerText     = "שולם " + prevYear;
}

Database.whenReady(function () {
  donors  = Database.get("donors");
  workers = Database.get("workers");
  tasks   = Database.get("tasks");
  calculateTotals();
  buildFinanceReport();
  buildWorkersReport();
  buildAdvancedStats();
  buildCategoryDropdown();
  buildPeriodReport();
  buildMonthlyBreakdown();
});

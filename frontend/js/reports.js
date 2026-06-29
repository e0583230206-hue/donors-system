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
      <td>${purpose}</td>
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
      <td>${worker.name}</td>
      <td>${worker.role}</td>
      <td class="${worker.status === "פעיל" ? "green-text" : "red-text"}">
        ${worker.status}
      </td>
      <td>${countTasksForWorker(worker.name, false)}</td>
      <td>${countTasksForWorker(worker.name, true)}</td>
      <td>${countCallbacksForWorker(worker.name, false)}</td>
      <td>${countCallbacksForWorker(worker.name, true)}</td>
    `;

    workersReportTable.appendChild(row);
  });
}

function downloadXLSX(filename, sheetName, rows) {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet(rows);

  worksheet["!cols"] = rows[0].map(function () {
    return { wch: 22 };
  });

  worksheet["!rtl"] = true;
  workbook.Workbook = {
    Views: [{ RTL: true }],
  };

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
      donor.fullName || "",
      donor.phone || "",
      donor.city || "",
      donor.address || "",
      donor.status || "",
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
          donor.fullName || "",
          donor.phone || "",
          donation.finalPurpose || "",
          debt,
          donation.regularDate || donation.date || "",
          donation.hebrewDate || "",
          donation.note || "",
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
      worker.name || "",
      worker.role || "",
      worker.status || "",
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
});

let donors = Database.get("donors");
let tasks = Database.get("tasks");

const donorsTotal = document.getElementById("donorsTotal");
const debtsTotal = document.getElementById("debtsTotal");
const paidTotal = document.getElementById("paidTotal");
const remindersTotal = document.getElementById("remindersTotal");

const activityList = document.getElementById("activityList");
const alertsList = document.getElementById("alertsList");

// formatMoney is defined globally in database.js

function getAllDonations() {
  const donations = [];

  donors.forEach(function (donor) {
    if (!donor.donations) return;

    donor.donations.forEach(function (donation) {
      donations.push(donation);
    });
  });

  return donations;
}

function getAllReminders() {
  const reminders = [];

  donors.forEach(function (donor) {
    if (!donor.reminders) return;

    donor.reminders.forEach(function (reminder) {
      reminders.push(reminder);
    });
  });

  return reminders;
}

function getAllCallbacks() {
  const callbacks = [];

  donors.forEach(function (donor) {
    if (!donor.callbacks) return;

    donor.callbacks.forEach(function (callback) {
      callbacks.push(callback);
    });
  });

  return callbacks;
}

function getTodayString() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const values = {};
  parts.forEach(function (part) {
    values[part.type] = part.value;
  });

  return values.year + "-" + values.month + "-" + values.day;
}

function updateDashboard() {
  const donations = getAllDonations();
  const reminders = getAllReminders();
  const callbacks = getAllCallbacks();

  const totalDebt = donations.reduce(function (sum, donation) {
    return sum + Number(donation.remainingDebt || 0);
  }, 0);

  const totalPaid = donations.reduce(function (sum, donation) {
    return sum + Number(donation.paidPartial || 0);
  }, 0);

  const openReminders = reminders.filter(function (reminder) {
    return reminder.done === false;
  });

  const todayReminders = openReminders.filter(function (reminder) {
    return reminder.date <= getTodayString();
  });

  const openCallbacks = callbacks.filter(function (callback) {
    return callback.done === false;
  });

  const urgentCallbacks = openCallbacks.filter(function (callback) {
    return callback.priority === "דחוף";
  });

  const openTasks = tasks.filter(function (task) {
    return task.done === false;
  });

  const urgentTasks = openTasks.filter(function (task) {
    return task.priority === "דחוף";
  });

  donorsTotal.innerText = donors.length;
  debtsTotal.innerText = formatMoney(totalDebt);
  paidTotal.innerText = formatMoney(totalPaid);
  remindersTotal.innerText = openReminders.length;

  const dashboardData = {
    totalDebt: totalDebt,
    todayReminders: todayReminders.length,
    urgentCallbacks: urgentCallbacks.length,
    urgentTasks: urgentTasks.length,
    openTasks: openTasks.length,
    openCallbacks: openCallbacks.length,
  };

  renderActivity(dashboardData);
  renderAlerts(dashboardData);
  updateServerDashboard();
}

async function updateServerDashboard() {
  if (typeof apiFetch !== "function") return;

  try {
    const response = await apiFetch("/api/dashboard");
    if (!response.ok) return;

    const stats = await response.json();

    if (stats && typeof stats.totalDonors === "number" && donors.length === 0) {
      donorsTotal.innerText = stats.totalDonors;
    }

    if (stats && typeof stats.totalPaymentAmount === "number" && donors.length === 0) {
      paidTotal.innerText = formatMoney(stats.totalPaymentAmount);
    }
  } catch (error) {
    // Local dashboard stays available when the production API is offline.
  }

  try {
    const pRes = await apiFetch("/api/payments/stats");
    if (!pRes.ok) return;
    const ps = await pRes.json();
    const fmt = function (n) {
      return "₪" + Number(n || 0).toLocaleString("he-IL",
        { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };
    const row = document.getElementById("ivrStatsRow");
    if (row) row.style.display = "";
    const el = function (id) { return document.getElementById(id); };
    if (el("ivrTodayCount"))  el("ivrTodayCount").innerText  = (ps.today && ps.today.count)  || 0;
    if (el("ivrTodayTotal"))  el("ivrTodayTotal").innerText  = fmt(ps.today && ps.today.total);
    if (el("ivrWeekTotal"))   el("ivrWeekTotal").innerText   = fmt(ps.week  && ps.week.total);
    if (el("ivrMonthTotal"))  el("ivrMonthTotal").innerText  = fmt(ps.month && ps.month.total);
  } catch (_) {}

  // Click2Call count this week (from dashboard stats)
  try {
    const dRes = await apiFetch("/api/dashboard");
    if (dRes.ok) {
      const ds = await dRes.json();
      if (el("click2callWeekCount") && typeof ds.click2callThisWeek === "number") {
        el("click2callWeekCount").innerText = ds.click2callThisWeek;
      }
    }
  } catch (_) {}

  // Donors without an approved IVR phone (client-side)
  try {
    var noIvrCount = donors.filter(function (d) {
      return !d.ivrApprovedPhones || d.ivrApprovedPhones.length === 0;
    }).length;
    if (el("noIvrPhoneCount")) el("noIvrPhoneCount").innerText = noIvrCount;
  } catch (_) {}
}

function renderActivity(data) {
  activityList.innerHTML = "";

  const items = [];

  if (data.totalDebt > 0) {
    items.push({ text: "⚠️ יש חובות פתוחים בסך " + formatMoney(data.totalDebt), href: "debts.html" });
  }

  if (data.todayReminders > 0) {
    items.push({ text: "🔔 יש " + data.todayReminders + " תזכורות לטיפול היום", href: "reminders.html" });
  }

  if (data.openCallbacks > 0) {
    items.push({ text: "📞 יש " + data.openCallbacks + " הודעות לחזרה פתוחות", href: "phone.html" });
  }

  if (data.openTasks > 0) {
    items.push({ text: "📋 יש " + data.openTasks + " משימות פתוחות", href: "tasks.html" });
  }

  if (items.length === 0) {
    items.push({ text: "✅ אין כרגע פעילות פתוחה", href: null });
  }

  items.forEach(function (item) {
    const li = document.createElement("li");
    if (item.href) {
      const a = document.createElement("a");
      a.href = item.href;
      a.innerText = item.text;
      a.style.cssText = "color:inherit;text-decoration:none;display:block;";
      li.appendChild(a);
    } else {
      li.innerText = item.text;
    }
    activityList.appendChild(li);
  });
}

function renderAlerts(data) {
  alertsList.innerHTML = "";

  const alerts = [];

  if (data.totalDebt > 0) {
    alerts.push({ text: "⚠️ יש חובות פתוחים בסך " + formatMoney(data.totalDebt), href: "debts.html" });
  }

  if (data.todayReminders > 0) {
    alerts.push({ text: "🔔 יש " + data.todayReminders + " תזכורות שהגיע זמנן", href: "reminders.html" });
  }

  if (data.urgentCallbacks > 0) {
    alerts.push({ text: "📞 יש " + data.urgentCallbacks + " הודעות לחזרה דחופות", href: "phone.html" });
  }

  if (data.urgentTasks > 0) {
    alerts.push({ text: "🔥 יש " + data.urgentTasks + " משימות דחופות", href: "tasks.html" });
  }

  if (alerts.length === 0) {
    alerts.push({ text: "✅ אין כרגע התראות דחופות", href: null });
  }

  alerts.forEach(function (item) {
    const li = document.createElement("li");
    if (item.href) {
      const a = document.createElement("a");
      a.href = item.href;
      a.innerText = item.text;
      a.style.cssText = "color:inherit;text-decoration:none;display:block;";
      li.appendChild(a);
    } else {
      li.innerText = item.text;
    }
    alertsList.appendChild(li);
  });
}

Database.whenReady(function () {
  donors = Database.get("donors");
  tasks  = Database.get("tasks");
  updateDashboard();
  renderChart();
  loadIvrChart();
});

// ── IVR Payments chart ────────────────────────────────────────────────────────

var _ivrChartMode = "day";
var _ivrPaymentsCache = null;

function switchIvrChart(mode) {
  _ivrChartMode = mode;
  var dayBtn   = document.getElementById("ivrChartDayBtn");
  var monthBtn = document.getElementById("ivrChartMonthBtn");
  if (dayBtn)   dayBtn.classList.toggle("active",   mode === "day");
  if (monthBtn) monthBtn.classList.toggle("active", mode === "month");
  renderIvrChart(_ivrPaymentsCache || []);
}

async function loadIvrChart() {
  if (typeof apiFetch !== "function") return;
  try {
    var res = await apiFetch("/api/payments?limit=2000");
    if (!res || !res.ok) return;
    var payments = await res.json();
    _ivrPaymentsCache = payments;
    var panel = document.getElementById("ivrChartPanel");
    if (panel) panel.style.display = "";
    renderIvrChart(payments);
  } catch (_) {}
}

function renderIvrChart(payments) {
  var el = document.getElementById("ivrChartBars");
  if (!el) return;

  var sym    = typeof currencySymbol === "function" ? currencySymbol() : "₪";
  var MAX_H  = 160;

  function shortNum(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1000)    return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
    return String(Math.round(n));
  }

  function makeBar(label, val, maxVal) {
    var h      = val > 0 ? Math.max(4, Math.round((val / maxVal) * MAX_H)) : 4;
    var valTxt = val > 0 ? sym + shortNum(val) : "";
    return (
      '<div class="chart-bar-group">' +
        '<span class="chart-bar-value">' + valTxt + '</span>' +
        '<div class="chart-bar-outer" style="height:' + h + 'px" title="' + label + ': ' + sym + shortNum(val) + '">' +
          '<div style="height:' + h + 'px;background:linear-gradient(to bottom,#60a5fa,#1d4ed8);border-radius:5px 5px 0 0"></div>' +
        '</div>' +
        '<div class="chart-bar-label">' + label + '</div>' +
      '</div>'
    );
  }

  if (_ivrChartMode === "day") {
    var days = {};
    var now  = new Date();
    var fmtCA = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" });
    for (var i = 13; i >= 0; i--) {
      var d = new Date(now);
      d.setDate(d.getDate() - i);
      days[fmtCA.format(d)] = 0;
    }
    payments.forEach(function (p) {
      if (p.status !== "success") return;
      var k = (p.timestamp || p.createdAt || "").slice(0, 10);
      if (k in days) days[k] += Number(p.amount || 0);
    });
    var keys    = Object.keys(days);
    var maxVal2 = Math.max.apply(null, keys.map(function (k) { return days[k]; })) || 1;
    el.innerHTML = keys.map(function (k) {
      return makeBar(k.slice(8) + "/" + k.slice(5, 7), days[k], maxVal2);
    }).join("");

  } else {
    var months = {};
    var now2   = new Date();
    for (var j = 11; j >= 0; j--) {
      var d2 = new Date(now2.getFullYear(), now2.getMonth() - j, 1);
      var mk = d2.getFullYear() + "-" + String(d2.getMonth() + 1).padStart(2, "0");
      months[mk] = 0;
    }
    payments.forEach(function (p) {
      if (p.status !== "success") return;
      var mk2 = (p.timestamp || p.createdAt || "").slice(0, 7);
      if (mk2 in months) months[mk2] += Number(p.amount || 0);
    });
    var keys2    = Object.keys(months);
    var maxVal3  = Math.max.apply(null, keys2.map(function (k) { return months[k]; })) || 1;
    el.innerHTML = keys2.map(function (k) {
      return makeBar(k.slice(5) + "/" + k.slice(2, 4), months[k], maxVal3);
    }).join("");
  }
}

// ── CRM donations bar chart ───────────────────────────────────────────────────

function renderChart() {
  var chartBars = document.getElementById("chartBars");
  if (!chartBars) return;

  function stripNikud(s) {
    return String(s || "").replace(/[֑-ׇ]/g, "");
  }

  function getHebMonth(key) {
    var p = key.split("-");
    var d = new Date(Number(p[0]), Number(p[1]) - 1, 15);
    try {
      return stripNikud(
        new Intl.DateTimeFormat("he-IL-u-ca-hebrew", {
          month: "long",
          timeZone: "Asia/Jerusalem"
        }).format(d)
      );
    } catch (_) {
      return p[1] + "/" + p[0].slice(2);
    }
  }

  function shortNum(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1000)    return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
    return String(Math.round(n));
  }

  var donations = getAllDonations();
  var months = {};

  donations.forEach(function (d) {
    var dateStr = d.createdAt || d.date || "";
    var dt = new Date(dateStr);
    if (isNaN(dt.getTime())) return;
    var key = dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0");
    if (!months[key]) months[key] = { paid: 0, debt: 0 };
    months[key].paid += Number(d.paidPartial || 0);
    months[key].debt += Number(d.remainingDebt || 0);
  });

  var keys = Object.keys(months).sort().slice(-12);

  if (keys.length === 0) {
    chartBars.innerHTML = '<div class="chart-empty">אין נתוני תרומות להצגה</div>';
    return;
  }

  var maxTotal = Math.max.apply(null, keys.map(function (k) {
    return months[k].paid + months[k].debt;
  }));

  var sym = typeof currencySymbol === "function" ? currencySymbol() : "₪";
  var MAX_H = 160;

  chartBars.innerHTML = keys.map(function (key) {
    var paid      = months[key].paid;
    var debt      = months[key].debt;
    var total     = paid + debt;
    var barH      = maxTotal > 0 ? Math.max(4, Math.round((total / maxTotal) * MAX_H)) : 4;
    var paidH     = total > 0 ? Math.round((paid / total) * barH) : 0;
    var debtH     = barH - paidH;
    var monthName = getHebMonth(key);
    var valText   = total > 0 ? sym + shortNum(total) : "";
    var tip       = monthName + " | שולם: " + sym + shortNum(paid) +
                    " | חוב: " + sym + shortNum(debt);
    return (
      '<div class="chart-bar-group">' +
        '<span class="chart-bar-value">' + valText + '</span>' +
        '<div class="chart-bar-outer" style="height:' + barH + 'px" title="' + tip + '">' +
          '<div class="chart-bar-debt" style="height:' + debtH + 'px"></div>' +
          '<div class="chart-bar-paid" style="height:' + paidH + 'px"></div>' +
        '</div>' +
        '<div class="chart-bar-label">' + monthName + '</div>' +
      '</div>'
    );
  }).join("");
}

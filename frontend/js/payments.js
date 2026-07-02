var allPayments = [];

var searchInput  = document.getElementById("searchInput");
var dateFrom     = document.getElementById("dateFrom");
var dateTo       = document.getElementById("dateTo");
var paymentsTable = document.getElementById("paymentsTable");
var paymentsCount = document.getElementById("paymentsCount");
var statTotal     = document.getElementById("statTotal");
var statAmount    = document.getElementById("statAmount");
var statTodayCount = document.getElementById("statTodayCount");
var statTodayAmount = document.getElementById("statTodayAmount");
var loadingMsg   = document.getElementById("loadingMsg");
var errorMsg     = document.getElementById("errorMsg");

function todayIsrael() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date());
}

function formatDateTime(isoStr) {
  if (!isoStr) return "—";
  var d = new Date(isoStr);
  if (isNaN(d.getTime())) return isoStr;
  return d.toLocaleString("he-IL", { timeZone: "Asia/Jerusalem", hour12: false });
}

function formatMoney(amount) {
  if (amount === null || amount === undefined) return "—";
  return "₪" + Number(amount).toLocaleString("he-IL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escapeHTML(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function statusBadge(status) {
  if (status === "success") {
    return '<span style="background:#d4edda;color:#155724;padding:2px 8px;border-radius:10px;font-size:.85em;">הצלחה</span>';
  }
  if (status === "failed" || status === "error") {
    return '<span style="background:#f8d7da;color:#721c24;padding:2px 8px;border-radius:10px;font-size:.85em;">כישלון</span>';
  }
  return '<span style="background:#e2e3e5;color:#383d41;padding:2px 8px;border-radius:10px;font-size:.85em;">' + escapeHTML(status) + '</span>';
}

function getDateStr(p) {
  var iso = p.timestamp || p.createdAt || "";
  return iso.slice(0, 10);
}

function applyFilters() {
  var q      = (searchInput.value || "").trim().toLowerCase();
  var from   = dateFrom.value || "";
  var to     = dateTo.value   || "";

  var filtered = allPayments.filter(function (p) {
    if (q) {
      var name    = (p.donorName || "").toLowerCase();
      var phone   = (p.phone     || "").toLowerCase();
      var confirm = (p.confirmationNumber || "").toLowerCase();
      if (!name.includes(q) && !phone.includes(q) && !confirm.includes(q)) return false;
    }
    var dateStr = getDateStr(p);
    if (from && dateStr < from) return false;
    if (to   && dateStr > to  ) return false;
    return true;
  });

  renderTable(filtered);
  renderStats(filtered);
}

function renderTable(payments) {
  if (payments.length === 0) {
    paymentsTable.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:1.5rem;color:#888;">אין תשלומים להצגה</td></tr>';
    paymentsCount.textContent = "";
    return;
  }

  paymentsTable.innerHTML = payments.map(function (p) {
    var donorLink = p.donorId
      ? '<a href="donor.html?id=' + p.donorId + '">' + escapeHTML(p.donorName || "—") + '</a>'
      : escapeHTML(p.donorName || "לא ידוע");

    return "<tr>" +
      "<td>" + escapeHTML(formatDateTime(p.timestamp || p.createdAt)) + "</td>" +
      "<td>" + donorLink + "</td>" +
      "<td>" + escapeHTML(p.phone || "—") + "</td>" +
      "<td style='font-weight:600'>" + formatMoney(p.amount) + "</td>" +
      "<td>" + escapeHTML(p.confirmationNumber || "—") + "</td>" +
      "<td>" + escapeHTML(p.source || "ivr") + "</td>" +
      "<td style='font-size:.8em;color:#666;direction:ltr;text-align:left'>" + escapeHTML(p.callId || "—") + "</td>" +
      "<td>" + statusBadge(p.status) + "</td>" +
      "</tr>";
  }).join("");

  paymentsCount.textContent = "מוצגים " + payments.length + " תשלומים";
}

function renderStats(payments) {
  var today   = todayIsrael();
  var total   = payments.length;
  var amount  = payments.reduce(function (s, p) { return s + Number(p.amount || 0); }, 0);
  var todayRows  = payments.filter(function (p) { return getDateStr(p) === today; });
  var todayAmt   = todayRows.reduce(function (s, p) { return s + Number(p.amount || 0); }, 0);

  statTotal.textContent      = total;
  statAmount.textContent     = formatMoney(amount);
  statTodayCount.textContent = todayRows.length;
  statTodayAmount.textContent = formatMoney(todayAmt);
}

function clearFilters() {
  searchInput.value = "";
  dateFrom.value    = "";
  dateTo.value      = "";
  applyFilters();
}

async function loadPayments() {
  loadingMsg.style.display = "block";
  errorMsg.style.display   = "none";
  paymentsTable.innerHTML  = "";
  paymentsCount.textContent = "";

  try {
    var res = await apiFetch("/api/payments");
    if (!res.ok) {
      throw new Error("שגיאת שרת " + res.status);
    }
    allPayments = await res.json();
    applyFilters();
  } catch (err) {
    errorMsg.textContent   = "שגיאה בטעינת תשלומים: " + (err.message || err);
    errorMsg.style.display = "block";
  } finally {
    loadingMsg.style.display = "none";
  }
}

searchInput.addEventListener("input",  applyFilters);
dateFrom.addEventListener("change",    applyFilters);
dateTo.addEventListener("change",      applyFilters);

loadPayments();

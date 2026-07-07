// ── State ─────────────────────────────────────────────────────────────────────
var allPayments  = [];
var sortCol      = "timestamp";
var sortDir      = -1;   // -1 = desc, 1 = asc
var currentPage  = 0;
var pageSize     = 100;
var quickFilter  = "all";
var _currentReceipt = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
var searchInput     = document.getElementById("searchInput");
var dateFrom        = document.getElementById("dateFrom");
var dateTo          = document.getElementById("dateTo");
var tableBody       = document.getElementById("paymentsTableBody");
var paginationBar   = document.getElementById("paginationBar");
var rowCountInfo    = document.getElementById("rowCountInfo");
var statTotal       = document.getElementById("statTotal");
var statAmount      = document.getElementById("statAmount");
var statTodayCount  = document.getElementById("statTodayCount");
var statTodayAmount = document.getElementById("statTodayAmount");
var loadingMsg      = document.getElementById("loadingMsg");
var errorMsg        = document.getElementById("errorMsg");

// ── Utilities ─────────────────────────────────────────────────────────────────
function todayIsrael() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date());
}

function isoToDate(iso) {
  return (iso || "").slice(0, 10);
}

function formatDateTime(iso) {
  if (!iso) return "—";
  var d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("he-IL", { timeZone: "Asia/Jerusalem", hour12: false });
}

function statusBadge(status) {
  if (status === "success")  return '<span class="badge badge-ok">🟢 הצליח</span>';
  if (status === "failed" || status === "error")
                             return '<span class="badge badge-err">🔴 נכשל</span>';
  if (status === "duplicate") return '<span class="badge badge-dup">🟡 כפול</span>';
  return '<span class="badge badge-def">' + escapeHTML(status) + '</span>';
}

function shortCallId(callId) {
  if (!callId) return "—";
  var short = callId.length > 10 ? callId.slice(0, 10) + "…" : callId;
  return '<span class="callid-cell">' +
    '<button class="copy-btn" title="העתק Call ID" onclick="copyCallId(\'' +
      escapeHTML(callId) + '\')" >📋</button>' +
    '<span class="callid-short" title="' + escapeHTML(callId) + '">' + escapeHTML(short) + '</span>' +
    '</span>';
}

function copyCallId(id) {
  navigator.clipboard.writeText(id).then(function () {
    if (typeof showToast === "function") showToast("Call ID הועתק");
  }).catch(function () {
    prompt("Call ID:", id);
  });
}

// ── Quick date filters ────────────────────────────────────────────────────────
function setQuickFilter(period) {
  quickFilter = period;
  var today   = todayIsrael();

  document.querySelectorAll("#quickFilters button").forEach(function (b) {
    b.classList.remove("active");
  });
  var activeBtn = document.querySelector("#quickFilters button[onclick*='" + period + "']");
  if (activeBtn) activeBtn.classList.add("active");

  if (period === "today") {
    dateFrom.value = today; dateTo.value = today;
  } else if (period === "week") {
    var d = new Date();
    var dow = d.getDay(); var daysBack = dow === 0 ? 6 : dow - 1;
    d.setDate(d.getDate() - daysBack);
    dateFrom.value = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(d);
    dateTo.value   = today;
  } else if (period === "month") {
    dateFrom.value = today.slice(0, 7) + "-01"; dateTo.value = today;
  } else if (period === "year") {
    dateFrom.value = today.slice(0, 4) + "-01-01"; dateTo.value = today;
  } else {
    dateFrom.value = ""; dateTo.value = "";
  }
  currentPage = 0;
  applyAll();
}

function clearFilters() {
  searchInput.value = "";
  dateFrom.value    = "";
  dateTo.value      = "";
  quickFilter       = "all";
  currentPage       = 0;
  document.querySelectorAll("#quickFilters button").forEach(function (b) { b.classList.remove("active"); });
  var allBtn = document.querySelector("#quickFilters button[onclick*='all']");
  if (allBtn) allBtn.classList.add("active");
  applyAll();
}

// ── Sorting ───────────────────────────────────────────────────────────────────
function sortBy(col) {
  if (sortCol === col) {
    sortDir = -sortDir;
  } else {
    sortCol = col;
    sortDir = col === "timestamp" || col === "amount" ? -1 : 1;
  }
  currentPage = 0;
  updateSortIcons();
  applyAll();
}

function updateSortIcons() {
  ["timestamp", "donorName", "amount", "confirmationNumber"].forEach(function (c) {
    var el = document.getElementById("si-" + c);
    if (!el) return;
    el.textContent = c === sortCol ? (sortDir === 1 ? "▲" : "▼") : "⇅";
  });
}

function doSort(arr) {
  return arr.slice().sort(function (a, b) {
    var av = a[sortCol] || "";
    var bv = b[sortCol] || "";
    if (sortCol === "amount") { av = Number(av) || 0; bv = Number(bv) || 0; }
    if (av < bv) return -sortDir;
    if (av > bv) return  sortDir;
    return 0;
  });
}

// ── Filtering ─────────────────────────────────────────────────────────────────
function doFilter() {
  var q    = (searchInput.value || "").trim().toLowerCase();
  var from = dateFrom.value || "";
  var to   = dateTo.value   || "";

  return allPayments.filter(function (p) {
    if (q) {
      var name    = (p.donorName          || "").toLowerCase();
      var phone   = (p.phone              || "").toLowerCase();
      var cid     = (p.callId             || "").toLowerCase();
      var confirm = (p.confirmationNumber || "").toLowerCase();
      var amt     = String(p.amount       || "");
      if (!name.includes(q) && !phone.includes(q) && !cid.includes(q) &&
          !confirm.includes(q) && !amt.includes(q)) return false;
    }
    var d = isoToDate(p.timestamp || p.createdAt);
    if (from && d < from) return false;
    if (to   && d > to  ) return false;
    return true;
  });
}

// ── Pagination ────────────────────────────────────────────────────────────────
function changePageSize(val) {
  pageSize    = Number(val);
  currentPage = 0;
  applyAll();
}

function renderPagination(total) {
  var totalPages = Math.ceil(total / pageSize);
  if (totalPages <= 1) { paginationBar.innerHTML = ""; return; }

  var html = "";
  html += '<button ' + (currentPage === 0 ? "disabled" : 'onclick="goPage(' + (currentPage - 1) + ')"') +
          '>‹ הקודם</button>';

  var start = Math.max(0, currentPage - 2);
  var end   = Math.min(totalPages - 1, currentPage + 2);
  for (var i = start; i <= end; i++) {
    html += '<button class="' + (i === currentPage ? "active" : "") +
            '" onclick="goPage(' + i + ')">' + (i + 1) + '</button>';
  }

  html += '<button ' + (currentPage >= totalPages - 1 ? "disabled" : 'onclick="goPage(' + (currentPage + 1) + ')"') +
          '>הבא ›</button>';
  paginationBar.innerHTML = html;
}

function goPage(n) {
  currentPage = n;
  applyAll();
}

// ── Render ────────────────────────────────────────────────────────────────────
function applyAll() {
  var filtered = doFilter();
  var sorted   = doSort(filtered);
  var start    = currentPage * pageSize;
  var pageRows = sorted.slice(start, start + pageSize);

  renderStats(filtered);
  renderTable(pageRows);
  renderPagination(filtered.length);

  rowCountInfo.textContent = "מוצגים " + pageRows.length + " מתוך " + filtered.length + " תשלומים";
}

function renderStats(payments) {
  var today      = todayIsrael();
  var total      = payments.length;
  var amount     = payments.reduce(function (s, p) { return s + Number(p.amount || 0); }, 0);
  var todayRows  = payments.filter(function (p) { return isoToDate(p.timestamp || p.createdAt) === today; });
  var todayAmt   = todayRows.reduce(function (s, p) { return s + Number(p.amount || 0); }, 0);

  statTotal.textContent       = total;
  statAmount.textContent      = formatMoney(amount);
  statTodayCount.textContent  = todayRows.length;
  statTodayAmount.textContent = formatMoney(todayAmt);
}

function renderTable(rows) {
  if (rows.length === 0) {
    tableBody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:1.5rem;color:#888;">אין תשלומים להצגה</td></tr>';
    return;
  }

  tableBody.innerHTML = rows.map(function (p) {
    var donorCell = p.donorId
      ? '<a href="donor.html?id=' + p.donorId + '">' + escapeHTML(p.donorName || "—") + '</a>'
      : escapeHTML(p.donorName || "לא ידוע");

    return "<tr>" +
      "<td style='white-space:nowrap'>" + escapeHTML(formatDateTime(p.timestamp || p.createdAt)) + "</td>" +
      "<td>" + donorCell + "</td>" +
      "<td style='direction:ltr;text-align:left'>" + escapeHTML(p.phone || "—") + "</td>" +
      "<td style='font-weight:600;white-space:nowrap'>" + formatMoney(p.amount) + "</td>" +
      "<td>" + escapeHTML(p.confirmationNumber || "—") + "</td>" +
      "<td>" + escapeHTML(p.source || "ivr") + "</td>" +
      "<td>" + shortCallId(p.callId) + "</td>" +
      "<td>" + statusBadge(p.status) + "</td>" +
      "<td style='white-space:nowrap'>" +
        "<button class='copy-btn' onclick='showReceipt(" + JSON.stringify(p).replace(/'/g, "\\'") + ")' title='קבלה'>🧾</button> " +
        "<button class='copy-btn' onclick='showIvrFlow(\"" + escapeHTML(p.callId || "") + "\")' title='רצף IVR'>📡</button>" +
      "</td>" +
      "</tr>";
  }).join("");
}

// ── Receipt ───────────────────────────────────────────────────────────────────
function showReceipt(p) {
  _currentReceipt = p;
  var body = document.getElementById("receiptBody");
  body.innerHTML =
    '<div class="receipt-amount">' + formatMoney(p.amount) + '</div>' +
    '<div class="receipt-row"><span class="receipt-label">שם:</span><span>' + escapeHTML(p.donorName || "לא ידוע") + '</span></div>' +
    '<div class="receipt-row"><span class="receipt-label">טלפון:</span><span>' + escapeHTML(p.phone || "—") + '</span></div>' +
    '<div class="receipt-row"><span class="receipt-label">תאריך:</span><span>' + escapeHTML(formatDateTime(p.timestamp || p.createdAt)) + '</span></div>' +
    '<div class="receipt-row"><span class="receipt-label">מספר אישור:</span><span>' + escapeHTML(p.confirmationNumber || "—") + '</span></div>' +
    '<div class="receipt-row"><span class="receipt-label">מקור:</span><span>IVR</span></div>' +
    '<div class="receipt-row"><span class="receipt-label">Call ID:</span><span style="direction:ltr;unicode-bidi:embed">' + escapeHTML(p.callId || "—") + '</span></div>' +
    '<div class="receipt-row"><span class="receipt-label">סטטוס:</span>' + statusBadge(p.status) + '</div>';
  document.getElementById("receiptModal").classList.add("open");
}

function printReceipt() {
  var p = _currentReceipt;
  if (!p) return;
  var w = window.open("", "_blank", "width=600,height=700");
  w.document.write("<!DOCTYPE html><html dir='rtl' lang='he'><head><meta charset='UTF-8'>" +
    "<title>קבלה</title><style>" +
    "body{font-family:Arial,sans-serif;padding:40px;direction:rtl;color:#000}" +
    ".hdr{text-align:center;border-bottom:2px solid #333;padding-bottom:16px;margin-bottom:20px}" +
    ".row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #eee}" +
    ".lbl{font-weight:bold;color:#444}.amt{font-size:1.6em;font-weight:700;color:#1a6e1a;text-align:center;margin:18px 0}" +
    ".ftr{text-align:center;margin-top:26px;font-size:.82em;color:#888}" +
    "</style></head><body>" +
    "<div class='hdr'><h2 style='margin:0'>קבלה על תשלום IVR</h2><p style='margin:4px 0 0'>א בלאט גמרא</p></div>" +
    "<div class='amt'>" + formatMoney(p.amount) + "</div>" +
    "<div class='row'><span class='lbl'>שם:</span><span>" + escapeHTML(p.donorName || "לא ידוע") + "</span></div>" +
    "<div class='row'><span class='lbl'>טלפון:</span><span>" + escapeHTML(p.phone || "—") + "</span></div>" +
    "<div class='row'><span class='lbl'>תאריך:</span><span>" + escapeHTML(formatDateTime(p.timestamp || p.createdAt)) + "</span></div>" +
    "<div class='row'><span class='lbl'>מספר אישור:</span><span>" + escapeHTML(p.confirmationNumber || "—") + "</span></div>" +
    "<div class='row'><span class='lbl'>מקור:</span><span>IVR</span></div>" +
    "<div class='row'><span class='lbl'>Call ID:</span><span style='direction:ltr'>" + escapeHTML(p.callId || "—") + "</span></div>" +
    "<div class='ftr'>נוצר אוטומטית &bull; " + new Date().toLocaleDateString("he-IL") + "</div>" +
    "<script>window.onload=function(){window.print();window.close();}<\/script>" +
    "</body></html>");
  w.document.close();
}

// ── IVR flow ──────────────────────────────────────────────────────────────────
var STEP_LABELS = {
  call_start:             { icon: "📞", label: "שיחה נכנסה" },
  donor_identified:       { icon: "👤", label: "תורם זוהה" },
  unknown_caller:         { icon: "❓", label: "מתקשר לא מזוהה" },
  menu_selection:         { icon: "📋", label: "בחר תפריט" },
  payment_submenu:        { icon: "💳", label: "תפריט תשלום" },
  debt_submenu:           { icon: "📊", label: "תפריט חובות" },
  amount_entered:         { icon: "🔢", label: "הוזן סכום" },
  payment_success:        { icon: "✅", label: "תשלום הצליח" },
  payment_failed:         { icon: "❌", label: "תשלום נכשל" },
  voice_message_received: { icon: "🎤", label: "הודעה קולית" },
  call_end:               { icon: "📴", label: "שיחה הסתיימה" },
  hangup:                 { icon: "📴", label: "ניתוק" },
  error:                  { icon: "⚠️", label: "שגיאה" },
};

async function showIvrFlow(callId) {
  if (!callId) { alert("אין Call ID לשיחה זו"); return; }
  var body = document.getElementById("flowBody");
  body.innerHTML = "<p style='color:#888'>טוען...</p>";
  document.getElementById("flowModal").classList.add("open");

  try {
    var res = await apiFetch("/api/ivr/sessions/" + encodeURIComponent(callId) + "/logs");
    if (!res.ok) throw new Error("שגיאת שרת " + res.status);
    var logs = await res.json();

    if (!logs || logs.length === 0) {
      body.innerHTML = "<p style='color:#888;text-align:center'>אין רצף IVR שמור לשיחה זו</p>" +
                       "<p style='color:#aaa;text-align:center;font-size:.85em'>Call ID: " + escapeHTML(callId) + "</p>";
      return;
    }

    var html = "";
    logs.forEach(function (log, i) {
      var info  = STEP_LABELS[log.step] || { icon: "•", label: log.step };
      var payload = "";
      try {
        var parsed = typeof log.payload === "string" ? JSON.parse(log.payload) : log.payload;
        if (parsed) {
          var keys = Object.keys(parsed).filter(function(k){ return k !== "donorId"; });
          payload = keys.map(function(k){ return k + ": " + JSON.stringify(parsed[k]); }).join(" · ");
        }
      } catch (_) { payload = String(log.payload || ""); }

      if (i > 0) html += '<div class="flow-line"></div>';
      html += '<div class="flow-step">' +
        '<div class="flow-dot">' + info.icon + '</div>' +
        '<div class="flow-content">' +
          '<div class="flow-step-name">' + escapeHTML(info.label) + '</div>' +
          (payload ? '<div class="flow-step-payload">' + escapeHTML(payload) + '</div>' : '') +
          '<div class="flow-step-time">' + escapeHTML(formatDateTime(log.createdAt)) + '</div>' +
        '</div></div>';
    });
    body.innerHTML = html;
  } catch (err) {
    body.innerHTML = "<p style='color:#c00'>שגיאה: " + escapeHTML(err.message) + "</p>";
  }
}

// ── Modal helpers ─────────────────────────────────────────────────────────────
function closeModal(id) {
  document.getElementById(id).classList.remove("open");
}
document.addEventListener("click", function (e) {
  ["receiptModal", "flowModal"].forEach(function (id) {
    var el = document.getElementById(id);
    if (el && e.target === el) el.classList.remove("open");
  });
});

// ── CSV export ────────────────────────────────────────────────────────────────
function exportCSV() {
  var rows    = doSort(doFilter());
  var headers = ["תאריך ושעה", "שם תורם", "טלפון", "סכום", "מספר אישור", "מקור", "Call ID", "סטטוס"];
  var lines   = [headers.join(",")];
  rows.forEach(function (p) {
    lines.push([
      '"' + escapeHTML(formatDateTime(p.timestamp || p.createdAt)) + '"',
      '"' + escapeHTML(p.donorName || "") + '"',
      '"' + escapeHTML(p.phone || "") + '"',
      Number(p.amount || 0).toFixed(2),
      '"' + escapeHTML(p.confirmationNumber || "") + '"',
      '"' + escapeHTML(p.source || "ivr") + '"',
      '"' + escapeHTML(p.callId || "") + '"',
      '"' + escapeHTML(p.status || "") + '"',
    ].join(","));
  });
  var blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  var url  = URL.createObjectURL(blob);
  var a    = document.createElement("a");
  a.href   = url;
  a.download = "תשלומי-IVR-" + todayIsrael() + ".csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Load from server ──────────────────────────────────────────────────────────
async function loadPayments() {
  loadingMsg.style.display = "block";
  errorMsg.style.display   = "none";
  tableBody.innerHTML      = "";
  paginationBar.innerHTML  = "";
  rowCountInfo.textContent = "";

  try {
    var res = await apiFetch("/api/payments?limit=2000");
    if (!res.ok) throw new Error("שגיאת שרת " + res.status);
    allPayments = await res.json();
    currentPage = 0;
    updateSortIcons();
    applyAll();
  } catch (err) {
    errorMsg.textContent   = "שגיאה בטעינת תשלומים: " + (err.message || err);
    errorMsg.style.display = "block";
  } finally {
    loadingMsg.style.display = "none";
  }
}

searchInput.addEventListener("input",  function () { currentPage = 0; applyAll(); });
dateFrom.addEventListener("change",    function () { currentPage = 0; applyAll(); });
dateTo.addEventListener("change",      function () { currentPage = 0; applyAll(); });

loadPayments();

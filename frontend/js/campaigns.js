/* global apiFetch, Database, showToast, escapeHTML */

// ── Radio card visual selection ──────────────────────────────────────────────

document.querySelectorAll(".radio-cards").forEach(function (group) {
  group.addEventListener("change", function (e) {
    if (e.target.type !== "radio") return;
    group.querySelectorAll(".radio-card").forEach(function (card) {
      card.classList.toggle("checked", card.querySelector("input") === e.target);
    });
  });
});

// ── Message type toggle ───────────────────────────────────────────────────────

document.querySelectorAll("input[name=msgType]").forEach(function (r) {
  r.addEventListener("change", function () {
    var textGroup = document.getElementById("textMsgGroup");
    if (textGroup) textGroup.style.display = r.value === "text" ? "" : "none";
  });
});

// ── Schedule toggle ───────────────────────────────────────────────────────────

document.querySelectorAll("input[name=sendWhen]").forEach(function (r) {
  r.addEventListener("change", function () {
    var sg = document.getElementById("scheduleGroup");
    if (sg) sg.style.display = r.value === "scheduled" ? "" : "none";
  });
});

// ── Recipient filter + counts ─────────────────────────────────────────────────

var filterOptions = { cities: [], years: [] };

async function loadFilterOptions() {
  try {
    var res  = await apiFetch("/api/technoline/campaign/filter-options");
    var data = await res.json();
    filterOptions = data;

    var citySelect = document.getElementById("citySelect");
    var yearSelect = document.getElementById("yearSelect");

    if (data.cities && data.cities.length > 0) {
      data.cities.forEach(function (c) {
        var o = document.createElement("option");
        o.value = c; o.textContent = c;
        citySelect.appendChild(o);
      });
      document.getElementById("cityCard").style.display = "";
    }

    if (data.years && data.years.length > 0) {
      data.years.forEach(function (y) {
        var o = document.createElement("option");
        o.value = y; o.textContent = y;
        yearSelect.appendChild(o);
      });
      document.getElementById("yearCard").style.display = "";
    }
  } catch (_) {}

  updateRecipientCount();
}

async function fetchCount(filter) {
  try {
    var res  = await apiFetch("/api/technoline/campaign/recipient-count?filter=" + encodeURIComponent(filter));
    var data = await res.json();
    return data.count || 0;
  } catch (_) { return 0; }
}

async function updateRecipientCount() {
  var allCount = await fetchCount("all");
  var allNote  = document.getElementById("countAll");
  if (allNote) allNote.textContent = allCount + " מספרי טלפון";
  refreshTotalCount();
}

async function refreshTotalCount() {
  var selected = getSelectedRecipient();
  var filter   = buildFilter(selected);
  var count    = await fetchCount(filter);

  var totalEl   = document.getElementById("totalCount");
  var summaryEl = document.getElementById("totalCountSummary");
  if (totalEl)   totalEl.textContent   = count;
  if (summaryEl) summaryEl.textContent = count > 0 ? "(" + count + " מספרי טלפון)" : "(אין מספרים תואמים)";
}

function getSelectedRecipient() {
  var checked = document.querySelector("input[name=recipient]:checked");
  return checked ? checked.value : "all";
}

function buildFilter(selected) {
  if (selected === "city") {
    var v = (document.getElementById("citySelect") || {}).value || "";
    return v ? "city:" + v : "all";
  }
  if (selected === "year") {
    var v2 = (document.getElementById("yearSelect") || {}).value || "";
    return v2 ? "year:" + v2 : "all";
  }
  return "all";
}

// Update counts when recipient card changes
document.querySelectorAll("input[name=recipient]").forEach(function (r) {
  r.addEventListener("change", refreshTotalCount);
});

var citySelect = document.getElementById("citySelect");
var yearSelect = document.getElementById("yearSelect");

if (citySelect) citySelect.addEventListener("change", async function () {
  var count = await fetchCount("city:" + this.value);
  var el    = document.getElementById("countCity");
  if (el) { el.textContent = count + " מספרים"; el.style.display = count > 0 ? "" : "none"; }
  refreshTotalCount();
});

if (yearSelect) yearSelect.addEventListener("change", async function () {
  var count = await fetchCount("year:" + this.value);
  var el    = document.getElementById("countYear");
  if (el) { el.textContent = count + " מספרים"; el.style.display = count > 0 ? "" : "none"; }
  refreshTotalCount();
});

// ── Send ──────────────────────────────────────────────────────────────────────

function showSendStatus(text, type) {
  var el = document.getElementById("sendStatus");
  if (!el) return;
  el.innerText = text;
  el.className = "message show " + (type || "success");
  if (type !== "error") setTimeout(function () { el.className = "message"; el.innerText = ""; }, 7000);
}

document.getElementById("sendButton").addEventListener("click", async function () {
  var btn = this;

  var selectedRecipient = getSelectedRecipient();
  var recipientFilter   = buildFilter(selectedRecipient);
  var msgType           = (document.querySelector("input[name=msgType]:checked") || {}).value || "ivr";
  var messageText       = (document.getElementById("messageText") || {}).value || "";
  var sendWhen          = (document.querySelector("input[name=sendWhen]:checked") || {}).value || "now";
  var quietHours        = !!(document.getElementById("quietHours") || {}).checked;

  // Validate
  if (msgType === "text" && !messageText.trim()) {
    showSendStatus("יש להזין טקסט להודעה", "error");
    return;
  }
  if (sendWhen === "scheduled") {
    var dtEl = document.getElementById("sendTimeInput");
    if (!dtEl || !dtEl.value) {
      showSendStatus("יש לבחור תאריך ושעה לשיגור", "error");
      return;
    }
  }

  var totalCount = Number((document.getElementById("totalCount") || {}).textContent) || 0;
  if (totalCount === 0) {
    showSendStatus("אין מספרי טלפון תואמים לשיגור", "error");
    return;
  }

  if (!confirm("לשלוח הודעה ל-" + totalCount + " מספרים?")) return;

  btn.disabled    = true;
  btn.textContent = "שולח...";

  try {
    var payload = {
      recipientFilter: recipientFilter,
      messageKind:     msgType,
      messageText:     messageText,
      quietHours:      quietHours,
    };

    if (sendWhen === "scheduled") {
      var d   = new Date(document.getElementById("sendTimeInput").value);
      var pad = function (n) { return String(n).padStart(2, "0"); };
      payload.sendTime =
        (d.getFullYear() % 100) + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
        " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":00";
    }

    var res  = await apiFetch("/api/technoline/campaign/run", { method: "POST", body: JSON.stringify(payload) });
    var data = await res.json();

    if (!res.ok) {
      showSendStatus(data.error || "שגיאה בשיגור ההודעות", "error");
      return;
    }

    var summary = "ההודעות נשלחו ל-" + (data.phones || totalCount) + " מספרים";
    if (data.blockedPhones) summary += " | " + data.blockedPhones + " חסומים";
    if (data.errorPhones)   summary += " | " + data.errorPhones + " שגיאות פורמט";

    showSendStatus("✅ " + summary, "success");
    showToast("שיגור הופעל בהצלחה!");
    loadHistory();
  } catch (_) {
    showSendStatus("שגיאת תקשורת עם השרת", "error");
  } finally {
    btn.disabled    = false;
    btn.textContent = "📣 שלח הודעה";
  }
});

// ── History ───────────────────────────────────────────────────────────────────

function statusLabel(s) {
  var map = {
    active:  '<span class="campaign-status-active">🟢 פעיל</span>',
    hold:    '<span class="campaign-status-hold">⏸ מושהה</span>',
    ended:   '<span class="campaign-status-ended">✔ הסתיים</span>',
    stoped:  '<span class="campaign-status-stopped">⏹ הופסק</span>',
    stopped: '<span class="campaign-status-stopped">⏹ הופסק</span>',
  };
  return map[(s || "").toLowerCase()] || escapeHTML(s || "—");
}

async function loadHistory() {
  var tbody = document.getElementById("historyTableBody");
  var msgEl = document.getElementById("historyMessage");
  if (!tbody) return;

  tbody.innerHTML = "<tr><td colspan='7' style='color:#888;padding:.8rem;'>טוען...</td></tr>";

  try {
    var res  = await apiFetch("/api/technoline/campaign/history");
    var data = await res.json();

    if (!res.ok) {
      if (msgEl) { msgEl.innerText = data.error || "שגיאה בטעינה"; msgEl.className = "message show error"; }
      tbody.innerHTML = "";
      return;
    }

    var campaigns = Array.isArray(data) ? data : (data.campaigns || data.history || []);
    if (campaigns.length === 0) {
      tbody.innerHTML = "<tr><td colspan='7' style='color:#888;text-align:center;padding:.8rem;'>לא נמצאו שיגורים</td></tr>";
      return;
    }

    tbody.innerHTML = campaigns.map(function (c) {
      var startStr = c.start_time
        ? new Date(c.start_time.replace(" ", "T")).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem", hour12: false })
        : "—";
      return "<tr>" +
        "<td style='font-weight:600;color:#888;font-size:.85em'>#" + escapeHTML(String(c.id || "")) + "</td>" +
        "<td>" + escapeHTML(c.title || "ללא שם") + "</td>" +
        "<td>" + statusLabel(c.active) + "</td>" +
        "<td>" + escapeHTML(String(c.total_sent   || "—")) + "</td>" +
        "<td>" + escapeHTML(String(c.answerd_calls || "—")) + "</td>" +
        "<td style='white-space:nowrap;font-size:.85em'>" + escapeHTML(startStr) + "</td>" +
        "<td style='white-space:nowrap'>" + buildActions(c) + "</td>" +
        "</tr>";
    }).join("");
  } catch (_) {
    tbody.innerHTML = "<tr><td colspan='7' style='color:#b00;padding:.8rem;'>שגיאת תקשורת</td></tr>";
  }
}

function buildActions(c) {
  var id   = c.id;
  var btns = [];
  btns.push("<button onclick='showReport(" + id + ")' style='font-size:.78em;padding:3px 9px;border:1px solid #1565c0;border-radius:4px;background:#e8f0fe;color:#1565c0;cursor:pointer;margin-left:4px'>פרטים</button>");
  if (c.active === "active") {
    btns.push("<button onclick='doAction(" + id + ",\"hold\")' style='font-size:.78em;padding:3px 9px;border:1px solid #b07000;border-radius:4px;background:#fff8e1;color:#b07000;cursor:pointer;margin-left:4px'>⏸ השהה</button>");
    btns.push("<button onclick='doAction(" + id + ",\"stop\")' style='font-size:.78em;padding:3px 9px;border:1px solid #b00;border-radius:4px;background:#fff0f0;color:#b00;cursor:pointer'>⏹ עצור</button>");
  } else if (c.active === "hold") {
    btns.push("<button onclick='doAction(" + id + ",\"resume\")' style='font-size:.78em;padding:3px 9px;border:1px solid #1a7a1a;border-radius:4px;background:#e8f5e9;color:#1a7a1a;cursor:pointer;margin-left:4px'>▶ המשך</button>");
    btns.push("<button onclick='doAction(" + id + ",\"stop\")' style='font-size:.78em;padding:3px 9px;border:1px solid #b00;border-radius:4px;background:#fff0f0;color:#b00;cursor:pointer'>⏹ עצור</button>");
  }
  return btns.join("");
}

async function doAction(id, action) {
  var labels = { hold: "להשהות", resume: "להמשיך", stop: "לעצור סופית" };
  if (!confirm("האם לבצע: " + (labels[action] || action) + " שיגור #" + id + "?")) return;
  try {
    var res  = await apiFetch("/api/technoline/campaign/" + id + "/" + action, { method: "POST" });
    var data = await res.json();
    if (data.errorCode === 0 || String(data.status || "").toUpperCase() === "OK") {
      showToast("הפעולה בוצעה");
      loadHistory();
    } else {
      showToast("שגיאה: " + (data.note || data.error || ""));
    }
  } catch (_) { showToast("שגיאת תקשורת"); }
}

// ── Report ────────────────────────────────────────────────────────────────────

async function showReport(id) {
  var modal = document.getElementById("reportModal");
  var title = document.getElementById("reportTitle");
  var sumEl = document.getElementById("reportSummary");
  var tbody = document.getElementById("reportTableBody");
  if (!modal) return;

  title.textContent   = "טוען דוח שיגור #" + id + "...";
  sumEl.innerHTML     = "";
  tbody.innerHTML     = "<tr><td colspan='5' style='color:#888;padding:.8rem;'>טוען...</td></tr>";
  modal.style.display = "flex";

  try {
    var res  = await apiFetch("/api/technoline/campaign/" + id + "/report");
    var data = await res.json();
    var c    = data.campaign || data;

    title.textContent = "שיגור #" + id + (c.title ? " — " + c.title : "");

    sumEl.innerHTML = [
      c.status       ? "<p><strong>סטטוס:</strong> "    + escapeHTML(c.status)              + "</p>" : "",
      c.recipients   ? "<p><strong>נמענים:</strong> "   + escapeHTML(String(c.recipients))  + "</p>" : "",
      c.answeredCalls? "<p><strong>נענו:</strong> "     + escapeHTML(String(c.answeredCalls))+ "</p>" : "",
      c.billing      ? "<p><strong>עלות:</strong> "     + escapeHTML(String(c.billing))     + "</p>" : "",
    ].join("");

    var rows = data.calls || data.recipients || [];
    if (rows.length === 0) {
      tbody.innerHTML = "<tr><td colspan='5' style='color:#888;text-align:center;padding:.8rem;'>אין נתוני שיחות</td></tr>";
      return;
    }
    tbody.innerHTML = rows.map(function (r) {
      var ok = r.status === "answered";
      return "<tr>" +
        "<td dir='ltr'>" + escapeHTML(r.phone || "—") + "</td>" +
        "<td>" + escapeHTML(r.name  || "—") + "</td>" +
        "<td style='color:" + (ok ? "#1a7a1a" : "#888") + ";font-weight:600'>" + escapeHTML(r.status || "—") + "</td>" +
        "<td>" + escapeHTML(r.duration || "—") + "</td>" +
        "<td>" + escapeHTML(r.digits   || "—") + "</td>" +
        "</tr>";
    }).join("");
  } catch (_) {
    title.textContent = "שגיאה בטעינת הדוח";
    tbody.innerHTML   = "";
  }
}

document.getElementById("reportModal").addEventListener("click", function (e) {
  if (e.target === this) this.style.display = "none";
});

// ── Init ──────────────────────────────────────────────────────────────────────

document.getElementById("loadHistoryButton").addEventListener("click", loadHistory);

loadFilterOptions();
loadHistory();

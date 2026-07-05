/* global apiFetch, Database, showToast, escapeHTML */

// ── Helpers ───────────────────────────────────────────────────────────────────

function showLaunchMsg(text, type) {
  var el = document.getElementById("campaignLaunchMessage");
  if (!el) return;
  el.innerText = text;
  el.className = "message show " + (type || "success");
  if (type !== "error") setTimeout(function () { el.className = "message"; el.innerText = ""; }, 6000);
}

function showHistoryMsg(text, type) {
  var el = document.getElementById("historyMessage");
  if (!el) return;
  el.innerText = text;
  el.className = "message show " + (type || "");
  setTimeout(function () { el.className = "message"; el.innerText = ""; }, 5000);
}

function statusLabel(s) {
  switch ((s || "").toLowerCase()) {
    case "active":  return '<span style="color:#1a7a1a;font-weight:600">🟢 פעיל</span>';
    case "hold":    return '<span style="color:#b07000;font-weight:600">⏸ מושהה</span>';
    case "ended":   return '<span style="color:#555">✔ הסתיים</span>';
    case "stoped":
    case "stopped": return '<span style="color:#b00">⏹ הופסק</span>';
    default:        return escapeHTML(s || "—");
  }
}

// ── Message type toggle ───────────────────────────────────────────────────────

var typeSelect = document.getElementById("campaignMessagesType");
function updateTypeGroups() {
  var v = typeSelect ? typeSelect.value : "audioText";
  document.getElementById("audioTextGroup").style.display    = v === "audioText"          ? "" : "none";
  document.getElementById("extensionGroup").style.display   = v === "extensionActivation" ? "" : "none";
  document.getElementById("apiUrlGroup").style.display      = v === "apiUrl"              ? "" : "none";
}
if (typeSelect) typeSelect.addEventListener("change", updateTypeGroups);
updateTypeGroups();

// ── Approved phones count ─────────────────────────────────────────────────────

function updateApprovedCount() {
  var note = document.getElementById("approvedCountNote");
  if (!note) return;
  var donors = Database.get("donors") || [];
  var total = 0;
  donors.forEach(function (d) { total += (d.ivrApprovedPhones || []).length; });
  note.textContent = total > 0
    ? total + " מספרי טלפון מאושרי IVR יקבלו את השיחה (ניתן לשנות ברמת כרטיס תורם)"
    : "⚠️ אין מספרי טלפון מאושרים ל-IVR. יש לאשר מספרים בכרטיס התורם תחילה.";
}
Database.whenReady(function () { updateApprovedCount(); });

// ── Launch campaign ───────────────────────────────────────────────────────────

async function launchCampaign(demo) {
  var btn = document.getElementById(demo ? "demoLaunchButton" : "launchCampaignButton");
  if (btn) { btn.disabled = true; btn.textContent = demo ? "בודק..." : "משגר..."; }

  try {
    var msgType = (typeSelect ? typeSelect.value : "audioText");
    var payload = {
      title:          (document.getElementById("campaignTitle")           || {}).value || "",
      messagesType:   msgType,
      audioText:      (document.getElementById("campaignAudioText")       || {}).value || "",
      extension:      (document.getElementById("campaignExtension")       || {}).value || "",
      apiUrl:         (document.getElementById("campaignApiUrl")          || {}).value || "",
      callLength:     Number((document.getElementById("campaignCallLength")    || {}).value) || 25,
      dialRetries:    Number((document.getElementById("campaignDialRetries")   || {}).value) || 1,
      betweenRetries: Number((document.getElementById("campaignBetweenRetries")|| {}).value) || 20,
      reasonableHours: !!(document.getElementById("campaignReasonableHours")  || {}).checked,
    };
    var sendTimeEl = document.getElementById("campaignSendTime");
    if (sendTimeEl && sendTimeEl.value) {
      // Convert datetime-local (yyyy-MM-ddThh:mm) to API format (yy-mm-dd hh:mm:ss)
      var d = new Date(sendTimeEl.value);
      var pad = function (n) { return String(n).padStart(2, "0"); };
      payload.sendTime = (d.getFullYear() % 100) + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
                         " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":00";
    }
    if (demo) payload.demo = "yes";

    var res  = await apiFetch("/api/technoline/campaign/run", { method: "POST", body: JSON.stringify(payload) });
    var data = await res.json();

    if (!res.ok) {
      showLaunchMsg(data.error || "שגיאה בהפעלת קמפיין", "error");
      return;
    }

    if (demo) {
      showLaunchMsg(
        "בדיקה עברה ✅ | " +
        "מספרים תקינים: " + (data.phones || 0) + " | " +
        "שגיאות: "        + (data.errorPhones || 0) + " | " +
        "חסומים: "        + (data.blockedPhones || 0),
        "success"
      );
    } else {
      showLaunchMsg(
        "קמפיין הופעל! מזהה: " + data.campaignId + " | " +
        "נשלח ל-" + (data.phones || 0) + " מספרים | עלות: " + (data.billing || "—"),
        "success"
      );
      showToast("קמפיין " + data.campaignId + " הופעל בהצלחה");
      loadHistory();
    }
  } catch (_) {
    showLaunchMsg("שגיאת תקשורת עם השרת", "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = demo ? "🔍 בדיקת תקינות (demo)" : "🚀 הפעל קמפיין"; }
  }
}

var launchBtn = document.getElementById("launchCampaignButton");
var demoBtn   = document.getElementById("demoLaunchButton");
if (launchBtn) launchBtn.addEventListener("click", function () { launchCampaign(false); });
if (demoBtn)   demoBtn.addEventListener("click",   function () { launchCampaign(true); });

// ── Campaign history ──────────────────────────────────────────────────────────

async function loadHistory() {
  var tbody = document.getElementById("historyTableBody");
  if (!tbody) return;

  var fromDate = (document.getElementById("historyFromDate") || {}).value || "";
  var toDate   = (document.getElementById("historyToDate")   || {}).value || "";
  var qs = [];
  if (fromDate) qs.push("fromDate=" + encodeURIComponent(fromDate));
  if (toDate)   qs.push("toDate="   + encodeURIComponent(toDate));

  tbody.innerHTML = "<tr><td colspan='9' style='color:#888;padding:.8rem;'>טוען...</td></tr>";
  showHistoryMsg("");

  try {
    var res  = await apiFetch("/api/technoline/campaign/history" + (qs.length ? "?" + qs.join("&") : ""));
    var data = await res.json();

    if (!res.ok) {
      tbody.innerHTML = "";
      showHistoryMsg(data.error || "שגיאה בטעינת היסטוריה", "error");
      return;
    }

    var campaigns = Array.isArray(data) ? data : (data.campaigns || data.history || []);
    if (campaigns.length === 0) {
      tbody.innerHTML = "<tr><td colspan='9' style='color:#888;padding:.8rem;text-align:center'>אין קמפיינים</td></tr>";
      return;
    }

    tbody.innerHTML = campaigns.map(function (c) {
      var startStr = c.start_time
        ? new Date(c.start_time.replace(" ", "T")).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem", hour12: false })
        : "—";
      return "<tr>" +
        "<td style='font-weight:600'>" + escapeHTML(String(c.id || "—")) + "</td>" +
        "<td>" + escapeHTML(c.title || "—") + "</td>" +
        "<td>" + statusLabel(c.active) + "</td>" +
        "<td>" + escapeHTML(String(c.total_phones || "—")) + "</td>" +
        "<td>" + escapeHTML(String(c.answerd_calls || "—")) + "</td>" +
        "<td>" + escapeHTML(String(c.total_sent   || "—")) + "</td>" +
        "<td>" + escapeHTML(String(c.billing       || "—")) + "</td>" +
        "<td style='white-space:nowrap;font-size:.85em'>" + escapeHTML(startStr) + "</td>" +
        "<td style='white-space:nowrap'>" + campaignActions(c) + "</td>" +
        "</tr>";
    }).join("");
  } catch (_) {
    tbody.innerHTML = "";
    showHistoryMsg("שגיאת תקשורת", "error");
  }
}

function campaignActions(c) {
  var id = c.id;
  var btns = [];
  btns.push("<button onclick='showReport(" + id + ")' style='font-size:.78em;padding:3px 9px;border:1px solid #1565c0;border-radius:4px;background:#e8f0fe;color:#1565c0;cursor:pointer'>דוח</button>");
  if (c.active === "active") {
    btns.push("<button onclick='campaignAction(" + id + ",\"hold\")' style='font-size:.78em;padding:3px 9px;border:1px solid #b07000;border-radius:4px;background:#fff8e1;color:#b07000;cursor:pointer'>השהה</button>");
    btns.push("<button onclick='campaignAction(" + id + ",\"stop\")' style='font-size:.78em;padding:3px 9px;border:1px solid #b00;border-radius:4px;background:#fff0f0;color:#b00;cursor:pointer'>עצור</button>");
  } else if (c.active === "hold") {
    btns.push("<button onclick='campaignAction(" + id + ",\"resume\")' style='font-size:.78em;padding:3px 9px;border:1px solid #1a7a1a;border-radius:4px;background:#e8f5e9;color:#1a7a1a;cursor:pointer'>המשך</button>");
    btns.push("<button onclick='campaignAction(" + id + ",\"stop\")' style='font-size:.78em;padding:3px 9px;border:1px solid #b00;border-radius:4px;background:#fff0f0;color:#b00;cursor:pointer'>עצור</button>");
  }
  return btns.join(" ");
}

async function campaignAction(id, action) {
  var labels = { hold: "להשהות", resume: "להמשיך", stop: "לעצור סופית" };
  if (!confirm("האם לבצע: " + (labels[action] || action) + " קמפיין " + id + "?")) return;
  try {
    var res  = await apiFetch("/api/technoline/campaign/" + id + "/" + action, { method: "POST" });
    var data = await res.json();
    if (data.errorCode === 0 || String(data.status).toUpperCase() === "OK") {
      showToast("הפעולה בוצעה על קמפיין " + id);
      loadHistory();
    } else {
      showToast("שגיאה: " + (data.note || data.error || ""));
    }
  } catch (_) {
    showToast("שגיאת תקשורת");
  }
}

// ── Campaign report ───────────────────────────────────────────────────────────

async function showReport(id) {
  var modal   = document.getElementById("campaignReportModal");
  var summary = document.getElementById("reportSummary");
  var tbody   = document.getElementById("reportTableBody");
  var title   = document.getElementById("reportTitle");
  if (!modal) return;

  title.textContent   = "טוען דוח קמפיין " + id + "...";
  summary.innerHTML   = "";
  tbody.innerHTML     = "<tr><td colspan='7' style='color:#888;padding:.8rem;'>טוען...</td></tr>";
  modal.style.display = "flex";

  try {
    var res  = await apiFetch("/api/technoline/campaign/" + id + "/report");
    var data = await res.json();

    if (String(data.status).toUpperCase() !== "OK") {
      title.textContent = "שגיאה בטעינת הדוח";
      tbody.innerHTML   = "<tr><td colspan='7' style='color:#b00;padding:.8rem;'>" + escapeHTML(data.note || "שגיאה") + "</td></tr>";
      return;
    }

    var c = data.campaign || data;
    title.textContent = "דוח קמפיין " + id + (c.title ? " — " + c.title : "");

    summary.innerHTML = [
      c.status          ? "<p><strong>סטטוס:</strong> "   + escapeHTML(c.status) + "</p>" : "",
      c.recipients      ? "<p><strong>נמענים:</strong> "  + escapeHTML(String(c.recipients)) + "</p>" : "",
      c.answeredCalls   ? "<p><strong>נענו:</strong> "    + escapeHTML(String(c.answeredCalls)) + "</p>" : "",
      c.billing         ? "<p><strong>עלות:</strong> "    + escapeHTML(String(c.billing)) + "</p>" : "",
      c.callLength      ? "<p><strong>משך שיחה:</strong> " + escapeHTML(String(c.callLength)) + " שנ'</p>" : "",
      c.dialRetries     ? "<p><strong>ניסיונות:</strong> " + escapeHTML(String(c.dialRetries)) + "</p>" : "",
    ].join("");

    var rows = data.calls || data.recipients || [];
    if (rows.length === 0) {
      tbody.innerHTML = "<tr><td colspan='7' style='color:#888;padding:.8rem;text-align:center'>אין נתוני שיחות</td></tr>";
      return;
    }

    tbody.innerHTML = rows.map(function (r) {
      var statusColor = r.status === "answered" ? "#1a7a1a" : "#888";
      return "<tr>" +
        "<td dir='ltr'>" + escapeHTML(r.phone || "—") + "</td>" +
        "<td>" + escapeHTML(r.name  || "—") + "</td>" +
        "<td style='color:" + statusColor + ";font-weight:600'>" + escapeHTML(r.status || "—") + "</td>" +
        "<td>" + escapeHTML(r.duration || "—") + "</td>" +
        "<td>" + escapeHTML(String(r.retries || "—")) + "</td>" +
        "<td>" + escapeHTML(r.digits || "—") + "</td>" +
        "<td style='font-size:.8em;color:#666'>" + escapeHTML(r.sipCode || r.q850Text || "—") + "</td>" +
        "</tr>";
    }).join("");
  } catch (_) {
    title.textContent = "שגיאת תקשורת";
    tbody.innerHTML   = "";
  }
}

document.getElementById("campaignReportModal").addEventListener("click", function (e) {
  if (e.target === this) this.style.display = "none";
});

// ── Init ──────────────────────────────────────────────────────────────────────

var loadHistoryBtn = document.getElementById("loadHistoryButton");
if (loadHistoryBtn) loadHistoryBtn.addEventListener("click", loadHistory);

// Default date range: last 30 days
(function () {
  var toEl   = document.getElementById("historyToDate");
  var fromEl = document.getElementById("historyFromDate");
  if (!toEl || !fromEl) return;
  var now  = new Date();
  var past = new Date(now);
  past.setDate(past.getDate() - 30);
  var fmt = function (d) { return d.toISOString().slice(0, 10); };
  toEl.value   = fmt(now);
  fromEl.value = fmt(past);
})();

loadHistory();

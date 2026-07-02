/* sync.js — Address-book import/sync UI */
"use strict";

var _csvContent  = "";
var _csvFilename = "";
var _previewData = null;

// ── File drop zone ────────────────────────────────────────────────────────────

var dropZone  = document.getElementById("dropZone");
var fileInput = document.getElementById("fileInput");

dropZone.addEventListener("click", function () { fileInput.click(); });
dropZone.addEventListener("dragover",  function (e) { e.preventDefault(); dropZone.classList.add("drag-over"); });
dropZone.addEventListener("dragleave", function ()  { dropZone.classList.remove("drag-over"); });
dropZone.addEventListener("drop", function (e) {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  var file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});
fileInput.addEventListener("change", function () {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
});

function handleFile(file) {
  document.getElementById("selectedFileName").textContent = "📄 " + file.name;
  _csvFilename = file.name;
  var reader = new FileReader();
  reader.onload = function (e) {
    _csvContent = e.target.result;
    loadPreview();
  };
  reader.readAsText(file, "utf-8");
}

// ── Preview ───────────────────────────────────────────────────────────────────

async function loadPreview() {
  document.getElementById("previewArea").style.display = "none";
  document.getElementById("resultBanner").style.display = "none";

  try {
    var r = await apiFetch("/api/sync/preview", {
      method: "POST",
      body:   JSON.stringify({ content: _csvContent }),
    });
    if (!r.ok) {
      var err = await r.json().catch(function () { return {}; });
      showBanner("שגיאה: " + (err.error || r.status), "error");
      return;
    }
    var data = await r.json();
    _previewData = data;
    renderPreview(data);
  } catch (e) {
    showBanner("שגיאת רשת: " + e.message, "error");
  }
}

function renderPreview(data) {
  var counts = data.counts;
  var grid = document.getElementById("summaryGrid");
  grid.innerHTML =
    statCard(counts.create,    "create",    "🆕 תורמים חדשים")    +
    statCard(counts.update,    "update",    "🔄 לעדכון")           +
    statCard(counts.unchanged, "unchanged", "✅ עדכניים")          +
    statCard(counts.skip,      "skip",      "⏭ מדולגים/בעיות");

  var tbody = document.getElementById("previewBody");
  tbody.innerHTML = "";

  (data.preview || []).forEach(function (row) {
    var tr = document.createElement("tr");
    var details = "";
    if (row.action === "update" && row.changes) {
      var parts = [];
      if (row.changes.nameChanged)  parts.push("שם");
      if (row.changes.cityChanged)  parts.push("עיר");
      if (row.changes.addrChanged)  parts.push("כתובת");
      if (row.changes.newPhones && row.changes.newPhones.length)
        parts.push("+" + row.changes.newPhones.length + " טל'");
      details = parts.join(", ") || "—";
    } else if (row.action === "skip") {
      details = reasonLabel(row.reason);
    } else if (row.action === "update") {
      details = "תורם קיים: " + escSafe(row.existingName || "");
    }

    tr.innerHTML =
      "<td>" + (row.lineNum || "") + "</td>" +
      "<td><span class='act-" + row.action + "'>" + actionLabel(row.action) + "</span></td>" +
      "<td>" + escSafe(row.fullName) + "</td>" +
      "<td>" + escSafe(row.city) + "</td>" +
      "<td style='font-size:.82em;color:#666'>" + escSafe(row.address) + "</td>" +
      "<td style='direction:ltr;text-align:right'>" + escSafe(row.phone1) + "</td>" +
      "<td style='font-size:.82em;color:#666'>" + escSafe(details) + "</td>";
    tbody.appendChild(tr);
  });

  var note = "";
  if (counts.create + counts.update > 0) {
    note = "סה\"כ " + (counts.create + counts.update) + " שינויים יתבצעו.";
  } else {
    note = "אין שינויים לביצוע.";
  }
  document.getElementById("applyNote").textContent = note;
  document.getElementById("applyBtn").disabled = (counts.create + counts.update === 0);
  document.getElementById("previewArea").style.display = "";
}

function statCard(n, cls, label) {
  return "<div class='sync-stat " + cls + "'>" +
    "<div class='num'>" + n + "</div>" +
    "<div class='lbl'>" + label + "</div>" +
    "</div>";
}

function actionLabel(action) {
  return { create: "חדש", update: "עדכון", unchanged: "ללא שינוי", skip: "דלג" }[action] || action;
}

function reasonLabel(reason) {
  return {
    no_name:           "אין שם",
    no_phone:          "אין טלפון",
    duplicate_in_file: "כפול בקובץ",
  }[reason] || reason || "—";
}

function escSafe(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Apply ─────────────────────────────────────────────────────────────────────

document.getElementById("applyBtn").addEventListener("click", async function () {
  if (!_csvContent) return;
  var btn = this;
  btn.disabled = true;
  btn.innerHTML = "מבצע סנכרון… <span class='spinner'></span>";

  try {
    var r = await apiFetch("/api/sync/apply", {
      method: "POST",
      body:   JSON.stringify({ content: _csvContent, filename: _csvFilename }),
    });
    var data = await r.json().catch(function () { return {}; });
    if (!r.ok) {
      showBanner("שגיאה: " + (data.error || r.status), "error");
    } else {
      showBanner(
        "✅ סנכרון הושלם! נוספו: " + data.added +
        " | עודכנו: "  + data.updated +
        " | דולגו: "   + data.skipped +
        " | נכשלו: "   + data.failed,
        "success"
      );
      loadSyncLog(); loadPending();
      // Reset
      _csvContent  = "";
      _csvFilename = "";
      document.getElementById("previewArea").style.display = "none";
      document.getElementById("selectedFileName").textContent = "";
      fileInput.value = "";
    }
  } catch (e) {
    showBanner("שגיאת רשת: " + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = "✅ בצע סנכרון";
  }
});

document.getElementById("cancelBtn").addEventListener("click", function () {
  _csvContent  = "";
  _csvFilename = "";
  _previewData = null;
  document.getElementById("previewArea").style.display = "none";
  document.getElementById("selectedFileName").textContent = "";
  fileInput.value = "";
  document.getElementById("resultBanner").style.display = "none";
});

function showBanner(msg, type) {
  var el = document.getElementById("resultBanner");
  el.textContent = msg;
  el.className   = "result-banner " + type;
  el.style.display = "";
  el.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ── Sync log ──────────────────────────────────────────────────────────────────

async function loadSyncLog() {
  var area = document.getElementById("syncLogArea");
  try {
    var r = await apiFetch("/api/sync/logs");
    if (!r.ok) { area.innerHTML = "<p style='color:#999'>לא ניתן לטעון היסטוריה</p>"; return; }
    var logs = await r.json();
    if (!logs.length) { area.innerHTML = "<p style='color:#999'>אין עדיין סנכרונים</p>"; return; }

    area.innerHTML =
      "<table class='sync-log-table'>" +
      "<thead><tr><th>תאריך</th><th>קובץ</th><th>נוספו</th><th>עודכנו</th><th>דולגו</th><th>נכשלו</th><th>מבצע</th></tr></thead>" +
      "<tbody>" +
      logs.map(function (l) {
        var dt = l.createdAt ? new Date(l.createdAt).toLocaleString("he-IL") : "—";
        return "<tr>" +
          "<td>" + escSafe(dt) + "</td>" +
          "<td style='font-size:.82em;color:#666'>" + escSafe(l.filename) + "</td>" +
          "<td style='color:#155724;font-weight:600'>" + l.added + "</td>" +
          "<td style='color:#856404;font-weight:600'>" + l.updated + "</td>" +
          "<td>" + l.skipped + "</td>" +
          "<td style='color:" + (l.failed ? "#721c24" : "inherit") + "'>" + l.failed + "</td>" +
          "<td>" + escSafe(l.workerName) + "</td>" +
          "</tr>";
      }).join("") +
      "</tbody></table>";
  } catch (e) {
    area.innerHTML = "<p style='color:#999'>שגיאה בטעינת היסטוריה</p>";
  }
}

// ── Alfon pending approval ────────────────────────────────────────────────────

async function loadPending() {
  try {
    var r = await apiFetch("/api/sync/alfon-pending");
    if (!r.ok) return;
    var list = await r.json();
    var pending = list.filter(function (l) { return l.status === "pending"; });
    var sec = document.getElementById("pendingSection");
    if (!pending.length) { sec.style.display = "none"; return; }
    sec.style.display = "";
    var container = document.getElementById("pendingList");
    container.innerHTML = "";
    pending.forEach(function (item) {
      var div = document.createElement("div");
      div.className = "pending-card";
      div.dataset.id = item.id;
      div.innerHTML =
        "<h4>📤 " + escSafe(item.filename) + "</h4>" +
        "<div class='pending-meta'>הועלה: " + new Date(item.createdAt).toLocaleString("he-IL") + "</div>" +
        "<div class='pending-counts'>" +
          "<span class='pc pc-c'>🆕 חדש: " + item.previewAdded + "</span>" +
          "<span class='pc pc-u'>🔄 עדכון: " + item.previewUpdated + "</span>" +
          "<span class='pc pc-s'>⏭ דלג: " + item.previewSkipped + "</span>" +
        "</div>" +
        "<div class='pending-btns'>" +
          "<button class='btn-preview' onclick='togglePendingPreview(" + item.id + ", this)'>🔍 תצוגה מקדימה</button>" +
          "<button class='btn-approve' onclick='approvePending(" + item.id + ", this)'>✅ אשר וסנכרן</button>" +
          "<button class='btn-reject'  onclick='rejectPending(" + item.id + ", this)'>❌ דחה</button>" +
        "</div>" +
        "<div class='pending-preview-wrap' id='ppw-" + item.id + "'></div>";
      container.appendChild(div);
    });
  } catch (_) {}
}

window.togglePendingPreview = async function (id, btn) {
  var wrap = document.getElementById("ppw-" + id);
  if (wrap.style.display === "block") { wrap.style.display = "none"; btn.textContent = "🔍 תצוגה מקדימה"; return; }
  btn.textContent = "טוען…";
  try {
    var r = await apiFetch("/api/sync/alfon-pending/" + id + "/preview");
    if (!r.ok) { btn.textContent = "שגיאה"; return; }
    var data = await r.json();
    wrap.innerHTML =
      "<div class='sync-summary' style='margin-top:10px'>" +
        statCard(data.counts.create,    "create",    "🆕 חדש")      +
        statCard(data.counts.update,    "update",    "🔄 עדכון")    +
        statCard(data.counts.unchanged, "unchanged", "✅ ללא שינוי") +
        statCard(data.counts.skip,      "skip",      "⏭ דלג")      +
      "</div>" +
      "<div class='preview-table-wrap' style='max-height:300px'>" +
      "<table class='preview-table'><thead><tr>" +
        "<th>שורה</th><th>פעולה</th><th>שם</th><th>עיר</th><th>טלפון א</th>" +
      "</tr></thead><tbody>" +
      (data.preview || []).slice(0, 100).map(function (row) {
        return "<tr><td>" + row.lineNum + "</td>" +
          "<td><span class='act-" + row.action + "'>" + actionLabel(row.action) + "</span></td>" +
          "<td>" + escSafe(row.fullName) + "</td>" +
          "<td>" + escSafe(row.city) + "</td>" +
          "<td style='direction:ltr'>" + escSafe(row.phone1) + "</td></tr>";
      }).join("") + "</tbody></table></div>";
    wrap.style.display = "block";
    btn.textContent = "🔼 סגור";
  } catch (e) { btn.textContent = "שגיאה: " + e.message; }
};

window.approvePending = async function (id, btn) {
  if (!confirm("לאשר ולבצע את הסנכרון?")) return;
  btn.disabled = true;
  btn.innerHTML = "מבצע… <span class='spinner'></span>";
  try {
    var r = await apiFetch("/api/sync/alfon-pending/" + id + "/approve", { method: "POST", body: "{}" });
    var data = await r.json().catch(function () { return {}; });
    if (!r.ok) { alert("שגיאה: " + (data.error || r.status)); btn.disabled = false; btn.textContent = "✅ אשר וסנכרן"; return; }
    btn.closest(".pending-card").innerHTML =
      "<p style='color:#155724;font-weight:600;padding:8px'>✅ סנכרון בוצע — נוספו: " + data.added + " | עודכנו: " + data.updated + "</p>";
    loadSyncLog();
    setTimeout(loadPending, 500);
  } catch (e) { alert("שגיאת רשת: " + e.message); btn.disabled = false; btn.textContent = "✅ אשר וסנכרן"; }
};

window.rejectPending = async function (id, btn) {
  if (!confirm("לדחות ולמחוק את הסנכרון הממתין?")) return;
  btn.disabled = true;
  try {
    var r = await apiFetch("/api/sync/alfon-pending/" + id + "/reject", { method: "POST", body: "{}" });
    if (!r.ok) { alert("שגיאה"); btn.disabled = false; return; }
    btn.closest(".pending-card").innerHTML = "<p style='color:#888;padding:8px'>❌ נדחה</p>";
    setTimeout(loadPending, 500);
  } catch (e) { alert("שגיאת רשת"); btn.disabled = false; }
};

loadPending();

loadSyncLog();

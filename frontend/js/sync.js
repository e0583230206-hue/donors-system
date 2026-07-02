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
      loadSyncLog();
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

loadSyncLog();

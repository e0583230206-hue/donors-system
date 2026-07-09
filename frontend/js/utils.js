"use strict";
// utils.js — shared helpers that were previously copy-pasted, byte-for-byte
// identical, into several page scripts (audit finding #28). Only functions
// verified identical (or made parameter/DOM-lookup self-contained without
// changing behavior) across every page that used them were moved here —
// nothing on any existing page should render or behave differently.
// Load this AFTER auth.js/database.js/sidebar.js and BEFORE the page's own
// script, same position on every page.

// Was duplicated in: approvals.js, phone.js, reminders.js, settings.js,
// tasks.js, donors.js — all relied on the same #messageBox element id.
function showMessage(text, type = "success") {
  var messageBox = document.getElementById("messageBox");
  if (!messageBox) return;
  messageBox.innerText = text;
  messageBox.className = "message show " + type;

  setTimeout(function () {
    messageBox.innerText = "";
    messageBox.className = "message";
  }, 3000);
}

// Was duplicated in: approvals.js, phone.js, tasks.js.
// (payments.js has a deliberately different, more defensive version and
// keeps its own local copy — not merged here.)
function formatDateTime(dateString) {
  if (!dateString) return "";
  return new Date(dateString).toLocaleString("he-IL");
}

// Was duplicated in: app.js, reminders.js.
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

// Was duplicated in: donor.js, donors.js.
function normalizePhoneLocal(p) {
  var digits = String(p === undefined || p === null ? "" : p).trim().replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("972") && digits.length >= 11) return "0" + digits.slice(3);
  if (digits.length === 9 && !digits.startsWith("0")) return "0" + digits;
  return digits;
}

// Was duplicated in: approvals.js, logs.js, phone.js, reminders.js, tasks.js.
// (reports.js has its own differently-formatted export and keeps its own
// local copy — not merged here.) Relies on the global XLSX vendor library,
// already loaded on every page that uses this.
function downloadXLSX(filename, sheetName, rows) {
  var safe = rows.map(function (row) {
    return row.map(function (cell) {
      if (typeof cell === "string" && /^[=+\-@|]/.test(cell)) return "'" + cell;
      return cell;
    });
  });
  var workbook = XLSX.utils.book_new();
  var worksheet = XLSX.utils.aoa_to_sheet(safe);
  worksheet["!cols"] = safe[0].map(function () { return { wch: 22 }; });
  worksheet["!rtl"] = true;
  workbook.Workbook = { Views: [{ RTL: true }] };
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  XLSX.writeFile(workbook, filename);
}

// Was duplicated in: phone.js, tasks.js — both called it with no arguments,
// relying on outer worker-select/workers variables. Made explicit here so it
// doesn't depend on any particular outer variable name; call sites updated
// to pass `workers` in.
function fillWorkerSelect(workers) {
  var workerSelect = document.getElementById("workerSelect");
  if (!workerSelect) return;
  workerSelect.innerHTML = `<option value="">בחר מטפל</option>`;
  workers
    .filter(function (worker) { return worker.status === "פעיל"; })
    .forEach(function (worker) {
      const option = document.createElement("option");
      option.value = worker.name;
      option.innerText = worker.name + " - " + worker.role;
      workerSelect.appendChild(option);
    });
}

// Was duplicated in: phone.js, reminders.js — same reasoning as fillWorkerSelect.
function fillDonorSelect(donors) {
  var donorSelect = document.getElementById("donorSelect");
  if (!donorSelect) return;
  donorSelect.innerHTML = `<option value="">בחר תורם</option>`;
  donors.forEach(function (donor) {
    const option = document.createElement("option");
    option.value = donor.id;
    option.innerText = donor.fullName + " - " + donor.phone;
    donorSelect.appendChild(option);
  });
}

let donors = Database.get("donors");
let workers = Database.get("workers");

const donorSelect = document.getElementById("donorSelect");
const workerSelect = document.getElementById("workerSelect");
const prioritySelect = document.getElementById("prioritySelect");
const sourceSelect = document.getElementById("sourceSelect");
const reasonInput = document.getElementById("reasonInput");
const addCallbackButton = document.getElementById("addCallbackButton");
const messageBox = document.getElementById("messageBox");

const openCallbacksTable = document.getElementById("openCallbacksTable");
const doneCallbacksTable = document.getElementById("doneCallbacksTable");

const openCallbacksCount = document.getElementById("openCallbacksCount");
const urgentCallbacksCount = document.getElementById("urgentCallbacksCount");
const doneCallbacksCount = document.getElementById("doneCallbacksCount");
const workersCount = document.getElementById("workersCount");

var callbackFilter = "";
var callbackPage = 0;
var CALLBACK_PAGE_SIZE = 25;
var pendingCallbackDeletions = {};

function saveDonors() {
  Database.save("donors", donors);
}

function showMessage(text, type = "success") {
  messageBox.innerText = text;
  messageBox.className = "message show " + type;

  setTimeout(function () {
    messageBox.innerText = "";
    messageBox.className = "message";
  }, 3000);
}

function formatDateTime(dateString) {
  if (!dateString) return "";
  return new Date(dateString).toLocaleString("he-IL");
}

function fillDonorSelect() {
  donorSelect.innerHTML = `<option value="">בחר תורם</option>`;

  donors.forEach(function (donor) {
    const option = document.createElement("option");
    option.value = donor.id;
    option.innerText = donor.fullName + " - " + donor.phone;
    donorSelect.appendChild(option);
  });
}

function fillWorkerSelect() {
  workerSelect.innerHTML = `<option value="">בחר מטפל</option>`;

  workers
    .filter(function (worker) {
      return worker.status === "פעיל";
    })
    .forEach(function (worker) {
      const option = document.createElement("option");
      option.value = worker.name;
      option.innerText = worker.name + " - " + worker.role;
      workerSelect.appendChild(option);
    });
}

function ensureCallbackArrays() {
  donors.forEach(function (donor) {
    if (!donor.callbacks) {
      donor.callbacks = [];
    }
  });

  saveDonors();
}

function getAllCallbacks() {
  const callbacks = [];

  donors.forEach(function (donor) {
    if (!donor.callbacks) return;

    donor.callbacks.forEach(function (callback) {
      var pendingKey = donor.id + ":" + callback.id;
      if (pendingCallbackDeletions[pendingKey]) return;
      callbacks.push({
        donorId: donor.id,
        donorName: donor.fullName,
        donorPhone: donor.phone,
        ...callback,
      });
    });
  });

  return callbacks;
}

function getPriorityClass(priority) {
  if (priority === "דחוף") return "red-text";
  if (priority === "חשוב") return "yellow-text";
  return "green-text";
}

function addCallback() {
  const donorId = Number(donorSelect.value);
  const workerName = workerSelect.value;
  const priority = prioritySelect.value;
  const source = sourceSelect.value;
  const reason = reasonInput.value.trim();

  if (!donorId || workerName === "" || reason === "") {
    showMessage("חובה לבחור תורם, מטפל ולכתוב סיבה", "error");
    return;
  }

  const donor = donors.find(function (item) {
    return item.id === donorId;
  });

  if (!donor) {
    showMessage("התורם לא נמצא", "error");
    return;
  }

  if (!donor.callbacks) {
    donor.callbacks = [];
  }

  const newCallback = {
    id: Date.now(),
    reason: reason,
    workerName: workerName,
    priority: priority,
    source: source,
    status: "ממתין",
    done: false,
    createdAt: new Date().toISOString(),
    doneAt: "",
  };

  donor.callbacks.push(newCallback);

  donor.updatedAt = new Date().toISOString();

  saveDonors();
  AuditLog.record({
    action: "create",
    entityType: "callback",
    entityId: newCallback.id,
    entityName: donor.fullName,
    details: "נוספה הודעה לחזרה: " + reason,
  });

  donorSelect.value = "";
  workerSelect.value = "";
  prioritySelect.value = "רגיל";
  sourceSelect.value = "מזכיר";
  reasonInput.value = "";

  showMessage("הודעה לחזרה נוספה בהצלחה");
  renderCallbacks();
}

function setCallbackInProgress(donorId, callbackId) {
  const donor = donors.find(function (item) {
    return item.id === donorId;
  });

  if (!donor || !donor.callbacks) return;

  const callback = donor.callbacks.find(function (item) {
    return item.id === callbackId;
  });

  if (!callback) return;

  callback.status = "בטיפול";
  donor.updatedAt = new Date().toISOString();

  saveDonors();
  AuditLog.record({
    action: "status",
    entityType: "callback",
    entityId: callback.id,
    entityName: donor.fullName,
    details: "הודעה לחזרה הועברה לטיפול",
  });
  renderCallbacks();
}

function markCallbackDone(donorId, callbackId) {
  const donor = donors.find(function (item) {
    return item.id === donorId;
  });

  if (!donor || !donor.callbacks) return;

  const callback = donor.callbacks.find(function (item) {
    return item.id === callbackId;
  });

  if (!callback) return;

  callback.status = "טופל";
  callback.done = true;
  callback.doneAt = new Date().toISOString();
  donor.updatedAt = new Date().toISOString();

  saveDonors();
  AuditLog.record({
    action: "complete",
    entityType: "callback",
    entityId: callback.id,
    entityName: donor.fullName,
    details: "הודעה לחזרה טופלה",
  });
  renderCallbacks();
}

function deleteCallback(donorId, callbackId) {
  const donor = donors.find(function (item) { return item.id === donorId; });
  if (!donor || !donor.callbacks) return;

  const deletedCallback = donor.callbacks.find(function (callback) { return callback.id === callbackId; });
  if (!deletedCallback) return;

  donor.callbacks = donor.callbacks.filter(function (callback) { return callback.id !== callbackId; });
  donor.updatedAt = new Date().toISOString();
  saveDonors();
  AuditLog.record({
    action: "delete",
    entityType: "callback",
    entityId: deletedCallback.id,
    entityName: donor.fullName,
    details: "נמחקה הודעה לחזרה: " + deletedCallback.reason,
  });
  renderCallbacks();

  if (typeof showToast === "function") {
    showToast("הודעה לחזרה נמחקה", function () {
      donor.callbacks.push(deletedCallback);
      donor.updatedAt = new Date().toISOString();
      saveDonors();
      renderCallbacks();
    }, 5000);
  } else {
    showMessage("ההודעה נמחקה בהצלחה");
  }
}

function setCallbackPage(n) {
  callbackPage = n;
  renderCallbacks();
}

function renderCallbackPagination(total) {
  var el = document.getElementById("callbacksPaginationBar");
  if (!el) return;
  var totalPages = Math.ceil(total / CALLBACK_PAGE_SIZE);
  if (totalPages <= 1) { el.innerHTML = ""; return; }
  var html = "";
  for (var i = 0; i < totalPages; i++) {
    html += '<button class="page-btn' + (i === callbackPage ? " active" : "") +
            '" onclick="setCallbackPage(' + i + ')">' + (i + 1) + '</button>';
  }
  el.innerHTML = html;
}

function renderStats(allCallbacks) {
  const open = allCallbacks.filter(function (callback) {
    return callback.done === false;
  });

  const done = allCallbacks.filter(function (callback) {
    return callback.done === true;
  });

  const urgent = open.filter(function (callback) {
    return callback.priority === "דחוף";
  });

  openCallbacksCount.innerText = open.length;
  urgentCallbacksCount.innerText = urgent.length;
  doneCallbacksCount.innerText = done.length;

  workersCount.innerText = workers.filter(function (worker) {
    return worker.status === "פעיל";
  }).length;
}

function renderOpenCallbacks(openCallbacks) {
  openCallbacksTable.innerHTML = "";

  if (openCallbacks.length === 0) {
    openCallbacksTable.innerHTML = `
      <tr class="empty-state-row">
        <td colspan="9">↩️ אין הודעות פתוחות לחזרה</td>
      </tr>
    `;
    return;
  }

  openCallbacks.forEach(function (callback) {
    const row = document.createElement("tr");
    const priorityClass = getPriorityClass(callback.priority);

    row.innerHTML = `
      <td>${escapeHTML(callback.donorName)}</td>
      <td>${escapeHTML(callback.donorPhone)}</td>
      <td>${escapeHTML(callback.reason)}</td>
      <td>${escapeHTML(callback.workerName)}</td>
      <td class="${priorityClass}">${callback.priority}</td>
      <td>${callback.source}</td>
      <td>${callback.status}</td>
      <td>${formatDateTime(callback.createdAt)}</td>
      <td>
        <a class="small-btn" href="donor.html?id=${callback.donorId}">
          כרטיס
        </a>
        <button class="warning-btn" onclick="setCallbackInProgress(${callback.donorId}, ${callback.id})">
          בטיפול
        </button>
        <button class="success-btn" onclick="markCallbackDone(${callback.donorId}, ${callback.id})">
          טופל
        </button>
        <button class="danger-btn" onclick="deleteCallback(${callback.donorId}, ${callback.id})">
          מחק
        </button>
      </td>
    `;

    openCallbacksTable.appendChild(row);
  });
}

function renderDoneCallbacks(doneCallbacks) {
  doneCallbacksTable.innerHTML = "";

  if (doneCallbacks.length === 0) {
    doneCallbacksTable.innerHTML = `
      <tr class="empty-state-row">
        <td colspan="9">✅ אין עדיין הודעות שטופלו</td>
      </tr>
    `;
    return;
  }

  doneCallbacks.forEach(function (callback) {
    const row = document.createElement("tr");
    const priorityClass = getPriorityClass(callback.priority);

    row.innerHTML = `
      <td>${escapeHTML(callback.donorName)}</td>
      <td>${escapeHTML(callback.donorPhone)}</td>
      <td>${escapeHTML(callback.reason)}</td>
      <td>${escapeHTML(callback.workerName)}</td>
      <td class="${priorityClass}">${callback.priority}</td>
      <td>${callback.source}</td>
      <td>${formatDateTime(callback.createdAt)}</td>
      <td>${formatDateTime(callback.doneAt)}</td>
      <td>
        <button class="danger-btn" onclick="deleteCallback(${callback.donorId}, ${callback.id})">
          מחק
        </button>
      </td>
    `;

    doneCallbacksTable.appendChild(row);
  });
}

function renderCallbacks() {
  const allCallbacks = getAllCallbacks();

  var q = callbackFilter.toLowerCase();

  var openCallbacks = allCallbacks.filter(function (callback) {
    if (callback.done !== false) return false;
    if (!q) return true;
    return (
      (callback.donorName || "").toLowerCase().includes(q) ||
      (callback.donorPhone || "").includes(q) ||
      (callback.reason || "").toLowerCase().includes(q) ||
      (callback.workerName || "").toLowerCase().includes(q)
    );
  });

  const doneCallbacks = allCallbacks.filter(function (callback) {
    return callback.done === true;
  });

  openCallbacks.sort(function (a, b) {
    return (b.createdAt || "").localeCompare(a.createdAt || "");
  });

  doneCallbacks.sort(function (a, b) {
    return (b.doneAt || "").localeCompare(a.doneAt || "");
  });

  var pagedOpen = openCallbacks.slice(callbackPage * CALLBACK_PAGE_SIZE, (callbackPage + 1) * CALLBACK_PAGE_SIZE);

  renderStats(allCallbacks);
  renderOpenCallbacks(pagedOpen);
  renderCallbackPagination(openCallbacks.length);
  renderDoneCallbacks(doneCallbacks);
}

function downloadXLSX(filename, sheetName, rows) {
  var workbook = XLSX.utils.book_new();
  var worksheet = XLSX.utils.aoa_to_sheet(rows);
  worksheet["!cols"] = rows[0].map(function () { return { wch: 22 }; });
  worksheet["!rtl"] = true;
  workbook.Workbook = { Views: [{ RTL: true }] };
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  XLSX.writeFile(workbook, filename);
}

function exportCallbacksExcel() {
  var exportable = getAllCallbacks();

  if (exportable.length === 0) {
    showMessage("אין הודעות לייצוא", "error");
    return;
  }

  var rows = [["תורם", "טלפון", "סיבה", "מטפל", "דחיפות", "מקור", "סטטוס", "נוצר", "טופל"]];

  exportable.forEach(function (callback) {
    rows.push([
      callback.donorName || "",
      callback.donorPhone || "",
      callback.reason || "",
      callback.workerName || "",
      callback.priority || "",
      callback.source || "",
      callback.status || "",
      callback.createdAt ? new Date(callback.createdAt).toLocaleString("he-IL") : "",
      callback.doneAt ? new Date(callback.doneAt).toLocaleString("he-IL") : "",
    ]);
  });

  var today = new Date().toISOString().slice(0, 10);
  downloadXLSX("callbacks-" + today + ".xlsx", "הודעות לחזרה", rows);
}

addCallbackButton.addEventListener("click", addCallback);

reasonInput.addEventListener("keydown", function (event) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    addCallback();
  }
});

var callbackSearchInput = document.getElementById("callbackSearchInput");
if (callbackSearchInput) {
  callbackSearchInput.addEventListener("input", function () {
    callbackFilter = callbackSearchInput.value.trim();
    callbackPage = 0;
    renderCallbacks();
  });
}

Database.whenReady(function () {
  donors  = Database.get("donors");
  workers = Database.get("workers");
  ensureCallbackArrays();
  fillDonorSelect();
  fillWorkerSelect();
  renderCallbacks();
});

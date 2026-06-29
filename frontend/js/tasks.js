let donors = Database.get("donors");
let workers = Database.get("workers");
let tasks = Database.get("tasks");

const titleInput = document.getElementById("titleInput");
const workerSelect = document.getElementById("workerSelect");
const donorSelect = document.getElementById("donorSelect");
const dueDateInput = document.getElementById("dueDateInput");
const prioritySelect = document.getElementById("prioritySelect");
const statusSelect = document.getElementById("statusSelect");
const descriptionInput = document.getElementById("descriptionInput");
const addTaskButton = document.getElementById("addTaskButton");
const messageBox = document.getElementById("messageBox");

const openTasksTable = document.getElementById("openTasksTable");
const doneTasksTable = document.getElementById("doneTasksTable");

const openTasksCount = document.getElementById("openTasksCount");
const urgentTasksCount = document.getElementById("urgentTasksCount");
const doneTasksCount = document.getElementById("doneTasksCount");
const workersCount = document.getElementById("workersCount");
const pendingTaskDeletions = {};
var taskFilter = "";
var taskPage = 0;
var TASK_PAGE_SIZE = 25;

function saveTasks() {
  Database.save("tasks", tasks);
}

function showMessage(text, type = "success") {
  messageBox.innerText = text;
  messageBox.className = "message show " + type;

  setTimeout(function () {
    messageBox.innerText = "";
    messageBox.className = "message";
  }, 3000);
}

function formatDate(dateString) {
  if (!dateString) return "לא נקבע";
  return new Date(dateString).toLocaleDateString("he-IL");
}

function formatDateTime(dateString) {
  if (!dateString) return "";
  return new Date(dateString).toLocaleString("he-IL");
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

function fillDonorSelect() {
  donorSelect.innerHTML = `<option value="">ללא תורם קשור</option>`;

  donors.forEach(function (donor) {
    const option = document.createElement("option");
    option.value = donor.id;
    option.innerText = donor.fullName + " - " + donor.phone;
    donorSelect.appendChild(option);
  });
}

function getDonorName(donorId) {
  if (!donorId) return "ללא";

  const donor = donors.find(function (item) {
    return item.id === Number(donorId);
  });

  return donor ? donor.fullName : "לא נמצא";
}

function getPriorityClass(priority) {
  if (priority === "דחוף") return "red-text";
  if (priority === "חשוב") return "yellow-text";
  return "green-text";
}

function addTask() {
  const title = titleInput.value.trim();
  const workerName = workerSelect.value;
  const donorId = donorSelect.value;
  const dueDate = dueDateInput.value;
  const priority = prioritySelect.value;
  const status = statusSelect.value;
  const description = descriptionInput.value.trim();

  if (title === "" || workerName === "") {
    showMessage("חובה להכניס כותרת ולבחור מטפל", "error");
    return;
  }

  const newTask = {
    id: Date.now(),
    title: title,
    workerName: workerName,
    donorId: donorId,
    dueDate: dueDate,
    priority: priority,
    status: status,
    description: description,
    done: false,
    createdAt: new Date().toISOString(),
    doneAt: "",
  };

  tasks.push(newTask);

  saveTasks();
  AuditLog.record({
    action: "create",
    entityType: "task",
    entityId: newTask.id,
    entityName: newTask.title,
    details: "נוספה משימה עבור " + newTask.workerName,
  });

  titleInput.value = "";
  workerSelect.value = "";
  donorSelect.value = "";
  dueDateInput.value = "";
  prioritySelect.value = "רגיל";
  statusSelect.value = "ממתין";
  descriptionInput.value = "";

  showMessage("המשימה נוספה בהצלחה");
  renderTasks();
}

function setTaskInProgress(id) {
  const task = tasks.find(function (item) {
    return item.id === id;
  });

  if (!task) return;

  task.status = "בטיפול";
  task.updatedAt = new Date().toISOString();

  saveTasks();
  AuditLog.record({
    action: "status",
    entityType: "task",
    entityId: task.id,
    entityName: task.title,
    details: "משימה הועברה לטיפול",
  });
  renderTasks();
}

function markTaskDone(id) {
  const task = tasks.find(function (item) {
    return item.id === id;
  });

  if (!task) return;

  task.status = "הושלם";
  task.done = true;
  task.doneAt = new Date().toISOString();

  saveTasks();
  AuditLog.record({
    action: "complete",
    entityType: "task",
    entityId: task.id,
    entityName: task.title,
    details: "משימה סומנה כהושלמה",
  });
  renderTasks();
}

function deleteTask(id) {
  const deletedTask = tasks.find(function (task) { return task.id === id; });
  if (!deletedTask || pendingTaskDeletions[id]) return;

  tasks = tasks.filter(function (task) { return task.id !== id; });
  saveTasks();
  AuditLog.record({
    action: "delete",
    entityType: "task",
    entityId: deletedTask.id,
    entityName: deletedTask.title,
    details: "משימה נמחקה",
  });
  renderTasks();

  if (typeof showToast === "function") {
    showToast('משימה "' + deletedTask.title + '" נמחקה', function () {
      tasks.push(deletedTask);
      tasks.sort(function (a, b) { return (a.dueDate || "9999").localeCompare(b.dueDate || "9999"); });
      saveTasks();
      renderTasks();
    }, 5000);
  } else {
    showMessage("המשימה נמחקה בהצלחה");
  }
}

function setTaskPage(n) {
  taskPage = n;
  renderTasks();
}

function renderTaskPagination(total) {
  var el = document.getElementById("tasksPaginationBar");
  if (!el) return;
  var totalPages = Math.ceil(total / TASK_PAGE_SIZE);
  if (totalPages <= 1) { el.innerHTML = ""; return; }
  var html = "";
  for (var i = 0; i < totalPages; i++) {
    html += '<button class="page-btn' + (i === taskPage ? " active" : "") +
            '" onclick="setTaskPage(' + i + ')">' + (i + 1) + '</button>';
  }
  el.innerHTML = html;
}

function renderStats() {
  const open = tasks.filter(function (task) {
    return task.done === false && !pendingTaskDeletions[task.id];
  });

  const done = tasks.filter(function (task) {
    return task.done === true && !pendingTaskDeletions[task.id];
  });

  const urgent = open.filter(function (task) {
    return task.priority === "דחוף";
  });

  openTasksCount.innerText = open.length;
  urgentTasksCount.innerText = urgent.length;
  doneTasksCount.innerText = done.length;
  workersCount.innerText = workers.filter(function (worker) {
    return worker.status === "פעיל";
  }).length;
}

function renderOpenTasks(openTasks) {
  openTasksTable.innerHTML = "";

  if (openTasks.length === 0) {
    openTasksTable.innerHTML = `
      <tr class="empty-state-row">
        <td colspan="8">📋 אין משימות פתוחות</td>
      </tr>
    `;
    return;
  }

  openTasks.forEach(function (task) {
    const row = document.createElement("tr");
    const priorityClass = getPriorityClass(task.priority);
    const donorName = getDonorName(task.donorId);

    const donorButton = task.donorId
      ? `<a class="small-btn" href="donor.html?id=${task.donorId}">כרטיס</a>`
      : "";

    row.innerHTML = `
      <td>${escapeHTML(task.title)}</td>
      <td>${escapeHTML(task.workerName)}</td>
      <td>${escapeHTML(donorName)} ${donorButton}</td>
      <td class="${priorityClass}">${task.priority}</td>
      <td>${formatDate(task.dueDate)}</td>
      <td>${task.status}</td>
      <td>${escapeHTML(task.description || "")}</td>
      <td>
        <button class="warning-btn" onclick="setTaskInProgress(${task.id})">
          בטיפול
        </button>
        <button class="success-btn" onclick="markTaskDone(${task.id})">
          הושלם
        </button>
        <button class="danger-btn" onclick="deleteTask(${task.id})">
          מחק
        </button>
      </td>
    `;

    openTasksTable.appendChild(row);
  });
}

function renderDoneTasks(doneTasks) {
  doneTasksTable.innerHTML = "";

  if (doneTasks.length === 0) {
    doneTasksTable.innerHTML = `
      <tr class="empty-state-row">
        <td colspan="8">✅ אין עדיין משימות שהושלמו</td>
      </tr>
    `;
    return;
  }

  doneTasks.forEach(function (task) {
    const row = document.createElement("tr");
    const priorityClass = getPriorityClass(task.priority);
    const donorName = getDonorName(task.donorId);

    row.innerHTML = `
      <td>${escapeHTML(task.title)}</td>
      <td>${escapeHTML(task.workerName)}</td>
      <td>${escapeHTML(donorName)}</td>
      <td class="${priorityClass}">${task.priority}</td>
      <td>${formatDate(task.dueDate)}</td>
      <td>${escapeHTML(task.description || "")}</td>
      <td>${formatDateTime(task.doneAt)}</td>
      <td>
        <button class="danger-btn" onclick="deleteTask(${task.id})">
          מחק
        </button>
      </td>
    `;

    doneTasksTable.appendChild(row);
  });
}

function renderTasks() {
  renderStats();

  var q = taskFilter.toLowerCase();

  var openTasks = tasks.filter(function (task) {
    if (task.done !== false || pendingTaskDeletions[task.id]) return false;
    if (!q) return true;
    return (
      (task.title || "").toLowerCase().includes(q) ||
      (task.workerName || "").toLowerCase().includes(q) ||
      getDonorName(task.donorId).toLowerCase().includes(q)
    );
  });

  const doneTasks = tasks.filter(function (task) {
    return task.done === true && !pendingTaskDeletions[task.id];
  });

  openTasks.sort(function (a, b) {
    return (a.dueDate || "9999").localeCompare(b.dueDate || "9999");
  });

  doneTasks.sort(function (a, b) {
    return (b.doneAt || "").localeCompare(a.doneAt || "");
  });

  var pagedOpen = openTasks.slice(taskPage * TASK_PAGE_SIZE, (taskPage + 1) * TASK_PAGE_SIZE);
  renderOpenTasks(pagedOpen);
  renderTaskPagination(openTasks.length);
  renderDoneTasks(doneTasks);
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

function exportTasksExcel() {
  var exportable = tasks.filter(function (task) {
    return !pendingTaskDeletions[task.id];
  });

  if (exportable.length === 0) {
    showMessage("אין משימות לייצוא", "error");
    return;
  }

  var rows = [["כותרת", "מטפל", "תורם", "דחיפות", "תאריך יעד", "סטטוס", "תיאור", "נוצר", "הושלם"]];

  exportable.forEach(function (task) {
    rows.push([
      task.title || "",
      task.workerName || "",
      getDonorName(task.donorId),
      task.priority || "",
      task.dueDate || "",
      task.status || "",
      task.description || "",
      task.createdAt ? new Date(task.createdAt).toLocaleString("he-IL") : "",
      task.doneAt ? new Date(task.doneAt).toLocaleString("he-IL") : "",
    ]);
  });

  var today = new Date().toISOString().slice(0, 10);
  downloadXLSX("tasks-" + today + ".xlsx", "משימות", rows);
}

addTaskButton.addEventListener("click", addTask);

descriptionInput.addEventListener("keydown", function (event) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    addTask();
  }
});

titleInput.addEventListener("keydown", function (event) {
  if (event.key === "Enter") {
    addTask();
  }
});

var taskSearchInput = document.getElementById("taskSearchInput");
if (taskSearchInput) {
  taskSearchInput.addEventListener("input", function () {
    taskFilter = taskSearchInput.value.trim();
    taskPage = 0;
    renderTasks();
  });
}

Database.whenReady(function () {
  donors  = Database.get("donors");
  tasks   = Database.get("tasks");
  fillWorkerSelect();
  fillDonorSelect();
  renderTasks();
});

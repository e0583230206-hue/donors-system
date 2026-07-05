let donors = Database.get("donors");

const donorSelect = document.getElementById("donorSelect");
const dateInput = document.getElementById("dateInput");
const timeInput = document.getElementById("timeInput");
const prioritySelect = document.getElementById("prioritySelect");
const descriptionInput = document.getElementById("descriptionInput");
const addReminderButton = document.getElementById("addReminderButton");
const messageBox = document.getElementById("messageBox");

const openRemindersTable = document.getElementById("openRemindersTable");
const doneRemindersTable = document.getElementById("doneRemindersTable");

const openRemindersCount = document.getElementById("openRemindersCount");
const todayRemindersCount = document.getElementById("todayRemindersCount");
const doneRemindersCount = document.getElementById("doneRemindersCount");
const donorsCount = document.getElementById("donorsCount");
const menuOpenCount = document.getElementById("menuOpenCount");
const pendingReminderDeletions = {};
var reminderFilter = "";
var reminderPage = 0;
var REMINDER_PAGE_SIZE = 25;

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

function fillDonorSelect() {
  donorSelect.innerHTML = `<option value="">בחר תורם</option>`;

  donors.forEach(function (donor) {
    const option = document.createElement("option");
    option.value = donor.id;
    option.innerText = donor.fullName + " - " + donor.phone;
    donorSelect.appendChild(option);
  });
}

function ensureReminderArrays() {
  donors.forEach(function (donor) {
    if (!donor.reminders) {
      donor.reminders = [];
    }
  });

  saveDonors();
}

function getAllReminders() {
  const reminders = [];

  donors.forEach(function (donor) {
    if (!donor.reminders) return;

    donor.reminders.forEach(function (reminder) {
      var pendingKey = donor.id + ":" + reminder.id;
      if (pendingReminderDeletions[pendingKey]) return;

      reminders.push({
        donorId: donor.id,
        donorName: donor.fullName,
        donorPhone: donor.phone,
        ...reminder,
      });
    });
  });

  return reminders;
}

function isTodayOrLate(date) {
  if (!date) return false;

  return date <= getTodayString();
}

function getPriorityClass(priority) {
  if (priority === "דחוף") {
    return "red-text";
  }

  if (priority === "חשוב") {
    return "yellow-text";
  }

  return "green-text";
}

function addReminder() {
  const donorId = Number(donorSelect.value);
  const date = dateInput.value;
  const time = timeInput.value;
  const priority = prioritySelect.value;
  const description = descriptionInput.value.trim();

  if (!donorId || date === "" || time === "" || description === "") {
    showMessage("חובה לבחור תורם, תאריך, שעה ותיאור", "error");
    return;
  }

  const donor = donors.find(function (item) {
    return item.id === donorId;
  });

  if (!donor) {
    showMessage("התורם לא נמצא", "error");
    return;
  }

  if (!donor.reminders) {
    donor.reminders = [];
  }

  const newReminder = {
    id: Date.now(),
    date: date,
    time: time,
    priority: priority,
    description: description,
    done: false,
    createdAt: new Date().toISOString(),
    doneAt: "",
  };

  donor.reminders.push(newReminder);

  donor.updatedAt = new Date().toISOString();

  saveDonors();
  AuditLog.record({
    action: "create",
    entityType: "reminder",
    entityId: newReminder.id,
    entityName: donor.fullName,
    details: "נוספה תזכורת לתאריך " + date + " בשעה " + time,
  });

  donorSelect.value = "";
  dateInput.value = "";
  timeInput.value = "";
  prioritySelect.value = "רגיל";
  descriptionInput.value = "";

  showMessage("התזכורת נוספה בהצלחה");
  renderReminders();
}

function markReminderDone(donorId, reminderId) {
  const donor = donors.find(function (item) {
    return item.id === donorId;
  });

  if (!donor || !donor.reminders) return;

  const reminder = donor.reminders.find(function (item) {
    return item.id === reminderId;
  });

  if (!reminder) return;

  reminder.done = true;
  reminder.doneAt = new Date().toLocaleString("he-IL");
  donor.updatedAt = new Date().toISOString();

  saveDonors();
  AuditLog.record({
    action: "complete",
    entityType: "reminder",
    entityId: reminder.id,
    entityName: donor.fullName,
    details: "תזכורת סומנה כבוצעה: " + reminder.description,
  });
  renderReminders();
}

function deleteReminder(donorId, reminderId) {
  const donor = donors.find(function (item) { return item.id === donorId; });
  if (!donor || !donor.reminders) return;

  const deletedReminder = donor.reminders.find(function (item) { return item.id === reminderId; });
  if (!deletedReminder) return;

  donor.reminders = donor.reminders.filter(function (item) { return item.id !== reminderId; });
  donor.updatedAt = new Date().toISOString();
  saveDonors();
  AuditLog.record({
    action: "delete",
    entityType: "reminder",
    entityId: deletedReminder.id,
    entityName: donor.fullName,
    details: "תזכורת נמחקה: " + deletedReminder.description,
  });
  renderReminders();

  if (typeof showToast === "function") {
    showToast("תזכורת נמחקה", function () {
      donor.reminders.push(deletedReminder);
      donor.updatedAt = new Date().toISOString();
      saveDonors();
      renderReminders();
    }, 5000);
  } else {
    showMessage("התזכורת נמחקה בהצלחה");
  }
}

function setReminderPage(n) {
  reminderPage = n;
  renderReminders();
}

function renderReminderPagination(total) {
  var el = document.getElementById("remindersPaginationBar");
  if (!el) return;
  var totalPages = Math.ceil(total / REMINDER_PAGE_SIZE);
  if (totalPages <= 1) { el.innerHTML = ""; return; }
  var html = "";
  for (var i = 0; i < totalPages; i++) {
    html += '<button class="page-btn' + (i === reminderPage ? " active" : "") +
            '" onclick="setReminderPage(' + i + ')">' + (i + 1) + '</button>';
  }
  el.innerHTML = html;
}

function renderStats(allReminders) {
  const open = allReminders.filter(function (reminder) {
    return reminder.done === false;
  });

  const done = allReminders.filter(function (reminder) {
    return reminder.done === true;
  });

  const today = open.filter(function (reminder) {
    return isTodayOrLate(reminder.date);
  });

  openRemindersCount.innerText = open.length;
  todayRemindersCount.innerText = today.length;
  doneRemindersCount.innerText = done.length;
  donorsCount.innerText = donors.length;
  if (menuOpenCount) {
    menuOpenCount.innerText = open.length;
  }
}

function renderOpenReminders(openReminders) {
  openRemindersTable.innerHTML = "";

  if (openReminders.length === 0) {
    openRemindersTable.innerHTML = `
      <tr class="empty-state-row">
        <td colspan="8">🔔 אין תזכורות פתוחות</td>
      </tr>
    `;
    return;
  }

  openReminders.forEach(function (reminder) {
    const row = document.createElement("tr");
    const priorityClass = getPriorityClass(reminder.priority);
    const todayText = isTodayOrLate(reminder.date)
      ? `<span class="red-text">לטיפול היום</span>`
      : `<span class="green-text">עתידי</span>`;

    row.innerHTML = `
      <td>${escapeHTML(reminder.donorName)}</td>
      <td>${reminder.date}</td>
      <td>${reminder.time}</td>
      <td class="${priorityClass}">${reminder.priority}</td>
      <td>${todayText}</td>
      <td>${escapeHTML(reminder.description)}</td>
      <td>
        <a class="small-btn" href="donor.html?id=${reminder.donorId}">
          פתח כרטיס
        </a>
      </td>
      <td>
        <button class="success-btn" onclick="markReminderDone(${reminder.donorId}, ${reminder.id})">
          בוצע
        </button>
        <button class="danger-btn" onclick="deleteReminder(${reminder.donorId}, ${reminder.id})">
          מחק
        </button>
      </td>
    `;

    openRemindersTable.appendChild(row);
  });
}

function renderDoneReminders(doneReminders) {
  doneRemindersTable.innerHTML = "";

  if (doneReminders.length === 0) {
    doneRemindersTable.innerHTML = `
      <tr class="empty-state-row">
        <td colspan="7">✅ אין עדיין תזכורות שבוצעו</td>
      </tr>
    `;
    return;
  }

  doneReminders.forEach(function (reminder) {
    const row = document.createElement("tr");
    const priorityClass = getPriorityClass(reminder.priority);

    row.innerHTML = `
      <td>${escapeHTML(reminder.donorName)}</td>
      <td>${reminder.date}</td>
      <td>${reminder.time}</td>
      <td class="${priorityClass}">${reminder.priority}</td>
      <td>${escapeHTML(reminder.description)}</td>
      <td>${reminder.doneAt || ""}</td>
      <td>
        <button class="danger-btn" onclick="deleteReminder(${reminder.donorId}, ${reminder.id})">
          מחק
        </button>
      </td>
    `;

    doneRemindersTable.appendChild(row);
  });
}

function renderReminders() {
  const allReminders = getAllReminders();

  var q = reminderFilter.toLowerCase();

  var openReminders = allReminders.filter(function (reminder) {
    if (reminder.done !== false) return false;
    if (!q) return true;
    return (
      (reminder.donorName || "").toLowerCase().includes(q) ||
      (reminder.description || "").toLowerCase().includes(q) ||
      (reminder.date || "").includes(q)
    );
  });

  const doneReminders = allReminders.filter(function (reminder) {
    return reminder.done === true;
  });

  openReminders.sort(function (a, b) {
    return (a.date + a.time).localeCompare(b.date + b.time);
  });

  doneReminders.sort(function (a, b) {
    return (b.doneAt || "").localeCompare(a.doneAt || "");
  });

  var pagedOpen = openReminders.slice(reminderPage * REMINDER_PAGE_SIZE, (reminderPage + 1) * REMINDER_PAGE_SIZE);

  renderStats(allReminders);
  renderOpenReminders(pagedOpen);
  renderReminderPagination(openReminders.length);
  renderDoneReminders(doneReminders);
}

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

function exportRemindersExcel() {
  var exportable = getAllReminders();

  if (exportable.length === 0) {
    showMessage("אין תזכורות לייצוא", "error");
    return;
  }

  var rows = [["תורם", "תאריך", "שעה", "עדיפות", "תיאור", "סטטוס", "נוצר", "בוצע בתאריך"]];

  exportable.forEach(function (reminder) {
    rows.push([
      reminder.donorName || "",
      reminder.date || "",
      reminder.time || "",
      reminder.priority || "",
      reminder.description || "",
      reminder.done ? "בוצע" : "פתוח",
      reminder.createdAt ? new Date(reminder.createdAt).toLocaleString("he-IL") : "",
      reminder.doneAt || "",
    ]);
  });

  var today = new Date().toISOString().slice(0, 10);
  downloadXLSX("reminders-" + today + ".xlsx", "תזכורות", rows);
}

addReminderButton.addEventListener("click", addReminder);

descriptionInput.addEventListener("keydown", function (event) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    addReminder();
  }
});

var reminderSearchInput = document.getElementById("reminderSearchInput");
if (reminderSearchInput) {
  reminderSearchInput.addEventListener("input", function () {
    reminderFilter = reminderSearchInput.value.trim();
    reminderPage = 0;
    renderReminders();
  });
}

Database.whenReady(function () {
  donors = Database.get("donors");
  ensureReminderArrays();
  fillDonorSelect();
  renderReminders();
});

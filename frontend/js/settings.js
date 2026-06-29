let workers = [];

const workerNameInput   = document.getElementById("workerNameInput");
const workerRoleInput   = document.getElementById("workerRoleInput");
const workerStatusInput = document.getElementById("workerStatusInput");
const addWorkerButton   = document.getElementById("addWorkerButton");
const messageBox        = document.getElementById("messageBox");

const workersTable = document.getElementById("workersTable");
const workersCount = document.getElementById("workersCount");
const activeWorkersCount = document.getElementById("activeWorkersCount");
const adminsCount = document.getElementById("adminsCount");

const backupButton = document.getElementById("backupButton");
const restoreInput = document.getElementById("restoreInput");

const changePasswordWorkerSelect = document.getElementById("changePasswordWorkerSelect");
const changePasswordInput = document.getElementById("changePasswordInput");
const changePasswordConfirmInput = document.getElementById("changePasswordConfirmInput");
const changePasswordButton = document.getElementById("changePasswordButton");
const changePasswordMessage = document.getElementById("changePasswordMessage");

async function reloadWorkers() {
  try {
    const res = await apiFetch("/api/workers");
    if (res.ok) {
      workers = await res.json();
      localStorage.setItem("workers", JSON.stringify(workers));
    }
  } catch (_) {}
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
  return new Date(dateString).toLocaleDateString("he-IL");
}

async function addWorker() {
  if (!requireAdminAction("רק מנהל יכול להוסיף עובד")) return;

  const name   = workerNameInput.value.trim();
  const role   = workerRoleInput.value;
  const status = workerStatusInput.value;

  if (name === "") {
    showMessage("חובה להכניס שם עובד", "error");
    return;
  }

  try {
    const res = await apiFetch("/api/workers", {
      method: "POST",
      body:   JSON.stringify({ name, role, status }),
    });

    if (!res.ok) {
      const err = await res.json().catch(function () { return {}; });
      showMessage(
        err.error === "Worker with this name already exists"
          ? "עובד בשם הזה כבר קיים"
          : (err.error || "שגיאה בהוספת עובד"),
        "error"
      );
      return;
    }

    const newWorker = await res.json();

    if (typeof AuditLog !== "undefined" && typeof AuditLog.record === "function") {
      AuditLog.record({
        action: "create", entityType: "worker",
        entityId: newWorker.id, entityName: newWorker.name, details: "נוסף עובד חדש",
      });
    }

    workerNameInput.value   = "";
    workerRoleInput.value   = "מזכיר";
    workerStatusInput.value = "פעיל";

    showMessage("העובד נוסף בהצלחה");
    await reloadWorkers();
    renderWorkers();
  } catch (_) {
    showMessage("שגיאה בהתחברות לשרת", "error");
  }
}

async function deleteWorker(id) {
  if (!requireAdminAction("רק מנהל יכול למחוק עובד")) return;

  if (!confirm("האם אתה בטוח שברצונך למחוק עובד זה?")) return;

  const deletedWorker = workers.find(function (w) { return w.id === id; });

  try {
    const res = await apiFetch("/api/workers/" + id, { method: "DELETE" });

    if (!res.ok) {
      const err = await res.json().catch(function () { return {}; });
      showMessage(
        err.error === "Cannot delete the last admin"
          ? "לא ניתן למחוק את המנהל האחרון במערכת"
          : (err.error || "שגיאה במחיקת עובד"),
        "error"
      );
      return;
    }

    if (deletedWorker && typeof AuditLog !== "undefined" && typeof AuditLog.record === "function") {
      AuditLog.record({
        action: "delete", entityType: "worker",
        entityId: deletedWorker.id, entityName: deletedWorker.name, details: "נמחק עובד",
      });
    }

    showMessage("העובד נמחק בהצלחה");
    await reloadWorkers();
    renderWorkers();
  } catch (_) {
    showMessage("שגיאה בהתחברות לשרת", "error");
  }
}

function renderStats() {
  workersCount.innerText = workers.length;

  activeWorkersCount.innerText = workers.filter(function (worker) {
    return worker.status === "פעיל";
  }).length;

  adminsCount.innerText = workers.filter(function (worker) {
    return worker.role === "מנהל";
  }).length;
}

function fillChangePasswordSelect() {
  if (!changePasswordWorkerSelect) return;

  changePasswordWorkerSelect.innerHTML = `<option value="">בחר עובד</option>`;

  workers.forEach(function (worker) {
    const option = document.createElement("option");
    option.value = worker.id;
    option.innerText = worker.name + " - " + worker.role;
    changePasswordWorkerSelect.appendChild(option);
  });
}

function showChangePasswordMessage(text, type = "success") {
  if (!changePasswordMessage) return;
  changePasswordMessage.innerText = text;
  changePasswordMessage.className = "message show " + type;

  setTimeout(function () {
    changePasswordMessage.innerText = "";
    changePasswordMessage.className = "message";
  }, 3000);
}

async function changeWorkerPassword() {
  if (!requireAdminAction("רק מנהל יכול לשנות סיסמה")) return;

  const workerId        = Number(changePasswordWorkerSelect.value);
  const newPassword     = changePasswordInput.value;
  const confirmPassword = changePasswordConfirmInput.value;

  if (!workerId) {
    showChangePasswordMessage("חובה לבחור עובד", "error");
    return;
  }

  if (newPassword === "") {
    showChangePasswordMessage("חובה להכניס סיסמה חדשה", "error");
    return;
  }

  if (newPassword.length < 4) {
    showChangePasswordMessage("הסיסמה חייבת להיות לפחות 4 תווים", "error");
    return;
  }

  if (newPassword !== confirmPassword) {
    showChangePasswordMessage("הסיסמאות אינן תואמות", "error");
    return;
  }

  const worker = workers.find(function (item) { return item.id === workerId; });

  try {
    const res = await apiFetch("/api/workers/" + workerId + "/password", {
      method: "PUT",
      body:   JSON.stringify({ newPassword }),
    });

    if (!res.ok) {
      const err = await res.json().catch(function () { return {}; });
      showChangePasswordMessage(err.error || "שגיאה בשינוי הסיסמה", "error");
      return;
    }

    if (worker && typeof AuditLog !== "undefined" && typeof AuditLog.record === "function") {
      AuditLog.record({
        action: "update", entityType: "worker",
        entityId: worker.id, entityName: worker.name, details: "סיסמת עובד שונתה",
      });
    }

    changePasswordWorkerSelect.value = "";
    changePasswordInput.value        = "";
    changePasswordConfirmInput.value = "";

    showChangePasswordMessage("הסיסמה שונתה בהצלחה");
  } catch (_) {
    showChangePasswordMessage("שגיאה בהתחברות לשרת", "error");
  }
}

function renderWorkers() {
  renderStats();

  workersTable.innerHTML = "";

  if (workers.length === 0) {
    workersTable.innerHTML = `
      <tr class="empty-state-row">
        <td colspan="5">👥 אין עדיין עובדים במערכת</td>
      </tr>
    `;
    fillChangePasswordSelect();
    return;
  }

  workers.forEach(function (worker) {
    const row = document.createElement("tr");

    row.innerHTML = `
      <td>${escapeHTML(worker.name)}</td>
      <td>${escapeHTML(worker.role)}</td>
      <td class="${worker.status === "פעיל" ? "green-text" : "red-text"}">
        ${worker.status}
      </td>
      <td>${formatDate(worker.createdAt)}</td>
      <td>
        <button class="danger-btn" onclick="deleteWorker(${worker.id})">
          מחק
        </button>
      </td>
    `;

    workersTable.appendChild(row);
  });

  fillChangePasswordSelect();
}

function getFullLocalStorageBackup() {
  const storage = {};

  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    storage[key] = localStorage.getItem(key);
  }

  return {
    type: "donors-system-full-backup",
    version: 2,
    createdAt: new Date().toISOString(),
    storage: storage,
  };
}

function downloadBackupFile(backupData, fileName) {
  const blob = new Blob([JSON.stringify(backupData, null, 2)], {
    type: "application/json",
  });

  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(link.href);
}

function getBackupFileName(prefix) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return prefix + "-" + timestamp + ".json";
}

function validateRestoreData(data) {
  const legacyKeys = ["donors", "workers", "tasks", "approvals", "logs"];

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }

  if (
    data.type === "donors-system-full-backup" &&
    data.version === 2 &&
    data.storage &&
    typeof data.storage === "object" &&
    !Array.isArray(data.storage)
  ) {
    const entries = Object.entries(data.storage);

    const allValuesAreStrings = entries.every(function (entry) {
      return typeof entry[0] === "string" && typeof entry[1] === "string";
    });

    if (!allValuesAreStrings) {
      return null;
    }

    for (const key of legacyKeys) {
      if (data.storage[key] !== undefined) {
        try {
          if (!Array.isArray(JSON.parse(data.storage[key]))) {
            return null;
          }
        } catch (error) {
          return null;
        }
      }
    }

    return {
      mode: "full",
      storage: data.storage,
    };
  }

  const hasLegacyData = legacyKeys.some(function (key) {
    return Array.isArray(data[key]);
  });

  if (!hasLegacyData) {
    return null;
  }

  const legacyStorage = {};

  for (const key of legacyKeys) {
    if (data[key] !== undefined) {
      if (!Array.isArray(data[key])) {
        return null;
      }

      legacyStorage[key] = JSON.stringify(data[key]);
    }
  }

  return {
    mode: "legacy",
    storage: legacyStorage,
  };
}

function recordAuditLog(action, entityName, details) {
  if (typeof AuditLog === "undefined" || typeof AuditLog.record !== "function") {
    return;
  }

  AuditLog.record({
    action: action,
    entityType: "system",
    entityId: "localStorage",
    entityName: entityName,
    details: details,
  });
}

// After restoring localStorage, push all data keys to the server so the
// next page load doesn't overwrite the restored data with stale server data.
async function pushRestoredDataToServer() {
  var serverKeys = ["donors", "tasks", "logs", "settings", "approvals"];
  var token = sessionStorage.getItem("authToken") || "";
  if (!token) return;

  var promises = serverKeys.map(function (key) {
    var raw = localStorage.getItem(key);
    if (!raw) return Promise.resolve();
    var data;
    try { data = JSON.parse(raw); } catch (_) { return Promise.resolve(); }
    return fetch("/api/data/" + key, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + token,
      },
      body: JSON.stringify(data),
    }).catch(function () {});
  });

  return Promise.all(promises);
}

function createBackup() {
  const backupData = getFullLocalStorageBackup();

  downloadBackupFile(backupData, getBackupFileName("donors-system-backup"));
  recordAuditLog("backup", "גיבוי מערכת", "בוצע גיבוי מלא של נתוני המערכת");

  showMessage("הגיבוי הורד בהצלחה");
}

function restoreBackup(event) {
  if (!canDeleteSystemData()) {
    showMessage("רק מנהל יכול לבצע שחזור מערכת", "error");
    event.target.value = "";
    return;
  }

  const file = event.target.files[0];

  if (!file) {
    return;
  }

  const confirmRestore = confirm(
    "האם אתה בטוח שברצונך לשחזר? זה יחליף את הנתונים הקיימים.",
  );

  if (!confirmRestore) {
    return;
  }

  const reader = new FileReader();

  reader.onload = function (e) {
    try {
      const data = JSON.parse(e.target.result);
      const restoreData = validateRestoreData(data);

      if (!restoreData) {
        showMessage("קובץ גיבוי לא תקין", "error");
        return;
      }

      downloadBackupFile(
        getFullLocalStorageBackup(),
        getBackupFileName("donors-system-before-restore"),
      );

      if (restoreData.mode === "full") {
        localStorage.clear();
      }

      Object.keys(restoreData.storage).forEach(function (key) {
        localStorage.setItem(key, restoreData.storage[key]);
      });

      recordAuditLog(
        "restore",
        "שחזור מערכת",
        "בוצע שחזור נתוני מערכת מקובץ גיבוי",
      );

      showMessage("השחזור הושלם — מסנכרן עם השרת...");

      pushRestoredDataToServer().finally(function () {
        setTimeout(function () { location.reload(); }, 500);
      });
    } catch (error) {
      showMessage("קובץ גיבוי לא תקין", "error");
    }
  };

  reader.readAsText(file);
}

var restoreAutoBackupButton = document.getElementById("restoreAutoBackupButton");
var listAutoBackupsButton   = document.getElementById("listAutoBackupsButton");
var autoBackupMessage       = document.getElementById("autoBackupMessage");
var autoBackupList          = document.getElementById("autoBackupList");

function getAutoBackupKeys() {
  var keys = [];
  for (var i = 0; i < localStorage.length; i++) {
    var k = localStorage.key(i);
    if (k && k.startsWith("crm_auto_backup_")) keys.push(k);
  }
  return keys.sort().reverse();
}

function showAutoMsg(text, type) {
  if (!autoBackupMessage) return;
  autoBackupMessage.innerText = text;
  autoBackupMessage.className = "message show " + (type || "success");
  setTimeout(function () { autoBackupMessage.className = "message"; autoBackupMessage.innerText = ""; }, 4000);
}

function restoreFromAutoBackup() {
  if (!canDeleteSystemData()) {
    showAutoMsg("רק מנהל יכול לבצע שחזור מערכת", "error");
    return;
  }

  var keys = getAutoBackupKeys();
  if (keys.length === 0) { showAutoMsg("לא נמצא גיבוי אוטומטי", "error"); return; }
  var latestKey  = keys[0];
  var latestDate = latestKey.replace("crm_auto_backup_", "");
  if (!confirm("לשחזר מגיבוי אוטומטי מתאריך " + latestDate + "?")) return;
  try {
    var snap = JSON.parse(localStorage.getItem(latestKey));
    downloadBackupFile(getFullLocalStorageBackup(), getBackupFileName("donors-system-before-auto-restore"));
    Object.keys(snap).forEach(function (k) { localStorage.removeItem(k); });
    Object.keys(snap).forEach(function (k) { localStorage.setItem(k, snap[k]); });
    showAutoMsg("שוחזר בהצלחה מגיבוי " + latestDate + " — מסנכרן עם השרת...");
    pushRestoredDataToServer().finally(function () {
      setTimeout(function () { location.reload(); }, 500);
    });
  } catch (e) {
    showAutoMsg("שגיאה בשחזור הגיבוי", "error");
  }
}

function listAutoBackups() {
  if (!autoBackupList) return;
  var keys = getAutoBackupKeys();
  if (keys.length === 0) {
    autoBackupList.innerHTML = "<li>אין גיבויים אוטומטיים</li>";
    return;
  }
  autoBackupList.innerHTML = keys.map(function (k) {
    var rawDate = k.replace("crm_auto_backup_", "");
    var d = new Date(rawDate);
    var label = isNaN(d.getTime()) ? rawDate : d.toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" });
    return "<li>📦 " + label + "</li>";
  }).join("");
}

if (restoreAutoBackupButton) restoreAutoBackupButton.addEventListener("click", restoreFromAutoBackup);
if (listAutoBackupsButton)   listAutoBackupsButton.addEventListener("click", listAutoBackups);

// ── Currency setting ──────────────────────────────────────────────────────────
var currencySelect  = document.getElementById("currencySelect");
var saveCurrencyBtn = document.getElementById("saveCurrencyButton");
var currencyMsg     = document.getElementById("currencyMessage");

function loadCurrencySetting() {
  if (!currencySelect) return;
  var settings = Database.get("settings");
  if (Array.isArray(settings) || !settings || typeof settings !== "object") settings = {};
  currencySelect.value = settings.currency || "ILS";
}

function saveCurrencySetting() {
  var settings = Database.get("settings");
  if (Array.isArray(settings) || !settings || typeof settings !== "object") settings = {};
  settings.currency = currencySelect.value;
  Database.save("settings", settings);
  if (currencyMsg) {
    currencyMsg.innerText = "המטבע נשמר בהצלחה";
    currencyMsg.className = "message show success";
    setTimeout(function () { currencyMsg.className = "message"; currencyMsg.innerText = ""; }, 3000);
  }
}

if (saveCurrencyBtn) saveCurrencyBtn.addEventListener("click", saveCurrencySetting);
Database.whenReady(function () { loadCurrencySetting(); });
// ─────────────────────────────────────────────────────────────────────────────

addWorkerButton.addEventListener("click", function () {
  addWorker();
});

workerNameInput.addEventListener("keydown", function (event) {
  if (event.key === "Enter") {
    addWorker();
  }
});

if (changePasswordButton) {
  changePasswordButton.addEventListener("click", function () {
    changeWorkerPassword();
  });
}

if (backupButton) {
  backupButton.addEventListener("click", createBackup);
}

if (restoreInput) {
  restoreInput.addEventListener("change", restoreBackup);
}

// Load workers from server then render
reloadWorkers().then(function () { renderWorkers(); });

// ── Forced password change overlay (shown when ?forcePassword=1) ──────────────
(function () {
  if (new URLSearchParams(window.location.search).get("forcePassword") !== "1") return;

  var overlay = document.createElement("div");
  overlay.id = "forcePasswordOverlay";
  overlay.style.cssText = [
    "position:fixed", "inset:0", "background:rgba(0,0,0,0.88)",
    "z-index:9999", "display:flex", "align-items:center", "justify-content:center",
  ].join(";");

  overlay.innerHTML = [
    '<div style="background:var(--bg2,#1e1e2e);padding:32px;border-radius:12px;',
    'max-width:420px;width:90%;direction:rtl;text-align:right;border:2px solid #e74c3c;">',
    '<h2 style="color:#e74c3c;margin-top:0;font-size:20px;">⚠️ שינוי סיסמה נדרש</h2>',
    '<p style="color:var(--muted,#aaa);margin-bottom:20px;font-size:14px;line-height:1.6;">',
    'אתה מחובר עם סיסמת ברירת המחדל. עליך לבחור סיסמה חדשה לפני הכניסה למערכת.</p>',
    '<div style="margin-bottom:14px;">',
    '<label style="display:block;margin-bottom:6px;font-size:14px;">סיסמה חדשה</label>',
    '<input type="password" id="fpNewPass" minlength="4" placeholder="לפחות 4 תווים"',
    ' style="width:100%;box-sizing:border-box;padding:10px;border-radius:6px;',
    'border:1px solid #555;background:var(--bg,#151521);color:inherit;font-size:14px;">',
    '</div>',
    '<div style="margin-bottom:18px;">',
    '<label style="display:block;margin-bottom:6px;font-size:14px;">אימות סיסמה</label>',
    '<input type="password" id="fpConfirmPass" placeholder="חזור על הסיסמה"',
    ' style="width:100%;box-sizing:border-box;padding:10px;border-radius:6px;',
    'border:1px solid #555;background:var(--bg,#151521);color:inherit;font-size:14px;">',
    '</div>',
    '<div id="fpMsg" style="min-height:18px;font-size:13px;margin-bottom:14px;color:#e74c3c;"></div>',
    '<button id="fpBtn" style="width:100%;padding:12px;background:#4ade80;color:#000;',
    'border:none;border-radius:8px;font-size:15px;font-weight:bold;cursor:pointer;">',
    'שמור סיסמה חדשה</button>',
    '</div>',
  ].join("");

  document.body.appendChild(overlay);

  document.getElementById("fpBtn").addEventListener("click", async function () {
    var newPass  = document.getElementById("fpNewPass").value;
    var confirm  = document.getElementById("fpConfirmPass").value;
    var msgEl    = document.getElementById("fpMsg");
    var btn      = document.getElementById("fpBtn");

    if (!newPass || newPass.length < 4) {
      msgEl.textContent = "הסיסמה חייבת להיות לפחות 4 תווים";
      return;
    }
    if (newPass !== confirm) {
      msgEl.textContent = "הסיסמאות אינן תואמות";
      return;
    }

    btn.disabled    = true;
    btn.textContent = "שומר...";

    try {
      var token = sessionStorage.getItem("authToken") || "";
      var res = await fetch("/api/workers/me/password", {
        method:  "PUT",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
        body:    JSON.stringify({ newPassword: newPass }),
      });

      if (!res.ok) {
        var err = await res.json().catch(function () { return {}; });
        msgEl.textContent   = err.error || "שגיאה בשינוי הסיסמה";
        btn.disabled        = false;
        btn.textContent     = "שמור סיסמה חדשה";
        return;
      }

      sessionStorage.removeItem("mustChangePassword");
      overlay.remove();
      window.location.href = "index.html";
    } catch (e) {
      msgEl.textContent = "שגיאה בהתחברות לשרת";
      btn.disabled      = false;
      btn.textContent   = "שמור סיסמה חדשה";
    }
  });

  document.getElementById("fpNewPass").addEventListener("keydown", function (e) {
    if (e.key === "Enter") document.getElementById("fpBtn").click();
  });
  document.getElementById("fpConfirmPass").addEventListener("keydown", function (e) {
    if (e.key === "Enter") document.getElementById("fpBtn").click();
  });
}());

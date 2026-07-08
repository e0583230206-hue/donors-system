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
    row.dataset.workerId = worker.id;

    row.innerHTML = `
      <td>${escapeHTML(worker.name)}</td>
      <td>${escapeHTML(worker.role)}</td>
      <td class="${worker.status === "פעיל" ? "green-text" : "red-text"}">
        ${escapeHTML(worker.status)}
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

// Called from the sessions screen's "פתח עובד" button — this app has no separate
// worker-detail page, so the simplest honest option is to jump to the existing
// worker row in the table above and flash it, rather than invent a new destination.
function scrollToWorker(workerId) {
  var row = document.querySelector('#workersTable tr[data-worker-id="' + workerId + '"]');
  if (!row) {
    if (typeof showToast === "function") showToast("העובד לא נמצא בטבלת העובדים (ייתכן שנמחק)");
    return;
  }
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.classList.add("worker-row-highlight");
  setTimeout(function () { row.classList.remove("worker-row-highlight"); }, 2000);
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

// ── Technoline Mailing List sync ──────────────────────────────────────────────
var mailingListSyncButton  = document.getElementById("mailingListSyncButton");
var mailingListSyncMessage = document.getElementById("mailingListSyncMessage");

function showSyncMsg(text, type) {
  if (!mailingListSyncMessage) return;
  mailingListSyncMessage.innerText = text;
  mailingListSyncMessage.className = "message show " + (type || "success");
  setTimeout(function () { mailingListSyncMessage.className = "message"; mailingListSyncMessage.innerText = ""; }, 5000);
}

if (mailingListSyncButton) {
  mailingListSyncButton.addEventListener("click", async function () {
    if (!requireAdminAction("רק מנהל יכול לסנכרן את רשימת התפוצה")) return;
    mailingListSyncButton.disabled = true;
    mailingListSyncButton.textContent = "מסנכרן...";
    try {
      var res = await apiFetch("/api/technoline/mailing-list/sync", { method: "POST" });
      var data = await res.json();
      if (!res.ok) {
        showSyncMsg(data.error || "שגיאה בסינכרון", "error");
      } else if (data.synced === 0) {
        showSyncMsg("אין מספרים מאושרים לסינכרון", "error");
      } else {
        var r = data.result || {};
        showSyncMsg(
          "סונכרנו " + data.synced + " מספרים. " +
          "חדשים: " + (r.newNumbers || 0) + " | עודכנו: " + (r.updateNumbers || 0) +
          (r.errorNumbers ? " | שגיאות: " + r.errorNumbers : ""),
          "success"
        );
      }
    } catch (_) {
      showSyncMsg("שגיאת תקשורת עם השרת", "error");
    } finally {
      mailingListSyncButton.disabled = false;
      mailingListSyncButton.textContent = "🔄 סנכרן עכשיו";
    }
  });
}

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

// ── Server backup management ──────────────────────────────────────────────────
(function () {
  var runBtn  = document.getElementById("runServerBackupBtn");
  var listBtn = document.getElementById("loadServerBackupsBtn");
  var msgEl   = document.getElementById("serverBackupMsg");
  var listEl  = document.getElementById("serverBackupList");
  if (!runBtn && !listBtn) return;

  function showSrvMsg(txt, type) {
    if (!msgEl) return;
    msgEl.innerText = txt;
    msgEl.className = "message" + (type === "error" ? " error" : type === "success" ? " success" : "");
    setTimeout(function () { msgEl.className = "message"; msgEl.innerText = ""; }, 5000);
  }

  function formatBytes(b) {
    if (b < 1024)       return b + " B";
    if (b < 1048576)    return (b / 1024).toFixed(1) + " KB";
    return (b / 1048576).toFixed(1) + " MB";
  }

  function renderBackupList(files) {
    if (!listEl) return;
    if (!files || files.length === 0) {
      listEl.innerHTML = "<p style='color:var(--muted);font-size:13px;'>אין גיבויים זמינים.</p>";
      return;
    }
    listEl.innerHTML = "<table style='width:100%;border-collapse:collapse;font-size:13px;'>" +
      "<thead><tr style='background:var(--bg2,#f5f5f5);'>" +
        "<th style='padding:6px 10px;text-align:right;border-bottom:1px solid var(--border,#ddd);'>שם קובץ</th>" +
        "<th style='padding:6px 10px;text-align:right;border-bottom:1px solid var(--border,#ddd);'>גודל</th>" +
        "<th style='padding:6px 10px;text-align:right;border-bottom:1px solid var(--border,#ddd);'>תאריך</th>" +
        "<th style='padding:6px 10px;border-bottom:1px solid var(--border,#ddd);'></th>" +
      "</tr></thead><tbody>" +
      files.map(function (f) {
        return "<tr style='border-bottom:1px solid var(--border,#eee);'>" +
          "<td style='padding:6px 10px;direction:ltr;text-align:right;'>" + f.name + "</td>" +
          "<td style='padding:6px 10px;'>" + formatBytes(f.size) + "</td>" +
          "<td style='padding:6px 10px;'>" + new Date(f.mtime).toLocaleString("he-IL") + "</td>" +
          "<td style='padding:6px 10px;'><button class='warning-btn' style='padding:3px 12px;font-size:.82em;' onclick='restoreServerBackup(\"" + f.name + "\")'>♻️ שחזר</button></td>" +
          "</tr>";
      }).join("") +
      "</tbody></table>";
  }

  window.restoreServerBackup = function (filename) {
    if (!confirm("לשחזר את הנתונים מ-" + filename + "?\nהפעולה תדרוס את הנתונים הנוכחיים בשרת.")) return;
    var tok = sessionStorage.getItem("authToken") || "";
    fetch("/api/admin/backups/restore/" + encodeURIComponent(filename), {
      method: "POST",
      headers: { "Authorization": "Bearer " + tok },
    }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok) {
          showSrvMsg("✅ שוחזרו " + data.restored + " קבצים מ-" + filename, "success");
          setTimeout(function () { location.reload(); }, 1500);
        } else {
          showSrvMsg("❌ " + (data.error || "שגיאה בשחזור"), "error");
        }
      })
      .catch(function () { showSrvMsg("❌ שגיאת רשת", "error"); });
  };

  if (listBtn) {
    listBtn.addEventListener("click", function () {
      var tok = sessionStorage.getItem("authToken") || "";
      fetch("/api/admin/backups/list", { headers: { "Authorization": "Bearer " + tok } })
        .then(function (r) { return r.json(); })
        .then(function (files) { renderBackupList(files); })
        .catch(function () { showSrvMsg("❌ שגיאת רשת", "error"); });
    });
  }

  if (runBtn) {
    runBtn.addEventListener("click", function () {
      runBtn.disabled = true;
      var tok = sessionStorage.getItem("authToken") || "";
      fetch("/api/admin/backups/run", { method: "POST", headers: { "Authorization": "Bearer " + tok } })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          runBtn.disabled = false;
          if (data.ok) {
            showSrvMsg("✅ גיבוי נוצר: " + data.name, "success");
            if (listEl && listEl.innerHTML) listBtn && listBtn.click();
          } else {
            showSrvMsg("❌ " + (data.error || "שגיאה"), "error");
          }
        })
        .catch(function () { runBtn.disabled = false; showSrvMsg("❌ שגיאת רשת", "error"); });
    });
  }
}());

// ── ניהול כניסות ויציאות (Sessions) — גלוי למנהלים בלבד ───────────────────────
(function () {
  var panel = document.getElementById("sessionsPanel");
  if (!panel || !isAdmin()) return; // מזכיר לא רואה את האזור הזה כלל, גם לא ה-JS שלו

  panel.style.display = "";

  var currentUser     = getCurrentUser();
  var currentWorkerId = currentUser ? Number(currentUser.id) : null;

  var searchInput      = document.getElementById("sessionsSearchInput");
  var statusFilter     = document.getElementById("sessionsStatusFilter");
  var sortSelect       = document.getElementById("sessionsSortSelect");
  var refreshBtn       = document.getElementById("refreshSessionsBtn");
  var exportBtn        = document.getElementById("exportSessionsBtn");
  var clearBtn         = document.getElementById("clearSessionsFiltersBtn");
  var autoRefreshCheck = document.getElementById("sessionsAutoRefresh");
  var activeTable      = document.getElementById("activeSessionsTable");
  var historyTable     = document.getElementById("sessionsHistoryTable");

  var statActiveNow     = document.getElementById("statActiveNow");
  var statLoginsToday   = document.getElementById("statLoginsToday");
  var statLogoutsToday  = document.getElementById("statLogoutsToday");
  var statTimeoutsToday = document.getElementById("statTimeoutsToday");

  var _rawActive       = [];
  var _rawHistory      = [];
  var _prevActiveBySid = null; // null = first load, don't toast yet
  var _autoRefreshTimer = null;

  // ── Formatting helpers ───────────────────────────────────────────────────────

  function fmtSessionDate(iso) {
    if (!iso) return "—";
    try {
      return new Date(String(iso).replace(" ", "T")).toLocaleString("he-IL", {
        timeZone: "Asia/Jerusalem", hour12: false, dateStyle: "short", timeStyle: "short",
      });
    } catch (_) { return iso; }
  }

  function toMs(iso) {
    if (!iso) return NaN;
    var t = new Date(String(iso).replace(" ", "T")).getTime();
    return isNaN(t) ? NaN : t;
  }

  // Hebrew relative time — shown alongside (never instead of) the absolute date.
  function relativeTimeHe(iso) {
    var ms = Date.now() - toMs(iso);
    if (!isFinite(ms)) return "";
    if (ms < 0) ms = 0;
    var sec = Math.floor(ms / 1000);
    if (sec < 45) return "לפני רגע";
    var min = Math.floor(sec / 60);
    if (min < 60) return min === 1 ? "לפני דקה" : "לפני " + min + " דקות";
    var hr = Math.floor(min / 60);
    if (hr < 24) return hr === 1 ? "לפני שעה" : "לפני " + hr + " שעות";
    var day = Math.floor(hr / 24);
    return day === 1 ? "לפני יום" : "לפני " + day + " ימים";
  }

  function fmtDateWithRelative(iso) {
    if (!iso) return "—";
    var rel = relativeTimeHe(iso);
    return fmtSessionDate(iso) + (rel ? "<br><small style='color:var(--muted)'>" + rel + "</small>" : "");
  }

  function isToday(iso) {
    if (!iso) return false;
    var d = new Date(String(iso).replace(" ", "T"));
    if (isNaN(d.getTime())) return false;
    var fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" });
    return fmt.format(d) === fmt.format(new Date());
  }

  function fmtDuration(ms) {
    if (!isFinite(ms) || ms < 0) return "—";
    var totalMinutes = Math.floor(ms / 60000);
    var days    = Math.floor(totalMinutes / 1440);
    var hours   = Math.floor((totalMinutes % 1440) / 60);
    var minutes = totalMinutes % 60;
    var parts = [];
    if (days)    parts.push(days + " ימים");
    if (hours)   parts.push(hours + " שעות");
    if (minutes || parts.length === 0) parts.push(minutes + " דקות");
    return parts.join(" ו-");
  }

  // Browser + OS parsing. Note: modern Chrome/Edge freeze the Windows UA token at
  // "Windows NT 10.0" for both Windows 10 AND 11 — there is no reliable way to tell
  // them apart from the User-Agent string alone (would need Client Hints + a schema
  // change to persist them), so we show "Windows 10 / 11" rather than guess.
  function parseBrowser(ua) {
    if (!ua) return "לא ידוע";
    if (/Edg\//.test(ua))                                 return "Edge";
    if (/OPR\//.test(ua) || /Opera/i.test(ua))            return "Opera";
    if (/Chrome\//.test(ua) && !/Chromium/.test(ua))      return "Chrome";
    if (/Firefox\//.test(ua))                             return "Firefox";
    if (/Safari\//.test(ua) && !/Chrome\//.test(ua))      return "Safari";
    return "לא ידוע";
  }

  function parseOS(ua) {
    if (!ua) return "לא ידוע";
    var winMatch = ua.match(/Windows NT ([\d.]+)/);
    if (winMatch) {
      if (winMatch[1] === "10.0") return "Windows 10 / 11";
      if (winMatch[1] === "6.3")  return "Windows 8.1";
      if (winMatch[1] === "6.2")  return "Windows 8";
      if (winMatch[1] === "6.1")  return "Windows 7";
      return "Windows";
    }
    var androidMatch = ua.match(/Android ([\d.]+)/);
    if (androidMatch) return "Android " + androidMatch[1];
    if (/iPhone|iPad|iOS/.test(ua)) return "iOS";
    if (/Mac OS X/.test(ua))        return "Mac";
    if (/Linux/.test(ua))           return "Linux";
    return "לא ידוע";
  }

  var STATUS_HTML = {
    active:        '<span style="color:#1a7a1a;font-weight:600">🟢 מחובר</span>',
    logout:        '<span style="color:#777;font-weight:600">⚪ מנותק</span>',
    timeout:       '<span style="color:#b00;font-weight:600">🔴 פג תוקף</span>',
    forced_logout: '<span style="color:#e07b00;font-weight:600">🟠 נותק ע"י מנהל</span>',
  };
  var STATUS_TEXT = {
    active: "מחובר", logout: "מנותק", timeout: "פג תוקף", forced_logout: 'נותק ע"י מנהל',
  };
  var END_REASON_TEXT = {
    active: "עדיין מחובר", logout: "יציאה רגילה", timeout: "פג תוקף", forced_logout: 'נותק ע"י מנהל',
  };
  var ROW_STATUS_CLASS = {
    active: "row-status-active", logout: "row-status-logout",
    timeout: "row-status-timeout", forced_logout: "row-status-forced_logout",
  };

  function statusHtml(status)  { return STATUS_HTML[status] || escapeHTML(status || "—"); }
  function statusText(status)  { return STATUS_TEXT[status] || (status || "—"); }
  function rowClass(status)    { return ROW_STATUS_CLASS[status] || ""; }

  // Recognizes admin-initiated disconnects in the Audit Log regardless of exactly
  // which action string was used ("force_logout" is what this app actually writes;
  // the others are matched defensively in case older/other code paths used them).
  var ADMIN_DISCONNECT_ACTIONS = ["force_logout", "forced_logout", "ended_by_admin"];
  function isAdminDisconnectAction(action) {
    if (!action) return false;
    var a = String(action).toLowerCase();
    return ADMIN_DISCONNECT_ACTIONS.indexOf(a) !== -1 || a.indexOf("force") !== -1;
  }

  function lastActionText(row) {
    if (!row.lastAction || !row.lastAction.details) return "לא ידוע";
    return row.lastAction.details + " (" + fmtSessionDate(row.lastAction.createdAt) + ")";
  }

  function shortSessionId(sessionId) {
    if (!sessionId) return "—";
    return String(sessionId).slice(0, 8);
  }

  // ── Row model builders ───────────────────────────────────────────────────────

  function buildActiveRow(s) {
    return {
      sessionId: s.sessionId, sessionIdShort: shortSessionId(s.sessionId), workerId: s.workerId,
      workerName: s.workerName || "—", role: s.workerRole || "—",
      loginAt: s.loginAt, lastHeartbeat: s.lastHeartbeat,
      durationMs: Date.now() - toMs(s.loginAt),
      ip: s.ip || "—", browser: parseBrowser(s.userAgent), os: parseOS(s.userAgent),
      status: s.status || "active", lastAction: s.lastAction,
    };
  }

  function buildHistoryRow(s) {
    var endMs = s.logoutAt ? toMs(s.logoutAt) : toMs(s.lastHeartbeat);
    return {
      sessionId: s.sessionId, sessionIdShort: shortSessionId(s.sessionId), workerId: s.workerId,
      workerName: s.workerName || "—", role: s.workerRole || "—",
      loginAt: s.loginAt, logoutAt: s.logoutAt, durationMs: endMs - toMs(s.loginAt),
      ip: s.ip || "—", browser: parseBrowser(s.userAgent), os: parseOS(s.userAgent),
      status: s.status || "active", lastAction: s.lastAction,
    };
  }

  // Count of *currently active* sessions sharing the same workerId — recomputed
  // from _rawActive on every render so it always reflects live data, not stale.
  function countActiveConnections(workerId) {
    var n = 0;
    _rawActive.forEach(function (s) { if (Number(s.workerId) === Number(workerId)) n++; });
    return n;
  }

  // ── Search / filter / sort (shared toolbar, applied to both tables) ──────────

  function matchesSearch(row, q) {
    if (!q) return true;
    q = q.toLowerCase();
    return (row.workerName     || "").toLowerCase().indexOf(q) !== -1 ||
           (row.ip             || "").toLowerCase().indexOf(q) !== -1 ||
           (row.browser        || "").toLowerCase().indexOf(q) !== -1 ||
           (row.os             || "").toLowerCase().indexOf(q) !== -1 ||
           // Only the 8-char id shown in the table is searchable — never the full sessionId.
           (row.sessionIdShort || "").toLowerCase().indexOf(q) !== -1;
  }

  function applyControls(rows) {
    var q      = (searchInput  && searchInput.value.trim()) || "";
    var status = (statusFilter && statusFilter.value)       || "";
    var sortBy = (sortSelect   && sortSelect.value)          || "lastHeartbeat-desc";

    var filtered = rows.filter(function (r) {
      return matchesSearch(r, q) && (!status || r.status === status);
    });

    var parts = sortBy.split("-");
    var field = parts[0], dir = parts[1] === "asc" ? 1 : -1;

    filtered.sort(function (a, b) {
      if (field === "workerName") return dir * (a.workerName || "").localeCompare(b.workerName || "", "he");
      var av, bv;
      if (field === "duration")       { av = a.durationMs || 0;          bv = b.durationMs || 0; }
      else if (field === "loginAt")   { av = toMs(a.loginAt)  || 0;      bv = toMs(b.loginAt)  || 0; }
      else if (field === "logoutAt")  { av = toMs(a.logoutAt) || 0;      bv = toMs(b.logoutAt) || 0; }
      else                            { av = toMs(a.lastHeartbeat) || 0; bv = toMs(b.lastHeartbeat) || 0; }
      return dir * (av - bv);
    });

    return filtered;
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  function activityBtn(workerId, workerName) {
    return '<button class="secondary-btn session-activity-btn" data-worker-id="' + escapeHTML(workerId) +
      '" data-worker-name="' + escapeHTML(workerName) + '" style="padding:4px 10px;font-size:.82em;">🕘 פעילות אחרונה</button>';
  }

  // "פתח עובד" — no dedicated worker-detail page exists in this app, so this jumps
  // to (and flashes) the worker's row in the "רשימת עובדים" table further up the page.
  function workerNameCell(workerId, workerName) {
    return escapeHTML(workerName) +
      ' <button type="button" onclick="scrollToWorker(' + Number(workerId) + ')" class="secondary-btn" ' +
      'style="padding:1px 7px;font-size:.75em;margin-right:4px;">פתח עובד</button>';
  }

  function renderActive() {
    if (!activeTable) return;
    var rows = applyControls(_rawActive.map(buildActiveRow));
    if (rows.length === 0) {
      activeTable.innerHTML = '<tr><td colspan="13" style="text-align:center;color:var(--muted)">אין משתמשים מחוברים כרגע</td></tr>';
      return;
    }
    activeTable.innerHTML = rows.map(function (r) {
      var isSelf = currentWorkerId != null && Number(r.workerId) === currentWorkerId;
      var disconnectCell = isSelf
        ? '<span style="color:var(--muted);font-size:.85em;">המשתמש שלך</span>'
        : '<button class="danger-btn session-disconnect-btn" data-session-id="' + escapeHTML(r.sessionId) +
          '" data-worker-name="' + escapeHTML(r.workerName) + '" style="padding:4px 10px;font-size:.82em;">נתק משתמש</button>';
      var connCount = countActiveConnections(r.workerId);
      return "<tr class='" + rowClass(r.status) + "'>" +
        "<td>" + workerNameCell(r.workerId, r.workerName) + "</td>" +
        "<td>" + escapeHTML(r.role) + "</td>" +
        "<td>" + fmtDateWithRelative(r.loginAt) + "</td>" +
        "<td>" + fmtDateWithRelative(r.lastHeartbeat) + "</td>" +
        "<td>" + fmtDuration(r.durationMs) + "</td>" +
        "<td>" + connCount + " חיבור" + (connCount === 1 ? "" : "ים") + "</td>" +
        "<td dir='ltr' style='font-family:monospace;font-size:.85em' title='מזהה חלקי — לא הטוקן המלא'>" + escapeHTML(shortSessionId(r.sessionId)) + "</td>" +
        "<td dir='ltr'>" + escapeHTML(r.ip) + "</td>" +
        "<td>" + escapeHTML(r.browser) + "</td>" +
        "<td>" + escapeHTML(r.os) + "</td>" +
        "<td>" + statusHtml(r.status) + "</td>" +
        "<td>" + activityBtn(r.workerId, r.workerName) + "</td>" +
        "<td>" + disconnectCell + "</td>" +
        "</tr>";
    }).join("");
  }

  function renderHistory() {
    if (!historyTable) return;
    var rows = applyControls(_rawHistory.map(buildHistoryRow)).slice(0, 100);
    if (rows.length === 0) {
      historyTable.innerHTML = '<tr><td colspan="12" style="text-align:center;color:var(--muted)">אין היסטוריה עדיין</td></tr>';
      return;
    }
    historyTable.innerHTML = rows.map(function (r) {
      return "<tr class='" + rowClass(r.status) + "'>" +
        "<td>" + workerNameCell(r.workerId, r.workerName) + "</td>" +
        "<td>" + escapeHTML(r.role) + "</td>" +
        "<td>" + fmtDateWithRelative(r.loginAt) + "</td>" +
        "<td>" + fmtDateWithRelative(r.logoutAt) + "</td>" +
        "<td>" + fmtDuration(r.durationMs) + "</td>" +
        "<td>" + escapeHTML(END_REASON_TEXT[r.status] || "—") + "</td>" +
        "<td dir='ltr' style='font-family:monospace;font-size:.85em' title='מזהה חלקי — לא הטוקן המלא'>" + escapeHTML(shortSessionId(r.sessionId)) + "</td>" +
        "<td dir='ltr'>" + escapeHTML(r.ip) + "</td>" +
        "<td>" + escapeHTML(r.browser) + "</td>" +
        "<td>" + escapeHTML(r.os) + "</td>" +
        "<td>" + statusHtml(r.status) + "</td>" +
        "<td>" + activityBtn(r.workerId, r.workerName) + "</td>" +
        "</tr>";
    }).join("");
  }

  function renderStats() {
    if (statActiveNow)     statActiveNow.textContent     = _rawActive.length;
    if (statLoginsToday)   statLoginsToday.textContent   = _rawHistory.filter(function (s) { return isToday(s.loginAt); }).length;
    if (statLogoutsToday)  statLogoutsToday.textContent  = _rawHistory.filter(function (s) { return s.status === "logout"  && isToday(s.logoutAt); }).length;
    if (statTimeoutsToday) statTimeoutsToday.textContent = _rawHistory.filter(function (s) { return s.status === "timeout" && isToday(s.logoutAt); }).length;
  }

  function renderAll() {
    renderStats();
    renderActive();
    renderHistory();
  }

  // ── New-login / disconnect toasts ────────────────────────────────────────────
  // Only fires from the 2nd successful load onward, so opening the panel never
  // spams a toast per already-connected user.

  function notifySessionChanges(newActive) {
    var newBySid = {};
    newActive.forEach(function (s) { newBySid[s.sessionId] = s; });

    if (_prevActiveBySid !== null && typeof showToast === "function") {
      Object.keys(newBySid).forEach(function (sid) {
        if (!_prevActiveBySid[sid]) showToast("🟢 משתמש חדש התחבר: " + newBySid[sid].workerName);
      });
      Object.keys(_prevActiveBySid).forEach(function (sid) {
        if (!newBySid[sid]) showToast("🔴 משתמש התנתק: " + _prevActiveBySid[sid].workerName);
      });
    }

    _prevActiveBySid = newBySid;
  }

  // ── Data loading ─────────────────────────────────────────────────────────────

  function loadSessionsPanel() {
    apiFetch("/api/admin/sessions")
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        var newActive = data.active || [];
        notifySessionChanges(newActive);
        _rawActive  = newActive;
        _rawHistory = data.history || [];
        renderAll();
      })
      .catch(function (err) {
        console.error("[Sessions]", err);
        var msg = '<tr><td colspan="13" style="text-align:center;color:#b00">שגיאה בטעינת נתונים</td></tr>';
        if (activeTable)  activeTable.innerHTML  = msg;
        if (historyTable) historyTable.innerHTML = msg;
      });
  }

  // ── Auto-refresh every 30s (opt-in) ──────────────────────────────────────────

  function updateAutoRefresh() {
    if (_autoRefreshTimer) { clearInterval(_autoRefreshTimer); _autoRefreshTimer = null; }
    if (autoRefreshCheck && autoRefreshCheck.checked) {
      _autoRefreshTimer = setInterval(loadSessionsPanel, 30000);
    }
  }
  if (autoRefreshCheck) autoRefreshCheck.addEventListener("change", updateAutoRefresh);

  // ── Disconnect user remotely ─────────────────────────────────────────────────

  if (activeTable) {
    activeTable.addEventListener("click", function (e) {
      var btn = e.target.closest(".session-disconnect-btn");
      if (!btn) return;
      var sessionId  = btn.dataset.sessionId;
      var workerName = btn.dataset.workerName;
      if (!sessionId) return;
      if (!confirm('לנתק את המשתמש "' + workerName + '" מהמערכת?\n\nהמשתמש יקבל הודעה ויועבר להתחברות מחדש.')) return;

      btn.disabled    = true;
      btn.textContent = "מנתק...";
      apiFetch("/api/admin/sessions/" + encodeURIComponent(sessionId) + "/force-logout", { method: "POST" })
        .then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (data) {
            return { ok: res.ok, data: data };
          });
        })
        .then(function (result) {
          if (!result.ok) {
            alert(result.data.error || "שגיאה בניתוק המשתמש");
            btn.disabled    = false;
            btn.textContent = "נתק משתמש";
            return;
          }
          if (typeof showToast === "function") showToast('המשתמש "' + workerName + '" נותק בהצלחה');
          loadSessionsPanel();
        })
        .catch(function () {
          alert("שגיאת תקשורת עם השרת");
          btn.disabled    = false;
          btn.textContent = "נתק משתמש";
        });
    });
  }

  // ── "פעילות אחרונה" modal — last 10 audit-log entries for one worker ─────────

  var activityModal = null;

  function ensureActivityModal() {
    if (activityModal) return activityModal;
    var backdrop = document.createElement("div");
    backdrop.className = "mini-modal-backdrop";
    backdrop.style.display = "none";
    backdrop.innerHTML =
      '<div class="mini-modal">' +
        '<div class="mini-modal-header">' +
          '<h3 id="activityModalTitle">פעילות אחרונה</h3>' +
          '<button type="button" class="mini-modal-close" id="activityModalClose">✕</button>' +
        '</div>' +
        '<div class="mini-modal-body" id="activityModalBody">טוען...</div>' +
      '</div>';
    document.body.appendChild(backdrop);

    backdrop.addEventListener("click", function (e) {
      if (e.target === backdrop) closeActivityModal();
    });
    backdrop.querySelector("#activityModalClose").addEventListener("click", closeActivityModal);

    activityModal = backdrop;
    return backdrop;
  }

  function closeActivityModal() {
    if (activityModal) activityModal.style.display = "none";
  }

  function openActivityModal(workerId, workerName) {
    var modal = ensureActivityModal();
    var title = modal.querySelector("#activityModalTitle");
    var body  = modal.querySelector("#activityModalBody");
    title.textContent = "🕘 פעילות אחרונה — " + workerName;
    body.innerHTML = "טוען...";
    modal.style.display = "flex";

    apiFetch("/api/admin/workers/" + encodeURIComponent(workerId) + "/audit-log?limit=10")
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        var logs  = (data && Array.isArray(data.logs)) ? data.logs : [];
        var total = (data && typeof data.total === "number") ? data.total : null;

        if (logs.length === 0) {
          body.innerHTML = '<p style="color:var(--muted);text-align:center;margin:10px 0;">לא נמצאו פעולות אחרונות</p>';
          return;
        }

        var caption = total != null && total > logs.length
          ? logs.length + " הפעולות האחרונות מתוך " + total
          : logs.length + " הפעולות האחרונות";

        body.innerHTML =
          '<p style="color:var(--muted);font-size:.85em;margin:0 0 10px;">' + escapeHTML(caption) + '</p>' +
          '<table style="width:100%;border-collapse:collapse;font-size:.9em;">' +
          '<thead><tr>' +
            '<th style="text-align:right;padding:6px 8px;border-bottom:1px solid var(--border);">תאריך ושעה</th>' +
            '<th style="text-align:right;padding:6px 8px;border-bottom:1px solid var(--border);">סוג פעולה</th>' +
            '<th style="text-align:right;padding:6px 8px;border-bottom:1px solid var(--border);">תיאור</th>' +
          '</tr></thead><tbody>' +
          logs.map(function (l) {
            var rowStyle = isAdminDisconnectAction(l.action) ? " style='background:var(--warning-soft)'" : "";
            return "<tr" + rowStyle + ">" +
              "<td style='padding:6px 8px;border-bottom:1px solid var(--border);white-space:nowrap'>" +
                fmtSessionDate(l.createdAt) + "<br><small style='color:var(--muted)'>" + relativeTimeHe(l.createdAt) + "</small></td>" +
              "<td style='padding:6px 8px;border-bottom:1px solid var(--border);font-family:monospace;font-size:.9em'>" + escapeHTML(l.action || "—") + "</td>" +
              "<td style='padding:6px 8px;border-bottom:1px solid var(--border);'>" + escapeHTML(l.details || "—") + "</td>" +
              "</tr>";
          }).join("") +
          "</tbody></table>";
      })
      .catch(function () {
        body.innerHTML = '<p style="color:#b00;text-align:center;margin:10px 0;">שגיאה בטעינת הפעילות</p>';
      });
  }

  [activeTable, historyTable].forEach(function (table) {
    if (!table) return;
    table.addEventListener("click", function (e) {
      var btn = e.target.closest(".session-activity-btn");
      if (!btn) return;
      openActivityModal(btn.dataset.workerId, btn.dataset.workerName);
    });
  });

  // ── Export to Excel ──────────────────────────────────────────────────────────

  function exportToExcel() {
    if (typeof XLSX === "undefined") { alert("ספריית ייצוא לא נטענה"); return; }

    var activeRows = applyControls(_rawActive.map(buildActiveRow)).map(function (r) {
      return {
        "עובד": r.workerName, "תפקיד": r.role,
        "זמן כניסה": fmtSessionDate(r.loginAt), "פעילות אחרונה": fmtSessionDate(r.lastHeartbeat),
        "משך התחברות": fmtDuration(r.durationMs),
        "חיבורים פעילים": countActiveConnections(r.workerId),
        "מזהה סשן": shortSessionId(r.sessionId),
        "IP": r.ip, "דפדפן": r.browser, "מערכת הפעלה": r.os,
        "פעולה אחרונה": lastActionText(r), "סטטוס": statusText(r.status),
      };
    });

    var historyRows = applyControls(_rawHistory.map(buildHistoryRow)).map(function (r) {
      return {
        "עובד": r.workerName, "תפקיד": r.role,
        "כניסה": fmtSessionDate(r.loginAt), "יציאה": fmtSessionDate(r.logoutAt),
        "משך סשן": fmtDuration(r.durationMs), "סיבת סיום": END_REASON_TEXT[r.status] || "—",
        "מזהה סשן": shortSessionId(r.sessionId),
        "IP": r.ip, "דפדפן": r.browser, "מערכת הפעלה": r.os, "סטטוס": statusText(r.status),
        "פעולה אחרונה": lastActionText(r),
      };
    });

    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(activeRows),  "מחוברים עכשיו");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(historyRows), "היסטוריה");
    XLSX.writeFile(wb, "sessions-" + new Date().toISOString().slice(0, 10) + ".xlsx");
  }

  // ── Wiring ───────────────────────────────────────────────────────────────────

  if (refreshBtn)   refreshBtn.addEventListener("click", loadSessionsPanel);
  if (exportBtn)    exportBtn.addEventListener("click", exportToExcel);
  if (searchInput)  searchInput.addEventListener("input", renderAll);
  if (statusFilter) statusFilter.addEventListener("change", renderAll);
  if (sortSelect)   sortSelect.addEventListener("change", renderAll);
  if (clearBtn) {
    clearBtn.addEventListener("click", function () {
      if (searchInput)  searchInput.value  = "";
      if (statusFilter) statusFilter.value = "";
      if (sortSelect)   sortSelect.value   = "lastHeartbeat-desc";
      renderAll();
    });
  }

  loadSessionsPanel();
}());

// ── Settings tabs ─────────────────────────────────────────────────────────────
(function () {
  var tabButtons = document.querySelectorAll(".settings-tab-btn");
  var tabPanels  = document.querySelectorAll("[data-tab-panel]");
  if (!tabButtons.length) return;

  var admin = typeof isAdmin === "function" && isAdmin();

  // Admin-only tabs — hide the button entirely for non-admins (same visibility
  // rule the sessions panel already used, just applied to the tab button too).
  ["ivr-audio", "sessions"].forEach(function (name) {
    if (admin) return;
    var btn = document.querySelector('.settings-tab-btn[data-tab="' + name + '"]');
    if (btn) btn.style.display = "none";
  });

  function activate(tabName) {
    tabButtons.forEach(function (btn) {
      btn.classList.toggle("active", btn.dataset.tab === tabName);
    });
    tabPanels.forEach(function (panel) {
      panel.style.display = panel.getAttribute("data-tab-panel") === tabName ? "" : "none";
    });
    try { window.location.hash = tabName; } catch (_) {}
  }

  var allowedTabs = Array.prototype.map.call(tabButtons, function (b) { return b.dataset.tab; })
    .filter(function (name) { return admin || (name !== "ivr-audio" && name !== "sessions"); });

  tabButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      if (btn.style.display === "none") return;
      activate(btn.dataset.tab);
    });
  });

  var initial = (window.location.hash || "").replace("#", "");
  if (allowedTabs.indexOf(initial) === -1) {
    initial = admin ? "ivr-audio" : "workers";
  }
  activate(initial);
}());

// ── IVR Audio Recordings tab ("ניהול הקלטות") ─────────────────────────────────
// Staging/management tool for the future Yiddish IVR recordings. Talks only to
// /api/admin/ivr-audio/* (admin-only on the server). Does not touch Technoline
// or ivr.js/ivr.service.js in any way.
(function () {
  var tableBody = document.getElementById("ivrAudioTableBody");
  if (!tableBody || typeof isAdmin !== "function" || !isAdmin()) return;

  var searchInput  = document.getElementById("ivrAudioSearchInput");
  var statusFilter = document.getElementById("ivrAudioStatusFilter");
  var addRowBtn    = document.getElementById("ivrAudioAddRowBtn");
  var exportXlsBtn = document.getElementById("ivrAudioExportExcelBtn");
  var exportJsonBtn= document.getElementById("ivrAudioExportJsonBtn");
  var importFile   = document.getElementById("ivrAudioImportFile");
  var refreshBtn   = document.getElementById("ivrAudioRefreshBtn");
  var msgEl        = document.getElementById("ivrAudioMessage");
  var sheetTabsEl  = document.getElementById("ivrSheetTabs");

  // Categories that belong on גיליון1 (fixed sentences) vs גיליון2 (numbers/
  // currency) when exporting back to the exact Excel structure. Also used to
  // split the two internal sheet-tabs in the UI itself. "ident" = the caller-
  // identification texts added after the frozen v1.0 73-row spec — fixed
  // sentences, not numbers, so they belong on גיליון1 too.
  var SHEET1_CATEGORIES = ["open", "menu", "debt", "pay", "voicemail", "system", "purpose", "ident"];
  var activeSheet = "sentences"; // "sentences" | "numbers"

  // Fields that support Excel-style multi-cell paste, in on-screen column
  // order. pasteMatrix[rowIndex][fieldIndex] holds the live <textarea> for
  // that cell in the currently rendered (filtered) row order.
  var PASTE_FIELDS = ["sourceTextHe", "translation", "usageDescription"];
  var pasteMatrix = [];
  var renderedRows = [];

  var statTotal      = document.getElementById("ivrAudioStatTotal");
  var statMissing     = document.getElementById("ivrAudioStatMissing");
  var statTranslated  = document.getElementById("ivrAudioStatTranslated");
  var statRecorded    = document.getElementById("ivrAudioStatRecorded");
  var statApproved    = document.getElementById("ivrAudioStatApproved");

  var STATUSES   = ["חסר", "תורגם", "הוקלט", "נבדק", "אושר"];
  var STATUS_CSS = { "חסר": "missing", "תורגם": "translated", "הוקלט": "recorded", "נבדק": "checked", "אושר": "approved" };

  var allRecordings = [];

  function showMsg(text, type) {
    if (!msgEl) return;
    msgEl.innerText = text;
    msgEl.className = "message show " + (type || "success");
    clearTimeout(showMsg._t);
    showMsg._t = setTimeout(function () {
      msgEl.innerText = "";
      msgEl.className = "message";
    }, 3000);
  }

  async function loadRecordings() {
    tableBody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--muted)">טוען...</td></tr>';
    try {
      var res = await apiFetch("/api/admin/ivr-audio");
      if (!res.ok) throw new Error("שגיאה בטעינת הרשימה");
      allRecordings = await res.json();
      render();
      updateStats();
    } catch (err) {
      tableBody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--danger)">שגיאה בטעינה: ' + escapeHTML(err.message) + "</td></tr>";
    }
  }

  function updateStats() {
    var counts = { total: allRecordings.length };
    STATUSES.forEach(function (s) { counts[s] = 0; });
    allRecordings.forEach(function (r) { counts[r.status] = (counts[r.status] || 0) + 1; });
    if (statTotal)      statTotal.innerText      = counts.total;
    if (statMissing)     statMissing.innerText     = counts["חסר"]   || 0;
    if (statTranslated)  statTranslated.innerText  = counts["תורגם"] || 0;
    if (statRecorded)    statRecorded.innerText    = counts["הוקלט"] || 0;
    if (statApproved)    statApproved.innerText    = counts["אושר"] || 0;
  }

  function matchesSheet(rec) {
    var inSheet1 = SHEET1_CATEGORIES.indexOf(rec.category) !== -1;
    return activeSheet === "sentences" ? inSheet1 : !inSheet1;
  }

  function matchesFilters(rec, query, status) {
    if (status && rec.status !== status) return false;
    if (!query) return true;
    var hay = [rec.audioId, rec.sourceTextHe, rec.translation, rec.usageDescription, rec.status]
      .join(" ").toLowerCase();
    return hay.indexOf(query.toLowerCase()) !== -1;
  }

  function render() {
    var query  = (searchInput  && searchInput.value.trim())  || "";
    var status = (statusFilter && statusFilter.value)        || "";
    var rows = allRecordings
      .filter(matchesSheet)
      .filter(function (r) { return matchesFilters(r, query, status); });

    renderedRows = rows;
    pasteMatrix = rows.map(function () { return []; });

    // Rows about to be discarded may hold a still-playing <audio> that isn't
    // attached to the DOM (custom play button, not a native <audio> element)
    // — stop it now or it would keep playing silently in the background.
    if (activeAudioEl) { activeAudioEl.pause(); activeAudioEl = null; }

    tableBody.innerHTML = "";
    if (!rows.length) {
      tableBody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--muted)">אין הקלטות להצגה בגליון זה</td></tr>';
      return;
    }
    rows.forEach(function (rec, rowIdx) { tableBody.appendChild(buildRow(rec, rowIdx)); });
  }

  function buildRow(rec, rowIdx) {
    var tr = document.createElement("tr");

    var tdId = document.createElement("td");
    tdId.className = "ivr-audio-id-cell";
    tdId.textContent = rec.audioId;
    tr.appendChild(tdId);

    tr.appendChild(makeInputCell(rec, "sourceTextHe", rowIdx, 0));
    tr.appendChild(makeInputCell(rec, "translation", rowIdx, 1));
    tr.appendChild(makeInputCell(rec, "usageDescription", rowIdx, 2));
    tr.appendChild(buildAudioCell(rec, 1));
    tr.appendChild(buildAudioCell(rec, 2));
    tr.appendChild(buildAudioCell(rec, 3));
    tr.appendChild(buildStatusCell(rec));

    return tr;
  }

  // Cached height (in px) of a single-line .ivr-audio-field, used to tell
  // whether a given field is currently showing just 1 visual line (the
  // common case) or has grown to 2+ (long/wrapped content).
  var singleLineHeightPx = null;
  function getSingleLineHeight() {
    if (singleLineHeightPx !== null) return singleLineHeightPx;
    var probe = document.createElement("textarea");
    probe.className = "ivr-audio-field";
    probe.rows = 1;
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    document.body.appendChild(probe);
    singleLineHeightPx = probe.scrollHeight;
    document.body.removeChild(probe);
    return singleLineHeightPx;
  }

  // A field showing only 1 visual line has no "up" or "down" caret position
  // to move to within its own text, so Up/Down should leave the cell on the
  // very first press — matching a single Excel keystroke. Multi-line /
  // wrapped content (2+ visual lines) still gets natural in-text movement
  // first (see handleCellKeydown), only leaving the cell once the caret is
  // already at the text's absolute start/end.
  function isSingleLine(el) {
    return el.scrollHeight <= getSingleLineHeight() + 2;
  }

  // Auto-grows a compact textarea to fit its content (up to the CSS
  // max-height cap, after which it scrolls internally) so short cells stay
  // one line tall and long ones stay readable without a permanently tall row.
  function autoGrow(el) {
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }

  function makeInputCell(rec, field, rowIdx, fieldIdx) {
    var td = document.createElement("td");
    var el = document.createElement("textarea");
    el.className = "ivr-audio-field";
    el.rows = 1;
    el.value = rec[field] || "";
    el.addEventListener("input", function () { autoGrow(el); });
    el.addEventListener("focus", function () { autoGrow(el); });
    el.addEventListener("change", function () { saveField(rec.audioId, field, el.value); });
    el.addEventListener("paste", function (e) { handlePaste(e, rowIdx, fieldIdx); });
    el.addEventListener("keydown", function (e) { handleCellKeydown(e, el, rowIdx, fieldIdx); });
    td.appendChild(el);
    pasteMatrix[rowIdx][fieldIdx] = el;
    // Initial sizing happens after insertion (scrollHeight needs layout).
    setTimeout(function () { autoGrow(el); }, 0);
    return td;
  }

  function getCell(rowIdx, fieldIdx) {
    return pasteMatrix[rowIdx] && pasteMatrix[rowIdx][fieldIdx];
  }

  // Selecting all text on arrival mirrors Excel/Sheets, where landing on a
  // cell via keyboard navigation shows it "selected" (ready to be typed over).
  function focusCell(el) {
    if (!el) return false;
    el.focus();
    el.select();
    return true;
  }

  // Excel-style keyboard navigation between the editable text cells:
  //  - Tab / Shift+Tab: next / previous cell, wrapping to the next/previous row.
  //  - Enter: down one row, same column (Shift+Enter inserts a literal newline).
  //  - Arrow keys: navigate to the adjacent cell, but ONLY when the native
  //    arrow press has no effect on the caret — i.e. it's already at the edge
  //    of the text in that direction. This is checked by letting the browser
  //    handle the key normally first, then comparing the caret position a
  //    tick later; if unchanged, the browser had nowhere left to move it, so
  //    we treat the key as "leave the cell" instead. This correctly handles
  //    multi-line/wrapped text and RTL bidi caret physics (in an RTL field,
  //    the browser itself moves ArrowLeft toward the logical end and
  //    ArrowRight toward the logical start) without us reimplementing it.
  function handleCellKeydown(ev, el, rowIdx, fieldIdx) {
    var numCols = PASTE_FIELDS.length;
    var key = ev.key;

    function go(r, f) {
      var target = getCell(r, f);
      if (!target) return false;
      focusCell(target);
      return true;
    }

    if (key === "Tab") {
      ev.preventDefault();
      if (ev.shiftKey) {
        var pf = fieldIdx - 1, pr = rowIdx;
        if (pf < 0) { pf = numCols - 1; pr = rowIdx - 1; }
        go(pr, pf);
      } else {
        var nf = fieldIdx + 1, nr = rowIdx;
        if (nf >= numCols) { nf = 0; nr = rowIdx + 1; }
        go(nr, nf);
      }
      return;
    }

    if (key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      go(rowIdx + 1, fieldIdx);
      return;
    }

    // A single-visual-line field has no "up"/"down" caret position to move
    // to within its own text, so leave the cell on the very first press.
    if ((key === "ArrowUp" || key === "ArrowDown") && isSingleLine(el)) {
      ev.preventDefault();
      go(key === "ArrowUp" ? rowIdx - 1 : rowIdx + 1, fieldIdx);
      return;
    }

    // RTL table: visual-right ↔ previous column, visual-left ↔ next column.
    var ARROW_TARGET = {
      ArrowUp:    function () { return [rowIdx - 1, fieldIdx]; },
      ArrowDown:  function () { return [rowIdx + 1, fieldIdx]; },
      ArrowRight: function () {
        var f = fieldIdx - 1, r = rowIdx;
        if (f < 0) { f = numCols - 1; r = rowIdx - 1; }
        return [r, f];
      },
      ArrowLeft: function () {
        var f = fieldIdx + 1, r = rowIdx;
        if (f >= numCols) { f = 0; r = rowIdx + 1; }
        return [r, f];
      },
    }[key];

    if (ARROW_TARGET) {
      var beforeS = el.selectionStart, beforeE = el.selectionEnd;
      setTimeout(function () {
        if (el.selectionStart === beforeS && el.selectionEnd === beforeE) {
          var rf = ARROW_TARGET();
          go(rf[0], rf[1]);
        }
      }, 0);
    }
  }

  // Excel-style multi-cell paste: a paste containing tabs/newlines is
  // distributed across the grid starting at the focused cell instead of
  // being dropped as one blob of text into a single field. A plain
  // single-value paste (no \t or \n) is left to the browser's default
  // behaviour so normal copy/paste of one cell still works as expected.
  function handlePaste(e, rowIdx, fieldIdx) {
    var clipboard = e.clipboardData || window.clipboardData;
    if (!clipboard) return;
    var text = clipboard.getData("text");
    if (!text || (text.indexOf("\n") === -1 && text.indexOf("\t") === -1)) return;

    e.preventDefault();
    var lines = text.replace(/\r/g, "").split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

    var touched = 0;
    lines.forEach(function (line, li) {
      var targetRow = rowIdx + li;
      if (targetRow >= renderedRows.length) return;
      var targetRec = renderedRows[targetRow];
      line.split("\t").forEach(function (val, ci) {
        var targetField = fieldIdx + ci;
        if (targetField >= PASTE_FIELDS.length) return;
        var targetEl = pasteMatrix[targetRow] && pasteMatrix[targetRow][targetField];
        if (!targetEl) return;
        targetEl.value = val;
        autoGrow(targetEl);
        targetRec[PASTE_FIELDS[targetField]] = val;
        saveField(targetRec.audioId, PASTE_FIELDS[targetField], val);
        touched++;
      });
    });
    if (touched) showMsg("הודבקו " + touched + " תאים ✓");
  }

  function buildStatusCell(rec) {
    var td = document.createElement("td");
    var sel = document.createElement("select");
    sel.className = "ivr-audio-status-select ivr-audio-status-" + (STATUS_CSS[rec.status] || "missing");
    STATUSES.forEach(function (s) {
      var opt = document.createElement("option");
      opt.value = s;
      opt.textContent = s;
      if (s === rec.status) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", function () {
      sel.className = "ivr-audio-status-select ivr-audio-status-" + (STATUS_CSS[sel.value] || "missing");
      saveField(rec.audioId, "status", sel.value);
    });
    td.appendChild(sel);
    return td;
  }

  // Shared across all audio cells so starting one playback stops any other
  // that might already be playing (avoids overlapping audio from 3 slots ×
  // many rows).
  var activeAudioEl = null;

  function buildAudioCell(rec, slot) {
    var field = "audioFile" + slot;
    var filename = rec[field];
    var td = document.createElement("td");
    td.className = "ivr-audio-cell";

    if (!filename) {
      var uploadLabel = document.createElement("label");
      uploadLabel.className = "ivr-audio-upload-btn";
      uploadLabel.textContent = "⬆️ העלה";
      var uploadInput = document.createElement("input");
      uploadInput.type = "file";
      uploadInput.accept = "audio/*";
      uploadInput.hidden = true;
      uploadInput.addEventListener("change", function () {
        if (uploadInput.files[0]) uploadAudio(rec.audioId, slot, uploadInput.files[0]);
      });
      uploadLabel.appendChild(uploadInput);
      td.appendChild(uploadLabel);
      return td;
    }

    // ▶ play / שם קובץ / ✏ החלף / 🗑 מחק — all in a single compact row.
    var row = document.createElement("div");
    row.className = "ivr-audio-cell-row";

    var audioEl = new Audio("/uploads/ivr-audio/" + encodeURIComponent(filename));
    var playBtn = document.createElement("button");
    playBtn.type = "button";
    playBtn.className = "ivr-audio-icon-btn";
    playBtn.title = "נגן";
    playBtn.textContent = "▶";
    playBtn.addEventListener("click", function () {
      if (audioEl.paused) {
        if (activeAudioEl && activeAudioEl !== audioEl) activeAudioEl.pause();
        activeAudioEl = audioEl;
        // play() returns a promise that rejects for an unplayable/corrupted
        // file — without a .catch() that surfaces as an uncaught rejection
        // and leaves the ▶/⏸ icon stuck.
        audioEl.play().catch(function () { showMsg("שגיאה בנגינת הקובץ", "error"); });
      } else {
        audioEl.pause();
      }
    });
    audioEl.addEventListener("play",  function () { playBtn.textContent = "⏸"; playBtn.classList.add("playing"); });
    audioEl.addEventListener("pause", function () { playBtn.textContent = "▶"; playBtn.classList.remove("playing"); });
    audioEl.addEventListener("ended", function () { playBtn.textContent = "▶"; playBtn.classList.remove("playing"); });
    row.appendChild(playBtn);

    var name = document.createElement("span");
    name.className = "ivr-audio-filename";
    name.title = filename;
    name.textContent = filename;
    row.appendChild(name);

    var replaceLabel = document.createElement("label");
    replaceLabel.className = "ivr-audio-icon-btn";
    replaceLabel.title = "החלף קובץ";
    replaceLabel.textContent = "✏";
    var replaceInput = document.createElement("input");
    replaceInput.type = "file";
    replaceInput.accept = "audio/*";
    replaceInput.hidden = true;
    replaceInput.addEventListener("change", function () {
      if (replaceInput.files[0]) uploadAudio(rec.audioId, slot, replaceInput.files[0]);
    });
    replaceLabel.appendChild(replaceInput);
    row.appendChild(replaceLabel);

    var delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "ivr-audio-icon-btn danger";
    delBtn.title = "מחק הקלטה";
    delBtn.textContent = "🗑";
    delBtn.addEventListener("click", function () {
      if (activeAudioEl === audioEl) { audioEl.pause(); activeAudioEl = null; }
      deleteAudio(rec.audioId, slot);
    });
    row.appendChild(delBtn);

    td.appendChild(row);
    return td;
  }

  async function saveField(audioId, field, value) {
    try {
      var body = {};
      body[field] = value;
      var res = await apiFetch("/api/admin/ivr-audio/" + encodeURIComponent(audioId), {
        method: "PUT",
        body: JSON.stringify(body),
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || "שגיאה בשמירה");
      var idx = allRecordings.findIndex(function (r) { return r.audioId === audioId; });
      if (idx >= 0) allRecordings[idx][field] = value;
      showMsg("נשמר ✓");
    } catch (err) {
      showMsg("שגיאה: " + err.message, "error");
    }
  }

  // Uses fetch directly (not apiFetch) — apiFetch always forces
  // Content-Type: application/json, which breaks multipart/form-data uploads
  // (the browser needs to set its own boundary). Only the Authorization
  // header is needed here.
  async function uploadAudio(audioId, slot, file) {
    var fd = new FormData();
    fd.append("audio", file);
    showMsg("מעלה קובץ...");
    try {
      var headers = {};
      if (typeof getAuthToken === "function") {
        var token = getAuthToken();
        if (token) headers["Authorization"] = "Bearer " + token;
      }
      var res = await fetch("/api/admin/ivr-audio/" + encodeURIComponent(audioId) + "/audio/" + slot, {
        method: "POST",
        headers: headers,
        body: fd,
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || "שגיאה בהעלאה");
      var idx = allRecordings.findIndex(function (r) { return r.audioId === audioId; });
      if (idx >= 0) allRecordings[idx] = data.recording;
      render();
      updateStats();
      showMsg("הקובץ הועלה ✓");
    } catch (err) {
      showMsg("שגיאה: " + err.message, "error");
    }
  }

  async function deleteAudio(audioId, slot) {
    if (!confirm("למחוק את קובץ ההקלטה?")) return;
    try {
      var res = await apiFetch("/api/admin/ivr-audio/" + encodeURIComponent(audioId) + "/audio/" + slot, { method: "DELETE" });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || "שגיאה במחיקה");
      var idx = allRecordings.findIndex(function (r) { return r.audioId === audioId; });
      if (idx >= 0) allRecordings[idx] = data.recording;
      render();
      updateStats();
      showMsg("הקובץ נמחק");
    } catch (err) {
      showMsg("שגיאה: " + err.message, "error");
    }
  }

  async function addRow() {
    var id = prompt("Audio ID חדש:");
    if (!id) return;
    try {
      var res = await apiFetch("/api/admin/ivr-audio", {
        method: "POST",
        body: JSON.stringify({ audioId: id.trim() }),
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || "שגיאה");
      // New rows have no category yet — tag them into whichever sheet-tab
      // is currently open (via the existing PUT endpoint) so the row shows
      // up immediately instead of silently landing in the other sheet.
      var newCategory = activeSheet === "sentences" ? "open" : "number";
      await apiFetch("/api/admin/ivr-audio/" + encodeURIComponent(data.recording.audioId), {
        method: "PUT",
        body: JSON.stringify({ category: newCategory }),
      });
      await loadRecordings();
      showMsg("נוספה שורה חדשה ✓");
    } catch (err) {
      showMsg("שגיאה: " + err.message, "error");
    }
  }

  // Mirrors הקלטות_א_בלאט_גמרא_מעוצב.xlsx exactly: same 8 headers, same
  // 2-sheet split (גיליון1 = fixed sentences, גיליון2 = numbers/currency).
  function toExcelRow(r) {
    return {
      "Audio ID": r.audioId,
      "טקסט מקור בעברית": r.sourceTextHe,
      "תרגום": r.translation,
      "הסבר שימוש": r.usageDescription,
      "קובץ הקלטה 1": r.audioFile1,
      "קובץ הקלטה 2": r.audioFile2,
      "קובץ הקלטה 3": r.audioFile3,
      "סטטוס": r.status,
    };
  }

  function exportToExcel() {
    var sheet1Rows = allRecordings.filter(function (r) { return SHEET1_CATEGORIES.indexOf(r.category) !== -1; }).map(toExcelRow);
    var sheet2Rows = allRecordings.filter(function (r) { return SHEET1_CATEGORIES.indexOf(r.category) === -1; }).map(toExcelRow);
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheet1Rows), "גיליון1");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheet2Rows), "גיליון2");
    XLSX.writeFile(wb, "הקלטות_א_בלאט_גמרא_מעוצב_" + new Date().toISOString().slice(0, 10) + ".xlsx");
  }

  // Reads the uploaded Excel entirely in the browser (same xlsx lib already
  // loaded on the page) and sends the parsed rows as JSON — the server never
  // needs to parse .xlsx itself. Safe merge only, see importRows() on the server.
  async function importFromExcel(file) {
    showMsg("קורא קובץ...");
    try {
      var buf = await file.arrayBuffer();
      var wb = XLSX.read(buf, { type: "array" });
      var rows = [];
      wb.SheetNames.forEach(function (name) {
        var sheetRows = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: "" });
        rows = rows.concat(sheetRows);
      });
      if (!rows.length) throw new Error("לא נמצאו שורות בקובץ");

      var res = await apiFetch("/api/admin/ivr-audio/import", {
        method: "POST",
        body: JSON.stringify({ rows: rows }),
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || "שגיאת ייבוא");
      showMsg("יובאו " + data.inserted + " חדשים, עודכנו " + data.merged + ", דולגו " + data.skipped);
      await loadRecordings();
    } catch (err) {
      showMsg("שגיאה בייבוא: " + err.message, "error");
    }
  }

  function exportJsonBackup() {
    var blob = new Blob([JSON.stringify(allRecordings, null, 2)], { type: "application/json" });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement("a");
    a.href = url;
    a.download = "ivr-audio-backup-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  if (sheetTabsEl) {
    sheetTabsEl.addEventListener("click", function (e) {
      var btn = e.target.closest(".ivr-sheet-tab-btn");
      if (!btn) return;
      activeSheet = btn.getAttribute("data-sheet");
      sheetTabsEl.querySelectorAll(".ivr-sheet-tab-btn").forEach(function (b) {
        b.classList.toggle("active", b === btn);
      });
      render();
    });
  }

  if (searchInput)   searchInput.addEventListener("input", render);
  if (statusFilter)  statusFilter.addEventListener("change", render);
  if (addRowBtn)     addRowBtn.addEventListener("click", addRow);
  if (exportXlsBtn)  exportXlsBtn.addEventListener("click", exportToExcel);
  if (exportJsonBtn) exportJsonBtn.addEventListener("click", exportJsonBackup);
  if (refreshBtn)    refreshBtn.addEventListener("click", loadRecordings);
  if (importFile) {
    importFile.addEventListener("change", function () {
      if (importFile.files[0]) importFromExcel(importFile.files[0]);
      importFile.value = "";
    });
  }

  loadRecordings();
}());

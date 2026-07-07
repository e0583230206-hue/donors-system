(function () {
  if (typeof Database === "undefined") return;

  var today = new Date();
  var todayKey = "briefing_" + today.toDateString();
  if (localStorage.getItem(todayKey)) return;

  var todayISO = today.getFullYear() + "-" +
    String(today.getMonth() + 1).padStart(2, "0") + "-" +
    String(today.getDate()).padStart(2, "0");

  var donors = Database.get("donors");
  var tasks  = Database.get("tasks");
  if (!Array.isArray(donors)) donors = [];
  if (!Array.isArray(tasks))  tasks  = [];

  var todayTasks = tasks.filter(function (t) {
    return !t.done && t.dueDate === todayISO;
  });

  var overdueTasks = tasks.filter(function (t) {
    return !t.done && t.dueDate && t.dueDate < todayISO;
  });

  var todayReminders = [];
  donors.forEach(function (d) {
    if (!d.reminders) return;
    d.reminders.forEach(function (r) {
      if (!r.done && r.date && r.date <= todayISO) {
        todayReminders.push({
          donor: d.fullName,
          text: r.description || r.text || "",
        });
      }
    });
  });

  localStorage.setItem(todayKey, "1");

  // Prune briefing keys older than 30 days
  var cutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
  var briefingToRemove = [];
  for (var bki = 0; bki < localStorage.length; bki++) {
    var bkKey = localStorage.key(bki);
    if (bkKey && bkKey.startsWith("briefing_")) {
      var d = new Date(bkKey.replace("briefing_", ""));
      if (!isNaN(d.getTime()) && d.getTime() < cutoffMs) briefingToRemove.push(bkKey);
    }
  }
  briefingToRemove.forEach(function(bkKey) { localStorage.removeItem(bkKey); });

  var total = todayTasks.length + overdueTasks.length + todayReminders.length;
  if (total === 0) return;

  // Browser notification
  if (window.Notification && Notification.permission !== "denied") {
    var req = Notification.permission === "default"
      ? Notification.requestPermission()
      : Promise.resolve(Notification.permission);
    req.then(function (perm) {
      if (perm === "granted") {
        new Notification("CRM — ניהול תורמים", {
          body: "יש לך " + total + " פריטים לטיפול היום",
        });
      }
    });
  }

  // Daily briefing popup
  var hebrewDate = window.HebrewDate ? window.HebrewDate.getHebrewDateText(today) : "";
  var gregDate   = today.toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "long" });

  var html = '<div class="briefing-modal">';
  html += '<h2>☀️ בוקר טוב!</h2>';
  html += '<div class="briefing-date">' + escapeHTML(hebrewDate) + ' — ' + gregDate + '</div>';

  if (todayTasks.length > 0) {
    html += '<div class="briefing-section"><h3>📋 משימות להיום (' + todayTasks.length + ')</h3>';
    todayTasks.slice(0, 6).forEach(function (t) {
      html += '<div class="briefing-item"><span>' + escapeHTML(t.title) + '</span>';
      if (t.workerName) html += '<span style="color:var(--muted);font-size:11px">' + escapeHTML(t.workerName) + '</span>';
      html += '</div>';
    });
    html += '</div>';
  }

  if (overdueTasks.length > 0) {
    html += '<div class="briefing-section"><h3 style="color:var(--danger)">🔥 משימות שעבר זמנן (' + overdueTasks.length + ')</h3>';
    overdueTasks.slice(0, 4).forEach(function (t) {
      html += '<div class="briefing-item"><span>' + escapeHTML(t.title) + '</span>';
      html += '<span style="color:var(--danger);font-size:11px">' + (t.dueDate || "") + '</span></div>';
    });
    html += '</div>';
  }

  if (todayReminders.length > 0) {
    html += '<div class="briefing-section"><h3>🔔 תזכורות לטיפול (' + todayReminders.length + ')</h3>';
    todayReminders.slice(0, 6).forEach(function (r) {
      html += '<div class="briefing-item"><span>' + escapeHTML(r.donor) + '</span>';
      if (r.text) html += '<span style="color:var(--muted);font-size:11px">' + escapeHTML(r.text) + '</span>';
      html += '</div>';
    });
    html += '</div>';
  }

  html += '<button class="briefing-close" id="briefingCloseBtn">הבנתי, מתחילים! 💪</button>';
  html += '</div>';

  var overlay = document.createElement("div");
  overlay.className = "briefing-overlay";
  overlay.innerHTML = html;
  document.body.appendChild(overlay);

  function closeBriefing() {
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }

  document.getElementById("briefingCloseBtn").addEventListener("click", closeBriefing);
  overlay.addEventListener("click", function (e) {
    if (e.target === overlay) closeBriefing();
  });
})();

function updateSidebarCounts() {
  var donors = Database.get("donors");
  var tasks = Database.get("tasks");
  var openReminders = 0, openCallbacks = 0;
  donors.forEach(function(donor) {
    if (donor.reminders) openReminders += donor.reminders.filter(function(r) { return r.done === false; }).length;
    if (donor.callbacks) openCallbacks += donor.callbacks.filter(function(c) { return c.done === false; }).length;
  });
  var openTasks = tasks.filter(function(t) { return t.done === false; }).length;
  document.querySelectorAll("[data-count='tasks']").forEach(function(el) { el.innerText = openTasks; });
  document.querySelectorAll("[data-count='reminders']").forEach(function(el) { el.innerText = openReminders; });
  document.querySelectorAll("[data-count='callbacks']").forEach(function(el) { el.innerText = openCallbacks; });
}

updateSidebarCounts();

function setupSidebarToggle() {
  var nav = document.querySelector(".sidebar nav");

  // 1. Inject calendar link if not present
  if (nav) {
    var hasCalendar = Array.from(nav.querySelectorAll("a")).some(function(a) {
      return a.getAttribute("href") === "calendar.html";
    });
    if (!hasCalendar) {
      var calLink = document.createElement("a");
      calLink.href = "calendar.html";
      calLink.textContent = "📅 לוח שנה";
      if (window.location.href.includes("calendar.html")) calLink.className = "active";
      var logsLink = Array.from(nav.querySelectorAll("a")).find(function(a) {
        return a.getAttribute("href") === "logs.html";
      });
      if (logsLink) logsLink.insertAdjacentElement("beforebegin", calLink);
      else nav.appendChild(calLink);
    }
  }

  // 2. Split nav link text into icon + label wrapper so flex doesn't separate them
  document.querySelectorAll("nav a").forEach(function(a) {
    var textNode = null;
    a.childNodes.forEach(function(n) {
      if (n.nodeType === 3 && n.textContent.trim()) textNode = n;
    });
    if (!textNode) return;
    var text = textNode.textContent.trim();
    var spaceIdx = text.indexOf(" ");
    if (spaceIdx === -1) return;

    var iconSpan = document.createElement("span");
    iconSpan.className = "nav-icon";
    iconSpan.textContent = text.slice(0, spaceIdx);

    var labelSpan = document.createElement("span");
    labelSpan.className = "nav-label";
    labelSpan.textContent = " " + text.slice(spaceIdx + 1);

    var navText = document.createElement("span");
    navText.className = "nav-text";
    navText.appendChild(iconSpan);
    navText.appendChild(labelSpan);

    a.insertBefore(navText, textNode);
    a.removeChild(textNode);
    a.title = text.slice(spaceIdx + 1);
  });

  // 3. Split logout button text
  var logoutBtn = document.querySelector(".logout-btn");
  if (logoutBtn) {
    var lText = logoutBtn.textContent.trim();
    var lSpace = lText.indexOf(" ");
    if (lSpace !== -1) {
      logoutBtn.textContent = "";
      var navText = document.createElement("span");
      navText.className = "nav-text";
      var li = document.createElement("span");
      li.className = "nav-icon";
      li.textContent = lText.slice(0, lSpace);
      var ll = document.createElement("span");
      ll.className = "nav-label";
      ll.textContent = " " + lText.slice(lSpace + 1);
      navText.appendChild(li);
      navText.appendChild(ll);
      logoutBtn.appendChild(navText);
    }
  }

  // 4. Show current logged-in user above logout button
  var currentUser = JSON.parse(sessionStorage.getItem("currentUser") || "null");
  if (currentUser) {
    var sidebar = document.querySelector(".sidebar");
    if (sidebar) {
      var userDiv = document.createElement("div");
      userDiv.className = "sidebar-user";
      var initial = (currentUser.name || "?").charAt(0);
      userDiv.innerHTML =
        '<div class="sidebar-user-avatar">' + initial + '</div>' +
        '<div class="sidebar-user-info">' +
          '<div class="sidebar-user-name">' + escapeHTML(currentUser.name) + '</div>' +
          '<div class="sidebar-user-role">' + escapeHTML(currentUser.role) + '</div>' +
        '</div>';
      var lBtn = sidebar.querySelector(".logout-btn");
      sidebar.insertBefore(userDiv, lBtn);
    }
  }

  // 5. Global donor search in sidebar
  var searchWrapper = document.createElement("div");
  searchWrapper.className = "sidebar-search";
  var searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.placeholder = "🔍 חיפוש תורם...";
  searchInput.className = "sidebar-search-input";
  var resultsDiv = document.createElement("div");
  resultsDiv.className = "sidebar-search-results";
  searchWrapper.appendChild(searchInput);
  searchWrapper.appendChild(resultsDiv);

  var logoEl = document.querySelector(".sidebar .logo");
  if (logoEl) logoEl.insertAdjacentElement("afterend", searchWrapper);

  searchInput.addEventListener("input", function() {
    var q = this.value.trim().toLowerCase();
    if (!q || q.length < 2) { resultsDiv.innerHTML = ""; resultsDiv.classList.remove("show"); return; }
    var donors = Database.get("donors");
    var matches = donors.filter(function(d) {
      return (d.fullName || "").toLowerCase().includes(q) ||
             (d.phone || "").includes(q) ||
             (d.city || "").toLowerCase().includes(q) ||
             (d.tags && d.tags.some(function(tag) { return tag.toLowerCase().includes(q); }));
    }).slice(0, 7);
    if (matches.length === 0) {
      resultsDiv.innerHTML = '<div class="search-no-results">לא נמצאו תורמים</div>';
    } else {
      resultsDiv.innerHTML = matches.map(function(d) {
        return '<a class="search-result-item" href="donor.html?id=' + d.id + '">' +
          '<span class="search-result-name">' + escapeHTML(d.fullName) + '</span>' +
          '<span class="search-result-meta">' + escapeHTML(d.phone) +
            (d.city ? ' · ' + escapeHTML(d.city) : '') + '</span>' +
        '</a>';
      }).join("");
    }
    resultsDiv.classList.add("show");
  });

  document.addEventListener("click", function(e) {
    if (!searchWrapper.contains(e.target)) {
      resultsDiv.innerHTML = "";
      resultsDiv.classList.remove("show");
    }
  });

  // 6. Sidebar toggle button
  var btn = document.createElement("button");
  btn.id = "sidebarToggle";

  function applyState(collapsed) {
    if (collapsed) {
      document.body.classList.add("sidebar-collapsed");
      btn.textContent = "☰";
      btn.title = "פתח תפריט";
    } else {
      document.body.classList.remove("sidebar-collapsed");
      btn.textContent = "✕";
      btn.title = "סגור תפריט";
    }
  }

  var saved = localStorage.getItem("sidebarCollapsed") === "true";
  applyState(saved);

  btn.addEventListener("click", function() {
    var collapsed = document.body.classList.contains("sidebar-collapsed");
    localStorage.setItem("sidebarCollapsed", String(!collapsed));
    applyState(!collapsed);
  });

  document.body.appendChild(btn);
}

setupSidebarToggle();

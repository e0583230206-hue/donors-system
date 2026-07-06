/* login.js v2 — redirect-aware */
// Returns the redirect target only if it is a safe internal path.
// Blocks protocol-relative (//evil.com) and absolute URLs (http://...).
function getSafeRedirect() {
  var raw = new URLSearchParams(window.location.search).get("redirect") || "";
  if (!raw) return "";
  if (/^\/\//.test(raw)) return "";                          // protocol-relative
  if (/^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(raw)) return "";   // absolute URL
  if (raw.startsWith("/")) return raw;                       // root-relative path
  if (/^[a-zA-Z0-9_-]+\.html(\?.*)?$/.test(raw)) return raw; // bare filename
  return "";
}

// If already authenticated, skip login and go straight to the requested page.
(function () {
  var token = sessionStorage.getItem("authToken");
  var user  = null;
  try { user = JSON.parse(sessionStorage.getItem("currentUser")); } catch (_) {}
  if (token && user) {
    window.location.replace(getSafeRedirect() || "index.html");
  }
}());

const userSelect    = document.getElementById("userSelect");
const passwordInput = document.getElementById("passwordInput");
const loginButton   = document.getElementById("loginButton");
const messageBox    = document.getElementById("messageBox");

var workers = [];

function showMessage(text, type) {
  messageBox.innerText = text;
  messageBox.className = "message show " + (type || "error");
}

function fillUsers() {
  userSelect.innerHTML = `<option value="">בחר משתמש</option>`;
  workers.forEach(function (w) {
    const opt    = document.createElement("option");
    opt.value    = w.id;
    opt.innerText = w.name;
    userSelect.appendChild(opt);
  });
}

async function loadWorkers() {
  try {
    const res = await fetch("/api/workers/list");
    if (res.ok) {
      workers = await res.json();
    } else {
      workers = Database.get("workers") || [];
    }
  } catch (_) {
    workers = Database.get("workers") || [];
  }
  fillUsers();
}

async function login() {
  const workerId = Number(userSelect.value);
  const password = passwordInput.value.trim();

  if (!workerId || password === "") {
    showMessage("חובה לבחור משתמש ולהכניס סיסמה");
    return;
  }

  loginButton.disabled   = true;
  loginButton.innerText  = "מתחבר...";

  try {
    const res = await fetch("/api/login", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ workerId, password }),
    });

    if (!res.ok) {
      const err = await res.json().catch(function () { return {}; });
      if (res.status === 429) {
        showMessage("יותר מדי ניסיונות. נסה שוב מאוחר יותר.");
      } else if (res.status === 401) {
        showMessage("סיסמה שגויה");
      } else {
        showMessage(err.error || "שגיאה בהתחברות");
      }
      return;
    }

    const data = await res.json();

    // Store JWT, session ID, and user info
    sessionStorage.setItem("authToken",  data.token);
    sessionStorage.setItem("sessionId",  data.sessionId || "");
    sessionStorage.setItem("currentUser", JSON.stringify({
      id:        data.user.id,
      name:      data.user.name,
      role:      data.user.role,
      loginTime: Date.now(),
    }));

    // Pre-load workers list into localStorage so other pages can use it
    try {
      const wRes = await fetch("/api/workers", {
        headers: { "Authorization": "Bearer " + data.token },
      });
      if (wRes.ok) {
        const wList = await wRes.json();
        localStorage.setItem("workers", JSON.stringify(wList));
      }
    } catch (_) {}

    // Pre-load app data from server into localStorage
    try {
      await Database.loadFromServer(data.token);
    } catch (_) {}

    if (data.mustChangePassword) {
      sessionStorage.setItem("mustChangePassword", "1");
      window.location.href = "settings.html?forcePassword=1";
    } else {
      sessionStorage.removeItem("mustChangePassword");
      window.location.href = getSafeRedirect() || "index.html";
    }
  } catch (_) {
    showMessage("שגיאה בהתחברות לשרת");
  } finally {
    loginButton.disabled  = false;
    loginButton.innerText = "כניסה";
  }
}

loginButton.addEventListener("click", function () { login(); });
passwordInput.addEventListener("keydown", function (e) {
  if (e.key === "Enter") login();
});

if (new URLSearchParams(window.location.search).get("expired") === "1") {
  showMessage("פג תוקף החיבור — נא להתחבר מחדש", "error");
}
if (new URLSearchParams(window.location.search).get("forced") === "1") {
  showMessage("החיבור שלך נותק על ידי מנהל המערכת — נא להתחבר מחדש", "error");
}

loadWorkers();

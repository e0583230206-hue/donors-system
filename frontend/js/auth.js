/* auth.js v3 — redirect-aware, with server-side session tracking */
const SESSION_TIMEOUT_HOURS = 8;
const SESSION_TIMEOUT_MS    = SESSION_TIMEOUT_HOURS * 60 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 60 * 1000;

var _heartbeatTimer = null;
const ROLE_ADMIN      = "ADMIN";
const ROLE_SECRETARY  = "SECRETARY";
const ROLE_IVR_SYSTEM = "IVR_SYSTEM";

// ── Session ───────────────────────────────────────────────────────────────────

function getCurrentUser() {
  try {
    return JSON.parse(sessionStorage.getItem("currentUser"));
  } catch (_) {
    return null;
  }
}

function getAuthToken() {
  return sessionStorage.getItem("authToken") || "";
}

function normalizeRole(role) {
  const value = String(role || "").trim().toUpperCase();
  if (value === "ADMIN"      || role === "מנהל")  return ROLE_ADMIN;
  if (value === "SECRETARY"  || role === "מזכיר") return ROLE_SECRETARY;
  if (value === "IVR_SYSTEM" || value === "IVR")  return ROLE_IVR_SYSTEM;
  return "";
}

function _loginRedirectTarget(extra) {
  var here = window.location.pathname + window.location.search;
  var isLoginPage = here.indexOf("login.html") !== -1 || here === "/" || here === "";
  var base = "login.html" + (extra ? "?" + extra : "");
  if (isLoginPage) return base;
  var redirectPart = "redirect=" + encodeURIComponent(here);
  return "login.html?" + (extra ? extra + "&" : "") + redirectPart;
}

function requireLogin() {
  const token       = getAuthToken();
  const currentUser = getCurrentUser();

  if (!token || !currentUser) {
    window.location.replace(_loginRedirectTarget(""));
    return;
  }

  if (Date.now() - currentUser.loginTime > SESSION_TIMEOUT_MS) {
    sessionStorage.removeItem("authToken");
    sessionStorage.removeItem("currentUser");
    window.location.replace(_loginRedirectTarget("expired=1"));
    return;
  }

  if (sessionStorage.getItem("mustChangePassword") === "1") {
    const onSettings = window.location.pathname.endsWith("settings.html");
    if (!onSettings) {
      window.location.href = "settings.html?forcePassword=1";
      return;
    }
  }

  startHeartbeat();
}

// ── Role helpers ──────────────────────────────────────────────────────────────

function isAdmin() {
  const u = getCurrentUser();
  return u && normalizeRole(u.role) === ROLE_ADMIN;
}

function isSecretary() {
  const u = getCurrentUser();
  return u && normalizeRole(u.role) === ROLE_SECRETARY;
}

function canManageWorkers()   { return isAdmin(); }
function canDeleteSystemData() { return isAdmin(); }

// ── API helpers ───────────────────────────────────────────────────────────────

function getApiHeaders(extraHeaders) {
  const headers = Object.assign({ "Content-Type": "application/json" }, extraHeaders || {});
  const token   = getAuthToken();
  if (token) {
    headers["Authorization"] = "Bearer " + token;
  }
  return headers;
}

function apiFetch(url, options) {
  const opts    = Object.assign({}, options || {});
  opts.headers  = getApiHeaders(opts.headers);
  return fetch(url, opts).then(function (res) {
    if (res.status === 401) {
      sessionStorage.removeItem("authToken");
      sessionStorage.removeItem("currentUser");
      window.location.replace(_loginRedirectTarget("expired=1"));
      return Promise.reject(new Error("Session expired"));
    }
    return res;
  });
}

// ── Guards ────────────────────────────────────────────────────────────────────

function requireAdminAction(message) {
  if (canManageWorkers()) return true;
  alert(message || "רק מנהל יכול לבצע פעולה זו");
  return false;
}

// ── Session heartbeat ─────────────────────────────────────────────────────────

// An admin disconnected this session remotely from the sessions screen — end the
// local session the same way an expired one ends, but with a distinct message.
function _handleForcedLogout() {
  if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
  sessionStorage.removeItem("authToken");
  sessionStorage.removeItem("currentUser");
  sessionStorage.removeItem("sessionId");
  window.location.replace(_loginRedirectTarget("forced=1"));
}

function _sendHeartbeat() {
  var token     = getAuthToken();
  var sessionId = sessionStorage.getItem("sessionId") || "";
  if (!token || !sessionId) return;
  fetch("/api/sessions/heartbeat", {
    method:  "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
    body:    JSON.stringify({ sessionId: sessionId }),
  }).then(function (res) {
    return res.json().catch(function () { return {}; });
  }).then(function (data) {
    if (data && data.forceLogout) _handleForcedLogout();
  }).catch(function () { /* silent — heartbeat failures do not affect UX */ });
}

function startHeartbeat() {
  if (_heartbeatTimer) return;
  _sendHeartbeat();
  _heartbeatTimer = setInterval(_sendHeartbeat, HEARTBEAT_INTERVAL_MS);
}

// ── Logout ────────────────────────────────────────────────────────────────────

function logout() {
  if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }

  // Notify server (fire-and-forget)
  var token     = getAuthToken();
  var sessionId = sessionStorage.getItem("sessionId") || "";
  if (token && sessionId) {
    try {
      fetch("/api/logout", {
        method:  "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
        body:    JSON.stringify({ sessionId: sessionId }),
      });
    } catch (_) {}
  }

  sessionStorage.removeItem("authToken");
  sessionStorage.removeItem("currentUser");
  sessionStorage.removeItem("sessionId");
  // Clear cached app data from localStorage on logout
  ["donors", "tasks", "logs", "settings", "approvals", "workers"].forEach(function (k) {
    localStorage.removeItem(k);
  });
  window.location.href = "login.html";
}

requireLogin();

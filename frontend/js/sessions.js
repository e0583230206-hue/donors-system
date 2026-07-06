/* sessions.js — admin-only sessions viewer */
"use strict";

(function () {
  if (!isAdmin()) {
    document.querySelector("main.main").innerHTML =
      '<div style="padding:40px;text-align:center;color:var(--danger)">⛔ גישה לדף זה מותרת למנהלים בלבד.</div>';
    return;
  }

  function escapeHTML(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleString("he-IL", {
        timeZone: "Asia/Jerusalem",
        day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit",
      });
    } catch (_) { return iso; }
  }

  function timeSince(iso) {
    if (!iso) return "—";
    var diff = Date.now() - new Date(iso).getTime();
    if (diff < 0) return "עכשיו";
    var secs = Math.floor(diff / 1000);
    if (secs < 60) return secs + " שנ׳";
    var mins = Math.floor(secs / 60);
    if (mins < 60) return mins + " דק׳";
    var hrs = Math.floor(mins / 60);
    return hrs + " שע׳ " + (mins % 60) + " דק׳";
  }

  function parseUA(ua) {
    if (!ua) return "—";
    if (/mobile/i.test(ua)) return "📱 נייד";
    if (/chrome/i.test(ua) && !/edge|opr/i.test(ua)) return "Chrome";
    if (/firefox/i.test(ua)) return "Firefox";
    if (/safari/i.test(ua) && !/chrome/i.test(ua)) return "Safari";
    if (/edg/i.test(ua)) return "Edge";
    return "דפדפן";
  }

  function statusBadge(status) {
    var map = {
      active:  '<span style="color:var(--success);font-weight:600">● פעיל</span>',
      logout:  '<span style="color:var(--muted)">○ יצא</span>',
      timeout: '<span style="color:var(--warning);font-weight:600">⏱ פג תוקף</span>',
    };
    return map[status] || escapeHTML(status);
  }

  function renderActive(rows) {
    document.getElementById("activeCount").textContent = rows.length;
    var tbody = document.getElementById("activeTable");
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted)">אין עובדים מחוברים כעת</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(function (r) {
      return [
        "<tr>",
        "<td>" + escapeHTML(r.workerName) + "</td>",
        "<td>" + fmtDate(r.loginAt) + "</td>",
        "<td title='" + escapeHTML(r.lastHeartbeat) + "'>" + timeSince(r.lastHeartbeat) + " לפני</td>",
        "<td>" + escapeHTML(r.ip || "—") + "</td>",
        "<td>" + escapeHTML(parseUA(r.userAgent)) + "</td>",
        "</tr>",
      ].join("");
    }).join("");
  }

  function renderHistory(rows) {
    document.getElementById("historyCount").textContent = rows.length;
    var tbody = document.getElementById("historyTable");
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted)">אין רשומות</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(function (r) {
      return [
        "<tr>",
        "<td>" + escapeHTML(r.workerName) + "</td>",
        "<td>" + fmtDate(r.loginAt) + "</td>",
        "<td>" + fmtDate(r.logoutAt) + "</td>",
        "<td>" + statusBadge(r.status) + "</td>",
        "<td>" + escapeHTML(r.ip || "—") + "</td>",
        "</tr>",
      ].join("");
    }).join("");
  }

  function loadSessions() {
    apiFetch("/api/admin/sessions")
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        renderActive(data.active || []);
        renderHistory(data.history || []);
      })
      .catch(function (err) {
        console.error("[Sessions]", err);
        var msg = '<tr><td colspan="5" style="color:var(--danger);text-align:center">שגיאה בטעינת נתונים</td></tr>';
        document.getElementById("activeTable").innerHTML = msg;
        document.getElementById("historyTable").innerHTML = msg;
      });
  }

  window.loadSessions = loadSessions;
  loadSessions();
  setInterval(loadSessions, 30000);
}());

// ai-assistant.js — Floating AI chat widget (Read Only)
// Works on any page. On donor.html it picks up donorId from the URL.

(function () {
  "use strict";

  var _donorId = null;
  var _history = []; // { role: "user"|"assistant", text }
  var _busy    = false;

  // ── Quick-action buttons ──────────────────────────────────────────────────────

  var DONOR_QUICK_ACTIONS = [
    { label: "📋 מצב התורם",          q: "מה מצב התורם הזה?" },
    { label: "⚠️ חובות פתוחים",       q: "כמה חובות פתוחים יש לו?" },
    { label: "💰 תרומה אחרונה",        q: "מתי הוא תרם לאחרונה?" },
    { label: "✅ משימות פתוחות",       q: "מה המשימות הפתוחות?" },
    { label: "📅 ציר זמן",             q: "ציר זמן הפעילות" },
    { label: "💳 היסטוריית תשלומים",   q: "היסטוריית תשלומים" },
  ];

  var GLOBAL_QUICK_ACTIONS = [
    { label: "😴 לא פעיל חצי שנה",    q: "מי לא תרם בחצי השנה האחרונה?" },
    { label: "😴 לא פעיל שנה",         q: "מי לא תרם בשנה האחרונה?" },
    { label: "⚠️ חובות לפי עדיפות",   q: "חובות פתוחים לפי עדיפות" },
    { label: "🏆 תורמים גדולים",       q: "מי התורמים הגדולים ביותר?" },
  ];

  // ── DOM builders ─────────────────────────────────────────────────────────────

  function buildPanel() {
    var panel = document.createElement("div");
    panel.id = "aiPanel";
    panel.className = "ai-panel hidden";
    panel.innerHTML = [
      '<div class="ai-panel-header">',
        '<div class="ai-panel-title">',
          '<span class="ai-panel-icon">🤖</span>',
          '<span>עוזר AI</span>',
          '<span class="ai-read-only-badge">Read Only</span>',
        '</div>',
        '<div class="ai-panel-controls">',
          '<button class="ai-ctrl-btn" id="aiClearBtn" title="נקה שיחה">🗑️</button>',
          '<button class="ai-ctrl-btn" id="aiCloseBtn" title="סגור">✕</button>',
        '</div>',
      '</div>',
      '<div class="ai-quick-actions" id="aiQuickActions"></div>',
      '<div class="ai-messages" id="aiMessages">',
        '<div class="ai-welcome">',
          '<p>שלום! אני העוזר של מערכת ניהול התורמים.</p>',
          '<p>אני יכול לעזור לך לקבל תובנות על התורמים — לחץ על אחד מהכפתורים למעלה, או כתוב שאלה חופשית.</p>',
        '</div>',
      '</div>',
      '<div class="ai-input-row">',
        '<textarea id="aiInput" class="ai-input" rows="1" placeholder="שאל שאלה..." dir="rtl"></textarea>',
        '<button id="aiSendBtn" class="ai-send-btn" title="שלח">↑</button>',
      '</div>',
    ].join("");
    return panel;
  }

  function buildFab() {
    var fab = document.createElement("button");
    fab.id = "aiFab";
    fab.className = "ai-fab";
    fab.title = "עוזר AI";
    fab.innerHTML = '<span class="ai-fab-icon">🤖</span><span class="ai-fab-label">AI</span>';
    return fab;
  }

  // ── Rendering helpers ─────────────────────────────────────────────────────────

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function renderMarkdown(text) {
    // Bold **text**
    var html = escapeHtml(text)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\n/g, "<br>");
    return html;
  }

  function appendMessage(role, text) {
    var el = document.getElementById("aiMessages");
    if (!el) return;

    // Remove welcome message on first real message
    var welcome = el.querySelector(".ai-welcome");
    if (welcome) welcome.remove();

    var div = document.createElement("div");
    div.className = "ai-msg ai-msg-" + role;
    if (role === "assistant") {
      div.innerHTML = '<div class="ai-msg-bubble">' + renderMarkdown(text) + '</div>';
    } else {
      div.innerHTML = '<div class="ai-msg-bubble">' + escapeHtml(text) + '</div>';
    }
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  }

  function showTyping() {
    var el = document.getElementById("aiMessages");
    if (!el) return;
    var div = document.createElement("div");
    div.id = "aiTyping";
    div.className = "ai-msg ai-msg-assistant";
    div.innerHTML = '<div class="ai-msg-bubble ai-typing"><span></span><span></span><span></span></div>';
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  }

  function removeTyping() {
    var t = document.getElementById("aiTyping");
    if (t) t.remove();
  }

  // ── API call ──────────────────────────────────────────────────────────────────

  function sendQuestion(question) {
    if (_busy || !question.trim()) return;
    _busy = true;

    var input   = document.getElementById("aiInput");
    var sendBtn = document.getElementById("aiSendBtn");
    if (input)   { input.value = ""; input.style.height = ""; }
    if (sendBtn) sendBtn.disabled = true;

    _history.push({ role: "user", text: question });
    appendMessage("user", question);
    showTyping();

    var tok = sessionStorage.getItem("authToken") || "";
    fetch("/api/ai/query", {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": "Bearer " + tok,
      },
      body: JSON.stringify({
        question: question,
        donorId:  _donorId || undefined,
      }),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        removeTyping();
        var answer = data.answer || data.error || "שגיאה לא ידועה";
        if (data.fallback) {
          answer += "\n\n_(OpenAI לא זמין — תשובה מהמנוע המקומי)_";
        }
        _history.push({ role: "assistant", text: answer });
        appendMessage("assistant", answer);
      })
      .catch(function (err) {
        removeTyping();
        var msg = "שגיאה בתקשורת עם השרת.";
        appendMessage("assistant", msg);
        console.error("[AI]", err);
      })
      .finally(function () {
        _busy = false;
        if (sendBtn) sendBtn.disabled = false;
        if (input) input.focus();
      });
  }

  // ── Quick actions ─────────────────────────────────────────────────────────────

  function renderQuickActions() {
    var container = document.getElementById("aiQuickActions");
    if (!container) return;
    var actions = _donorId ? DONOR_QUICK_ACTIONS : GLOBAL_QUICK_ACTIONS;
    container.innerHTML = "";
    actions.forEach(function (a) {
      var btn = document.createElement("button");
      btn.className = "ai-quick-btn";
      btn.textContent = a.label;
      btn.addEventListener("click", function () { sendQuestion(a.q); });
      container.appendChild(btn);
    });
  }

  // ── Panel open/close ──────────────────────────────────────────────────────────

  function openPanel() {
    var panel = document.getElementById("aiPanel");
    var fab   = document.getElementById("aiFab");
    if (panel) panel.classList.remove("hidden");
    if (fab)   fab.classList.add("ai-fab-open");
    renderQuickActions();
    var input = document.getElementById("aiInput");
    if (input) setTimeout(function () { input.focus(); }, 80);
  }

  function closePanel() {
    var panel = document.getElementById("aiPanel");
    var fab   = document.getElementById("aiFab");
    if (panel) panel.classList.add("hidden");
    if (fab)   fab.classList.remove("ai-fab-open");
  }

  function clearChat() {
    _history = [];
    var el = document.getElementById("aiMessages");
    if (el) el.innerHTML = '<div class="ai-welcome"><p>שיחה נוקתה. בחר שאלה או כתוב ידנית.</p></div>';
  }

  // ── Input auto-grow + Enter key ───────────────────────────────────────────────

  function wireInput() {
    var input   = document.getElementById("aiInput");
    var sendBtn = document.getElementById("aiSendBtn");

    if (!input || !sendBtn) return;

    input.addEventListener("input", function () {
      this.style.height = "";
      this.style.height = Math.min(this.scrollHeight, 120) + "px";
    });

    input.addEventListener("keydown", function (e) {
      // Enter without Shift = send
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendQuestion(this.value.trim());
      }
    });

    sendBtn.addEventListener("click", function () {
      sendQuestion((input.value || "").trim());
    });
  }

  // ── Init ──────────────────────────────────────────────────────────────────────

  function init() {
    // Pick up donor ID from URL if on donor page
    var params = new URLSearchParams(window.location.search);
    var idParam = params.get("id");
    if (idParam) _donorId = Number(idParam) || null;

    // Build and inject DOM
    var fab   = buildFab();
    var panel = buildPanel();
    document.body.appendChild(fab);
    document.body.appendChild(panel);

    // Wire events
    fab.addEventListener("click", function () {
      var p = document.getElementById("aiPanel");
      if (p && p.classList.contains("hidden")) { openPanel(); } else { closePanel(); }
    });

    document.getElementById("aiCloseBtn").addEventListener("click", closePanel);
    document.getElementById("aiClearBtn").addEventListener("click", clearChat);

    wireInput();
  }

  // Wait for DOM
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
}());

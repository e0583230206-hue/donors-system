// ai-assistant.js — AI Assistant v3.0 (Read Only)
// pageContext detection, debug mode (?aiDebug=1), rich ResponseObject rendering
// This runs before the IIFE below (and its _debugMode variable) exist at all,
// so ?aiDebug=1 is checked inline here — the only line in the file that
// duplicates that check instead of reading _debugMode.
if (new URLSearchParams(window.location.search).get("aiDebug") === "1") {
  console.log("[AI] ai-assistant.js v3 loaded");
}

(function () {
  "use strict";

  var STORAGE_KEY = "crm_ai_chat_v2";
  var MAX_HISTORY = 20;

  var _donorId     = null;
  var _pageContext = "global";
  var _debugMode   = false;
  var _history     = [];
  var _busy        = false;

  // ── Page-context detection ────────────────────────────────────────────────────

  function detectPageContext() {
    var path = window.location.pathname.toLowerCase();
    var params = new URLSearchParams(window.location.search);

    _debugMode = params.get("aiDebug") === "1";

    var idParam = params.get("id");
    if (idParam) _donorId = Number(idParam) || null;

    if (/donor/.test(path) && idParam)             return "donor";
    if (/debt/.test(path))                         return "debts";
    if (/task/.test(path))                         return "tasks";
    if (/reminder/.test(path))                     return "reminders";
    if (/report/.test(path))                       return "reports";
    if (/phone|ivr|call/.test(path))               return "phone";
    return "global";
  }

  // ── Quick-action buttons ──────────────────────────────────────────────────────

  var DONOR_QUICK_ACTIONS = [
    { label: "📋 מצב התורם",        q: "מה מצב התורם הזה?" },
    { label: "⚠️ חובות פתוחים",     q: "כמה חובות פתוחים יש לו?" },
    { label: "💰 תרומה אחרונה",      q: "מתי הוא תרם לאחרונה?" },
    { label: "✅ משימות פתוחות",     q: "מה המשימות הפתוחות?" },
    { label: "📅 ציר זמן",           q: "ציר זמן הפעילות" },
    { label: "💡 המלצה",             q: "מה ההמלצה שלך לגבי תורם זה?" },
  ];

  var GLOBAL_QUICK_ACTIONS = [
    { label: "📊 מצב המערכת",        q: "תן לי סיכום כללי של המערכת" },
    { label: "😴 לא פעיל חצי שנה",  q: "מי לא תרם בחצי השנה האחרונה?" },
    { label: "⚠️ חובות לפי עדיפות", q: "חובות פתוחים לפי עדיפות" },
    { label: "📞 למי להתקשר?",       q: "למי כדאי להתקשר היום?" },
    { label: "⚡ Quick Wins",         q: "אילו חובות קל לסגור מהר?" },
    { label: "🏆 תורמים גדולים",     q: "מי התורמים הגדולים ביותר?" },
  ];

  // ── localStorage ──────────────────────────────────────────────────────────────

  function loadHistory() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) { return []; }
  }

  function saveHistory() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(_history.slice(-MAX_HISTORY)));
    } catch (e) { /* ignore */ }
  }

  // ── DOM builders ──────────────────────────────────────────────────────────────

  function buildPanel() {
    var panel = document.createElement("div");
    panel.id = "aiPanel";
    panel.className = "ai-panel hidden";
    panel.innerHTML = [
      '<div class="ai-panel-header">',
        '<div class="ai-panel-title">',
          '<span class="ai-panel-icon">🤖</span>',
          '<span>איציקנט העוזר</span>',
          '<span class="ai-read-only-badge">Read Only</span>',
          (_debugMode ? '<span class="ai-debug-badge">DEBUG</span>' : ""),
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
          '<p>בחר שאלה מהכפתורים למעלה, או כתוב שאלה חופשית.</p>',
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
    fab.title = "איציקנט העוזר";
    fab.innerHTML = '<span class="ai-fab-icon">🤖</span><span class="ai-fab-label">איציקנט</span>';
    return fab;
  }

  // ── Rendering helpers ─────────────────────────────────────────────────────────

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function renderMarkdown(text) {
    return escapeHtml(text)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\n/g, "<br>");
  }

  function buildDebugPanel(debug) {
    if (!_debugMode || !debug) return "";
    var lines = [
      "intent: " + escapeHtml(debug.intent || "—"),
      "confidence: " + (debug.confidence !== undefined ? Number(debug.confidence).toFixed(2) : "—"),
      "model: " + escapeHtml(debug.model || "—"),
      "pageContext: " + escapeHtml(debug.pageContext || "—"),
    ];
    if (debug.entities && Object.keys(debug.entities).length) {
      lines.push("entities: " + escapeHtml(JSON.stringify(debug.entities)));
    }
    return '<div class="ai-debug-panel">' + lines.map(function (l) {
      return '<span>' + l + '</span>';
    }).join("") + '</div>';
  }

  function appendMessage(role, text, debug) {
    var el = document.getElementById("aiMessages");
    if (!el) return;
    var welcome = el.querySelector(".ai-welcome");
    if (welcome) welcome.remove();

    var div = document.createElement("div");
    div.className = "ai-msg ai-msg-" + role;
    var bubble = role === "assistant" ? renderMarkdown(text) : escapeHtml(text);
    var debugHtml = role === "assistant" ? buildDebugPanel(debug) : "";
    div.innerHTML = '<div class="ai-msg-bubble">' + bubble + '</div>' + debugHtml;
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  }

  function appendSuggestions(suggestions) {
    if (!Array.isArray(suggestions) || !suggestions.length) return;
    var el = document.getElementById("aiMessages");
    if (!el) return;

    var row = document.createElement("div");
    row.className = "ai-suggestions-row";
    suggestions.forEach(function (label) {
      var btn = document.createElement("button");
      btn.className = "ai-suggestion-btn";
      btn.textContent = label;
      btn.addEventListener("click", function () {
        row.remove();
        sendQuestion(label);
      });
      row.appendChild(btn);
    });
    el.appendChild(row);
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

  // ── Restore history ───────────────────────────────────────────────────────────

  function restoreHistory() {
    _history = loadHistory();
    if (!_history.length) return;
    var el = document.getElementById("aiMessages");
    if (el) {
      var welcome = el.querySelector(".ai-welcome");
      if (welcome) welcome.remove();
    }
    _history.forEach(function (m) {
      appendMessage(m.role, m.text, m.debug);
    });
    var lastAsst = _history.slice().reverse().find(function (m) { return m.role === "assistant"; });
    if (lastAsst && lastAsst.suggestions && lastAsst.suggestions.length) {
      appendSuggestions(lastAsst.suggestions);
    }
  }

  // ── API call ──────────────────────────────────────────────────────────────────

  function sendQuestion(question) {
    if (_busy || !String(question || "").trim()) return;
    _busy = true;

    document.querySelectorAll(".ai-suggestions-row").forEach(function (el) { el.remove(); });

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
        question:    question,
        donorId:     _donorId || undefined,
        history:     _history.slice(-10),
        pageContext: _pageContext,
      }),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        removeTyping();
        var answer = data.answer || data.error || "שגיאה לא ידועה";
        if (data.fallback) {
          answer += "\n\n_(OpenAI לא זמין — תשובה מהמנוע המקומי)_";
        }
        var suggestions = data.suggestions || [];
        var debug = data.debug || null;
        _history.push({ role: "assistant", text: answer, intent: data.intent, suggestions: suggestions, debug: debug });
        saveHistory();
        appendMessage("assistant", answer, debug);
        appendSuggestions(suggestions);
      })
      .catch(function (err) {
        removeTyping();
        appendMessage("assistant", "שגיאה בתקשורת עם השרת.");
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
    saveHistory();
    var el = document.getElementById("aiMessages");
    if (el) el.innerHTML = '<div class="ai-welcome"><p>שיחה נוקתה. בחר שאלה או כתוב ידנית.</p></div>';
    document.querySelectorAll(".ai-suggestions-row").forEach(function (r) { r.remove(); });
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
    try {
      // _debugMode is only known once detectPageContext() has parsed
      // ?aiDebug=1 from the URL — both startup logs below are gated on it
      // and therefore moved after this call (previously the first log ran
      // before _debugMode was set at all, so it printed unconditionally
      // for every visitor, not just when debug mode is on).
      _pageContext = detectPageContext();
      if (_debugMode) {
        console.log("[AI] init() v3 starting, readyState=" + document.readyState);
        console.log("[AI] pageContext=" + _pageContext + ", donorId=" + _donorId + ", debug=" + _debugMode);
      }

      var fab   = buildFab();
      var panel = buildPanel();
      document.body.appendChild(fab);
      document.body.appendChild(panel);

      fab.addEventListener("click", function () {
        var p = document.getElementById("aiPanel");
        if (p && p.classList.contains("hidden")) { openPanel(); } else { closePanel(); }
      });

      var closeBtn = document.getElementById("aiCloseBtn");
      var clearBtn = document.getElementById("aiClearBtn");
      if (closeBtn) closeBtn.addEventListener("click", closePanel);
      if (clearBtn) clearBtn.addEventListener("click", clearChat);

      wireInput();
      restoreHistory();

      console.log("[AI] init() v3 done — FAB visible, pageContext=" + _pageContext);
    } catch (err) {
      console.error("[AI] init() v3 failed:", err);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
}());

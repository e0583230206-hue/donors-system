// IndexedDB wrapper for donors — transparent fallback from localStorage
// When localStorage quota is exceeded, donors migrate automatically to IDB.
var _CrmIDB = (function () {
  var _db      = null;
  var _cache   = null;   // null = not yet loaded from IDB
  var _pending = [];     // whenReady callbacks waiting for IDB load
  var _useIDB  = (localStorage.getItem("crm_idb_donors") === "1");
  var _loaded  = !_useIDB; // if not using IDB we're already "loaded"

  function _open(andLoad) {
    if (!window.indexedDB) { _fallback(); return; }
    var req = indexedDB.open("crm_v1", 1);
    req.onupgradeneeded = function (ev) {
      ev.target.result.createObjectStore("kv");
    };
    req.onsuccess = function (ev) {
      _db = ev.target.result;
      if (andLoad) _loadDonors();
    };
    req.onerror = function () { _fallback(); };
  }

  function _loadDonors() {
    if (!_db) { _fallback(); return; }
    try {
      var tx = _db.transaction("kv", "readonly");
      tx.objectStore("kv").get("donors").onsuccess = function (ev) {
        _cache  = ev.target.result || [];
        _loaded = true;
        _fire();
      };
      tx.onerror = function () { _fallback(); };
    } catch (e) { _fallback(); }
  }

  function _fallback() {
    try { _cache = JSON.parse(localStorage.getItem("donors") || "[]"); } catch (_) { _cache = []; }
    _loaded = true;
    _fire();
  }

  function _fire() {
    var cbs = _pending.splice(0);
    cbs.forEach(function (cb) { try { cb(); } catch (_) {} });
  }

  function _writeToDB(data) {
    if (!_db) return;
    try {
      var tx = _db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(data, "donors");
    } catch (e) { console.warn("[IDB] write error", e); }
  }

  _open(_useIDB);

  return {
    isUsingIDB : function ()   { return _useIDB; },
    getCache   : function ()   { return _cache || []; },
    whenReady  : function (cb) { if (_loaded) { cb(); } else { _pending.push(cb); } },

    saveDonors : function (data) {
      _cache = data;
      _writeToDB(data);
    },

    migrate : function (data) {
      _useIDB  = true;
      _loaded  = true;
      _cache   = data;
      localStorage.setItem("crm_idb_donors", "1");
      localStorage.removeItem("donors");
      console.info("[CRM] תורמים הועברו ל-IndexedDB (localStorage מלא)");
      if (_db) {
        _writeToDB(data);
      } else {
        _open(false);
        setTimeout(function () { _writeToDB(data); }, 80);
      }
    },
  };
}());

// ─────────────────────────────────────────────────────────────────────────────

const Database = {
  mode: "local",

  // Keys allowed to sync with server
  _serverKeys: ["donors", "tasks", "logs", "settings", "approvals"],
  _serverLoadPromise: null,

  get: function (key) {
    if (key === "donors" && _CrmIDB.isUsingIDB()) {
      return _CrmIDB.getCache();
    }
    if (this.mode === "local") {
      try {
        return JSON.parse(localStorage.getItem(key)) || [];
      } catch (error) {
        console.error("שגיאה בקריאת נתונים מהאחסון המקומי", key, error);
        return [];
      }
    }
    console.warn("מצב שרת עדיין לא מחובר: get", key);
    return [];
  },

  save: function (key, data) {
    if (key === "donors") {
      if (_CrmIDB.isUsingIDB()) {
        _CrmIDB.saveDonors(data);
        this._pushToServer(key, data);
        return;
      }
      if (this.mode === "local") {
        try {
          localStorage.setItem(key, JSON.stringify(data));
          this._pushToServer(key, data);
        } catch (e) {
          if (e.name === "QuotaExceededError" || e.code === 22 || e.code === 1014) {
            _CrmIDB.migrate(data);
            this._pushToServer(key, data);
            return;
          }
          throw e;
        }
      }
      return;
    }

    if (this.mode === "local") {
      localStorage.setItem(key, JSON.stringify(data));

      // Auto-backup every 10 saves (skip internal keys)
      var skipKeys = ["logs", "_autoBackupCount"];
      if (skipKeys.indexOf(key) === -1) {
        var count = Number(localStorage.getItem("_autoBackupCount") || 0) + 1;
        localStorage.setItem("_autoBackupCount", String(count));
        if (count % 10 === 0) {
          var stamp = new Date().toISOString().replace(/[:.]/g, "-");
          var backupKey = "crm_auto_backup_" + stamp;
          var suffix = 1;
          while (localStorage.getItem(backupKey)) {
            backupKey = "crm_auto_backup_" + stamp + "_" + suffix;
            suffix += 1;
          }
          var snap = {};
          ["donors", "workers", "tasks", "approvals"].forEach(function (k) {
            var v = localStorage.getItem(k);
            if (v) snap[k] = v;
          });
          localStorage.setItem(backupKey, JSON.stringify(snap));
        }
      }

      this._pushToServer(key, data);
      return;
    }

    console.warn("מצב שרת עדיין לא מחובר: save", key, data);
  },

  remove: function (key) {
    if (this.mode === "local") {
      localStorage.removeItem(key);
      return;
    }
    console.warn("מצב שרת עדיין לא מחובר: remove", key);
  },

  whenReady: function (cb) {
    var self = this;
    _CrmIDB.whenReady(function () {
      var token = self._getToken();
      if (!token) { cb(); return; }
      if (!self._serverLoadPromise) {
        self._serverLoadPromise = self.loadFromServer(token);
      }
      self._serverLoadPromise.then(function () { cb(); }).catch(function () { cb(); });
    });
  },

  // ── Server sync ────────────────────────────────────────────────────────────

  _getToken: function () {
    return sessionStorage.getItem("authToken") || "";
  },

  // Fire-and-forget push to server (non-blocking)
  _pushToServer: function (key, data) {
    if (this._serverKeys.indexOf(key) === -1) return;
    var token = this._getToken();
    if (!token) return;

    fetch("/api/data/" + key, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": "Bearer " + token,
      },
      body: JSON.stringify(data),
    }).then(function () {
      if (key !== "donors") return;
      // Sync phone+name to IVR donors table so the phone system sees updates
      var syncList = (Array.isArray(data) ? data : []).map(function (d) {
        return { phone: d.phone, fullName: d.fullName };
      }).filter(function (d) { return d.phone && d.fullName; });
      if (syncList.length === 0) return;
      return fetch("/api/donors/sync", {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": "Bearer " + token,
        },
        body: JSON.stringify(syncList),
      });
    }).catch(function (err) {
      console.warn("[DB] Server sync failed for key '" + key + "':", err.message);
    });
  },

  // Load all app data from server and update localStorage.
  // Called once after login; returns a Promise.
  loadFromServer: function (token) {
    var self  = this;
    var tok   = token || this._getToken();
    if (!tok) return Promise.resolve();

    var keys = this._serverKeys;

    var dataPromise = Promise.all(keys.map(function (key) {
      return fetch("/api/data/" + key, {
        headers: { "Authorization": "Bearer " + tok },
      })
        .then(function (res) {
          if (!res.ok) return;
          return res.json();
        })
        .then(function (data) {
          if (data === undefined) return;
          if (key === "donors" && _CrmIDB.isUsingIDB()) {
            _CrmIDB.saveDonors(Array.isArray(data) ? data : []);
          } else {
            localStorage.setItem(key, JSON.stringify(data));
          }
        })
        .catch(function () {});
    }));

    // Workers use a separate endpoint (not part of /api/data).
    // Admin/secretary get the full list; others fall back to the public list.
    var workersPromise = fetch("/api/workers", {
      headers: { "Authorization": "Bearer " + tok },
    }).then(function (res) {
      if (!res.ok) {
        return fetch("/api/workers/list").then(function (r) {
          return r.ok ? r.json() : undefined;
        });
      }
      return res.json();
    }).then(function (data) {
      if (Array.isArray(data)) {
        localStorage.setItem("workers", JSON.stringify(data));
      }
    }).catch(function () {});

    return Promise.all([dataPromise, workersPromise]);
  },
};

// ─────────────────────────────────────────────────────────────────────────────

function addLog(text) {
  var logs = Database.get("logs");
  logs.push({
    id:   Date.now(),
    text: text,
    date: new Date().toISOString(),
  });
  Database.save("logs", logs);
}

// Global currency formatter — reads settings.currency ("ILS" or "USD")
function formatMoney(amount, currency) {
  if (!currency) {
    var settings = {};
    try { settings = JSON.parse(localStorage.getItem("settings") || "{}"); } catch (_) {}
    currency = settings.currency || "ILS";
  }
  var n    = Number(amount || 0);
  var opts = { minimumFractionDigits: 0, maximumFractionDigits: 2 };
  if (currency === "USD") {
    return "$" + n.toLocaleString("en-US", opts);
  }
  return "₪" + n.toLocaleString("he-IL", opts);
}

function currencySymbol() {
  var settings = {};
  try { settings = JSON.parse(localStorage.getItem("settings") || "{}"); } catch (_) {}
  return (settings.currency || "ILS") === "USD" ? "$" : "₪";
}

function escapeHTML(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Legacy SHA-256 hash — NOT used for authentication (server uses bcrypt).
// Kept only so old backup files referencing this function don't break.
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data    = encoder.encode(password);
  const buf     = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map(function (b) { return b.toString(16).padStart(2, "0"); })
    .join("");
}

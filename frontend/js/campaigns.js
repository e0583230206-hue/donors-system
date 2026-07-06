/* global apiFetch, Database, showToast, escapeHTML */

// ── Radio-card visual selection helper ───────────────────────────────────────

function bindRadioCards(containerSel, radioName) {
  var container = document.querySelector(containerSel);
  if (!container) return;
  container.addEventListener("change", function (e) {
    if (e.target.name !== radioName) return;
    container.querySelectorAll("[data-value]").forEach(function (row) {
      row.classList.toggle("selected", row.dataset.value === e.target.value);
    });
  });
}
bindRadioCards("#audienceGrid", "audience");
bindRadioCards("#msgOptions",   "message");

// Show textarea only when "text" message is selected
document.querySelectorAll("input[name=message]").forEach(function (r) {
  r.addEventListener("change", updateSendButton);
});

// ── Audience options (load from server + live count) ─────────────────────────

var selectedDonorId   = null;
var selectedDonorName = null;

async function loadAudienceOptions() {
  try {
    var res  = await apiFetch("/api/technoline/send/audience-options");
    var data = await res.json();

    // Debt badge
    var badgeDebt = document.getElementById("badgeDebt");
    if (badgeDebt) {
      badgeDebt.textContent = (data.debtCount || 0) + " תורמים";
      if (!data.debtCount) badgeDebt.classList.add("zero");
    }

    // Tags
    if (data.tags && data.tags.length > 0) {
      var tagSelect = document.getElementById("tagSelect");
      data.tags.forEach(function (t) {
        var o = document.createElement("option");
        o.value = t; o.textContent = t;
        tagSelect.appendChild(o);
      });
      document.getElementById("rowTag").style.display = "";
    }

    // Cities
    if (data.cities && data.cities.length > 0) {
      var citySelect = document.getElementById("citySelect");
      data.cities.forEach(function (c) {
        var o = document.createElement("option");
        o.value = c; o.textContent = c;
        citySelect.appendChild(o);
      });
      document.getElementById("rowCity").style.display = "";
    }
  } catch (_) {}

  await refreshCount();
}

var _lastDonorCount = 0;

async function fetchCount(filter) {
  try {
    var res  = await apiFetch("/api/technoline/send/recipient-count?filter=" + encodeURIComponent(filter));
    var data = await res.json();
    _lastDonorCount = data.donorCount || 0;
    return data.count || 0;
  } catch (_) { _lastDonorCount = 0; return 0; }
}

function getAudienceFilter() {
  var val = (document.querySelector("input[name=audience]:checked") || {}).value || "debt";
  if (val === "tag") {
    var tv = (document.getElementById("tagSelect")  || {}).value || "";
    return tv ? "tag:" + tv : null;
  }
  if (val === "city") {
    var cv = (document.getElementById("citySelect") || {}).value || "";
    return cv ? "city:" + cv : null;
  }
  if (val === "donor") {
    return selectedDonorId ? "donor:" + selectedDonorId : null;
  }
  return val; // "debt" | "all"
}

async function refreshCount() {
  var filter = getAudienceFilter();
  var count  = filter ? await fetchCount(filter) : 0;

  var countEl = document.getElementById("sendCount");
  if (countEl) countEl.textContent = count;
  updateSendButton(count);

  // Update per-row badge for sub-selectors
  var audVal = (document.querySelector("input[name=audience]:checked") || {}).value;
  if (audVal === "tag")    updateBadge("badgeTag",    count);
  if (audVal === "city")   updateBadge("badgeCity",   count);
  if (audVal === "donor")  updateBadge("badgeDonor",  count);
}

function updateBadge(id, count) {
  var el = document.getElementById(id);
  if (!el) return;
  el.textContent = count;
  el.classList.toggle("zero", count === 0);
}

// Re-fetch when audience radio changes or sub-selects change
document.querySelectorAll("input[name=audience]").forEach(function (r) {
  r.addEventListener("change", refreshCount);
});
var tagSel  = document.getElementById("tagSelect");
var citySel = document.getElementById("citySelect");
if (tagSel)  tagSel.addEventListener("change",  refreshCount);
if (citySel) citySel.addEventListener("change", refreshCount);

// ── Donor search autocomplete ─────────────────────────────────────────────────

var donorInput       = document.getElementById("donorSearchInput");
var donorSuggestions = document.getElementById("donorSuggestions");
var donorInfo        = document.getElementById("selectedDonorInfo");

function searchDonors(query) {
  var donors = Database.get("donors") || [];
  query      = query.trim().toLowerCase();
  if (!query) return [];
  var digits = query.replace(/\D/g, "");
  return donors.filter(function (d) {
    var nameMatch  = (d.fullName || "").toLowerCase().includes(query);
    var phoneMatch = digits && [d.phone, d.phone2, d.phone3, d.phone4].some(function (p) {
      return p && String(p).replace(/\D/g, "").includes(digits);
    });
    var idMatch    = digits && d.idNumber && String(d.idNumber).replace(/\D/g, "").includes(digits);
    return nameMatch || phoneMatch || idMatch;
  }).slice(0, 8);
}

function selectDonor(donor) {
  selectedDonorId   = donor.id;
  selectedDonorName = donor.fullName;
  if (donorInput) donorInput.value = donor.fullName;
  if (donorInfo) {
    var approved = donor.ivrApprovedPhones || [];
    if (approved.length > 0) {
      donorInfo.style.color = "#1565c0";
      donorInfo.textContent = "📞 " + approved.join(" | ");
    } else {
      donorInfo.style.color = "#c62828";
      donorInfo.textContent = "⚠️ לתורם זה אין מספרים מאושרים ל-IVR";
    }
  }
  if (donorSuggestions) donorSuggestions.style.display = "none";
  refreshCount();
}

function clearDonorSelection() {
  selectedDonorId   = null;
  selectedDonorName = null;
  if (donorInfo)  donorInfo.textContent = "";
}

if (donorInput) {
  donorInput.addEventListener("input", function () {
    clearDonorSelection();
    var results = searchDonors(this.value);
    if (results.length === 0) {
      donorSuggestions.style.display = "none";
      return;
    }
    donorSuggestions.innerHTML = results.map(function (d) {
      var phones = (d.ivrApprovedPhones || []).slice(0, 2).join(", ");
      return '<div class="donor-suggestion" data-id="' + d.id + '">' +
        escapeHTML(d.fullName) +
        (phones ? '<span style="color:#888;font-size:.85em;margin-right:6px"> ' + escapeHTML(phones) + '</span>' : "") +
        '</div>';
    }).join("");
    donorSuggestions.style.display = "";
  });

  donorInput.addEventListener("blur", function () {
    setTimeout(function () { if (donorSuggestions) donorSuggestions.style.display = "none"; }, 200);
  });
}

if (donorSuggestions) {
  donorSuggestions.addEventListener("mousedown", function (e) {
    var item = e.target.closest(".donor-suggestion");
    if (!item) return;
    var donors = Database.get("donors") || [];
    var donor  = donors.find(function (d) { return d.id === Number(item.dataset.id); });
    if (donor) selectDonor(donor);
  });
}

// ── Send button state ─────────────────────────────────────────────────────────

function updateSendButton(count) {
  var btn = document.getElementById("sendButton");
  if (!btn) return;
  var n = typeof count === "number" ? count : Number((document.getElementById("sendCount") || {}).textContent) || 0;

  var msgVal     = (document.querySelector("input[name=message]:checked") || {}).value || "ivr";
  var textFilled = msgVal !== "text" || ((document.getElementById("msgTextInput") || {}).value || "").trim().length > 0;

  btn.disabled = (n === 0 || !textFilled);

  // Update button label: "שלח ל-X מספרים (Y תורמים)" when counts differ
  var countEl = document.getElementById("sendCount");
  if (countEl) {
    var suffix = (_lastDonorCount > 0 && _lastDonorCount !== n)
      ? n + " מספרים (" + _lastDonorCount + " תורמים)"
      : n + " מספרים";
    countEl.textContent = suffix;
  }
}

var msgTextInput = document.getElementById("msgTextInput");
if (msgTextInput) msgTextInput.addEventListener("input", updateSendButton);

// ── Send ──────────────────────────────────────────────────────────────────────

function showStatus(text, type) {
  var el = document.getElementById("sendStatus");
  if (!el) return;
  el.innerText = text;
  el.className = "message show " + (type || "success");
  if (type !== "error") setTimeout(function () { el.className = "message"; el.innerText = ""; }, 7000);
}

document.getElementById("sendButton").addEventListener("click", async function () {
  var btn      = this;
  var count    = Number((document.getElementById("sendCount") || {}).textContent) || 0;
  var filter   = getAudienceFilter();
  var msgVal   = (document.querySelector("input[name=message]:checked") || {}).value || "ivr";
  var msgText  = ((document.getElementById("msgTextInput") || {}).value || "").trim();

  if (!filter || count === 0) {
    showStatus("אין מספרים תואמים לשליחה", "error");
    return;
  }
  if (msgVal === "text" && !msgText) {
    showStatus("יש להזין הודעה", "error");
    return;
  }

  // Clear audience label for confirm dialog
  var audLabel = getAudienceLabel();
  if (!confirm("לשלוח הודעה ל-" + count + " מספרים" + (audLabel ? " (" + audLabel + ")" : "") + "?")) return;

  btn.disabled    = true;
  btn.textContent = "שולח...";

  try {
    var payload = {
      recipientFilter: filter,
      messageKind:     msgVal,
      messageText:     msgText,
      quietHours:      true,
    };

    var res  = await apiFetch("/api/technoline/send", { method: "POST", body: JSON.stringify(payload) });
    var data = await res.json();

    if (!res.ok) {
      showStatus(data.error || "שגיאה בשיגור", "error");
    } else {
      var summary = "ההודעות נשוגרו ל-" + (data.phones || count) + " מספרים";
      if (data.errorPhones)   summary += " | " + data.errorPhones   + " שגיאות פורמט";
      if (data.blockedPhones) summary += " | " + data.blockedPhones + " חסומים";
      showStatus("✅ " + summary, "success");
      showToast("שיגור הושלם");
      loadRecentLog();
    }
  } catch (_) {
    showStatus("שגיאת תקשורת עם השרת", "error");
  } finally {
    btn.disabled  = false;
    btn.innerHTML = "📣 שלח הודעה ל-<span id='sendCount'></span>";
    updateSendButton(count);
  }
});

function getAudienceLabel() {
  var val = (document.querySelector("input[name=audience]:checked") || {}).value || "";
  if (val === "debt") return "בעלי חוב";
  if (val === "tag")  return "תגית: " + ((document.getElementById("tagSelect")  || {}).value || "");
  if (val === "city") return "עיר: "  + ((document.getElementById("citySelect") || {}).value || "");
  if (val === "donor" && selectedDonorName) return selectedDonorName;
  return "";
}

// ── Recent log (read-only) ────────────────────────────────────────────────────

async function loadRecentLog() {
  var container = document.getElementById("recentLog");
  if (!container) return;

  try {
    var res  = await apiFetch("/api/technoline/campaign/history");
    var data = await res.json();

    if (!res.ok) {
      container.innerHTML = '<p class="log-empty">' + escapeHTML(data.error || "שגיאה בטעינה") + '</p>';
      return;
    }

    var list = Array.isArray(data) ? data : (data.campaigns || data.history || []);
    if (list.length === 0) {
      container.innerHTML = '<p class="log-empty">אין שיגורים קודמים</p>';
      return;
    }

    var statusMap = {
      active:  "🟢 פעיל",
      hold:    "⏸ מושהה",
      ended:   "✔ הסתיים",
      stoped:  "⏹ הופסק",
      stopped: "⏹ הופסק",
    };

    container.innerHTML = '<table style="width:100%;font-size:.88em;border-collapse:collapse;">' +
      '<thead><tr>' +
      '<th style="text-align:right;padding:4px 8px;color:#888;font-weight:600;border-bottom:1px solid #eee;">תאריך</th>' +
      '<th style="text-align:right;padding:4px 8px;color:#888;font-weight:600;border-bottom:1px solid #eee;">נשלח</th>' +
      '<th style="text-align:right;padding:4px 8px;color:#888;font-weight:600;border-bottom:1px solid #eee;">נענו</th>' +
      '<th style="text-align:right;padding:4px 8px;color:#888;font-weight:600;border-bottom:1px solid #eee;">סטטוס</th>' +
      '</tr></thead><tbody>' +
      list.slice(0, 10).map(function (c) {
        var dateStr = c.start_time
          ? new Date(c.start_time.replace(" ", "T")).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem", hour12: false, dateStyle: "short", timeStyle: "short" })
          : "—";
        var status = statusMap[(c.active || "").toLowerCase()] || escapeHTML(c.active || "—");
        return "<tr>" +
          "<td style='padding:5px 8px;border-bottom:1px solid #f5f5f5'>" + escapeHTML(dateStr) + "</td>" +
          "<td style='padding:5px 8px;border-bottom:1px solid #f5f5f5'>" + escapeHTML(String(c.total_sent || "—")) + "</td>" +
          "<td style='padding:5px 8px;border-bottom:1px solid #f5f5f5'>" + escapeHTML(String(c.answerd_calls || "—")) + "</td>" +
          "<td style='padding:5px 8px;border-bottom:1px solid #f5f5f5'>" + status + "</td>" +
          "</tr>";
      }).join("") +
      "</tbody></table>";
  } catch (_) {
    container.innerHTML = '<p class="log-empty">לא ניתן לטעון שיגורים</p>';
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

Database.whenReady(function () {
  loadAudienceOptions();
  loadRecentLog();
});

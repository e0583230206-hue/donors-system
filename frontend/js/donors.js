let donors = Database.get("donors");

const nameInput = document.getElementById("nameInput");
const phoneInput = document.getElementById("phoneInput");
const cityInput = document.getElementById("cityInput");
const addressInput = document.getElementById("addressInput");
const notesInput = document.getElementById("notesInput");
const addDonorButton = document.getElementById("addDonorButton");
const donorsList = document.getElementById("donorsList");
const searchInput = document.getElementById("searchInput");
const messageBox = document.getElementById("messageBox");
const namesList = document.getElementById("namesList");
const pendingDonorDeletions = {};
function updateNamesList() {
  if (!namesList) return;

  namesList.innerHTML = "";

  donors.forEach(function (donor) {
    const option = document.createElement("option");
    option.value = donor.fullName;
    namesList.appendChild(option);
  });
}

function saveDonors() {
  Database.save("donors", donors);
  updateNamesList();
}

function showMessage(text, type = "success") {
  messageBox.innerText = text;
  messageBox.className = "message show " + type;

  setTimeout(function () {
    messageBox.className = "message";
    messageBox.innerText = "";
  }, 3000);
}

function createDonorId() {
  return Date.now();
}

function getCurrentHebrewYear() {
  if (window.HebrewDate) {
    var fullText = window.HebrewDate.getHebrewDateText(new Date());
    var parts = fullText.split(" ");
    return parts[parts.length - 1];
  }
  return new Date().toLocaleDateString("he-IL-u-ca-hebrew", { year: "numeric" });
}

function addDonor() {
  const fullName = nameInput.value.trim();
  const phone = phoneInput.value.trim();
  const city = cityInput.value.trim();
  const address = addressInput.value.trim();
  const notes = notesInput.value.trim();

  if (fullName === "" || phone === "") {
    showMessage("חובה למלא שם מלא ומספר טלפון", "error");
    return;
  }

  if (!/^[\d\s\-+()]{7,15}$/.test(phone)) {
    showMessage("מספר טלפון לא תקין — ספרות בלבד, 7 עד 15 תווים", "error");
    return;
  }

  const phoneExists = donors.some(function (donor) {
    return donor.phone === phone;
  });

  if (phoneExists) {
    showMessage("תורם עם מספר טלפון זה כבר קיים", "error");
    return;
  }

  const newDonor = {
    id: createDonorId(),
    fullName: fullName,
    phone: phone,
    city: city,
    address: address,
    notes: notes,
    status: "פעיל",
    hebrewYear: getCurrentHebrewYear(),
    donations: [],
    tasks: [],
    reminders: [],
    internalNotes: [],
    publicNotes: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  donors.push(newDonor);
  saveDonors();

  nameInput.value = "";
  phoneInput.value = "";
  cityInput.value = "";
  addressInput.value = "";
  notesInput.value = "";
  AuditLog.record({
    action: "create",
    entityType: "donor",
    entityId: newDonor.id,
    entityName: newDonor.fullName,
    details: "נוסף תורם חדש",
  });
  showMessage("התורם נוסף בהצלחה");
  renderDonors();
}

function getDonorDebt(donor) {
  return donor.donations.reduce(function (sum, donation) {
    return sum + Number(donation.remainingDebt || 0);
  }, 0);
}

function getPaidTotal(donor) {
  return donor.donations.reduce(function (sum, donation) {
    return sum + Number(donation.paidPartial || 0);
  }, 0);
}

function populateCityFilter() {
  var filterCity = document.getElementById("filterCity");
  if (!filterCity) return;
  var cities = {};
  donors.forEach(function (d) { if (d.city) cities[d.city] = true; });
  var existing = Array.from(filterCity.options).map(function(o){ return o.value; });
  Object.keys(cities).sort(function(a,b){ return a.localeCompare(b,"he"); }).forEach(function(c) {
    if (existing.indexOf(c) === -1) {
      var opt = document.createElement("option");
      opt.value = c; opt.textContent = c;
      filterCity.appendChild(opt);
    }
  });
}

function renderDonorsStats(total, shown) {
  var el = document.getElementById("donorsStats");
  if (!el) return;
  var totalDebt = donors.reduce(function (s, d) {
    return s + (d.donations || []).reduce(function (ds, don) { return ds + Number(don.remainingDebt || 0); }, 0);
  }, 0);
  el.innerHTML =
    "<span>👤 סה״כ תורמים: <strong>" + total + "</strong></span>" +
    (shown !== total ? "<span>🔍 מוצגים: <strong>" + shown + "</strong></span>" : "") +
    "<span>💰 חוב כולל: <strong style='color:#e74c3c;'>" + formatMoney(totalDebt) + "</strong></span>";
}

function renderDonors() {
  donorsList.innerHTML = "";
  updateNamesList();
  populateCityFilter();

  const searchText  = searchInput.value.trim().toLowerCase();
  const sortSelect  = document.getElementById("sortSelect");
  const sortVal     = sortSelect ? sortSelect.value : "name-asc";
  const filterStatus = (document.getElementById("filterStatus") || {}).value || "";
  const filterCity   = (document.getElementById("filterCity")   || {}).value || "";
  const filterTag    = ((document.getElementById("filterTag") || {}).value || "").trim().toLowerCase();

  let filteredDonors = donors.filter(function (donor) {
    if (pendingDonorDeletions[donor.id]) return false;

    const matchSearch = (
      (donor.fullName || "").toLowerCase().includes(searchText) ||
      (donor.phone    || "").includes(searchText) ||
      (donor.city     || "").toLowerCase().includes(searchText) ||
      (donor.tags || []).some(function(t){ return t.toLowerCase().includes(searchText); })
    );
    const matchStatus = !filterStatus || (donor.status || "פעיל") === filterStatus;
    const matchCity   = !filterCity   || (donor.city   || "") === filterCity;
    const matchTag    = !filterTag    || (donor.tags || []).some(function(t){ return t.toLowerCase().includes(filterTag); });
    return matchSearch && matchStatus && matchCity && matchTag;
  });

  filteredDonors.sort(function(a, b) {
    switch (sortVal) {
      case "name-asc":  return (a.fullName || "").localeCompare(b.fullName || "", "he");
      case "name-desc": return (b.fullName || "").localeCompare(a.fullName || "", "he");
      case "city-asc":  return (a.city || "").localeCompare(b.city || "", "he");
      case "debt-desc": return getDonorDebt(b) - getDonorDebt(a);
      case "paid-desc": return getPaidTotal(b) - getPaidTotal(a);
      case "new-first": return (b.createdAt || "").localeCompare(a.createdAt || "");
      case "old-first": return (a.createdAt || "").localeCompare(b.createdAt || "");
      default:          return 0;
    }
  });

  renderDonorsStats(donors.filter(function(d){ return !pendingDonorDeletions[d.id]; }).length, filteredDonors.length);

  if (filteredDonors.length === 0) {
    donorsList.innerHTML = `<div class="empty-box">לא נמצאו תורמים</div>`;
    return;
  }

  filteredDonors.forEach(function (donor) {
    const debt = getDonorDebt(donor);
    const paidTotal = getPaidTotal(donor);
    const tagsHtml = (donor.tags && donor.tags.length > 0)
      ? '<div class="donor-card-tags">' + donor.tags.map(function(t){
          return '<span class="tag">' + escapeHTML(t) + '</span>';
        }).join("") + '</div>'
      : "";

    const card = document.createElement("div");
    card.className = "donor-card";

    card.innerHTML = `
      <h3>👤 ${escapeHTML(donor.fullName)}</h3>
      ${tagsHtml}
      <p>📞 ${escapeHTML(donor.phone)}</p>
      <p>🏙️ ${escapeHTML(donor.city || "לא הוזנה עיר")}</p>
      <p>📅 שנה: ${escapeHTML(donor.hebrewYear)}</p>

      <div class="donor-stats">
        <span>💰 שולם: ${formatMoney(paidTotal)}</span>
        <span class="${debt > 0 ? "red-text" : "green-text"}">
          ⚠️ חוב: ${formatMoney(debt)}
        </span>
      </div>

      <div class="card-actions">
        <a class="small-btn" href="donor.html?id=${donor.id}">פתח כרטיס</a>
        <button onclick="deleteDonor(${donor.id})" class="danger-btn">מחק</button>
      </div>
    `;

    donorsList.appendChild(card);
  });
}

function deleteDonor(id) {
  const deletedDonor = donors.find(function (donor) { return donor.id === id; });
  if (!deletedDonor || pendingDonorDeletions[id]) return;

  // Remove immediately from array and save to server/localStorage right away
  donors = donors.filter(function (donor) { return donor.id !== id; });
  saveDonors();
  AuditLog.record({
    action: "delete",
    entityType: "donor",
    entityId: deletedDonor.id,
    entityName: deletedDonor.fullName,
    details: "נמחק תורם מהמערכת",
  });
  renderDonors();

  if (typeof showToast === "function") {
    // Undo restores the donor back (client-side only, re-saves to server)
    showToast('תורם "' + deletedDonor.fullName + '" נמחק', function () {
      donors.push(deletedDonor);
      donors.sort(function (a, b) {
        return (a.fullName || "").localeCompare(b.fullName || "", "he");
      });
      saveDonors();
      renderDonors();
    }, 5000);
  } else {
    showMessage("התורם נמחק בהצלחה");
  }
}

function importFromExcel() {
  const fileInput = document.getElementById("fileInput");
  fileInput.click();
}

function handleFileUpload(event) {
  var file = event.target.files[0];
  if (!file) return;

  var skippedRows = [];   // declared outside try — accessible after the try block
  var importDone  = false;

  var reader = new FileReader();

  reader.onload = function (e) {
    try {
      var data      = new Uint8Array(e.target.result);
      var workbook  = XLSX.read(data, { type: "array" });
      var worksheet = workbook.Sheets[workbook.SheetNames[0]];
      var rawRows   = XLSX.utils.sheet_to_json(worksheet);

      if (rawRows.length === 0) {
        showMessage("⚠️ הגיליון ריק — לא נמצאו שורות לייבוא", "error");
        return;
      }

      // normalize column names: trim spaces + Unicode NFC to handle Excel encoding variations
      var normKey = function (k) { return String(k).trim().normalize ? String(k).trim().normalize("NFC") : String(k).trim(); };
      var rows = rawRows.map(function (r) {
        var out = {};
        Object.keys(r).forEach(function (k) { out[normKey(k)] = r[k]; });
        return out;
      });

      console.log("[ייבוא אקסל] עמודות שנמצאו:", Object.keys(rows[0]).join(", "));

      // Parses a cell that may contain a currency symbol (e.g. "$13.5", "13.5$", "₪13")
      // Returns { value: number, currency: "USD"|"ILS" }
      var parseCurrencyAmount = function (val) {
        var str = String(val === undefined || val === null ? "" : val).trim();
        var currency = str.indexOf("$") !== -1 ? "USD" : "ILS";
        var num = Number(str.replace(/[^0-9.]/g, ""));
        return { value: isNaN(num) ? NaN : num, currency: currency };
      };

      var normalizePhone = function (p) { return String(p).replace(/[\s\-()]/g, ""); };
      var donorsCreated  = 0;
      var donorsUpdated  = 0;
      var donationsAdded = 0;
      var idBase = Date.now();
      var idSeq  = 0;

      rows.forEach(function (row, rowIndex) {
        var phone      = String(row["פלפון"] || row["מספר פלפון"] || row["טלפון"] || row["phone"] || "").trim();
        var firstName  = String(row["שם"]    || "").trim();
        var familyName = String(row["משפחה"] || "").trim();
        var fullName   = (firstName + " " + familyName).trim();
        var parsha     = String(row["פרשת"]  || row["גליון"] || row["פרשה"] || "").trim();
        var purpose      = String(row["עבור"]  || "").trim();
        var parsedAmount = parseCurrencyAmount(row["סכום"]);
        var amount       = parsedAmount.value;
        var rowCurrency  = parsedAmount.currency;
        var paidAmount   = parseCurrencyAmount(row["שולם"] || 0).value;
        var remainingRaw = row["נשאר חייב"];
        var remainingDebt = (remainingRaw !== undefined && remainingRaw !== "")
          ? parseCurrencyAmount(remainingRaw).value
          : Math.max(0, amount - paidAmount);
        var paid = amount > 0 && remainingDebt <= 0;

        var skipReason = null;
        if (!phone)                            skipReason = "אין טלפון";
        else if (!fullName)                    skipReason = "אין שם";
        else if (isNaN(amount) || amount <= 0) skipReason = "סכום לא תקין (" + row["סכום"] + ")";

        if (skipReason) {
          skippedRows.push({ row: rowIndex + 2, name: fullName || "(ריק)", phone: phone || "(ריק)", reason: skipReason });
          return;
        }

        var phoneNorm = normalizePhone(phone);
        var isNew = false;
        var target = donors.find(function (d) { return normalizePhone(d.phone) === phoneNorm; });

        if (!target) {
          target = {
            id: idBase + (++idSeq),
            fullName: fullName,
            phone: phone,
            city: "",
            address: "",
            notes: "",
            status: "פעיל",
            hebrewYear: getCurrentHebrewYear(),
            donations: [],
            tasks: [],
            reminders: [],
            internalNotes: [],
            publicNotes: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          donors.push(target);
          donorsCreated++;
          isNew = true;
        }

        if (!target.donations) target.donations = [];
        var now = new Date();
        target.donations.push({
          id: idBase + (++idSeq),
          date: now.toISOString(),
          regularDate: now.toISOString().slice(0, 10),
          hebrewDate: window.HebrewDate ? window.HebrewDate.getHebrewDateText(now) : "",
          weekday: window.HebrewDate ? window.HebrewDate.getHebrewWeekday(now) : "",
          amount: amount,
          currency: rowCurrency,
          parsha: parsha,
          finalPurpose: purpose || "כללי",
          purposeType: "אחר",
          customPurpose: purpose || "",
          paymentMethod: "מזומן",
          paid: paid,
          paidPartial: paidAmount,
          remainingDebt: remainingDebt,
          note: String(row["הערות"] || "").trim(),
          approvedStatus: "טיוטה",
          messageStatus: "טיוטה",
          createdAt: now.toISOString(),
        });
        target.updatedAt = now.toISOString();
        donationsAdded++;
        if (!isNew) donorsUpdated++;
      });

      console.log("[ייבוא אקסל] שורות שדולגו:", skippedRows);

      if (donationsAdded > 0 || donorsCreated > 0) {
        saveDonors();
        addLog("יבוא מאקסל: " + donorsCreated + " חדשים, " + donorsUpdated + " עודכנו, " + donationsAdded + " תרומות, " + skippedRows.length + " דולגו");
        AuditLog.record({
          action: "import",
          entityType: "donor",
          entityId: "",
          entityName: "ייבוא תרומות מאקסל",
          details: donorsCreated + " חדשים, " + donorsUpdated + " עודכנו, " + donationsAdded + " תרומות",
        });
        showMessage(
          "✅ יבוא הושלם: " + donorsCreated + " תורמים חדשים | " +
          donorsUpdated + " קיימים עודכנו | " +
          donationsAdded + " תרומות נוספו" +
          (skippedRows.length > 0 ? " | " + skippedRows.length + " שורות דולגו" : "")
        );
        importDone = true;
        renderDonors();
      } else {
        var colList = rows.length > 0 ? Object.keys(rows[0]).join(", ") : "גיליון ריק";
        showMessage("⚠️ לא נמצאו נתונים לייבוא. עמודות שנמצאו: " + colList, "error");
        console.warn("[ייבוא אקסל] עמודות:", colList);
      }
    } catch (err) {
      showMessage("❌ שגיאה בקריאת הקובץ: " + err.message, "error");
      console.error("[ייבוא אקסל]", err);
    }

    // Show skipped-rows panel AFTER the try/catch — a crash here won't affect the import
    if (skippedRows.length > 0) {
      try { renderImportSkippedReport(skippedRows); } catch (ex) { console.warn(ex); }
    }
  };

  reader.readAsArrayBuffer(file);
  event.target.value = "";
}

function renderImportSkippedReport(skippedRows) {
  var panel = document.getElementById("importSkippedReport");
  if (!panel) return;

  panel.style.display = "block";
  panel.style.cssText =
    "display:block;margin:10px 0;padding:14px;background:var(--bg2,#1e1e2e);" +
    "border:1px solid #c0392b;border-radius:8px;direction:rtl;font-size:13px;";

  var tableRows = skippedRows.map(function (r) {
    return "<tr>" +
      "<td style='padding:5px 8px;border:1px solid #444;'>" + escapeHTML(String(r.row)) + "</td>" +
      "<td style='padding:5px 8px;border:1px solid #444;'>" + escapeHTML(r.name) + "</td>" +
      "<td style='padding:5px 8px;border:1px solid #444;'>" + escapeHTML(r.phone) + "</td>" +
      "<td style='padding:5px 8px;border:1px solid #444;color:#e74c3c;'>" + escapeHTML(r.reason) + "</td>" +
      "</tr>";
  }).join("");

  panel.innerHTML =
    "<div style='display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;'>" +
      "<strong style='color:#e74c3c;'>⚠️ שורות שדולגו (" + skippedRows.length + ")</strong>" +
      "<button onclick=\"document.getElementById('importSkippedReport').style.display='none'\" " +
        "style='background:none;border:1px solid #666;border-radius:4px;padding:3px 10px;cursor:pointer;'>✕ סגור</button>" +
    "</div>" +
    "<div style='overflow-x:auto;'>" +
    "<table style='width:100%;border-collapse:collapse;'>" +
      "<thead><tr style='background:rgba(255,255,255,.08);'>" +
        "<th style='padding:6px 8px;border:1px solid #444;text-align:right;'>שורה</th>" +
        "<th style='padding:6px 8px;border:1px solid #444;text-align:right;'>שם</th>" +
        "<th style='padding:6px 8px;border:1px solid #444;text-align:right;'>טלפון</th>" +
        "<th style='padding:6px 8px;border:1px solid #444;text-align:right;'>סיבה</th>" +
      "</tr></thead>" +
      "<tbody>" + tableRows + "</tbody>" +
    "</table></div>";
}

addDonorButton.addEventListener("click", addDonor);
searchInput.addEventListener("input", renderDonors);
var sortSelectEl = document.getElementById("sortSelect");
if (sortSelectEl) sortSelectEl.addEventListener("change", renderDonors);

["filterStatus","filterCity","filterTag"].forEach(function(id) {
  var el = document.getElementById(id);
  if (el) el.addEventListener(id === "filterTag" ? "input" : "change", renderDonors);
});

var filterClearBtn = document.getElementById("filterClearBtn");
if (filterClearBtn) {
  filterClearBtn.addEventListener("click", function() {
    var fs = document.getElementById("filterStatus"); if (fs) fs.value = "";
    var fc = document.getElementById("filterCity");   if (fc) fc.value = "";
    var ft = document.getElementById("filterTag");    if (ft) ft.value = "";
    renderDonors();
  });
}

nameInput.addEventListener("keydown", function (event) {
  if (event.key === "Enter") {
    addDonor();
  }
});

phoneInput.addEventListener("keydown", function (event) {
  if (event.key === "Enter") {
    addDonor();
  }
});

const importButton = document.getElementById("importButton");
const fileInput = document.getElementById("fileInput");
importButton.addEventListener("click", importFromExcel);
fileInput.addEventListener("change", handleFileUpload);

Database.whenReady(function () {
  donors = Database.get("donors");
  updateNamesList();
  renderDonors();
});

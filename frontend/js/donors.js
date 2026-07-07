let donors = Database.get("donors");
var selectedDonorIds = new Set();

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
var donorPage = 0;
var DONOR_PAGE_SIZE = 50;

function setDonorPage(n) {
  donorPage = n;
  renderDonors();
}

function renderDonorPagination(total) {
  var totalPages = Math.ceil(total / DONOR_PAGE_SIZE);
  var html = "";
  if (totalPages > 1) {
    for (var i = 0; i < totalPages; i++) {
      html += '<button class="page-btn' + (i === donorPage ? " active" : "") +
              '" onclick="setDonorPage(' + i + ')">' + (i + 1) + '</button>';
    }
  }
  var el  = document.getElementById("donorsPaginationBar");
  var el2 = document.getElementById("donorsPaginationBar2");
  if (el)  el.innerHTML  = html;
  if (el2) el2.innerHTML = html;
}

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

function normalizePhoneLocal(p) {
  var digits = String(p === undefined || p === null ? "" : p).trim().replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("972") && digits.length >= 11) return "0" + digits.slice(3);
  if (digits.length === 9 && !digits.startsWith("0")) return "0" + digits;
  return digits;
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

  const normPhone = normalizePhoneLocal(phone);
  const phoneExists = donors.some(function (donor) {
    return normalizePhoneLocal(donor.phone) === normPhone;
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
    if (donation.paid === true) {
      return sum + Number(donation.amount);
    }
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

  const searchText  = searchInput.value.trim().replace(/\s+/g, " ").toLowerCase();
  const sortSelect  = document.getElementById("sortSelect");
  const sortVal     = sortSelect ? sortSelect.value : "name-asc";
  const filterStatus = (document.getElementById("filterStatus") || {}).value || "";
  const filterCity   = (document.getElementById("filterCity")   || {}).value || "";
  const filterTag    = ((document.getElementById("filterTag") || {}).value || "").trim().toLowerCase();

  function donorMatchesSearch(donor, q) {
    if (!q) return true;
    var s = function(v) { return (v || "").toLowerCase().includes(q); };
    return (
      s(donor.fullName) ||
      s(donor.idNumber) ||
      s(donor.phone) || s(donor.phone2) || s(donor.phone3) || s(donor.phone4) ||
      s(donor.city) || s(donor.neighborhood) || s(donor.address) ||
      s(donor.alfonSerial) ||
      s(donor.notes) || s(donor.internalStaffNote) ||
      (Array.isArray(donor.tags) && donor.tags.some(function(t){ return s(t); })) ||
      (Array.isArray(donor.phones) && donor.phones.some(function(p){ return s(p); }))
    );
  }

  let filteredDonors = donors.filter(function (donor) {
    if (pendingDonorDeletions[donor.id]) return false;

    const matchSearch = donorMatchesSearch(donor, searchText);
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
  renderDonorPagination(filteredDonors.length);

  if (filteredDonors.length === 0) {
    donorsList.innerHTML = `<div class="empty-box">לא נמצאו תורמים</div>`;
    return;
  }

  var pagedDonors = filteredDonors.slice(donorPage * DONOR_PAGE_SIZE, (donorPage + 1) * DONOR_PAGE_SIZE);

  pagedDonors.forEach(function (donor) {
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
      <label style="position:absolute;top:10px;left:10px;cursor:pointer;">
        <input type="checkbox" class="donor-select-checkbox" data-id="${donor.id}" ${selectedDonorIds.has(donor.id) ? "checked" : ""} style="width:18px;height:18px;cursor:pointer;" />
      </label>
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
    card.style.position = "relative";

    donorsList.appendChild(card);
  });
}

// ── Bulk selection for campaign send ──────────────────────────────────────────

function updateBulkSelectBar() {
  var bar   = document.getElementById("bulkSelectBar");
  var count = document.getElementById("bulkSelectCount");
  if (!bar || !count) return;
  var n = selectedDonorIds.size;
  bar.style.display = n > 0 ? "flex" : "none";
  count.textContent = n + " נבחרו";
}

if (donorsList) {
  donorsList.addEventListener("change", function (e) {
    if (!e.target.classList || !e.target.classList.contains("donor-select-checkbox")) return;
    var id = Number(e.target.dataset.id);
    if (e.target.checked) selectedDonorIds.add(id);
    else selectedDonorIds.delete(id);
    updateBulkSelectBar();
  });
}

var bulkClearSelectionBtn = document.getElementById("bulkClearSelectionBtn");
if (bulkClearSelectionBtn) {
  bulkClearSelectionBtn.addEventListener("click", function () {
    selectedDonorIds.clear();
    updateBulkSelectBar();
    renderDonors();
  });
}

var bulkSendCampaignBtn = document.getElementById("bulkSendCampaignBtn");
if (bulkSendCampaignBtn) {
  bulkSendCampaignBtn.addEventListener("click", function () {
    var selected = donors.filter(function (d) { return selectedDonorIds.has(d.id); });
    if (selected.length === 0) return;

    var withPhone = selected.filter(function (d) {
      var approved = d.ivrApprovedPhones;
      return (Array.isArray(approved) && approved.length > 0) || (approved == null && d.phone);
    });
    var withoutPhone = selected.filter(function (d) { return withPhone.indexOf(d) === -1; });

    if (withPhone.length === 0) {
      alert("לאף אחד מהתורמים שנבחרו אין מספר טלפון תקין לשליחה.");
      return;
    }
    if (withoutPhone.length > 0) {
      var names = withoutPhone.map(function (d) { return d.fullName; }).join(", ");
      if (!confirm(
        "⚠️ ל-" + withoutPhone.length + " תורמים אין מספר טלפון תקין ולא יכללו בשליחה:\n" + names +
        "\n\nלהמשיך עם " + withPhone.length + " התורמים הנותרים?"
      )) return;
    }

    try {
      sessionStorage.setItem("campaignSelectedDonorIds", JSON.stringify(withPhone.map(function (d) { return d.id; })));
    } catch (_) {}
    window.location.href = "campaigns.html?selected=1";
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

// ── Excel import helpers ───────────────────────────────────────────────────────

var _importPreviewData = null;

var normPhone = function (p) {
  var digits = String(p === undefined || p === null ? "" : p).trim().replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("972") && digits.length >= 11) return "0" + digits.slice(3);
  if (digits.length === 9 && !digits.startsWith("0")) return "0" + digits;
  return digits;
};

var parseCurrencyAmt = function (val) {
  var str = String(val === undefined || val === null ? "" : val).trim();
  var currency = str.indexOf("$") !== -1 ? "USD" : "ILS";
  var num = parseFloat(str.replace(/[^0-9.]/g, ""));
  return { value: isNaN(num) ? NaN : num, currency: currency };
};

var colVal = function (row, keys) {
  for (var i = 0; i < keys.length; i++) {
    var v = row[keys[i]];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
};

var donorAllPhones = function (d) {
  return [d.phone, d.phone2, d.phone3, d.phone4].map(normPhone).filter(Boolean);
};

function findExistingDonor(rowPhones, rowIdNumber, existingDonors) {
  if (rowIdNumber) {
    var byId = existingDonors.find(function (d) {
      return d.idNumber && String(d.idNumber).replace(/\D/g, "") === rowIdNumber.replace(/\D/g, "");
    });
    if (byId) return byId;
  }
  for (var ri = 0; ri < rowPhones.length; ri++) {
    var rp = normPhone(rowPhones[ri]);
    if (!rp) continue;
    var found = existingDonors.find(function (d) {
      return donorAllPhones(d).indexOf(rp) !== -1;
    });
    if (found) return found;
  }
  return null;
}

function buildExcelPreview(rows, existingDonors) {
  var idBase = Date.now();
  var idSeq  = 0;
  var toCreate = [], toUpdate = [], toSkip = [];

  rows.forEach(function (row, rowIndex) {
    var firstName  = colVal(row, ["שם פרטי","שם","firstName"]);
    var lastName   = colVal(row, ["שם משפחה","משפחה","lastName"]);
    var fullName   = colVal(row, ["שם מלא","fullName"]) || (firstName + " " + lastName).trim();
    var phone      = colVal(row, ["טלפון","פלפון","מספר פלפון","phone","phone1","פלאפון א"]);
    var phone2     = colVal(row, ["טלפון2","פלפון ב","טלפון נוסף","phone2","פלאפון ב"]);
    var phone3     = colVal(row, ["טלפון3","פלפון ג","phone3","פלאפון ג","טלפון ביתי"]);
    var phone4     = colVal(row, ["טלפון4","פלפון ד","phone4","פלאפון נוסף"]);
    var idNumber   = colVal(row, ["ת\"ז","תעודת זהות","idNumber","מספר זהות"]);
    var city       = colVal(row, ["עיר","ישוב","city"]);
    var neighborhood = colVal(row, ["שכונה","neighborhood"]);
    var address    = colVal(row, ["כתובת","רחוב","address"]);
    var alfonSerial = colVal(row, ["מ.ס.","מספר אלפון","alfonSerial"]);
    var tagsRaw    = colVal(row, ["תגיות","תגית","tags"]);
    var notes      = colVal(row, ["הערות","הערה","notes"]);
    var purpose    = colVal(row, ["עבור","מטרה","פרשת","גליון","פרשה"]);
    var parsedAmt  = parseCurrencyAmt(colVal(row, ["סכום","amount"]));
    var amount     = parsedAmt.value;
    var currency   = parsedAmt.currency;
    var paidAmt    = parseCurrencyAmt(colVal(row, ["שולם","paid"])).value || 0;
    var remRaw     = colVal(row, ["נשאר חייב","remainingDebt"]);
    var remainingDebt = remRaw !== ""
      ? (parseCurrencyAmt(remRaw).value || 0)
      : Math.max(0, (isNaN(amount) ? 0 : amount) - (isNaN(paidAmt) ? 0 : paidAmt));
    var paid = !isNaN(amount) && amount > 0 && remainingDebt <= 0;

    var skipReason = null;
    if (!phone && !phone2)  skipReason = "אין טלפון";
    else if (!fullName)     skipReason = "אין שם";

    if (skipReason) {
      toSkip.push({ row: rowIndex + 2, name: fullName || "(ריק)", phone: phone || "(ריק)", reason: skipReason });
      return;
    }

    var rowPhones = [phone, phone2, phone3, phone4].filter(Boolean);
    var existing  = findExistingDonor(rowPhones, idNumber, existingDonors);
    var tags      = tagsRaw ? tagsRaw.split(/[,;,]/).map(function(t){ return t.trim(); }).filter(Boolean) : [];
    var hasDebt   = !isNaN(amount) && amount > 0;

    var entry = {
      rowIndex: rowIndex + 2,
      fullName: fullName, phone: phone || phone2,
      phone2: phone2, phone3: phone3, phone4: phone4,
      idNumber: idNumber, city: city, neighborhood: neighborhood,
      address: address, alfonSerial: alfonSerial,
      tags: tags, notes: notes, purpose: purpose,
      amount: amount, currency: currency,
      paidAmt: paidAmt, remainingDebt: remainingDebt,
      paid: paid, hasDebt: hasDebt,
    };

    if (existing) {
      entry.existingId   = existing.id;
      entry.existingName = existing.fullName;
      toUpdate.push(entry);
    } else {
      entry.newId = idBase + (++idSeq);
      toCreate.push(entry);
    }
  });

  return { toCreate: toCreate, toUpdate: toUpdate, toSkip: toSkip };
}

function applyExcelImport(preview) {
  try {
    localStorage.setItem("importUndo",     JSON.stringify(donors));
    localStorage.setItem("importUndoDate", new Date().toLocaleString("he-IL"));
    var undoBtn = document.getElementById("undoImportButton");
    if (undoBtn) undoBtn.style.display = "";
  } catch (_) {}

  var now  = new Date();
  var idBase = Date.now(), idSeq = 0;
  var donorsCreated = 0, donorsUpdated = 0, donationsAdded = 0;

  preview.toCreate.forEach(function (entry) {
    var pn = normPhone(entry.phone);
    var d = {
      id:           entry.newId || (idBase + (++idSeq)),
      fullName:     entry.fullName,
      phone:        entry.phone  || "",
      phone2:       entry.phone2 || "",
      phone3:       entry.phone3 || "",
      phone4:       entry.phone4 || "",
      idNumber:     entry.idNumber || "",
      city:         entry.city    || "",
      neighborhood: entry.neighborhood || "",
      address:      entry.address || "",
      alfonSerial:  entry.alfonSerial || "",
      tags:         entry.tags    || [],
      notes:        entry.notes   || "",
      status:       "פעיל",
      ivrApprovedPhones: pn ? [pn] : [],
      donations: [], tasks: [], reminders: [], callbacks: [],
      createdAt: now.toISOString(), updatedAt: now.toISOString(),
    };
    if (entry.hasDebt) { d.donations.push(_buildDonation(entry, idBase + (++idSeq), now)); donationsAdded++; }
    donors.push(d);
    donorsCreated++;
  });

  preview.toUpdate.forEach(function (entry) {
    var target = donors.find(function (d) { return d.id === entry.existingId; });
    if (!target) return;
    if (entry.phone2       && !target.phone2)       target.phone2       = entry.phone2;
    if (entry.phone3       && !target.phone3)       target.phone3       = entry.phone3;
    if (entry.phone4       && !target.phone4)       target.phone4       = entry.phone4;
    if (entry.idNumber     && !target.idNumber)     target.idNumber     = entry.idNumber;
    if (entry.city         && !target.city)         target.city         = entry.city;
    if (entry.neighborhood && !target.neighborhood) target.neighborhood = entry.neighborhood;
    if (entry.address      && !target.address)      target.address      = entry.address;
    if (entry.alfonSerial  && !target.alfonSerial)  target.alfonSerial  = entry.alfonSerial;
    if (entry.tags && entry.tags.length > 0) {
      var ex = target.tags || [];
      entry.tags.forEach(function (t) { if (ex.indexOf(t) === -1) ex.push(t); });
      target.tags = ex;
    }
    if (entry.notes && !target.notes) target.notes = entry.notes;
    if (entry.hasDebt) {
      if (!target.donations) target.donations = [];
      target.donations.push(_buildDonation(entry, idBase + (++idSeq), now));
      donationsAdded++;
    }
    target.updatedAt = now.toISOString();
    donorsUpdated++;
  });

  saveDonors();
  addLog("יבוא מאקסל: " + donorsCreated + " חדשים, " + donorsUpdated + " עודכנו, " + donationsAdded + " תרומות, " + preview.toSkip.length + " דולגו");
  AuditLog.record({ action: "import", entityType: "donor", entityId: "", entityName: "ייבוא מאקסל", details: donorsCreated + " חדשים, " + donorsUpdated + " עודכנו, " + donationsAdded + " תרומות" });
  showMessage("✅ יבוא הושלם: " + donorsCreated + " תורמים חדשים | " + donorsUpdated + " קיימים עודכנו | " + donationsAdded + " תרומות נוספו" + (preview.toSkip.length > 0 ? " | " + preview.toSkip.length + " שורות דולגו" : ""));
  renderDonors();
  if (preview.toSkip.length > 0) { try { renderImportSkippedReport(preview.toSkip); } catch (_) {} }
}

function _buildDonation(entry, id, now) {
  return {
    id: id,
    date: now.toISOString(), regularDate: now.toISOString().slice(0, 10),
    hebrewDate: window.HebrewDate ? window.HebrewDate.getHebrewDateText(now) : "",
    weekday:    window.HebrewDate ? window.HebrewDate.getHebrewWeekday(now) : "",
    amount:        isNaN(entry.amount)  ? 0 : entry.amount,
    currency:      entry.currency || "ILS",
    finalPurpose:  entry.purpose  || "כללי",
    purposeType:   "אחר",
    customPurpose: entry.purpose  || "",
    paymentMethod: "מזומן",
    paid:          entry.paid,
    paidPartial:   isNaN(entry.paidAmt) ? 0 : entry.paidAmt,
    remainingDebt: entry.remainingDebt,
    note:          entry.notes || "",
    approvedStatus:"טיוטא",
    messageStatus: "טיוטא",
    createdAt:     now.toISOString(),
  };
}

// ── Preview modal ──────────────────────────────────────────────────────────────

function showImportPreviewModal(preview) {
  var modal = document.getElementById("importPreviewModal");
  if (!modal) return;

  var tagStyle = function (txt, color) {
    return "<span style='display:inline-block;padding:3px 10px;border-radius:12px;font-size:.82em;font-weight:700;background:" + color + ";color:#fff;'>" + txt + "</span>";
  };

  var summary = document.getElementById("importPreviewSummary");
  if (summary) {
    summary.innerHTML =
      tagStyle("🆕 " + preview.toCreate.length + " תורמים חדשים", "#1a7a1a") + " " +
      tagStyle("✏️ " + preview.toUpdate.length + " יתעדכנו", "#1565c0") + " " +
      (preview.toSkip.length > 0 ? tagStyle("⚠️ " + preview.toSkip.length + " ידולגו", "#c0392b") : "");
  }

  var allRows = preview.toCreate.concat(preview.toUpdate).slice(0, 30);
  var tbl = document.getElementById("importPreviewTable");
  if (tbl) {
    if (allRows.length === 0) {
      tbl.innerHTML = "<p style='color:var(--muted);font-size:.88em;'>אין שורות לייבוא.</p>";
    } else {
      tbl.innerHTML = "<table style='width:100%;border-collapse:collapse;'>" +
        "<thead><tr style='background:var(--bg2,#f5f5f5);font-size:.82em;'>" +
        "<th style='padding:5px 8px;text-align:right;border-bottom:1px solid var(--border,#ddd);'>שורה</th>" +
        "<th style='padding:5px 8px;text-align:right;border-bottom:1px solid var(--border,#ddd);'>שם</th>" +
        "<th style='padding:5px 8px;text-align:right;border-bottom:1px solid var(--border,#ddd);'>טלפון</th>" +
        "<th style='padding:5px 8px;text-align:right;border-bottom:1px solid var(--border,#ddd);'>חוב</th>" +
        "<th style='padding:5px 8px;text-align:right;border-bottom:1px solid var(--border,#ddd);'>פעולה</th>" +
        "</tr></thead><tbody>" +
        allRows.map(function (r) {
          var action = r.existingId
            ? "<span style='color:#1565c0;font-size:.8em;'>עדכון</span>"
            : "<span style='color:#1a7a1a;font-size:.8em;'>חדש</span>";
          var debt = r.hasDebt ? "₪" + Number(r.remainingDebt || 0).toLocaleString() : "—";
          return "<tr style='border-bottom:1px solid var(--border,#eee);'>" +
            "<td style='padding:4px 8px;color:var(--muted);font-size:.8em;'>" + r.rowIndex + "</td>" +
            "<td style='padding:4px 8px;'>" + escapeHTML(r.fullName) + "</td>" +
            "<td style='padding:4px 8px;direction:ltr;text-align:right;'>" + escapeHTML(r.phone || "") + "</td>" +
            "<td style='padding:4px 8px;'>" + debt + "</td>" +
            "<td style='padding:4px 8px;'>" + action + "</td>" +
            "</tr>";
        }).join("") + "</tbody></table>" +
        (preview.toCreate.length + preview.toUpdate.length > 30
          ? "<p style='color:var(--muted);font-size:.8em;margin-top:6px;'>...ועוד " + (preview.toCreate.length + preview.toUpdate.length - 30) + " שורות נוספות</p>"
          : "");
    }
  }

  modal.style.display = "flex";
}

function closeImportPreviewModal() {
  var modal = document.getElementById("importPreviewModal");
  if (modal) modal.style.display = "none";
}

// ── File upload handler ────────────────────────────────────────────────────────

function handleFileUpload(event) {
  var file = event.target.files[0];
  if (!file) return;
  event.target.value = "";
  if (file.size > 10 * 1024 * 1024) {
    alert("קובץ ה-Excel גדול מדי (מקסימום 10MB). אנא בחר קובץ קטן יותר.");
    return;
  }

  var reader = new FileReader();
  reader.onload = function (e) {
    try {
      var data     = new Uint8Array(e.target.result);
      var workbook = XLSX.read(data, { type: "array" });
      var sheet    = workbook.Sheets[workbook.SheetNames[0]];
      var rawRows  = XLSX.utils.sheet_to_json(sheet);

      if (rawRows.length === 0) {
        showMessage("⚠️ הגיליון ריק — לא נמצאו שורות לייבוא", "error");
        return;
      }

      var normKey = function (k) { return String(k).trim().normalize ? String(k).trim().normalize("NFC") : String(k).trim(); };
      var rows = rawRows.map(function (r) {
        var out = {};
        Object.keys(r).forEach(function (k) { out[normKey(k)] = r[k]; });
        return out;
      });

      var preview = buildExcelPreview(rows, donors);
      _importPreviewData = preview;

      if (preview.toCreate.length === 0 && preview.toUpdate.length === 0) {
        showMessage("⚠️ לא נמצאו נתונים. עמודות שנמצאו: " + Object.keys(rows[0]).join(", "), "error");
        if (preview.toSkip.length > 0) renderImportSkippedReport(preview.toSkip);
        return;
      }

      showImportPreviewModal(preview);
    } catch (err) {
      showMessage("❌ שגיאה בקריאת הקובץ: " + err.message, "error");
      console.error("[ייבוא אקסל]", err);
    }
  };
  reader.readAsArrayBuffer(file);
}

// Modal confirm / cancel
(function () {
  var confirmBtn = document.getElementById("importPreviewConfirm");
  var cancelBtn  = document.getElementById("importPreviewCancel");
  var closeBtn   = document.getElementById("importPreviewClose");

  if (confirmBtn) {
    confirmBtn.addEventListener("click", function () {
      var pv = _importPreviewData;
      closeImportPreviewModal();
      if (pv) applyExcelImport(pv);
    });
  }
  if (cancelBtn) cancelBtn.addEventListener("click", closeImportPreviewModal);
  if (closeBtn)  closeBtn.addEventListener("click",  closeImportPreviewModal);

  var modal = document.getElementById("importPreviewModal");
  if (modal) modal.addEventListener("click", function (e) { if (e.target === modal) closeImportPreviewModal(); });
}());

// Undo last import
(function () {
  var undoBtn = document.getElementById("undoImportButton");
  if (!undoBtn) return;
  if (localStorage.getItem("importUndo")) undoBtn.style.display = "";

  undoBtn.addEventListener("click", function () {
    var snapshot = localStorage.getItem("importUndo");
    var dateStr  = localStorage.getItem("importUndoDate") || "";
    if (!snapshot) { showMessage("אין ייבוא לביטול", "error"); return; }
    if (!confirm("לבטל את הייבוא האחרון" + (dateStr ? " מב-" + dateStr : "") + "?")) return;
    try {
      var prev = JSON.parse(snapshot);
      donors.splice(0, donors.length);
      prev.forEach(function (d) { donors.push(d); });
      saveDonors();
      localStorage.removeItem("importUndo");
      localStorage.removeItem("importUndoDate");
      undoBtn.style.display = "none";
      showMessage("✅ הייבוא בוטל — הנתונים שוחזרו");
      renderDonors();
    } catch (_) { showMessage("שגיאה בשחזור", "error"); }
  });
}());

function renderImportSkippedReport(skippedRows) {
  var panel = document.getElementById("importSkippedReport");
  if (!panel) return;

  panel.style.cssText =
    "display:block;margin:10px 0;padding:14px;background:var(--bg2,#1e1e2e);" +
    "border:1px solid #c0392b;border-radius:8px;direction:rtl;font-size:13px;";

  var tableRows = skippedRows.map(function (r) {
    return "<tr>" +
      "<td style='padding:5px 8px;border:1px solid #444;'>" + escapeHTML(String(r.row)) + "</td>" +
      "<td style='padding:5px 8px;border:1px solid #444;'>" + escapeHTML(r.name)   + "</td>" +
      "<td style='padding:5px 8px;border:1px solid #444;'>" + escapeHTML(r.phone)  + "</td>" +
      "<td style='padding:5px 8px;border:1px solid #444;color:#e74c3c;'>" + escapeHTML(r.reason) + "</td>" +
      "</tr>";
  }).join("");

  panel.innerHTML =
    "<div style='display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;'>" +
      "<strong style='color:#e74c3c;'>⚠️ שורות שדולגו (" + skippedRows.length + ")</strong>" +
      "<button onclick=\"document.getElementById('importSkippedReport').style.display='none'\" style='background:none;border:1px solid #666;border-radius:4px;padding:3px 10px;cursor:pointer;'>✕ סגור</button>" +
    "</div>" +
    "<div style='overflow-x:auto;'><table style='width:100%;border-collapse:collapse;'>" +
      "<thead><tr style='background:rgba(255,255,255,.08);'>" +
        "<th style='padding:6px 8px;border:1px solid #444;text-align:right;'>שורה</th>" +
        "<th style='padding:6px 8px;border:1px solid #444;text-align:right;'>שם</th>" +
        "<th style='padding:6px 8px;border:1px solid #444;text-align:right;'>טלפון</th>" +
        "<th style='padding:6px 8px;border:1px solid #444;text-align:right;'>סיבה</th>" +
      "</tr></thead>" +
      "<tbody>" + tableRows + "</tbody>" +
    "</table></div>";
}


function resetDonorPageAndRender() {
  donorPage = 0;
  renderDonors();
}

addDonorButton.addEventListener("click", addDonor);
searchInput.addEventListener("input", resetDonorPageAndRender);
var sortSelectEl = document.getElementById("sortSelect");
if (sortSelectEl) sortSelectEl.addEventListener("change", resetDonorPageAndRender);

["filterStatus","filterCity","filterTag"].forEach(function(id) {
  var el = document.getElementById(id);
  if (el) el.addEventListener(id === "filterTag" ? "input" : "change", resetDonorPageAndRender);
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

// Re-render when donors are refreshed in the background (e.g. after IVR payment)
window.addEventListener("crm-donors-refreshed", function () {
  donors = Database.get("donors");
  updateNamesList();
  renderDonors();
});

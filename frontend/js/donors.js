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
  var pushPromise = Database.save("donors", donors);
  updateNamesList();
  return pushPromise;
}

// showMessage, normalizePhoneLocal are defined in utils.js (shared — see #28)

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

async function addDonor() {
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
  try {
    await saveDonors();
  } catch (err) {
    donors.pop();
    showMessage(err.message || "השמירה נכשלה, נסה שוב", "error");
    return;
  }

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

async function deleteDonor(id) {
  const deletedDonor = donors.find(function (donor) { return donor.id === id; });
  if (!deletedDonor || pendingDonorDeletions[id]) return;

  // Remove immediately from array and save to server/localStorage right away
  const previousDonors = donors;
  donors = donors.filter(function (donor) { return donor.id !== id; });
  try {
    await saveDonors();
  } catch (err) {
    donors = previousDonors;
    showMessage(err.message || "מחיקת התורם נכשלה, נסה שוב", "error");
    return;
  }
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
    showToast('תורם "' + deletedDonor.fullName + '" נמחק', async function () {
      donors.push(deletedDonor);
      donors.sort(function (a, b) {
        return (a.fullName || "").localeCompare(b.fullName || "", "he");
      });
      try {
        await saveDonors();
      } catch (err) {
        donors = donors.filter(function (donor) { return donor.id !== id; });
        showMessage(err.message || "שחזור התורם נכשל, נסה שוב", "error");
        return;
      }
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

// Mirrors donorHasPhone() in backend/db.js (used for IVR caller-ID matching) —
// same four core fields plus phones[]/ivrApprovedPhones[], so the import's
// notion of "this donor's phones" matches what the rest of the app already
// treats as valid identifying numbers for a donor.
var donorAllPhones = function (d) {
  var fields = [d.phone, d.phone2, d.phone3, d.phone4]
    .concat(Array.isArray(d.phones) ? d.phones : [])
    .concat(Array.isArray(d.ivrApprovedPhones) ? d.ivrApprovedPhones : []);
  return fields.map(normPhone).filter(Boolean);
};

// A phone is only usable as a matching/identifying key once normalized —
// garbage text normalizes to "" or to something implausibly short/long and
// must never silently fall through to name-based guessing (see rule 7).
function isValidNormalizedPhone(p) {
  return !!p && p.length >= 7 && p.length <= 15;
}

// Reads a cell's raw value (Date object / number / string) without the
// String(v).trim() coercion colVal() does — needed for the date column,
// where stringifying a Date first would throw away its actual value.
var rawColVal = function (row, keys) {
  for (var i = 0; i < keys.length; i++) {
    var v = row[keys[i]];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return null;
};

// byPhone maps a normalized phone to the LIST of distinct donors that carry
// it (not a single donor) — a phone shared by more than one donor is exactly
// the ambiguous case resolveRowDonorMatch() below must catch instead of
// silently picking whichever donor happened to register first.
function registerDonorInLookupMaps(maps, d) {
  if (d.idNumber) {
    var idKey = String(d.idNumber).replace(/\D/g, "");
    if (idKey && !(idKey in maps.byIdNumber)) maps.byIdNumber[idKey] = d;
  }
  var phones = donorAllPhones(d);
  for (var j = 0; j < phones.length; j++) {
    if (!maps.byPhone[phones[j]]) maps.byPhone[phones[j]] = [];
    if (maps.byPhone[phones[j]].indexOf(d) === -1) maps.byPhone[phones[j]].push(d);
  }
}

// Precomputes idNumber/phone → donor lookup maps once per import instead of
// rescanning existingDonors (and rebuilding donorAllPhones(d) each time) for
// every phone of every imported row — that was O(rows * donors), and a real
// import (thousands of rows against thousands of donors) could freeze the
// tab for many seconds.
function buildDonorLookupMaps(existingDonors) {
  var maps = { byIdNumber: Object.create(null), byPhone: Object.create(null) };
  for (var i = 0; i < existingDonors.length; i++) registerDonorInLookupMaps(maps, existingDonors[i]);
  return maps;
}

// The phone is the primary, determining identifier for matching a row to a
// donor — this is the ONLY thing that decides "existing donor" vs "new
// donor". idNumber is never an independent lookup path; it is only ever used
// to CROSS-CHECK a phone match that was already found (rule 6) — if the
// row's ID number is on record for some OTHER donor than the one the phone
// matched, that is a contradiction the import must not silently resolve by
// guessing. Name is never used to match an existing donor at all (rule 4).
//
// rowValidPhones must already be normalized + filtered to isValidNormalizedPhone.
function resolveRowDonorMatch(rowValidPhones, rowIdNumber, lookupMaps) {
  var phoneMatches = [];
  for (var ri = 0; ri < rowValidPhones.length; ri++) {
    var donorsForPhone = lookupMaps.byPhone[rowValidPhones[ri]];
    if (!donorsForPhone) continue;
    for (var di = 0; di < donorsForPhone.length; di++) {
      if (phoneMatches.indexOf(donorsForPhone[di]) === -1) phoneMatches.push(donorsForPhone[di]);
    }
  }

  if (phoneMatches.length > 1) {
    return { status: "ambiguous", donors: phoneMatches };
  }

  var phoneMatch = phoneMatches.length === 1 ? phoneMatches[0] : null;

  if (phoneMatch && rowIdNumber) {
    var idKey = rowIdNumber.replace(/\D/g, "");
    if (idKey) {
      var idNumberDonor = lookupMaps.byIdNumber[idKey];
      if (idNumberDonor && idNumberDonor !== phoneMatch) {
        return { status: "conflict", phoneDonor: phoneMatch, idDonor: idNumberDonor };
      }
    }
  }

  return { status: phoneMatch ? "matched" : "not_found", donor: phoneMatch };
}

// Keeps a field's already-known value; only fills it from `incoming` when it's
// still empty. Used so import rows can never blank out or overwrite existing
// donor details — only add what was missing.
function mergeDonorField(current, incoming) {
  return (current && String(current).trim() !== "") ? current : (incoming || "");
}

// Matches the donor form's own purposeType select (#purposeSelect / #editDonationPurposeSelect
// in donor.html): a known category is stored as-is, anything else becomes "אחר" + customPurpose,
// exactly like a human picking "אחר" and typing a custom purpose in the form would.
var KNOWN_DONATION_PURPOSES = ["גליון מתאחדת", "פרנס"];

function resolvePurpose(raw) {
  var trimmed = (raw || "").trim();
  if (!trimmed) return { purposeType: "אחר", finalPurpose: "כללי", customPurpose: "" };
  var known = KNOWN_DONATION_PURPOSES.indexOf(trimmed) !== -1 ? trimmed : null;
  if (known) return { purposeType: known, finalPurpose: known, customPurpose: "" };
  return { purposeType: "אחר", finalPurpose: trimmed, customPurpose: trimmed };
}

function resolveCurrency(raw, fallback) {
  var t = (raw || "").trim();
  if (!t) return fallback;
  var upper = t.toUpperCase();
  if (upper === "USD" || t.indexOf("$") !== -1 || t.indexOf("דולר") !== -1) return "USD";
  if (upper === "ILS" || upper === "NIS" || t.indexOf("₪") !== -1 || t.indexOf("שקל") !== -1) return "ILS";
  return fallback;
}

// Accepts a JS Date (when the workbook was read with cellDates:true), a raw
// Excel serial date number (fallback for cells that slip through as numbers),
// or a text date (dd/mm/yyyy or anything the native parser understands).
function parseRowDate(val) {
  if (val === undefined || val === null || val === "") return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
  if (typeof val === "number") {
    var excelEpochMs = Date.UTC(1899, 11, 30);
    var d = new Date(excelEpochMs + val * 86400000);
    return isNaN(d.getTime()) ? null : d;
  }
  var str = String(val).trim();
  if (!str) return null;
  var m = str.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    var day = parseInt(m[1], 10), month = parseInt(m[2], 10), year = parseInt(m[3], 10);
    if (year < 100) year += 2000;
    var d2 = new Date(year, month - 1, day);
    return isNaN(d2.getTime()) ? null : d2;
  }
  var d3 = new Date(str);
  return isNaN(d3.getTime()) ? null : d3;
}

// Parses every donation-level column for one row. Returns null when the row
// carries no amount — such a row only touches donor fields, no donation is
// created for it.
function buildDonationEntry(row, rowIndex) {
  var parsedAmt = parseCurrencyAmt(colVal(row, ["סכום", "amount"]));
  var amount = parsedAmt.value;
  if (isNaN(amount) || amount <= 0) return null;

  var paidAmt = parseCurrencyAmt(colVal(row, ["שולם", "paid"])).value || 0;
  var remRaw  = colVal(row, ["נשאר חייב", "remainingDebt"]);
  var remainingDebt = remRaw !== ""
    ? (parseCurrencyAmt(remRaw).value || 0)
    : Math.max(0, amount - (isNaN(paidAmt) ? 0 : paidAmt));
  var paid = amount > 0 && remainingDebt <= 0;

  var purpose  = resolvePurpose(colVal(row, ["קטגוריה", "סוג תרומה", "מטרה", "purpose", "category"]));
  var currency = resolveCurrency(colVal(row, ["מטבע", "currency"]), parsedAmt.currency);

  return {
    rowIndex: rowIndex + 2,
    amount: amount, currency: currency,
    paidAmt: paidAmt, remainingDebt: remainingDebt, paid: paid,
    purposeType: purpose.purposeType, finalPurpose: purpose.finalPurpose, customPurpose: purpose.customPurpose,
    // Free text stored verbatim on the donation — NOT matched/validated against
    // anything. "גליון" here is the issue/sheet designation (e.g. "תתקסא"),
    // unrelated to purposeType/finalPurpose above.
    gilayon: colVal(row, ["גליון", "gilayon"]),
    parsha: colVal(row, ["פרשה", "פרשת", "parsha"]),
    note:   colVal(row, ["הערת תרומה", "הערה לתרומה", "עבור", "donationNote"]),
    date:   parseRowDate(rawColVal(row, ["תאריך", "date"])),
    hebrewYear: colVal(row, ["שנה עברית", "hebrewYear"]),
  };
}

// Groups rows by donor (matched on phone — see resolveRowDonorMatch) instead
// of treating each row as its own donor record. Two rows sharing a phone
// always land on ONE donor with two donations, whether that donor already
// existed before the import (→ toUpdate) or was just created by an earlier
// row of this same file (→ toCreate, matched via the batch registration
// below). Donor detail fields (city/address/...) are never overwritten —
// only filled in when still empty, across every row touching that donor.
function buildExcelPreview(rows, existingDonors) {
  var idBase = Date.now();
  var idSeq  = 0;
  var toCreate = [], toSkip = [];
  var toUpdateMap = Object.create(null);
  var toUpdateOrder = [];
  var lookupMaps = buildDonorLookupMaps(existingDonors);

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
    var donorNotes = colVal(row, ["הערות","הערה","notes"]);

    var rawPhones   = [phone, phone2, phone3, phone4].filter(Boolean);
    var validPhones = rawPhones.map(normPhone).filter(isValidNormalizedPhone);
    if (validPhones.length === 0) {
      toSkip.push({ row: rowIndex + 2, name: fullName || "(ריק)", phone: phone || phone2 || "(ריק)", reason: "טלפון ריק או לא תקין" });
      return;
    }

    var tags = tagsRaw ? tagsRaw.split(/[,;,]/).map(function (t) { return t.trim(); }).filter(Boolean) : [];
    var donationEntry = buildDonationEntry(row, rowIndex);
    var match = resolveRowDonorMatch(validPhones, idNumber, lookupMaps);

    if (match.status === "ambiguous") {
      var ambiguousNames = match.donors.map(function (d) { return d.fullName || "(ללא שם)"; }).join(", ");
      toSkip.push({ row: rowIndex + 2, name: fullName || "(ריק)", phone: phone || phone2 || "(ריק)", reason: "מספר טלפון כפול במערכת — נמצא אצל: " + ambiguousNames });
      return;
    }

    if (match.status === "conflict") {
      toSkip.push({
        row: rowIndex + 2, name: fullName || "(ריק)", phone: phone || phone2 || "(ריק)",
        reason: "סתירה בין טלפון לתעודת זהות — הטלפון שייך ל-" + (match.phoneDonor.fullName || "(ללא שם)") +
          ", אך תעודת הזהות בשורה שייכת ל-" + (match.idDonor.fullName || "(ללא שם)"),
      });
      return;
    }

    var existing = match.donor;

    // Matches a donor already staged earlier in THIS SAME import (see
    // registerDonorInLookupMaps call below) — merge into it instead of
    // creating a duplicate new donor.
    if (existing && existing.newId) {
      existing.phone2       = mergeDonorField(existing.phone2, phone2);
      existing.phone3       = mergeDonorField(existing.phone3, phone3);
      existing.phone4       = mergeDonorField(existing.phone4, phone4);
      existing.idNumber     = mergeDonorField(existing.idNumber, idNumber);
      existing.city         = mergeDonorField(existing.city, city);
      existing.neighborhood = mergeDonorField(existing.neighborhood, neighborhood);
      existing.address      = mergeDonorField(existing.address, address);
      existing.alfonSerial  = mergeDonorField(existing.alfonSerial, alfonSerial);
      existing.notes        = mergeDonorField(existing.notes, donorNotes);
      tags.forEach(function (t) { if (existing.tags.indexOf(t) === -1) existing.tags.push(t); });
      existing.rows.push(rowIndex + 2);
      if (donationEntry) existing.donations.push(donationEntry);
      return;
    }

    // Matches a real donor already in the system — accumulate into one
    // update group per donor; the real donor object itself is left
    // untouched until applyExcelImport actually commits the import.
    if (existing) {
      var group = toUpdateMap[existing.id];
      if (!group) {
        group = {
          existingId: existing.id, existingName: existing.fullName, phone: existing.phone || "",
          phone2: "", phone3: "", phone4: "", idNumber: "", city: "", neighborhood: "",
          address: "", alfonSerial: "", tags: [], notes: "",
          donations: [], rows: [],
        };
        toUpdateMap[existing.id] = group;
        toUpdateOrder.push(group);
      }
      group.phone2       = mergeDonorField(group.phone2, phone2);
      group.phone3       = mergeDonorField(group.phone3, phone3);
      group.phone4       = mergeDonorField(group.phone4, phone4);
      group.idNumber     = mergeDonorField(group.idNumber, idNumber);
      group.city         = mergeDonorField(group.city, city);
      group.neighborhood = mergeDonorField(group.neighborhood, neighborhood);
      group.address      = mergeDonorField(group.address, address);
      group.alfonSerial  = mergeDonorField(group.alfonSerial, alfonSerial);
      group.notes        = mergeDonorField(group.notes, donorNotes);
      tags.forEach(function (t) { if (group.tags.indexOf(t) === -1) group.tags.push(t); });
      group.rows.push(rowIndex + 2);
      if (donationEntry) group.donations.push(donationEntry);
      return;
    }

    // No match anywhere (real donors or this batch) — a brand new donor
    // needs a name; everything else about them is optional.
    if (!fullName) {
      toSkip.push({ row: rowIndex + 2, name: "(ריק)", phone: phone || phone2 || "(ריק)", reason: "אין שם" });
      return;
    }

    // Primary phone must itself normalize to something valid — a garbage
    // "phone" cell (e.g. "phone" holds text, "phone2" holds the real number)
    // must never end up stored as if it were the donor's real phone.
    var primaryRawPhone = rawPhones.filter(function (p) { return isValidNormalizedPhone(normPhone(p)); })[0] || "";

    var newEntry = {
      newId: idBase + (++idSeq),
      fullName: fullName, phone: primaryRawPhone,
      phone2: phone2, phone3: phone3, phone4: phone4,
      idNumber: idNumber, city: city, neighborhood: neighborhood,
      address: address, alfonSerial: alfonSerial,
      tags: tags, notes: donorNotes,
      donations: donationEntry ? [donationEntry] : [],
      rows: [rowIndex + 2],
    };
    registerDonorInLookupMaps(lookupMaps, newEntry);
    toCreate.push(newEntry);
  });

  return { toCreate: toCreate, toUpdate: toUpdateOrder, toSkip: toSkip };
}

async function applyExcelImport(preview) {
  var preImportDonorsJson = JSON.stringify(donors);
  try {
    localStorage.setItem("importUndo",     preImportDonorsJson);
    localStorage.setItem("importUndoDate", new Date().toLocaleString("he-IL"));
    var undoBtn = document.getElementById("undoImportButton");
    if (undoBtn) undoBtn.style.display = "";
  } catch (_) {}

  var now  = new Date();
  var idBase = Date.now(), idSeq = 0;
  var donorsCreated = 0, donorsUpdated = 0, donationsAdded = 0, donationsSkippedDuplicate = 0;

  preview.toCreate.forEach(function (group) {
    var pn = normPhone(group.phone);
    var d = {
      id:           group.newId || (idBase + (++idSeq)),
      fullName:     group.fullName,
      phone:        group.phone  || "",
      phone2:       group.phone2 || "",
      phone3:       group.phone3 || "",
      phone4:       group.phone4 || "",
      idNumber:     group.idNumber || "",
      city:         group.city    || "",
      neighborhood: group.neighborhood || "",
      address:      group.address || "",
      alfonSerial:  group.alfonSerial || "",
      tags:         group.tags    || [],
      notes:        group.notes   || "",
      status:       "פעיל",
      ivrApprovedPhones: pn ? [pn] : [],
      donations: [], tasks: [], reminders: [], callbacks: [],
      createdAt: now.toISOString(), updatedAt: now.toISOString(),
    };
    group.donations.forEach(function (donationEntry) {
      d.donations.push(_buildDonation(donationEntry, idBase + (++idSeq), now));
      donationsAdded++;
    });
    donors.push(d);
    donorsCreated++;
  });

  preview.toUpdate.forEach(function (group) {
    var target = donors.find(function (d) { return d.id === group.existingId; });
    if (!target) return;
    if (group.phone2       && !target.phone2)       target.phone2       = group.phone2;
    if (group.phone3       && !target.phone3)       target.phone3       = group.phone3;
    if (group.phone4       && !target.phone4)       target.phone4       = group.phone4;
    if (group.idNumber     && !target.idNumber)     target.idNumber     = group.idNumber;
    if (group.city         && !target.city)         target.city         = group.city;
    if (group.neighborhood && !target.neighborhood) target.neighborhood = group.neighborhood;
    if (group.address      && !target.address)      target.address      = group.address;
    if (group.alfonSerial  && !target.alfonSerial)  target.alfonSerial  = group.alfonSerial;
    if (group.tags && group.tags.length > 0) {
      var ex = target.tags || [];
      group.tags.forEach(function (t) { if (ex.indexOf(t) === -1) ex.push(t); });
      target.tags = ex;
    }
    if (group.notes && !target.notes) target.notes = group.notes;
    if (!target.donations) target.donations = [];

    // Re-importing the same file (accidentally, or "let me re-run to catch
    // new rows") used to append every donation row again unconditionally —
    // a same-day, same-amount, same-purpose row already present on this
    // donor is treated as a duplicate and skipped instead, rather than
    // silently doubling the donor's debt/history. Signature is computed the
    // same way for existing donations (already-stored fields) and freshly
    // parsed ones (via _buildDonation) so the comparison is apples-to-apples.
    var existingSignatures = {};
    target.donations.forEach(function (d) { existingSignatures[_donationSignature(d)] = true; });

    group.donations.forEach(function (donationEntry) {
      var candidate = _buildDonation(donationEntry, idBase + (++idSeq), now);
      var sig = _donationSignature(candidate);
      if (existingSignatures[sig]) {
        donationsSkippedDuplicate++;
        return;
      }
      existingSignatures[sig] = true; // also catches a repeated row within this same file
      target.donations.push(candidate);
      donationsAdded++;
    });
    target.updatedAt = now.toISOString();
    donorsUpdated++;
  });

  try {
    await saveDonors();
  } catch (err) {
    try { donors = JSON.parse(preImportDonorsJson); } catch (_) {}
    showMessage((err.message || "השמירה נכשלה") + " — הייבוא לא הושלם, נסה שוב", "error");
    renderDonors();
    return;
  }
  addLog("יבוא מאקסל: " + donorsCreated + " חדשים, " + donorsUpdated + " עודכנו, " + donationsAdded + " תרומות, " + preview.toSkip.length + " דולגו" + (donationsSkippedDuplicate > 0 ? ", " + donationsSkippedDuplicate + " תרומות כפולות נמנעו" : ""));
  AuditLog.record({ action: "import", entityType: "donor", entityId: "", entityName: "ייבוא מאקסל", details: donorsCreated + " חדשים, " + donorsUpdated + " עודכנו, " + donationsAdded + " תרומות" + (donationsSkippedDuplicate > 0 ? ", " + donationsSkippedDuplicate + " כפילויות נמנעו" : "") });
  showMessage("✅ יבוא הושלם: " + donorsCreated + " תורמים חדשים | " + donorsUpdated + " קיימים עודכנו | " + donationsAdded + " תרומות נוספו" +
    (preview.toSkip.length > 0 ? " | " + preview.toSkip.length + " שורות דולגו" : "") +
    (donationsSkippedDuplicate > 0 ? " | " + donationsSkippedDuplicate + " תרומות כפולות זוהו ונמנעו" : ""));
  renderDonors();
  if (preview.toSkip.length > 0) { try { renderImportSkippedReport(preview.toSkip); } catch (_) {} }
}

// Identity used to detect a re-imported duplicate donation on an existing
// donor: same calendar day + same amount + same purpose + same gilayon.
// Deliberately excludes id/createdAt/paid-status so a re-import is caught
// even if the row's paid state was edited manually in between.
function _donationSignature(d) {
  return [d.regularDate || "", Number(d.amount || 0), d.finalPurpose || "", d.gilayon || ""].join("|");
}

function _buildDonation(entry, id, now) {
  var baseDate = (entry.date instanceof Date && !isNaN(entry.date.getTime())) ? entry.date : now;
  // regularDate must stay in lockstep with hebrewDate/weekday below, which are
  // always anchored to Asia/Jerusalem — a plain toISOString().slice(0,10) is
  // UTC-based and can land on the wrong calendar day (e.g. an imported date
  // cell shifting back a day) whenever the two disagree.
  var regularDate = window.HebrewDate && window.HebrewDate.getLocalDateKey
    ? window.HebrewDate.getLocalDateKey(baseDate)
    : baseDate.toISOString().slice(0, 10);
  return {
    id: id,
    date: baseDate.toISOString(), regularDate: regularDate,
    hebrewDate: window.HebrewDate ? window.HebrewDate.getHebrewDateText(baseDate) : "",
    weekday:    window.HebrewDate ? window.HebrewDate.getHebrewWeekday(baseDate) : "",
    hebrewYear:    entry.hebrewYear || "",
    amount:        isNaN(entry.amount)  ? 0 : entry.amount,
    currency:      entry.currency || "ILS",
    gilayon:       entry.gilayon || "",
    parsha:        entry.parsha || "",
    finalPurpose:  entry.finalPurpose  || "כללי",
    purposeType:   entry.purposeType   || "אחר",
    customPurpose: entry.customPurpose || "",
    paymentMethod: "מזומן",
    paid:          entry.paid,
    paidPartial:   isNaN(entry.paidAmt) ? 0 : entry.paidAmt,
    remainingDebt: entry.remainingDebt,
    note:          entry.note || "",
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

  var totalDonations = preview.toCreate.concat(preview.toUpdate)
    .reduce(function (sum, g) { return sum + g.donations.length; }, 0);

  var summary = document.getElementById("importPreviewSummary");
  if (summary) {
    summary.innerHTML =
      tagStyle("🆕 " + preview.toCreate.length + " תורמים חדשים", "#1a7a1a") + " " +
      tagStyle("✏️ " + preview.toUpdate.length + " יתעדכנו", "#1565c0") + " " +
      (totalDonations > 0 ? tagStyle("🧾 " + totalDonations + " תרומות", "#6a1b9a") + " " : "") +
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
        "<th style='padding:5px 8px;text-align:right;border-bottom:1px solid var(--border,#ddd);'>שורות</th>" +
        "<th style='padding:5px 8px;text-align:right;border-bottom:1px solid var(--border,#ddd);'>שם</th>" +
        "<th style='padding:5px 8px;text-align:right;border-bottom:1px solid var(--border,#ddd);'>טלפון</th>" +
        "<th style='padding:5px 8px;text-align:right;border-bottom:1px solid var(--border,#ddd);'>תרומות</th>" +
        "<th style='padding:5px 8px;text-align:right;border-bottom:1px solid var(--border,#ddd);'>סכום כולל</th>" +
        "<th style='padding:5px 8px;text-align:right;border-bottom:1px solid var(--border,#ddd);'>פעולה</th>" +
        "</tr></thead><tbody>" +
        allRows.map(function (g) {
          var action = g.existingId
            ? "<span style='color:#1565c0;font-size:.8em;'>עדכון</span>"
            : "<span style='color:#1a7a1a;font-size:.8em;'>חדש</span>";
          var name = g.existingId ? g.existingName : g.fullName;
          var totalAmt = g.donations.reduce(function (s, dn) { return s + (Number(dn.amount) || 0); }, 0);
          return "<tr style='border-bottom:1px solid var(--border,#eee);'>" +
            "<td style='padding:4px 8px;color:var(--muted);font-size:.8em;'>" + g.rows.join(", ") + "</td>" +
            "<td style='padding:4px 8px;'>" + escapeHTML(name || "") + "</td>" +
            "<td style='padding:4px 8px;direction:ltr;text-align:right;'>" + escapeHTML(g.phone || "") + "</td>" +
            "<td style='padding:4px 8px;'>" + (g.donations.length || "—") + "</td>" +
            "<td style='padding:4px 8px;'>" + (totalAmt > 0 ? "₪" + totalAmt.toLocaleString() : "—") + "</td>" +
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
      var workbook = XLSX.read(data, { type: "array", cellDates: true });
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

  undoBtn.addEventListener("click", async function () {
    var snapshot = localStorage.getItem("importUndo");
    var dateStr  = localStorage.getItem("importUndoDate") || "";
    if (!snapshot) { showMessage("אין ייבוא לביטול", "error"); return; }
    if (!confirm("לבטל את הייבוא האחרון" + (dateStr ? " מב-" + dateStr : "") + "?")) return;
    var beforeUndoJson = JSON.stringify(donors);
    try {
      var prev = JSON.parse(snapshot);
      donors.splice(0, donors.length);
      prev.forEach(function (d) { donors.push(d); });
      await saveDonors();
      localStorage.removeItem("importUndo");
      localStorage.removeItem("importUndoDate");
      undoBtn.style.display = "none";
      showMessage("✅ הייבוא בוטל — הנתונים שוחזרו");
      renderDonors();
    } catch (err) {
      try { donors = JSON.parse(beforeUndoJson); } catch (_) {}
      showMessage((err && err.message) || "שגיאה בשחזור", "error");
      renderDonors();
    }
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

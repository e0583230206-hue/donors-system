let donors = Database.get("donors");

function normalizePhoneLocal(p) {
  var digits = String(p === undefined || p === null ? "" : p).trim().replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("972") && digits.length >= 11) return "0" + digits.slice(3);
  if (digits.length === 9 && !digits.startsWith("0")) return "0" + digits;
  return digits;
}

const params = new URLSearchParams(window.location.search);
const donorId = Number(params.get("id"));

let donor = donors.find(function (item) {
  return item.id === donorId;
});

const donorNameTitle = document.getElementById("donorNameTitle");
const donorSubTitle = document.getElementById("donorSubTitle");
const donorDetails = document.getElementById("donorDetails");
const editDonorButton = document.getElementById("editDonorButton");
const editDonorForm = document.getElementById("editDonorForm");
const editFullNameInput = document.getElementById("editFullNameInput");
const editPhoneInput = document.getElementById("editPhoneInput");
const editCityInput = document.getElementById("editCityInput");
const editAddressInput = document.getElementById("editAddressInput");
const editStatusSelect = document.getElementById("editStatusSelect");
const editNotesInput = document.getElementById("editNotesInput");
const saveDonorEditButton = document.getElementById("saveDonorEditButton");
const cancelDonorEditButton = document.getElementById("cancelDonorEditButton");
const editDonorMessage = document.getElementById("editDonorMessage");

const paidTotal = document.getElementById("paidTotal");
const debtTotal = document.getElementById("debtTotal");
const donationsCount = document.getElementById("donationsCount");
const ivrStatus = document.getElementById("ivrStatus");

const internalStaffNote = document.getElementById("internalStaffNote");
const publicPhoneNote = document.getElementById("publicPhoneNote");
const saveNotesButton = document.getElementById("saveNotesButton");
const notesMessage = document.getElementById("notesMessage");

const amountInput = document.getElementById("amountInput");
const parshaInput = document.getElementById("parshaInput");
const purposeSelect = document.getElementById("purposeSelect");
const customPurposeInput = document.getElementById("customPurposeInput");
const paymentMethodSelect = document.getElementById("paymentMethodSelect");
const paidSelect = document.getElementById("paidSelect");
const donationNoteInput = document.getElementById("donationNoteInput");
const addDonationButton = document.getElementById("addDonationButton");
const donationMessage = document.getElementById("donationMessage");

const includeInCallsCheckbox = document.getElementById(
  "includeInCallsCheckbox",
);
const allowPaymentCheckbox = document.getElementById("allowPaymentCheckbox");
const allowPreviousDebtsCheckbox = document.getElementById(
  "allowPreviousDebtsCheckbox",
);
const allowCallbackCheckbox = document.getElementById("allowCallbackCheckbox");
const saveIvrButton = document.getElementById("saveIvrButton");
const phonePreview = document.getElementById("phonePreview");

const partialAmountInput = document.getElementById("partialAmountInput");
const partialPaymentMethod = document.getElementById("partialPaymentMethod");
const partialPaymentButton = document.getElementById("partialPaymentButton");
const partialMessage = document.getElementById("partialMessage");

const donationsTable = document.getElementById("donationsTable");


function saveDonors() {
  Database.save("donors", donors);
}

function showMessage(element, text, type = "success") {
  element.innerText = text;
  element.className = "message show " + type;

  setTimeout(function () {
    element.innerText = "";
    element.className = "message";
  }, 3000);
}

function getTodayDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const values = {};
  parts.forEach(function (part) {
    values[part.type] = part.value;
  });

  return values.year + "-" + values.month + "-" + values.day;
}

function getHebrewYear() {
  if (window.HebrewDate) {
    var fullText = window.HebrewDate.getHebrewDateText(new Date());
    var parts = fullText.split(" ");
    return parts[parts.length - 1];
  }
  return new Date().toLocaleDateString("he-IL-u-ca-hebrew", { year: "numeric" });
}

function getHebrewDateText() {
  return window.HebrewDate
    ? window.HebrewDate.getHebrewDateText(new Date())
    : formatHebrewDate(new Date().toISOString());
}

function formatHebrewDate(dateString) {
  if (!dateString) return "---";
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return "---";

  return date.toLocaleDateString("he-IL-u-ca-hebrew", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function formatRegularDate(dateString) {
  if (!dateString) return "---";

  if (/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    const parts = dateString.split("-");
    return parts[2] + "." + parts[1] + "." + parts[0];
  }

  const date = new Date(dateString);
  if (isNaN(date.getTime())) return "---";

  return date.toLocaleDateString("he-IL", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Jerusalem",
  });
}

function getCurrentParsha() {
  return window.HebrewDate && window.HebrewDate.getParsha
    ? window.HebrewDate.getParsha(new Date())
    : "";
}

function ensureDonorDefaults() {
  if (!donor.donations) donor.donations = [];
  if (!donor.tasks) donor.tasks = [];
  if (!donor.reminders) donor.reminders = [];
  if (!donor.callbacks) donor.callbacks = [];
  if (!donor.tags) donor.tags = [];
  if (!donor.internalStaffNote) donor.internalStaffNote = "";
  if (!donor.publicPhoneNote) donor.publicPhoneNote = "";

  if (!donor.phoneMessageSettings) {
    donor.phoneMessageSettings = {
      includeInCalls: true,
      allowPayment: true,
      allowPreviousDebts: true,
      allowCallback: true,
    };
  }
}

function getPaidTotal() {
  return donor.donations.reduce(function (sum, donation) {
    if (donation.paid === true) {
      return sum + Number(donation.amount);
    }

    const paidPartial = Number(donation.paidPartial || 0);
    return sum + paidPartial;
  }, 0);
}

function getDebtTotal() {
  return donor.donations.reduce(function (sum, donation) {
    return sum + Number(donation.remainingDebt || 0);
  }, 0);
}

function generateDonorLetterContent() {
  const paidTotalAmount = getPaidTotal();
  const debtTotalAmount = getDebtTotal();
  const openDebts = getOpenDebts();
  const personalNote = document.getElementById("personalNoteInput") ? document.getElementById("personalNoteInput").value.trim() : "";

  let donationsDetailsHTML = "";
  if (donor.donations.length > 0) {
    var hasNotes = donor.donations.some(function (d) { return d.note && d.note.trim(); });

    donationsDetailsHTML = "<h3 style='margin-top:25px;margin-bottom:12px;border-bottom:2px solid #333;padding-bottom:8px;font-size:16px;color:black;'>פירוט תרומות וחובות:</h3>";
    donationsDetailsHTML += "<table style='width:100%;border-collapse:collapse;margin-top:10px;'>";
    donationsDetailsHTML += "<thead><tr style='background-color:#e8e8e8;border:1px solid #333;'>";
    donationsDetailsHTML += "<th style='padding:10px;text-align:right;border:1px solid #ccc;font-weight:bold;color:black;'>תאריך</th>";
    donationsDetailsHTML += "<th style='padding:10px;text-align:right;border:1px solid #ccc;font-weight:bold;color:black;'>תאריך עברי</th>";
    donationsDetailsHTML += "<th style='padding:10px;text-align:right;border:1px solid #ccc;font-weight:bold;color:black;'>פרשה</th>";
    donationsDetailsHTML += "<th style='padding:10px;text-align:right;border:1px solid #ccc;font-weight:bold;color:black;'>מטרה</th>";
    donationsDetailsHTML += "<th style='padding:10px;text-align:right;border:1px solid #ccc;font-weight:bold;color:black;'>סכום</th>";
    donationsDetailsHTML += "<th style='padding:10px;text-align:right;border:1px solid #ccc;font-weight:bold;color:black;'>שולם</th>";
    donationsDetailsHTML += "<th style='padding:10px;text-align:right;border:1px solid #ccc;font-weight:bold;color:black;'>חוב</th>";
    if (hasNotes) {
      donationsDetailsHTML += "<th style='padding:10px;text-align:right;border:1px solid #ccc;font-weight:bold;color:black;'>הערה</th>";
    }
    donationsDetailsHTML += "</tr></thead><tbody>";

    donor.donations.forEach(function (donation) {
      const status = donation.paid === true ? "כן" : "לא";
      donationsDetailsHTML += "<tr style='border:1px solid #ccc;'>";
      donationsDetailsHTML += "<td style='padding:10px;border:1px solid #ccc;color:black;'>" + formatRegularDate(donation.date || donation.regularDate) + "</td>";
      donationsDetailsHTML += "<td style='padding:10px;border:1px solid #ccc;color:black;'>" + (donation.hebrewDate || formatHebrewDate(donation.date)) + "</td>";
      donationsDetailsHTML += "<td style='padding:10px;border:1px solid #ccc;color:black;'>" + (donation.parsha || "---") + "</td>";
      donationsDetailsHTML += "<td style='padding:10px;border:1px solid #ccc;color:black;'>" + (donation.finalPurpose || donation.purpose || "---") + "</td>";
      donationsDetailsHTML += "<td style='padding:10px;border:1px solid #ccc;text-align:right;color:black;'>" + formatMoney(donation.amount || 0, donation.currency) + "</td>";
      donationsDetailsHTML += "<td style='padding:10px;border:1px solid #ccc;color:black;'>" + status + "</td>";
      donationsDetailsHTML += "<td style='padding:10px;border:1px solid #ccc;text-align:right;color:black;'>" + formatMoney(donation.remainingDebt || 0, donation.currency) + "</td>";
      if (hasNotes) {
        donationsDetailsHTML += "<td style='padding:10px;border:1px solid #ccc;color:black;'>" + (donation.note ? escapeHTML(donation.note) : "---") + "</td>";
      }
      donationsDetailsHTML += "</tr>";
    });

    donationsDetailsHTML += "</tbody></table>";
  } else {
    donationsDetailsHTML = "<p style='margin-top:20px;color:#333;font-size:14px;'>אין תרומות להציג במכתב זה.</p>";
  }

  if (openDebts.length === 0) {
    donationsDetailsHTML += "<p style='color:green;font-weight:bold;margin-top:15px;font-size:14px;'>✅ אין חובות פתוחים</p>";
  }

  let personalNoteHTML = "";
  if (personalNote) {
    personalNoteHTML = "<div style='margin-top:20px;padding:15px;background:#f0f0f0;border:2px solid #333;border-radius:4px;'><h4 style='margin:0 0 10px 0;color:#8b0000;font-size:14px;border-bottom:1px solid #333;padding-bottom:8px;'>הערה אישית:</h4><p style='margin:0;color:black;line-height:1.6;white-space:pre-wrap;'>" + personalNote.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>') + "</p></div>";
  }

  const currentDate = new Date();
  const dateInfo = window.HebrewDate
    ? window.HebrewDate.getFullHebrewDateInfo(currentDate)
    : { hebrewDate: formatHebrewDate(currentDate.toISOString()), weekday: "---" };
  const currentHebrewDate = dateInfo.hebrewDate;
  const currentHebrewWeekday = dateInfo.weekday;
  const currentHebrewDateLine =
    dateInfo.dateLine || currentHebrewDate + " " + currentHebrewWeekday;
  const donorLetterLogoSrc = new URL(
    "images/סמל א בלאט גמרא.png",
    window.location.href,
  ).href;

  return `
    <style>
      .donor-letter-root {
        line-height: 1.45 !important;
        font-size: 13px !important;
      }
      .donor-letter-root img {
        max-height: 60px !important;
      }
      .donor-letter-root > div {
        margin-bottom: 14px !important;
      }
      .donor-letter-root > div:nth-of-type(1) {
        margin-bottom: 10px !important;
      }
      .donor-letter-root > div:nth-of-type(2) {
        margin-bottom: 16px !important;
        padding-bottom: 12px !important;
        border-bottom-width: 2px !important;
      }
      .donor-letter-root > div:nth-of-type(3) {
        margin-bottom: 14px !important;
        font-size: 13px !important;
        page-break-inside: avoid;
        break-inside: avoid;
      }
      .donor-letter-root > div:nth-of-type(4) {
        margin-top: 14px !important;
        margin-bottom: 14px !important;
        padding: 12px !important;
        border-width: 1px !important;
        font-size: 13px !important;
        page-break-inside: avoid;
        break-inside: avoid;
      }
      .donor-letter-root > div:last-child {
        margin-top: 18px !important;
        padding-top: 8px !important;
      }
      .donor-letter-root h1 {
        font-size: 26px !important;
      }
      .donor-letter-root h3 {
        margin-top: 14px !important;
        margin-bottom: 8px !important;
        padding-bottom: 5px !important;
        font-size: 14px !important;
      }
      .donor-letter-root p {
        margin-top: 3px !important;
        margin-bottom: 3px !important;
      }
      .donor-letter-root table {
        page-break-inside: auto;
        margin-top: 6px !important;
      }
      .donor-letter-root thead {
        display: table-header-group;
      }
      .donor-letter-root tr {
        page-break-inside: avoid;
        break-inside: avoid;
      }
      .donor-letter-root th,
      .donor-letter-root td {
        padding: 6px 7px !important;
        font-size: 12px !important;
        line-height: 1.35 !important;
        page-break-inside: avoid;
      }
    </style>
    <div class="donor-letter-root" style="color:black;font-family:'Arial','Calibri',sans-serif;line-height:1.45;direction:rtl;max-width:210mm;margin:0 auto;padding:0;font-size:13px;">
      <div style="text-align:center;margin-bottom:20px;">
        <img src="${donorLetterLogoSrc}" alt="לוגו" style="max-height:80px;height:auto;display:block;margin:0 auto;" onerror="this.style.display='none'">
      </div>

      <div style="text-align:center;margin-bottom:30px;border-bottom:3px solid #333;padding-bottom:20px;">
        <h1 style="margin:0;font-size:32px;font-weight:bold;color:#8b0000;">מכתב לתורם</h1>
        <p style="margin:10px 0 0 0;color:#666;font-size:13px;">מ-CRM ניהול תורמים</p>
        <p style="margin:8px 0 0 0;color:#333;font-size:14px;font-weight:bold;">${currentHebrewDateLine}</p>
      </div>

      <div style="margin-bottom:25px;font-size:14px;">
        <p style="margin:6px 0;color:black;"><strong>שם התורם:</strong> ${escapeHTML(donor.fullName || '---')}</p>
        <p style="margin:6px 0;color:black;"><strong>טלפון:</strong> ${escapeHTML(donor.phone || '---')}</p>
        <p style="margin:6px 0;color:black;"><strong>עיר:</strong> ${escapeHTML(donor.city || '---')}</p>
        <p style="margin:6px 0;color:black;"><strong>כתובת:</strong> ${escapeHTML(donor.address || '---')}</p>
      </div>

      <div style="margin:25px 0;padding:18px;background-color:#f5f5f5;border:2px solid #333;border-radius:4px;font-size:14px;">
        <h3 style="margin:0 0 12px 0;font-size:16px;color:#8b0000;border-bottom:1px solid #333;padding-bottom:8px;">סיכום:</h3>
        <p style="margin:8px 0;color:black;"><strong>סך ששולם:</strong> <span style="color:green;font-weight:bold;font-size:15px;">${escapeHTML(formatMoney(paidTotalAmount))}</span></p>
        <p style="margin:8px 0;color:black;"><strong>סך חוב פתוח:</strong> <span style="color:${debtTotalAmount > 0 ? 'red' : 'green'};font-weight:bold;font-size:15px;">${escapeHTML(formatMoney(debtTotalAmount))}</span></p>
      </div>

      ${donationsDetailsHTML}

      ${personalNoteHTML}

      <div style="margin-top:35px;text-align:center;color:#999;font-size:11px;border-top:1px solid #ddd;padding-top:15px;">
        <p>מסמך זה הודפס מ-CRM ניהול תורמים</p>
        <p>${currentHebrewDateLine} • ${currentDate.toLocaleTimeString('he-IL')}</p>
      </div>
    </div>
  `;
}

function generateDonorLetterPage() {
  return `<!doctype html>
    <html lang="he" dir="rtl">
      <head>
        <meta charset="utf-8" />
        <title>מכתב לתורם</title>
        <style>
          @page { size: A4; margin: 12mm; }
          html, body { margin: 0; padding: 0; direction: rtl; font-family: Arial, sans-serif; background: #fff; color: #000; }
          body { min-height: 297mm; font-size: 13px; line-height: 1.45; }
          table { width: 100%; border-collapse: collapse; page-break-inside: auto; }
          thead { display: table-header-group; }
          tr { page-break-inside: avoid; break-inside: avoid; }
          th, td { border: 1px solid #444; padding: 6px 7px; text-align: right; font-size: 12px; page-break-inside: avoid; }
          th { background: #f0f0f0; font-weight: bold; }
          .page { width: auto; min-height: auto; padding: 0; box-sizing: border-box; }
          .page h1 { font-size: 26px !important; }
          .page h3 { font-size: 14px !important; }
          .page img { max-height: 60px !important; }
          .logo img { max-height: 60px; }
          .note-box { margin-top: 14px; padding: 11px; background: #f8f8f8; border: 1px solid #ccc; page-break-inside: avoid; break-inside: avoid; }
          .summary-box { margin: 14px 0; padding: 12px; background-color: #f5f5f5; border: 1px solid #333; border-radius: 4px; font-size: 13px; page-break-inside: avoid; break-inside: avoid; }
        </style>
      </head>
      <body>
        <div class="page">
          ${generateDonorLetterContent()}
        </div>
      </body>
    </html>`;
}

function getOpenDebts() {
  return donor.donations.filter(function (donation) {
    return Number(donation.remainingDebt || 0) > 0;
  });
}

function getCurrentDebt() {
  const openDebts = getOpenDebts();
  if (openDebts.length === 0) return null;
  const sorted = openDebts.slice().sort(function(a, b) {
    return new Date(b.date || b.createdAt || 0) - new Date(a.date || a.createdAt || 0);
  });
  return sorted[0];
}

function getPreviousDebts() {
  const openDebts = getOpenDebts();
  if (openDebts.length <= 1) return [];
  const sorted = openDebts.slice().sort(function(a, b) {
    return new Date(b.date || b.createdAt || 0) - new Date(a.date || a.createdAt || 0);
  });
  return sorted.slice(1);
}

const printLetterButton = document.getElementById("printLetterButton");
if (printLetterButton) {
  printLetterButton.addEventListener("click", function() {
    const printModal = document.getElementById("printModal");
    const printContent = document.getElementById("printContent");
    printContent.innerHTML = generateDonorLetterContent();
    printModal.style.display = "flex";
  });
}

const printPdfButton = document.getElementById("printPdfButton");
if (printPdfButton) {
  printPdfButton.addEventListener("click", function() {
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      alert("לא ניתן לפתוח חלון חדש להדפסה. בדוק את חוסם החלונות הקופצים.");
      return;
    }
    printWindow.document.open();
    printWindow.document.write(generateDonorLetterPage());
    printWindow.document.close();
    printWindow.focus();
    printWindow.onafterprint = function () {
      printWindow.close();
    };
    printWindow.print();
  });
}

function renderDetails() {
  donorNameTitle.innerText = donor.fullName;
  donorSubTitle.innerText = "כרטיס תורם #" + donor.id;

  donorDetails.innerHTML = `
    <p><strong>שם:</strong> ${escapeHTML(donor.fullName)}</p>
    <p><strong>טלפון:</strong> ${escapeHTML(donor.phone)}</p>
    <p><strong>עיר:</strong> ${escapeHTML(donor.city) || "לא הוזן"}</p>
    <p><strong>כתובת:</strong> ${escapeHTML(donor.address) || "לא הוזן"}</p>
    <p><strong>שנה:</strong> ${escapeHTML(donor.hebrewYear || getHebrewYear())}</p>
    <p><strong>סטטוס:</strong> ${escapeHTML(donor.status) || "פעיל"}</p>
  `;

  internalStaffNote.value = donor.internalStaffNote || "";
  publicPhoneNote.value = donor.publicPhoneNote || "";
}

function fillEditDonorForm() {
  editFullNameInput.value = donor.fullName || "";
  editPhoneInput.value = donor.phone || "";
  editCityInput.value = donor.city || "";
  editAddressInput.value = donor.address || "";
  editStatusSelect.value = donor.status || "פעיל";
  editNotesInput.value = donor.notes || "";
}

function openEditDonorForm() {
  fillEditDonorForm();
  editDonorForm.classList.remove("hidden");
}

function closeEditDonorForm() {
  editDonorForm.classList.add("hidden");
  editDonorMessage.innerText = "";
  editDonorMessage.className = "message";
}

function saveDonorEdit() {
  const fullName = editFullNameInput.value.trim();
  const phone = editPhoneInput.value.trim();
  const city = editCityInput.value.trim();
  const address = editAddressInput.value.trim();
  const status = editStatusSelect.value;
  const notes = editNotesInput.value.trim();

  if (fullName === "" || phone === "") {
    showMessage(editDonorMessage, "חובה למלא שם מלא וטלפון", "error");
    return;
  }

  if (!/^[\d\s\-+()]{7,15}$/.test(phone)) {
    showMessage(editDonorMessage, "מספר טלפון לא תקין — ספרות בלבד, 7 עד 15 תווים", "error");
    return;
  }

  const phoneExists = donors.some(function (item) {
    return item.id !== donor.id && normalizePhoneLocal(item.phone) === normalizePhoneLocal(phone);
  });

  if (phoneExists) {
    showMessage(editDonorMessage, "קיים תורם אחר עם מספר טלפון זה", "error");
    return;
  }

  const previousDonor = {
    fullName: donor.fullName || "",
    phone: donor.phone || "",
    city: donor.city || "",
    address: donor.address || "",
    status: donor.status || "",
    notes: donor.notes || "",
  };

  donor.fullName = fullName;
  donor.phone = phone;
  donor.city = city;
  donor.address = address;
  donor.status = status;
  donor.notes = notes;
  donor.updatedAt = new Date().toISOString();

  saveDonors();
  AuditLog.record({
    action: "update",
    entityType: "donor",
    entityId: donor.id,
    entityName: donor.fullName,
    details: "עודכנו פרטי תורם",
    changes: [
      { field: "fullName", label: "שם מלא", before: previousDonor.fullName, after: donor.fullName || "" },
      { field: "phone", label: "טלפון", before: previousDonor.phone, after: donor.phone || "" },
      { field: "city", label: "עיר", before: previousDonor.city, after: donor.city || "" },
      { field: "address", label: "כתובת", before: previousDonor.address, after: donor.address || "" },
      { field: "status", label: "סטטוס", before: previousDonor.status, after: donor.status || "" },
      { field: "notes", label: "הערות", before: previousDonor.notes, after: donor.notes || "" },
    ].filter(function (change) {
      return change.before !== change.after;
    }),
  });
  closeEditDonorForm();
  renderAll();
}

function renderStats() {
  paidTotal.innerText = formatMoney(getPaidTotal());
  debtTotal.innerText = formatMoney(getDebtTotal());
  donationsCount.innerText = donor.donations.length;

  ivrStatus.innerText = donor.phoneMessageSettings.includeInCalls
    ? "פעיל"
    : "כבוי";
}

function renderIvrSettings() {
  includeInCallsCheckbox.checked = donor.phoneMessageSettings.includeInCalls;
  allowPaymentCheckbox.checked = donor.phoneMessageSettings.allowPayment;
  allowPreviousDebtsCheckbox.checked =
    donor.phoneMessageSettings.allowPreviousDebts;
  allowCallbackCheckbox.checked = donor.phoneMessageSettings.allowCallback;
}

function buildPhoneMessage() {
  const currentDebt = getCurrentDebt();
  const previousDebts = getPreviousDebts();

  if (!currentDebt) {
    return "אין חוב פתוח לתורם זה.";
  }

  let message = "";

  message += "יש לך חוב של " + formatMoney(currentDebt.remainingDebt) + " מהשבוע הנוכחי עבור " + currentDebt.finalPurpose + ".";

  if (donor.phoneMessageSettings.allowPayment) {
    message += " לתשלום עכשיו הקש 1.";
  }

  if (
    donor.phoneMessageSettings.allowPreviousDebts &&
    previousDebts.length > 0
  ) {
    message += " לשמיעת חובות קודמים הקש 2.";
  }

  if (donor.phoneMessageSettings.allowCallback) {
    message += " להשארת הודעה הקש 3.";
  }

  if (donor.publicPhoneNote) {
    message += " " + donor.publicPhoneNote;
  }

  return message;
}

function renderPhonePreview() {
  const previousDebts = getPreviousDebts();

  let previousHtml = "";

  if (previousDebts.length > 0) {
    previousHtml = `
      <h4>חובות קודמים:</h4>
      <ul>
        ${previousDebts
          .map(function (debt) {
            return "<li>" + formatMoney(debt.remainingDebt, debt.currency) + " עבור " + escapeHTML(debt.finalPurpose) + "</li>";
          })
          .join("")}
      </ul>
    `;
  }

  phonePreview.innerHTML = `
    <h3>🔊 טקסט משוער לטלפון</h3>
    <p>${buildPhoneMessage()}</p>
    ${previousHtml}
  `;
}

function renderDonationsTable() {
  donationsTable.innerHTML = "";

  if (donor.donations.length === 0) {
    donationsTable.innerHTML = `
      <tr class="empty-state-row">
        <td colspan="7">💰 אין עדיין תרומות לתורם זה</td>
      </tr>
    `;
    return;
  }

  donor.donations.forEach(function (donation) {
    const row = document.createElement("tr");

    row.innerHTML = `
      <td>${escapeHTML(donation.hebrewDate)}</td>
      <td>${escapeHTML(donation.parsha || "---")}</td>
      <td>${escapeHTML(donation.finalPurpose)}</td>
      <td>${formatMoney(donation.amount, donation.currency)}</td>
      <td>${donation.remainingDebt > 0 ? "לא שולם" : "שולם"}</td>
      <td>${escapeHTML(donation.paymentMethod)}</td>
      <td class="${donation.remainingDebt > 0 ? "red-text" : "green-text"}">
        ${formatMoney(donation.remainingDebt, donation.currency)}
      </td>
    `;

    donationsTable.appendChild(row);
  });
}

function renderTags() {
  var display = document.getElementById("donorTagsDisplay");
  if (!display) return;
  if (!donor.tags || donor.tags.length === 0) {
    display.innerHTML = '<span style="color:var(--muted);font-size:12px">אין תגיות</span>';
    return;
  }
  display.innerHTML = donor.tags.map(function (tag, i) {
    return '<span class="tag">' + escapeHTML(tag) +
      '<button class="tag-remove" onclick="removeTag(' + i + ')" title="הסר">×</button></span>';
  }).join("");
}

function addTag(tag) {
  tag = (tag || "").trim();
  if (!tag) return;
  if (donor.tags.indexOf(tag) !== -1) return;
  donor.tags.push(tag);
  saveDonors();
  renderTags();
}

window.removeTag = function removeTag(index) {
  donor.tags.splice(index, 1);
  saveDonors();
  renderTags();
};

var tagInput = document.getElementById("tagInput");
var addTagButton = document.getElementById("addTagButton");
if (addTagButton && tagInput) {
  addTagButton.addEventListener("click", function () {
    addTag(tagInput.value);
    tagInput.value = "";
  });
  tagInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { addTag(tagInput.value); tagInput.value = ""; }
  });
}

function formatTimelineDate(dateStr) {
  if (!dateStr) return "";
  try {
    return new Date(dateStr).toLocaleDateString("he-IL", { day: "numeric", month: "short", year: "numeric" });
  } catch (e) { return dateStr; }
}

function renderTimeline() {
  var container = document.getElementById("donorTimeline");
  if (!container) return;

  var events = [];
  var seen = {};

  function addTimelineEvent(type, id, date, text, sub) {
    if (!date) return;

    var key = type + ":" + (id || date + ":" + text);
    if (seen[key]) return;
    seen[key] = true;

    events.push({
      type: type,
      date: date,
      text: text,
      sub: sub || "",
    });
  }

  (donor.donations || []).forEach(function (d) {
    addTimelineEvent(
      "donation",
      d.id,
      d.date || d.createdAt || "",
      "תרומה: " + formatMoney(d.amount || 0, d.currency) + " עבור " + escapeHTML(d.finalPurpose || "כללי"),
      d.paid ? "שולם במלואו" : ("חוב פתוח: " + formatMoney(d.remainingDebt || 0, d.currency))
    );
  });

  (donor.tasks || []).forEach(function (t) {
    addTimelineEvent(
      "task",
      t.id,
      t.createdAt || t.dueDate || "",
      "משימה: " + escapeHTML(t.title || ""),
      t.done ? "הושלמה" : ("לביצוע" + (t.dueDate ? " עד " + t.dueDate : ""))
    );
  });

  Database.get("tasks").forEach(function (t) {
    if (Number(t.donorId) !== donor.id) return;

    addTimelineEvent(
      "task",
      t.id,
      t.createdAt || t.dueDate || "",
      "משימה: " + escapeHTML(t.title || ""),
      t.done ? "הושלמה" : ("לביצוע" + (t.dueDate ? " עד " + t.dueDate : ""))
    );
  });

  (donor.reminders || []).forEach(function (r) {
    addTimelineEvent(
      "reminder",
      r.id,
      r.date || r.createdAt || "",
      "תזכורת: " + escapeHTML(r.description || r.text || ""),
      r.done ? "טופל" : "פתוח"
    );
  });

  (donor.callbacks || []).forEach(function (c) {
    addTimelineEvent(
      "callback",
      c.id,
      c.createdAt || c.date || "",
      "הודעה לחזרה: " + escapeHTML(c.reason || c.description || ""),
      c.done ? "טופל" : "פתוח"
    );
  });

  [
    { value: donor.notes, date: donor.notesUpdatedAt || donor.notesCreatedAt, label: "הערה" },
    { value: donor.internalStaffNote, date: donor.internalStaffNoteUpdatedAt || donor.internalStaffNoteCreatedAt, label: "הערה פנימית" },
    { value: donor.publicPhoneNote, date: donor.publicPhoneNoteUpdatedAt || donor.publicPhoneNoteCreatedAt, label: "הערה לטלפון" },
  ].forEach(function (note, index) {
    if (!note.value || !note.date) return;
    addTimelineEvent(
      "note",
      "note-" + index,
      note.date,
      note.label + ": " + escapeHTML(note.value),
      ""
    );
  });

  events.sort(function (a, b) { return (b.date || "").localeCompare(a.date || ""); });

  if (events.length === 0) {
    container.innerHTML = '<div style="color:var(--muted);font-size:13px">אין פעילות להצגה</div>';
    return;
  }

  container.innerHTML = events.map(function (ev) {
    return '<div class="timeline-item ' + ev.type + '">' +
      '<div class="timeline-date">' + formatTimelineDate(ev.date) + '</div>' +
      '<div class="timeline-text">' + ev.text + '</div>' +
      '<div class="timeline-sub">' + ev.sub + '</div>' +
    '</div>';
  }).join("");
}

function renderAll() {
  renderDetails();
  renderStats();
  renderIvrSettings();
  renderPhonePreview();
  renderDonationsTable();
  renderTags();
  renderTimeline();
}

function saveNotes() {
  donor.internalStaffNote = internalStaffNote.value.trim();
  donor.publicPhoneNote = publicPhoneNote.value.trim();
  donor.updatedAt = new Date().toISOString();

  saveDonors();
  AuditLog.record({
    action: "update",
    entityType: "donor",
    entityId: donor.id,
    entityName: donor.fullName,
    details: "עודכנו הערות תורם",
  });
  renderPhonePreview();
  showMessage(notesMessage, "ההערות נשמרו בהצלחה");
}

function addDonation() {
  const amount = Number(amountInput.value);
  const manualParsha = parshaInput ? parshaInput.value.trim() : "";
  const selectedPurpose = purposeSelect.value;
  const customPurpose = customPurposeInput.value.trim();
  const paymentMethod = paymentMethodSelect.value;
  const paid = paidSelect.value === "true";
  const note = donationNoteInput.value.trim();

  if (!amount || amount <= 0) {
    showMessage(donationMessage, "חובה להכניס סכום תקין", "error");
    return;
  }

  if (selectedPurpose === "אחר" && customPurpose === "") {
    showMessage(donationMessage, "בחרת אחר, צריך לכתוב מטרה", "error");
    return;
  }

  const finalPurpose =
    selectedPurpose === "אחר" ? customPurpose : selectedPurpose;

  const now = new Date();
  const parsha =
    manualParsha ||
    (window.HebrewDate && window.HebrewDate.getParsha
      ? window.HebrewDate.getParsha(now)
      : "");
  const newDonation = {
    id: Date.now(),
    date: now.toISOString(),
    regularDate: getTodayDate(),
    hebrewDate: window.HebrewDate
      ? window.HebrewDate.getHebrewDateText(now)
      : formatHebrewDate(now.toISOString()),
    weekday: window.HebrewDate
      ? window.HebrewDate.getHebrewWeekday(now)
      : "",
    amount: amount,
    parsha: parsha,
    finalPurpose: finalPurpose,
    purposeType: selectedPurpose,
    customPurpose: customPurpose,
    paymentMethod: paymentMethod,
    paid: paid,
    paidPartial: paid ? amount : 0,
    remainingDebt: paid ? 0 : amount,
    note: note,
    approvedStatus: "טיוטה",
    messageStatus: "טיוטה",
    createdAt: now.toISOString(),
  };

  donor.donations.push(newDonation);
  donor.updatedAt = new Date().toISOString();

  saveDonors();
  AuditLog.record({
    action: "create",
    entityType: "donation",
    entityId: newDonation.id,
    entityName: donor.fullName,
    details:
      "נוספה תרומה/חוב בסך " + formatMoney(newDonation.amount) +
      " עבור " +
      newDonation.finalPurpose,
  });

  amountInput.value = "";
  if (parshaInput) parshaInput.value = "";
  customPurposeInput.value = "";
  donationNoteInput.value = "";
  purposeSelect.value = "גליון מתאחדת";
  paidSelect.value = "false";
  customPurposeInput.classList.add("hidden");

  showMessage(donationMessage, "התרומה נוספה בהצלחה");
  renderAll();
}

function saveIvrSettings() {
  donor.phoneMessageSettings = {
    includeInCalls: includeInCallsCheckbox.checked,
    allowPayment: allowPaymentCheckbox.checked,
    allowPreviousDebts: allowPreviousDebtsCheckbox.checked,
    allowCallback: allowCallbackCheckbox.checked,
  };

  donor.updatedAt = new Date().toISOString();

  saveDonors();
  AuditLog.record({
    action: "update",
    entityType: "donor",
    entityId: donor.id,
    entityName: donor.fullName,
    details: "עודכנו הגדרות IVR לתורם",
  });
  renderAll();
}

function registerPartialPayment() {
  const amount = Number(partialAmountInput.value);

  if (!amount || amount <= 0) {
    showMessage(partialMessage, "חובה להכניס סכום תקין", "error");
    return;
  }

  let remainingPayment = amount;
  const openDebts = getOpenDebts();

  if (openDebts.length === 0) {
    showMessage(partialMessage, "אין חובות פתוחים", "error");
    return;
  }

  const totalDebt = getDebtTotal();

  if (amount > totalDebt) {
    showMessage(partialMessage, "סכום התשלום גדול מסך החוב הפתוח", "error");
    return;
  }

  openDebts.forEach(function (debt) {
    if (remainingPayment <= 0) return;

    const debtAmount = Number(debt.remainingDebt);

    if (remainingPayment >= debtAmount) {
      debt.paidPartial = Number(debt.paidPartial || 0) + debtAmount;
      debt.remainingDebt = 0;
      debt.paid = true;
      remainingPayment -= debtAmount;
    } else {
      debt.paidPartial = Number(debt.paidPartial || 0) + remainingPayment;
      debt.remainingDebt = debtAmount - remainingPayment;
      debt.paid = false;
      remainingPayment = 0;
    }

    debt.lastPaymentMethod = partialPaymentMethod.value;
    debt.updatedAt = new Date().toISOString();
  });

  donor.updatedAt = new Date().toISOString();

  saveDonors();
  AuditLog.record({
    action: "payment",
    entityType: "donation",
    entityId: donor.id,
    entityName: donor.fullName,
    details:
      "נרשם תשלום חלקי בסך " + formatMoney(amount) +
      " באמצעי " +
      partialPaymentMethod.value,
  });
  partialAmountInput.value = "";
  showMessage(partialMessage, "התשלום החלקי נרשם בהצלחה");
  renderAll();
}

purposeSelect.addEventListener("change", function () {
  if (purposeSelect.value === "אחר") {
    customPurposeInput.classList.remove("hidden");
  } else {
    customPurposeInput.classList.add("hidden");
    customPurposeInput.value = "";
  }
});

saveNotesButton.addEventListener("click", saveNotes);
editDonorButton.addEventListener("click", openEditDonorForm);
saveDonorEditButton.addEventListener("click", saveDonorEdit);
cancelDonorEditButton.addEventListener("click", closeEditDonorForm);
addDonationButton.addEventListener("click", addDonation);
saveIvrButton.addEventListener("click", saveIvrSettings);
partialPaymentButton.addEventListener("click", registerPartialPayment);

Database.whenReady(function () {
  donors = Database.get("donors");
  donor  = donors.find(function (item) { return item.id === donorId; });

  if (!donor) {
    document.body.innerHTML = `
      <main class="main" style="margin:0">
        <section class="panel">
          <h1>התורם לא נמצא</h1>
          <a class="primary-btn" href="donors.html">חזרה לתורמים</a>
        </section>
      </main>
    `;
    return;
  }

  ensureDonorDefaults();
  renderAll();
  if (parshaInput && !parshaInput.value.trim()) {
    parshaInput.value = getCurrentParsha();
  }
  amountInput.addEventListener("keydown", function (event) {
    if (event.key === "Enter") { addDonation(); }
  });
  customPurposeInput.addEventListener("keydown", function (event) {
    if (event.key === "Enter") { addDonation(); }
  });

  // ── Click-to-Call ───────────────────────────────────────────────────────────
  var callDonorButton    = document.getElementById("callDonorButton");
  var callDonorModal     = document.getElementById("callDonorModal");
  var callDonorInfo      = document.getElementById("callDonorInfo");
  var agentExtInput      = document.getElementById("agentExtensionInput");
  var confirmCallButton  = document.getElementById("confirmCallButton");
  var cancelCallButton   = document.getElementById("cancelCallButton");
  var callDonorStatus    = document.getElementById("callDonorStatus");

  agentExtInput.value = localStorage.getItem("agentExtension") || "";

  callDonorButton.addEventListener("click", function () {
    if (!donor || !donor.phone) {
      showToast("לא נמצא מספר טלפון לתורם");
      return;
    }
    callDonorInfo.textContent = "מתקשר אל: " + donor.fullName + " (" + donor.phone + ")";
    callDonorStatus.textContent = "";
    callDonorStatus.className = "message";
    callDonorModal.style.display = "flex";
    agentExtInput.focus();
  });

  cancelCallButton.addEventListener("click", function () {
    callDonorModal.style.display = "none";
  });

  callDonorModal.addEventListener("click", function (e) {
    if (e.target === callDonorModal) callDonorModal.style.display = "none";
  });

  agentExtInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") confirmCallButton.click();
  });

  confirmCallButton.addEventListener("click", async function () {
    var ext = agentExtInput.value.trim();
    if (!ext) {
      callDonorStatus.textContent = "יש להזין מספר שלוחה";
      callDonorStatus.className = "message show error";
      return;
    }

    localStorage.setItem("agentExtension", ext);
    confirmCallButton.disabled = true;
    confirmCallButton.textContent = "מחייג...";
    callDonorStatus.textContent = "";
    callDonorStatus.className = "message";

    try {
      var res = await apiFetch("/api/technoline/click2call", {
        method: "POST",
        body: JSON.stringify({
          phone:     donor.phone,
          donorName: donor.fullName,
          donorId:   donor.id,
          extension: ext,
        }),
      });
      var data = await res.json();

      if (!res.ok) {
        callDonorStatus.textContent = data.error || "שגיאה בחיוג";
        callDonorStatus.className = "message show error";
      } else {
        callDonorModal.style.display = "none";
        showToast("הטלפון שלך יצלצל — כשתענה, תחובר אוטומטית אל " + donor.fullName);
      }
    } catch (_) {
      callDonorStatus.textContent = "שגיאת תקשורת עם השרת";
      callDonorStatus.className = "message show error";
    } finally {
      confirmCallButton.disabled = false;
      confirmCallButton.textContent = "חייג";
    }
  });
});

// Re-render when donors are refreshed in the background (e.g. after IVR payment)
window.addEventListener("crm-donors-refreshed", function () {
  donors = Database.get("donors");
  var updated = donors.find(function (item) { return item.id === donorId; });
  if (!updated) return;
  donor = updated;
  renderAll();
});

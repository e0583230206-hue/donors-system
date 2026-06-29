let donors = Database.get("donors");
let workers = Database.get("workers");
let approvals = Database.get("approvals");

const createDraftButton = document.getElementById("createDraftButton");
const approverSelect = document.getElementById("approverSelect");
const messageBox = document.getElementById("messageBox");

const draftCount = document.getElementById("draftCount");
const approvedCount = document.getElementById("approvedCount");
const cancelledCount = document.getElementById("cancelledCount");
const approvedAmount = document.getElementById("approvedAmount");
const approvalsTable = document.getElementById("approvalsTable");
var pendingApprovalDeletions = {};

function saveApprovals() {
  Database.save("approvals", approvals);
}

function showMessage(text, type = "success") {
  messageBox.innerText = text;
  messageBox.className = "message show " + type;

  setTimeout(function () {
    messageBox.innerText = "";
    messageBox.className = "message";
  }, 3000);
}

// formatMoney is defined globally in database.js

function formatDateTime(dateString) {
  if (!dateString) return "";
  return new Date(dateString).toLocaleString("he-IL");
}

function fillApproverSelect() {
  approverSelect.innerHTML = `<option value="">בחר עובד מאשר</option>`;

  workers
    .filter(function (worker) {
      return worker.status === "פעיל";
    })
    .forEach(function (worker) {
      const option = document.createElement("option");
      option.value = worker.name;
      option.innerText = worker.name + " - " + worker.role;
      approverSelect.appendChild(option);
    });
}

function getPreviousDebtsText(donor, currentDonationId) {
  if (!donor.donations) return "";

  const previousDebts = donor.donations.filter(function (donation) {
    return (
      donation.id !== currentDonationId &&
      Number(donation.remainingDebt || 0) > 0
    );
  });

  if (previousDebts.length === 0) {
    return "";
  }

  return previousDebts
    .map(function (debt) {
      return formatMoney(debt.remainingDebt) + " עבור " + debt.finalPurpose;
    })
    .join(", ");
}

function buildPhoneText(donor, donation) {
  let text = "יש לך חוב של " + formatMoney(donation.remainingDebt) + " עבור " + donation.finalPurpose + ".";

  const previousDebtsText = getPreviousDebtsText(donor, donation.id);

  text += " לתשלום הקש 1.";

  if (previousDebtsText !== "") {
    text += " לשמיעת חובות קודמים הקש 2.";
  }

  text += " להשארת הודעה הקש 3.";

  if (donor.publicPhoneNote) {
    text += " " + donor.publicPhoneNote;
  }

  return text;
}

function createDraftApprovals() {
  const newDrafts = [];
  let updatedDrafts = 0;
  let cancelledDrafts = 0;

  donors.forEach(function (donor) {
    if (!donor.donations) return;

    donor.donations.forEach(function (donation) {
      const remainingDebt = Number(donation.remainingDebt || 0);

      const existingDraft = approvals.find(function (approval) {
        return (
          approval.donorId === donor.id &&
          approval.donationId === donation.id &&
          approval.status === "טיוטה"
        );
      });

      if (remainingDebt <= 0) {
        if (existingDraft) {
          existingDraft.status = "בוטל";
          existingDraft.cancelledAt = new Date().toISOString();
          existingDraft.updatedAt = new Date().toISOString();
          cancelledDrafts++;
        }

        return;
      }

      if (existingDraft) {
        existingDraft.donorName = donor.fullName;
        existingDraft.phone = donor.phone;
        existingDraft.purpose = donation.finalPurpose;
        existingDraft.amount = remainingDebt;
        existingDraft.phoneText = buildPhoneText(donor, donation);
        existingDraft.updatedAt = new Date().toISOString();
        updatedDrafts++;
        return;
      }

      newDrafts.push({
        id: Date.now() + Math.random(),
        donorId: donor.id,
        donationId: donation.id,
        donorName: donor.fullName,
        phone: donor.phone,
        purpose: donation.finalPurpose,
        amount: remainingDebt,
        phoneText: buildPhoneText(donor, donation),
        status: "טיוטה",
        approvedBy: "",
        approvedAt: "",
        cancelledAt: "",
        createdAt: new Date().toISOString(),
      });
    });
  });

  approvals = approvals.concat(newDrafts);
  saveApprovals();
  AuditLog.record({
    action: "create",
    entityType: "approval",
    entityId: "",
    entityName: "טיוטת חיובים",
    details:
      "נוצרו " +
      newDrafts.length +
      " חיובים חדשים לטיוטה, עודכנו " +
      updatedDrafts +
      ", בוטלו " +
      cancelledDrafts,
  });
  renderApprovals();

  showMessage(
    "נוצרו " +
      newDrafts.length +
      " חיובים חדשים, עודכנו " +
      updatedDrafts +
      ", בוטלו " +
      cancelledDrafts,
  );
}

function approveItem(id) {
  const approver = approverSelect.value;

  if (approver === "") {
    showMessage("חובה לבחור עובד מאשר", "error");
    return;
  }

  const approval = approvals.find(function (item) {
    return item.id === id;
  });

  if (!approval) return;

  approval.status = "אושר";
  approval.approvedBy = approver;
  approval.approvedAt = new Date().toISOString();
  approval.cancelledAt = "";

  saveApprovals();
  AuditLog.record({
    action: "approve",
    entityType: "approval",
    entityId: approval.id,
    entityName: approval.donorName,
    details: "חיוב אושר על ידי " + approver,
  });
  renderApprovals();
}

function cancelApproval(id) {
  const approval = approvals.find(function (item) {
    return item.id === id;
  });

  if (!approval) return;

  approval.status = "בוטל";
  approval.cancelledAt = new Date().toISOString();

  saveApprovals();
  AuditLog.record({
    action: "cancel",
    entityType: "approval",
    entityId: approval.id,
    entityName: approval.donorName,
    details: "חיוב בוטל",
  });
  renderApprovals();
}

function returnToDraft(id) {
  const approval = approvals.find(function (item) {
    return item.id === id;
  });

  if (!approval) return;

  approval.status = "טיוטה";
  approval.approvedBy = "";
  approval.approvedAt = "";
  approval.cancelledAt = "";

  saveApprovals();
  AuditLog.record({
    action: "status",
    entityType: "approval",
    entityId: approval.id,
    entityName: approval.donorName,
    details: "חיוב הוחזר לטיוטה",
  });
  renderApprovals();
}

function deleteApproval(id) {
  const deletedApproval = approvals.find(function (item) { return item.id === id; });
  if (!deletedApproval || pendingApprovalDeletions[id]) return;

  approvals = approvals.filter(function (item) { return item.id !== id; });
  saveApprovals();
  AuditLog.record({
    action: "delete",
    entityType: "approval",
    entityId: deletedApproval.id,
    entityName: deletedApproval.donorName,
    details: "חיוב נמחק מהטיוטה",
  });
  renderApprovals();

  if (typeof showToast === "function") {
    showToast('חיוב "' + deletedApproval.donorName + '" נמחק', function () {
      approvals.push(deletedApproval);
      saveApprovals();
      renderApprovals();
    }, 5000);
  } else {
    showMessage("החיוב נמחק מהטיוטה");
  }
}

function renderStats() {
  const drafts = approvals.filter(function (item) {
    return item.status === "טיוטה" && !pendingApprovalDeletions[item.id];
  });

  const approved = approvals.filter(function (item) {
    return item.status === "אושר" && !pendingApprovalDeletions[item.id];
  });

  const cancelled = approvals.filter(function (item) {
    return item.status === "בוטל" && !pendingApprovalDeletions[item.id];
  });

  const approvedSum = approved.reduce(function (sum, item) {
    return sum + Number(item.amount || 0);
  }, 0);

  draftCount.innerText = drafts.length;
  approvedCount.innerText = approved.length;
  cancelledCount.innerText = cancelled.length;
  approvedAmount.innerText = formatMoney(approvedSum);
}

function getStatusClass(status) {
  if (status === "אושר") return "green-text";
  if (status === "בוטל") return "red-text";
  return "yellow-text";
}

function renderApprovals() {
  renderStats();

  approvalsTable.innerHTML = "";

  var visibleApprovals = approvals.filter(function (item) {
    return !pendingApprovalDeletions[item.id];
  });

  if (visibleApprovals.length === 0) {
    approvalsTable.innerHTML = `
      <tr class="empty-state-row">
        <td colspan="9">✅ אין עדיין טיוטת חיובים — לחץ על "צור / רענן טיוטת חיובים"</td>
      </tr>
    `;
    return;
  }

  visibleApprovals.forEach(function (item) {
    const row = document.createElement("tr");

    row.innerHTML = `
      <td>${escapeHTML(item.donorName)}</td>
      <td>${escapeHTML(item.phone)}</td>
      <td>${escapeHTML(item.purpose)}</td>
      <td class="red-text">${formatMoney(item.amount)}</td>
      <td>${escapeHTML(item.phoneText)}</td>
      <td class="${getStatusClass(item.status)}">${item.status}</td>
      <td>${escapeHTML(item.approvedBy || "")}</td>
      <td>${formatDateTime(item.approvedAt)}</td>
      <td>
        <a class="small-btn" href="donor.html?id=${item.donorId}">
          כרטיס
        </a>
        <button class="success-btn" onclick="approveItem(${item.id})">
          אשר
        </button>
        <button class="warning-btn" onclick="returnToDraft(${item.id})">
          טיוטה
        </button>
        <button class="danger-btn" onclick="cancelApproval(${item.id})">
          בטל
        </button>
        <button class="danger-btn" onclick="deleteApproval(${item.id})">
          מחק
        </button>
      </td>
    `;

    approvalsTable.appendChild(row);
  });
}

function downloadXLSX(filename, sheetName, rows) {
  var workbook = XLSX.utils.book_new();
  var worksheet = XLSX.utils.aoa_to_sheet(rows);
  worksheet["!cols"] = rows[0].map(function () { return { wch: 22 }; });
  worksheet["!rtl"] = true;
  workbook.Workbook = { Views: [{ RTL: true }] };
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  XLSX.writeFile(workbook, filename);
}

function exportApprovalsExcel() {
  if (approvals.length === 0) {
    showMessage("אין אישורים לייצוא", "error");
    return;
  }

  var rows = [["תורם", "טלפון", "מטרה", "סכום", "הודעה לטלפון", "סטטוס", "אושר ע\"י", "תאריך אישור", "נוצר"]];

  approvals.forEach(function (item) {
    rows.push([
      item.donorName || "",
      item.phone || "",
      item.purpose || "",
      Number(item.amount || 0),
      item.phoneText || "",
      item.status || "",
      item.approvedBy || "",
      item.approvedAt ? new Date(item.approvedAt).toLocaleString("he-IL") : "",
      item.createdAt ? new Date(item.createdAt).toLocaleString("he-IL") : "",
    ]);
  });

  var today = new Date().toISOString().slice(0, 10);
  downloadXLSX("approvals-" + today + ".xlsx", "אישורי חיוב", rows);
}

createDraftButton.addEventListener("click", createDraftApprovals);

Database.whenReady(function () {
  donors    = Database.get("donors");
  approvals = Database.get("approvals");
  fillApproverSelect();
  renderApprovals();
});

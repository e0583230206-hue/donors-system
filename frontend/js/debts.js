let donors = Database.get("donors");

const debtorsCount = document.getElementById("debtorsCount");
const totalDebts = document.getElementById("totalDebts");
const openDebtsCount = document.getElementById("openDebtsCount");
const filteredCount = document.getElementById("filteredCount");

const searchInput = document.getElementById("searchInput");
const purposeFilter = document.getElementById("purposeFilter");
const debtsTable = document.getElementById("debtsTable");

function getDaysOpen(dateString) {
  if (!dateString) return 0;

  const createdDate = new Date(dateString);
  const today = new Date();

  const difference = today - createdDate;
  return Math.floor(difference / (1000 * 60 * 60 * 24));
}

function getDebtStatus(daysOpen) {
  if (daysOpen > 90) {
    return "ישן מאוד";
  }

  if (daysOpen > 30) {
    return "דורש טיפול";
  }

  return "חדש";
}

function getStatusClass(daysOpen) {
  if (daysOpen > 90) {
    return "red-text";
  }

  if (daysOpen > 30) {
    return "yellow-text";
  }

  return "green-text";
}

function getAllOpenDebts() {
  const debts = [];

  donors.forEach(function (donor) {
    if (!donor.donations) return;

    donor.donations.forEach(function (donation) {
      const remainingDebt = Number(donation.remainingDebt || 0);

      if (remainingDebt > 0) {
        debts.push({
          donorId: donor.id,
          donorName: donor.fullName,
          phone: donor.phone,
          purpose: donation.finalPurpose,
          purposeType: donation.purposeType,
          amount: remainingDebt,
          currency: donation.currency,
          createdAt: donation.createdAt,
        });
      }
    });
  });

  return debts;
}

function renderDebts() {
  const allDebts = getAllOpenDebts();

  const searchText = searchInput.value.trim().toLowerCase();
  const selectedPurpose = purposeFilter.value;

  const filteredDebts = allDebts.filter(function (debt) {
    const matchesSearch =
      debt.donorName.toLowerCase().includes(searchText) ||
      debt.phone.includes(searchText);

    const matchesPurpose =
      selectedPurpose === "all" ||
      debt.purposeType === selectedPurpose ||
      debt.purpose === selectedPurpose;

    return matchesSearch && matchesPurpose;
  });

  const uniqueDebtors = new Set(
    allDebts.map(function (debt) {
      return debt.donorId;
    }),
  );

  const totalDebtAmount = allDebts.reduce(function (sum, debt) {
    return sum + Number(debt.amount);
  }, 0);

  debtorsCount.innerText = uniqueDebtors.size;
  totalDebts.innerText = formatMoney(totalDebtAmount);
  openDebtsCount.innerText = allDebts.length;
  filteredCount.innerText = filteredDebts.length;

  debtsTable.innerHTML = "";

  if (filteredDebts.length === 0) {
    debtsTable.innerHTML = `
      <tr class="empty-state-row">
        <td colspan="7">⚠️ אין חובות להצגה</td>
      </tr>
    `;
    return;
  }

  filteredDebts.forEach(function (debt) {
    const daysOpen = getDaysOpen(debt.createdAt);
    const status = getDebtStatus(daysOpen);
    const statusClass = getStatusClass(daysOpen);

    const row = document.createElement("tr");

    row.innerHTML = `
      <td>${escapeHTML(debt.donorName)}</td>
      <td>${escapeHTML(debt.phone)}</td>
      <td>${escapeHTML(debt.purpose)}</td>
      <td class="red-text">${formatMoney(debt.amount, debt.currency)}</td>
      <td class="${statusClass}">${daysOpen} ימים</td>
      <td class="${statusClass}">${status}</td>
      <td>
        <a class="small-btn" href="donor.html?id=${debt.donorId}">
          פתח כרטיס
        </a>
      </td>
    `;

    debtsTable.appendChild(row);
  });
}

searchInput.addEventListener("input", renderDebts);
purposeFilter.addEventListener("change", renderDebts);

Database.whenReady(function () {
  donors = Database.get("donors");
  renderDebts();
});

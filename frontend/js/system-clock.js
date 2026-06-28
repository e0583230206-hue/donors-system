(function () {
  function getIsraelDateParts(date) {
    const parts = new Intl.DateTimeFormat("he-IL", {
      timeZone: "Asia/Jerusalem",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);

    const values = {};
    parts.forEach(function (part) {
      values[part.type] = part.value;
    });

    return values.day + "." + values.month + "." + values.year;
  }

  function getIsraelTime(date) {
    return date.toLocaleTimeString("he-IL", {
      timeZone: "Asia/Jerusalem",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function getHebrewDate(date) {
    return window.HebrewDate
      ? window.HebrewDate.getHebrewDateText(date)
      : date.toLocaleDateString("he-IL-u-ca-hebrew", {
          day: "numeric",
          month: "long",
          year: "numeric",
          timeZone: "Asia/Jerusalem",
        });
  }

  function getWeekday(date) {
    return window.HebrewDate
      ? window.HebrewDate.getHebrewWeekday(date)
      : date.toLocaleDateString("he-IL", {
          weekday: "long",
          timeZone: "Asia/Jerusalem",
        });
  }

  function createClockElement() {
    const clock = document.createElement("div");
    clock.className = "system-clock";
    clock.innerHTML = `
      <strong data-system-clock-time></strong>
      <span data-system-clock-regular></span>
      <span data-system-clock-hebrew></span>
      <span data-system-clock-weekday></span>
    `;
    return clock;
  }

  function updateClock(clock) {
    const now = new Date();

    clock.querySelector("[data-system-clock-time]").innerText =
      getIsraelTime(now);
    clock.querySelector("[data-system-clock-regular]").innerText =
      getIsraelDateParts(now);
    clock.querySelector("[data-system-clock-hebrew]").innerText =
      getHebrewDate(now);
    clock.querySelector("[data-system-clock-weekday]").innerText =
      getWeekday(now);
  }

  function initSystemClock() {
    const topbar = document.querySelector(".topbar");
    if (!topbar) return;

    const clock = createClockElement();
    topbar.appendChild(clock);
    updateClock(clock);

    setInterval(function () {
      updateClock(clock);
    }, 1000);
  }

  initSystemClock();
})();

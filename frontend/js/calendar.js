function stripNikud(s) {
  return String(s || "").replace(/[֑-ׇ]/g, "");
}

function numToHeb(n) {
  var ones    = ["","א","ב","ג","ד","ה","ו","ז","ח","ט"];
  var tens    = ["","י","כ","ל","מ","נ","ס","ע","פ","צ"];
  var hundreds = ["","ק","ר","ש","ת"];
  if (n === 15) return "ט״ו";
  if (n === 16) return "ט״ז";
  var result = "";
  while (n >= 400) { result += "ת"; n -= 400; }
  result += hundreds[Math.floor(n / 100)] || "";
  n %= 100;
  result += tens[Math.floor(n / 10)] || "";
  n %= 10;
  result += ones[n] || "";
  if (result.length === 1) return result + "׳";  // geresh
  return result.slice(0, -1) + "״" + result.slice(-1); // gershayim
}

function getHebrewParts(gDate) {
  var fmt = new Intl.DateTimeFormat("he-IL-u-ca-hebrew", {
    day: "numeric", month: "long", year: "numeric",
    timeZone: "Asia/Jerusalem"
  });
  var parts = {};
  fmt.formatToParts(gDate).forEach(function(p) {
    if (p.type !== "literal") parts[p.type] = p.value;
  });
  parts.month = stripNikud(parts.month || "");
  return parts;
}

function hebrewMonthKey(gDate) {
  var p = getHebrewParts(gDate);
  return p.year + "/" + p.month;
}

function getFirstGregorianOfHebrewMonth(gDateInMonth) {
  var p = getHebrewParts(gDateInMonth);
  var day = parseInt(p.day, 10);
  var first = new Date(gDateInMonth);
  first.setDate(first.getDate() - (day - 1));
  var key = hebrewMonthKey(gDateInMonth);
  // Adjust for sunset boundary: push forward until we're in the right month
  while (hebrewMonthKey(first) !== key) {
    first.setDate(first.getDate() + 1);
  }
  return first;
}

function getDaysInHebrewMonth(gDateInMonth) {
  var key = hebrewMonthKey(gDateInMonth);
  var first = getFirstGregorianOfHebrewMonth(gDateInMonth);
  var days = [];
  var g = new Date(first);
  for (var i = 0; i < 31; i++) {
    if (hebrewMonthKey(g) !== key) break;
    days.push(new Date(g));
    g.setDate(g.getDate() + 1);
  }
  return days;
}

function pad(n) { return String(n).padStart(2, "0"); }
function toISO(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function todayISO() { return toISO(new Date()); }

function buildEventMap() {
  var map = {};
  function add(dateStr, ev) {
    if (!map[dateStr]) map[dateStr] = [];
    map[dateStr].push(ev);
  }
  Database.get("tasks").forEach(function(t) {
    if (t.dueDate) add(t.dueDate, { type: "task", text: t.title || "משימה", done: !!t.done });
  });
  Database.get("donors").forEach(function(donor) {
    if (!donor.reminders) return;
    donor.reminders.forEach(function(r) {
      if (!r.date) return;
      var label = (donor.fullName || "") + ((r.description || r.text) ? ": " + (r.description || r.text) : "");
      add(r.date, { type: "reminder", text: label, done: !!r.done });
    });
  });
  return map;
}

var refDate = new Date();

function renderCalendar() {
  var grid  = document.getElementById("calendarGrid");
  var title = document.getElementById("monthTitle");
  if (!grid || !title) return;

  var days = getDaysInHebrewMonth(refDate);
  if (!days.length) return;

  var fp = getHebrewParts(days[0]);
  var hebYear = numToHeb(Number(fp.year) % 1000);
  title.textContent = fp.month + " " + hebYear;

  var eventMap = buildEventMap();
  var today = todayISO();

  // Build grid cells: leading empties + day cells + trailing empties
  var firstDOW = days[0].getDay(); // 0=Sun, 6=Sat
  var cells = [];
  for (var i = 0; i < firstDOW; i++) cells.push(null);
  days.forEach(function(gDate) {
    var p = getHebrewParts(gDate);
    cells.push({
      label: numToHeb(parseInt(p.day, 10)),
      iso: toISO(gDate),
      isToday: toISO(gDate) === today
    });
  });
  while (cells.length % 7 !== 0) cells.push(null);

  grid.innerHTML = cells.map(function(cell) {
    if (!cell) return '<div class="calendar-day other-month"></div>';
    var cls = "calendar-day" + (cell.isToday ? " today" : "");
    var evs = eventMap[cell.iso] || [];
    var evHtml = evs.slice(0, 4).map(function(ev) {
      var eCls = "calendar-event " + ev.type + (ev.done ? " done" : "");
      var icon = ev.type === "task" ? "📋 " : "🔔 ";
      return '<span class="' + eCls + '" title="' + ev.text.replace(/"/g,"&quot;") + '">' +
        icon + escapeHTML(ev.text) + '</span>';
    }).join("");
    if (evs.length > 4) {
      evHtml += '<span class="calendar-event" style="background:transparent;color:var(--muted)">+' + (evs.length - 4) + ' עוד</span>';
    }
    return '<div class="' + cls + '">' +
      '<div class="calendar-day-num">' + cell.label + '</div>' +
      evHtml +
    '</div>';
  }).join("");
}

document.getElementById("prevMonth").addEventListener("click", function() {
  var days = getDaysInHebrewMonth(refDate);
  if (days.length) {
    var prev = new Date(days[0]);
    prev.setDate(prev.getDate() - 1);
    refDate = prev;
    renderCalendar();
  }
});

document.getElementById("nextMonth").addEventListener("click", function() {
  var days = getDaysInHebrewMonth(refDate);
  if (days.length) {
    var next = new Date(days[days.length - 1]);
    next.setDate(next.getDate() + 1);
    refDate = next;
    renderCalendar();
  }
});

renderCalendar();

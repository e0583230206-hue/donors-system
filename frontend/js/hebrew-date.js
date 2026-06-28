// Hebrew calendar utilities backed by local @hebcal/core bundle when available.
(function (global) {
  function toDate(date) {
    return date ? new Date(date) : new Date();
  }

  function stripNikud(text) {
    return String(text || "").replace(/[\u0591-\u05C7]/g, "");
  }

  function getHebcal() {
    return global.hebcal || null;
  }

  function getHebrewParts(date) {
    const formatter = new Intl.DateTimeFormat("he-IL-u-ca-hebrew", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "Asia/Jerusalem",
    });

    return formatter.formatToParts(date).reduce(function (values, part) {
      if (part.type !== "literal") {
        values[part.type] = part.value;
      }
      return values;
    }, {});
  }

  function addHebrewQuote(text) {
    if (text.length === 1) return text + "'";
    return text.slice(0, -1) + '"' + text.slice(-1);
  }

  function numberToHebrewNumber(number) {
    const ones = ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט"];
    const tens = ["", "י", "כ", "ל", "מ", "נ", "ס", "ע", "פ", "צ"];
    const hundreds = ["", "ק", "ר", "ש", "ת"];

    if (number === 15) return 'ט"ו';
    if (number === 16) return 'ט"ז';

    let value = number;
    let text = "";

    while (value >= 400) {
      text += "ת";
      value -= 400;
    }

    text += hundreds[Math.floor(value / 100)] || "";
    value %= 100;
    text += tens[Math.floor(value / 10)] || "";
    value %= 10;
    text += ones[value] || "";

    return addHebrewQuote(text);
  }

  function formatHebrewYear(year) {
    return numberToHebrewNumber(Number(year) % 1000);
  }

  function getHebrewDateText(date) {
    const d = toDate(date);
    const hebcal = getHebcal();

    if (hebcal && hebcal.HDate) {
      return stripNikud(new hebcal.HDate(d).renderGematriya("he-x-NoNikud"));
    }

    const parts = getHebrewParts(d);

    if (!parts.day || !parts.month || !parts.year) {
      return d.toLocaleDateString("he-IL-u-ca-hebrew", {
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: "Asia/Jerusalem",
      });
    }

    return (
      numberToHebrewNumber(Number(parts.day)) +
      " " +
      parts.month +
      " " +
      formatHebrewYear(parts.year)
    );
  }

  function getHebrewWeekday(date) {
    const d = toDate(date);
    const weekday = d.toLocaleDateString("he-IL", {
      weekday: "long",
      timeZone: "Asia/Jerusalem",
    });

    const shortWeekdays = {
      "יום ראשון": "יום א'",
      "יום שני": "יום ב'",
      "יום שלישי": "יום ג'",
      "יום רביעי": "יום ד'",
      "יום חמישי": "יום ה'",
      "יום שישי": "יום ו'",
      "יום שבת": "שבת",
    };

    return shortWeekdays[weekday] || weekday;
  }

  function getLocalDateParts(date) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Jerusalem",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);

    const values = {};
    parts.forEach(function (part) {
      values[part.type] = part.value;
    });

    return {
      year: Number(values.year),
      month: Number(values.month),
      day: Number(values.day),
    };
  }

  function getLocalDateKey(date) {
    const values = getLocalDateParts(date);
    return (
      values.year +
      "-" +
      String(values.month).padStart(2, "0") +
      "-" +
      String(values.day).padStart(2, "0")
    );
  }

  function getLocalWeekdayIndex(date) {
    const weekday = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      timeZone: "Asia/Jerusalem",
    }).format(date);

    return {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    }[weekday];
  }

  function getLocalNoonDate(date) {
    const parts = getLocalDateParts(date);
    return new Date(parts.year, parts.month - 1, parts.day, 12, 0, 0);
  }

  function getUpcomingShabbat(date) {
    const d = getLocalNoonDate(toDate(date));
    const weekdayIndex = getLocalWeekdayIndex(d);
    const daysUntilShabbat = (6 - weekdayIndex + 7) % 7;
    const shabbat = new Date(d);
    shabbat.setDate(d.getDate() + daysUntilShabbat);
    return shabbat;
  }

  function cleanReadingLabel(text) {
    return stripNikud(text)
      .replace(/^פרשת\s+/, "פר' ")
      .replace(/^פרשה\s+/, "פר' ")
      .trim();
  }

  function getReadingInfo(date) {
    const hebcal = getHebcal();
    if (!hebcal || !hebcal.HDate || !hebcal.getSedra || !hebcal.ParshaEvent) {
      return {
        parsha: "",
        label: "",
        shabbatDate: getLocalDateKey(getUpcomingShabbat(date)),
      };
    }

    const shabbat = getUpcomingShabbat(date);
    const hdate = new hebcal.HDate(shabbat);
    const sedra = hebcal.getSedra(hdate.getFullYear(), true).lookup(hdate);

    if (!sedra) {
      return {
        parsha: "",
        label: "",
        shabbatDate: getLocalDateKey(shabbat),
      };
    }

    if (sedra.chag && hebcal.getHolidaysOnDate) {
      const holidays = hebcal.getHolidaysOnDate(hdate, true) || [];
      const holiday = holidays[0];
      const holidayLabel = holiday ? stripNikud(holiday.render("he-x-NoNikud")) : "";

      return {
        parsha: holidayLabel,
        label: holidayLabel,
        shabbatDate: getLocalDateKey(shabbat),
      };
    }

    const event = new hebcal.ParshaEvent(sedra);
    const label = cleanReadingLabel(event.render("he-x-NoNikud"));

    return {
      parsha: label.replace(/^פר'\s+/, ""),
      label: label,
      shabbatDate: getLocalDateKey(shabbat),
    };
  }

  function getParsha(date) {
    return getReadingInfo(date).parsha;
  }

  function getLocalDateTime(date) {
    const d = toDate(date);
    return d.toLocaleString("he-IL", {
      dateStyle: "full",
      timeStyle: "medium",
      timeZone: "Asia/Jerusalem",
    });
  }

  function getFullHebrewDateInfo(date) {
    const d = toDate(date);
    const hebrewDate = getHebrewDateText(d);
    const weekday = getHebrewWeekday(d);
    const reading = getReadingInfo(d);

    return {
      hebrewDate: hebrewDate,
      weekday: weekday,
      parsha: reading.parsha,
      shabbatDate: reading.shabbatDate,
      dateLine:
        hebrewDate + " " + weekday + (reading.label ? " " + reading.label : ""),
    };
  }

  global.HebrewDate = {
    getHebrewDateText: getHebrewDateText,
    getHebrewWeekday: getHebrewWeekday,
    getParsha: getParsha,
    getLocalDateTime: getLocalDateTime,
    getFullHebrewDateInfo: getFullHebrewDateInfo,
  };
})(window);

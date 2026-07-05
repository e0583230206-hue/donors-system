// ai.service.js — AI assistant engine (local + optional OpenAI adapter)
// All operations are read-only; no data is modified.

const { getAppState } = require("./db");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(d) {
  if (!d) return "לא ידוע";
  var dt = new Date(d);
  if (isNaN(dt)) return String(d);
  return dt.toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function daysSince(d) {
  if (!d) return Infinity;
  var dt = new Date(d);
  if (isNaN(dt)) return Infinity;
  return Math.floor((Date.now() - dt.getTime()) / (1000 * 60 * 60 * 24));
}

function getDonorTotalDebt(donor) {
  return (donor.donations || []).reduce(function (s, d) { return s + Number(d.remainingDebt || 0); }, 0);
}

function getDonorTotalPaid(donor) {
  return (donor.donations || []).reduce(function (s, d) {
    return s + (d.paid ? Number(d.amount || 0) - Number(d.remainingDebt || 0) : 0);
  }, 0);
}

function getDonorDebts(donor) {
  return (donor.donations || []).filter(function (d) { return Number(d.remainingDebt || 0) > 0; });
}

function getLastDonationDate(donor) {
  var dates = (donor.donations || []).map(function (d) { return d.date; }).filter(Boolean).sort();
  return dates[dates.length - 1] || null;
}

function fmt(n) {
  return "₪" + Number(n || 0).toLocaleString("he-IL");
}

// ─── Intent detection ─────────────────────────────────────────────────────────

var INTENTS = [
  { name: "donor_summary",    patterns: ["מצב", "סיכום", "מה קורה", "ספר לי", "מה עם", "פרטים"] },
  { name: "last_donation",    patterns: ["תרם לאחרונה", "תרומה אחרונה", "מתי תרם", "מתי הוא תרם", "תרומה אחרון"] },
  { name: "open_debts",       patterns: ["חוב", "חובות", "כמה חייב", "כמה חובות", "חייב"] },
  { name: "payment_history",  patterns: ["תשלום", "שילם", "היסטוריית תשלום", "מה שילם"] },
  { name: "tasks_reminders",  patterns: ["משימ", "תזכורת", "פתוח", "תזכיר", "מה לעשות"] },
  { name: "timeline_summary", patterns: ["ציר זמן", "פעילות", "היסטוריה"] },
  { name: "dormant_donors",   patterns: ["לא תרם", "לא פעיל", "חצי שנה", "שנה", "לא תרמו", "ישן", "רדום"] },
  { name: "priority_debts",   patterns: ["עדיפות", "דחוף", "הכי חוב", "הגדולים", "הכי גדול", "כל החובות"] },
  { name: "top_donors",       patterns: ["הכי הרבה", "תרם יותר", "מוביל", "גדולים", "הטובים"] },
];

function detectIntent(question) {
  var q = String(question || "").toLowerCase();
  var best = null, bestScore = 0;
  INTENTS.forEach(function (intent) {
    var score = intent.patterns.filter(function (p) { return q.includes(p); }).length;
    if (score > bestScore) { bestScore = score; best = intent.name; }
  });
  return best || "general";
}

// ─── Donor-specific handlers ──────────────────────────────────────────────────

function handleDonorSummary(donor, tasks) {
  var totalDebt = getDonorTotalDebt(donor);
  var totalPaid = getDonorTotalPaid(donor);
  var lastDon   = getLastDonationDate(donor);
  var openTasks = tasks.filter(function (t) {
    return !t.done &&
      (String(t.donorId) === String(donor.id) || String(t.relatedDonorId) === String(donor.id));
  });
  var openDebts = getDonorDebts(donor);

  var lines = [
    "**" + (donor.fullName || "תורם") + "**",
    "• עיר: " + (donor.city || "לא ידוע"),
    "• טלפון: " + (donor.phone || "לא ידוע"),
    "• מספר תרומות: " + (donor.donations || []).length,
    "• סה\"כ שולם: " + fmt(totalPaid),
    "• חוב פתוח: " + fmt(totalDebt),
    "• תרומה אחרונה: " + (lastDon
      ? formatDate(lastDon) + " (לפני " + daysSince(lastDon) + " ימים)"
      : "אין רשומה"),
    "• משימות פתוחות: " + openTasks.length,
    "• חובות פתוחים: " + openDebts.length,
  ];
  if (donor.status)   lines.push("• סטטוס: " + donor.status);
  if (donor.tags && donor.tags.length) lines.push("• תגיות: " + donor.tags.join(", "));
  if (totalDebt > 0)  lines.push("\n⚠️ יש חובות פתוחים שדורשים טיפול.");
  if (!lastDon)       lines.push("\nℹ️ התורם עדיין לא רשום כתרם בעבר.");
  return lines.join("\n");
}

function handleLastDonation(donor) {
  var sorted = (donor.donations || []).slice().sort(function (a, b) {
    return new Date(b.date || 0) - new Date(a.date || 0);
  });
  if (!sorted.length) return (donor.fullName || "התורם") + " — אין תרומות רשומות.";
  var last = sorted[0];
  var days = daysSince(last.date);
  return [
    "התרומה האחרונה של " + (donor.fullName || "התורם") + ":",
    "• תאריך: " + formatDate(last.date) + " (לפני " + days + " ימים)",
    "• סכום: " + fmt(last.amount),
    "• מטרה: " + (last.purpose || "לא צוין"),
    "• שולם: " + (last.paid ? "כן ✅" : "לא ❌"),
    last.remainingDebt > 0 ? "• יתרת חוב: " + fmt(last.remainingDebt) : null,
  ].filter(Boolean).join("\n");
}

function handleOpenDebts(donor) {
  var debts = getDonorDebts(donor);
  if (!debts.length) return (donor.fullName || "התורם") + " — אין חובות פתוחים. 🟢";
  var total = getDonorTotalDebt(donor);
  var sortedDebts = debts.slice().sort(function (a, b) { return new Date(a.date || 0) - new Date(b.date || 0); });
  var lines = [
    (donor.fullName || "התורם") + " — " + debts.length + " חובות פתוחים, סה\"כ " + fmt(total) + ":",
  ];
  sortedDebts.forEach(function (d, i) {
    lines.push(
      (i + 1) + ". " + formatDate(d.date) + " | " + (d.purpose || "ללא מטרה") +
      " | " + fmt(d.remainingDebt) + " (מתוך " + fmt(d.amount) + ")"
    );
  });
  return lines.join("\n");
}

function handlePaymentHistory(donor) {
  var paid = (donor.donations || []).filter(function (d) { return d.paid; });
  if (!paid.length) return (donor.fullName || "התורם") + " — אין תשלומים שולמו.";
  var sorted = paid.slice().sort(function (a, b) { return new Date(b.date || 0) - new Date(a.date || 0); });
  var total = paid.reduce(function (s, d) { return s + Number(d.amount || 0); }, 0);
  var lines = [
    (donor.fullName || "התורם") + " — " + paid.length + " תשלומים, סה\"כ " + fmt(total) + ":",
  ];
  sorted.slice(0, 12).forEach(function (d, i) {
    lines.push(
      (i + 1) + ". " + formatDate(d.date) + " | " + fmt(d.amount) +
      " | " + (d.purpose || "") + " | " + (d.paymentMethod || "")
    );
  });
  return lines.join("\n");
}

function handleTasksReminders(donor, tasks) {
  var donorTasks = tasks.filter(function (t) {
    return !t.done &&
      (String(t.donorId) === String(donor.id) || String(t.relatedDonorId) === String(donor.id));
  });
  if (!donorTasks.length) return (donor.fullName || "התורם") + " — אין משימות פתוחות. ✅";
  var lines = [(donor.fullName || "התורם") + " — " + donorTasks.length + " משימות פתוחות:"];
  donorTasks.slice(0, 12).forEach(function (t, i) {
    var due = t.dueDate ? " (עד " + formatDate(t.dueDate) + ")" : "";
    lines.push((i + 1) + ". " + (t.title || t.text || "משימה") + due);
  });
  return lines.join("\n");
}

function handleTimelineSummary(donor) {
  var items = [];
  (donor.donations || []).forEach(function (d) {
    items.push({
      date: d.date,
      text: (d.paid ? "תשלום ✅" : "חוב ❌") +
        " — " + fmt(d.amount) + (d.purpose ? " (" + d.purpose + ")" : ""),
    });
  });
  items.sort(function (a, b) { return new Date(b.date || 0) - new Date(a.date || 0); });
  if (!items.length) return (donor.fullName || "התורם") + " — אין פעילות רשומה.";
  var lines = [(donor.fullName || "התורם") + " — ציר זמן (מהאחרון לראשון):"];
  items.slice(0, 15).forEach(function (it) {
    lines.push("• " + formatDate(it.date) + " — " + it.text);
  });
  return lines.join("\n");
}

// ─── Global handlers ──────────────────────────────────────────────────────────

function handleDormantDonors(donors, question) {
  var months = 6;
  if (/שנה/.test(question))           months = 12;
  else if (/שלושה חודשים/.test(question)) months = 3;
  var thresholdDays = months * 30;

  var dormant = donors.filter(function (d) {
    var last = getLastDonationDate(d);
    return !last || daysSince(last) >= thresholdDays;
  }).sort(function (a, b) {
    var la = getLastDonationDate(a), lb = getLastDonationDate(b);
    return (la ? new Date(la) : 0) - (lb ? new Date(lb) : 0);
  });

  if (!dormant.length) return "לא נמצאו תורמים שלא תרמו ב-" + months + " חודשים האחרונים. ✅";
  var lines = ["נמצאו " + dormant.length + " תורמים שלא תרמו ב-" + months + " חודשים האחרונים:"];
  dormant.slice(0, 20).forEach(function (d, i) {
    var last = getLastDonationDate(d);
    var debt = getDonorTotalDebt(d);
    lines.push(
      (i + 1) + ". " + (d.fullName || "ללא שם") +
      " | אחרונה: " + (last ? formatDate(last) : "אף פעם") +
      (debt > 0 ? " | חוב: " + fmt(debt) : "")
    );
  });
  if (dormant.length > 20) lines.push("... ועוד " + (dormant.length - 20) + " תורמים.");
  return lines.join("\n");
}

function handlePriorityDebts(donors) {
  var withDebts = donors
    .filter(function (d) { return getDonorTotalDebt(d) > 0; })
    .map(function (d) { return { donor: d, debt: getDonorTotalDebt(d) }; })
    .sort(function (a, b) { return b.debt - a.debt; });

  if (!withDebts.length) return "לא נמצאו חובות פתוחים במערכת. 🟢";

  var grandTotal = withDebts.reduce(function (s, x) { return s + x.debt; }, 0);
  var lines = [
    "חובות פתוחים לפי עדיפות — סה\"כ " + fmt(grandTotal) + " (" + withDebts.length + " תורמים):",
  ];
  withDebts.slice(0, 20).forEach(function (item, i) {
    var d = item.donor;
    lines.push(
      (i + 1) + ". " + (d.fullName || "ללא שם") +
      " — " + fmt(item.debt) +
      (d.city ? " | " + d.city : "") +
      (d.phone ? " | " + d.phone : "")
    );
  });
  if (withDebts.length > 20) lines.push("... ועוד " + (withDebts.length - 20) + " תורמים.");
  return lines.join("\n");
}

function handleTopDonors(donors) {
  var ranked = donors
    .map(function (d) { return { donor: d, total: getDonorTotalPaid(d) }; })
    .filter(function (x) { return x.total > 0; })
    .sort(function (a, b) { return b.total - a.total; });

  if (!ranked.length) return "אין נתוני תשלומים במערכת.";
  var lines = ["10 התורמים הגדולים ביותר:"];
  ranked.slice(0, 10).forEach(function (item, i) {
    var d = item.donor;
    var donations = (d.donations || []).length;
    lines.push(
      (i + 1) + ". " + (d.fullName || "ללא שם") +
      " — " + fmt(item.total) +
      " (" + donations + " תרומות)"
    );
  });
  return lines.join("\n");
}

function handleGeneral(donor) {
  if (donor) {
    return (
      "שאלה על " + (donor.fullName || "תורם") + ".\n" +
      "לא הצלחתי לזהות בדיוק מה שאלת. נסה לשאול על:\n" +
      "• \"מה מצב התורם?\"\n" +
      "• \"מתי הוא תרם לאחרונה?\"\n" +
      "• \"כמה חובות פתוחים יש לו?\"\n" +
      "• \"מה המשימות הפתוחות?\"\n" +
      "• \"ציר זמן הפעילות\""
    );
  }
  return (
    "לא הצלחתי לזהות את השאלה. נסה לשאול על:\n" +
    "• \"מי לא תרם בחצי השנה האחרונה?\"\n" +
    "• \"חובות פתוחים לפי עדיפות\"\n" +
    "• \"התורמים הגדולים ביותר\""
  );
}

// ─── Local engine ─────────────────────────────────────────────────────────────

function localEngine(donorId, question) {
  var allDonors = getAppState("donors") || [];
  var tasks     = getAppState("tasks")  || [];
  var intent    = detectIntent(question);

  var donor = null;
  if (donorId) {
    var id = Number(donorId);
    for (var i = 0; i < allDonors.length; i++) {
      if (allDonors[i].id === id) { donor = allDonors[i]; break; }
    }
  }

  if (donor) {
    if (intent === "donor_summary")    return { intent, answer: handleDonorSummary(donor, tasks) };
    if (intent === "last_donation")    return { intent, answer: handleLastDonation(donor) };
    if (intent === "open_debts")       return { intent, answer: handleOpenDebts(donor) };
    if (intent === "tasks_reminders")  return { intent, answer: handleTasksReminders(donor, tasks) };
    if (intent === "payment_history")  return { intent, answer: handlePaymentHistory(donor) };
    if (intent === "timeline_summary") return { intent, answer: handleTimelineSummary(donor) };
  }

  // Global intents
  if (intent === "dormant_donors")  return { intent, answer: handleDormantDonors(allDonors, question) };
  if (intent === "priority_debts")  return { intent, answer: handlePriorityDebts(allDonors) };
  if (intent === "top_donors")      return { intent, answer: handleTopDonors(allDonors) };

  return { intent: "general", answer: handleGeneral(donor) };
}

// ─── OpenAI adapter ───────────────────────────────────────────────────────────

async function openAIEngine(donorId, question) {
  var apiKey   = process.env.OPENAI_API_KEY;
  var model    = process.env.OPENAI_MODEL || "gpt-4o-mini";
  var allDonors = getAppState("donors") || [];
  var tasks     = getAppState("tasks")  || [];

  var donor = null;
  if (donorId) {
    var id = Number(donorId);
    for (var i = 0; i < allDonors.length; i++) {
      if (allDonors[i].id === id) { donor = allDonors[i]; break; }
    }
  }

  var contextObj;
  if (donor) {
    contextObj = {
      fullName:     donor.fullName,
      phone:        donor.phone,
      city:         donor.city,
      status:       donor.status,
      tags:         donor.tags || [],
      totalDebt:    getDonorTotalDebt(donor),
      totalPaid:    getDonorTotalPaid(donor),
      lastDonation: getLastDonationDate(donor),
      daysSinceLastDonation: daysSince(getLastDonationDate(donor)),
      donations:    (donor.donations || []).slice(-20),
      openTasks:    tasks.filter(function (t) {
        return !t.done && (String(t.donorId) === String(donor.id));
      }).slice(0, 10),
    };
  } else {
    contextObj = {
      totalDonors:  allDonors.length,
      totalDebt:    allDonors.reduce(function (s, d) { return s + getDonorTotalDebt(d); }, 0),
      totalPaid:    allDonors.reduce(function (s, d) { return s + getDonorTotalPaid(d); }, 0),
      dormant6mo:   allDonors.filter(function (d) { return daysSince(getLastDonationDate(d)) >= 180; }).length,
    };
  }

  var systemPrompt =
    "אתה עוזר AI לארגון צדקה יהודי. תפקידך לתת תובנות על נתוני התורמים. " +
    "ענה תמיד בעברית. אינך מבצע שינויים בנתונים (Read Only בלבד). " +
    "היה ממוקד ותמציתי. סכומים בשקלים (₪).\n\n" +
    "נתוני הקשר:\n" + JSON.stringify(contextObj, null, 2);

  var resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": "Bearer " + apiKey,
    },
    body: JSON.stringify({
      model:      model,
      max_tokens: 700,
      temperature: 0.3,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: question },
      ],
    }),
    signal: AbortSignal.timeout(25000),
  });

  if (!resp.ok) {
    var errBody = await resp.json().catch(function () { return {}; });
    throw new Error("OpenAI error: " + (errBody.error && errBody.error.message || resp.status));
  }

  var data   = await resp.json();
  var answer = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return { intent: "openai", answer: answer || "לא התקבלה תשובה מ-OpenAI.", model };
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function queryAI(donorId, question) {
  var openAIKey = (process.env.OPENAI_API_KEY || "").trim();
  if (openAIKey) {
    try {
      return await openAIEngine(donorId, question);
    } catch (err) {
      console.error("[AI] OpenAI failed, falling back to local engine:", err.message);
      var result = localEngine(donorId, question);
      result.fallback = true;
      result.fallbackReason = err.message;
      return result;
    }
  }
  return localEngine(donorId, question);
}

module.exports = { queryAI, detectIntent };

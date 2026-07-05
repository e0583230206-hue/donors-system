"use strict";
// handlers/donor.js — 18 donor-specific intent handlers (v3)
// All handlers return a ResponseObject: {summary,metrics,sections,conclusion,recommendation,suggestions}

function num(v) { return Number(v || 0); }

// ─── Debt priority tier ────────────────────────────────────────────────────────
function debtUrgency(donation, daysSince) {
  const amount    = num(donation.remainingDebt);
  const ageMonths = daysSince(donation.date) / 30;
  if (amount >= 1000 && ageMonths >= 6) return "דחוף";
  if (amount >= 500  || ageMonths >= 3) return "בינוני";
  return "נמוך";
}

// ─── donor_summary ────────────────────────────────────────────────────────────
function donorSummary(ctx) {
  const { donor, stats, openDebts, openTasks, fmtMoney, fmtDate, globalAvgPaid } = ctx;
  const name = donor.fullName || "תורם זה";

  let riskNote = "";
  if (stats.daysSinceLastDonation > 365) riskNote = "⚠️ לא תרם מעל שנה — בסיכון לאבד.";
  else if (stats.daysSinceLastDonation > 180) riskNote = "⚠️ לא תרם כחצי שנה — כדאי לפנות.";

  const hasDebt  = stats.totalDebt > 0;
  const hasTasks = openTasks.length > 0;
  const vsAvg    = stats.totalPaid > globalAvgPaid ? "מעל הממוצע" : stats.totalPaid < globalAvgPaid * 0.5 ? "מתחת לממוצע" : "בממוצע";

  return {
    summary: `${name} — ${stats.totalDonations} תרומות, שילם ${fmtMoney(stats.totalPaid)}${hasDebt ? ", חוב פתוח: " + fmtMoney(stats.totalDebt) : ""}`,
    metrics: [
      { label: "שולם סה\"כ",   value: fmtMoney(stats.totalPaid) },
      { label: "חוב פתוח",     value: fmtMoney(stats.totalDebt) },
      { label: "תרומות",        value: String(stats.totalDonations) },
      { label: "תרומה אחרונה",  value: stats.lastDonationFmt },
    ],
    sections: [
      {
        title: "פרטים",
        items: [
          "עיר: " + (donor.city || "לא ידוע") + (donor.phone ? " | טלפון: " + donor.phone : ""),
          "רמה ביחס לאחרים: " + vsAvg + " (ממוצע: " + fmtMoney(globalAvgPaid) + ")",
          hasTasks ? "משימות פתוחות: " + openTasks.length : "אין משימות פתוחות",
          riskNote || (stats.daysSinceLastDonation < 90 ? "✅ תורם פעיל לאחרונה" : ""),
        ].filter(Boolean),
      },
    ],
    conclusion: hasDebt
      ? "יש לטפל בחוב פתוח של " + fmtMoney(stats.totalDebt) + " — " + openDebts.length + " חובות."
      : "לא קיים חוב פתוח.",
    recommendation: hasDebt
      ? "להתקשר ל-" + (donor.phone || "תורם") + " ולסגור את החוב הפתוח."
      : stats.daysSinceLastDonation > 180
      ? "לפנות ל-" + (donor.fullName || "תורם") + " לחידוש הקשר — " + Math.floor(stats.daysSinceLastDonation / 30) + " חודשים ללא קשר."
      : "לעקוב ולוודא שהכל בסדר.",
    suggestions: [
      hasDebt ? "פרט חובות פתוחים" : "היסטוריית תשלומים",
      "תרומה אחרונה",
      "מה ההמלצה לגביו?",
    ],
  };
}

// ─── donor_last_donation ──────────────────────────────────────────────────────
function donorLastDonation(ctx) {
  const { donor, stats, allDonations, fmtDate, fmtMoney } = ctx;
  if (!allDonations.length) {
    return {
      summary: "אין תרומות רשומות עבור " + (donor.fullName || "תורם זה") + ".",
      metrics: [], sections: [],
      conclusion: "לא נמצאו נתוני תרומה במערכת.",
      recommendation: "לוודא שהנתונים הוזנו נכון.",
      suggestions: ["מצב כללי", "משימות פתוחות"],
    };
  }
  const last   = allDonations[0];
  const prev   = allDonations[1];
  const months = Math.floor(stats.daysSinceLastDonation / 30);

  return {
    summary: "תרומה אחרונה: " + fmtDate(last.date) + " — " + fmtMoney(last.amount),
    metrics: [
      { label: "תאריך",  value: fmtDate(last.date) },
      { label: "סכום",   value: fmtMoney(last.amount) },
      { label: "לפני",   value: months < 1 ? "פחות מחודש" : months + " חודשים" },
      { label: "שולם",   value: last.paid ? "כן" : "לא" },
    ],
    sections: [
      {
        title: "פרטים",
        items: [
          "מטרה: " + (last.purpose || "לא צוין"),
          "אמצעי תשלום: " + (last.paymentMethod || "לא צוין"),
          num(last.remainingDebt) > 0 ? "חוב נותר: " + fmtMoney(last.remainingDebt) : "שולם במלואו",
          prev ? "תרומה לפניה: " + fmtDate(prev.date) + " — " + fmtMoney(prev.amount) : "",
        ].filter(Boolean),
      },
    ],
    conclusion: months > 12
      ? "עבר יותר משנה — תורם זה לא פעיל."
      : months > 6
      ? "עברו " + months + " חודשים — כדאי ליצור קשר."
      : "תורם פעיל. תרם לפני " + (months < 1 ? "פחות מחודש" : months + " חודשים") + ".",
    recommendation: months > 6
      ? "לפנות ל-" + (donor.fullName || "תורם") + " ולחדש קשר."
      : "לאשר שהתשלום הצפוי בדרך.",
    suggestions: ["היסטוריית תשלומים", "מצב כללי", months > 3 ? "סיכון נטישה" : "כמה פעמים תרם?"],
  };
}

// ─── donor_debt_list ──────────────────────────────────────────────────────────
function donorDebtList(ctx) {
  const { donor, openDebts, fmtDate, fmtMoney, daysSince } = ctx;
  if (!openDebts.length) {
    return {
      summary: (donor.fullName || "תורם זה") + " — אין חובות פתוחים. ✅",
      metrics: [], sections: [],
      conclusion: "כל התרומות שולמו במלואן.",
      recommendation: "לא נדרשת פעולה בנושא חובות.",
      suggestions: ["היסטוריית תשלומים", "מצב כללי"],
    };
  }

  const groups = { "דחוף": [], "בינוני": [], "נמוך": [] };
  openDebts.forEach(function (d) {
    const tier = debtUrgency(d, daysSince);
    groups[tier].push(d);
  });
  const totalDebt = openDebts.reduce(function (s, d) { return s + num(d.remainingDebt); }, 0);

  const sections = [];
  ["דחוף", "בינוני", "נמוך"].forEach(function (tier) {
    if (!groups[tier].length) return;
    const icons = { "דחוף": "🔴", "בינוני": "🟡", "נמוך": "🟢" };
    sections.push({
      title:  icons[tier] + " " + tier + " (" + groups[tier].length + ")",
      urgent: tier === "דחוף",
      items:  groups[tier].map(function (d) {
        const age = Math.floor(daysSince(d.date) / 30);
        return fmtDate(d.date) + " — " + fmtMoney(d.remainingDebt) + " | " + age + " חודשים | מטרה: " + (d.purpose || "לא צוין");
      }),
    });
  });

  const mostUrgent = groups["דחוף"][0] || groups["בינוני"][0];

  return {
    summary: openDebts.length + " חובות פתוחים — סה\"כ " + fmtMoney(totalDebt),
    metrics: [
      { label: "חוב כולל",  value: fmtMoney(totalDebt) },
      { label: "דחוף",      value: String(groups["דחוף"].length) },
      { label: "בינוני",    value: String(groups["בינוני"].length) },
      { label: "נמוך",      value: String(groups["נמוך"].length) },
    ],
    sections: sections,
    conclusion: groups["דחוף"].length
      ? groups["דחוף"].length + " חובות בעדיפות דחופה — דורשים טיפול מיידי."
      : "אין חובות דחופים, אך יש " + openDebts.length + " חובות לטיפול.",
    recommendation: mostUrgent
      ? "להתקשר ולסגור את החוב מ-" + fmtDate(mostUrgent.date) + " (" + fmtMoney(mostUrgent.remainingDebt) + ")."
      : "לתאם עם התורם סגירת חובות.",
    suggestions: ["כמה חוב יש לו?", "היסטוריית תשלומים", "מה ההמלצה?"],
  };
}

// ─── donor_debt_total ─────────────────────────────────────────────────────────
function donorDebtTotal(ctx) {
  const { donor, stats, openDebts, fmtMoney, fmtDate, daysSince } = ctx;
  if (stats.totalDebt === 0) {
    return {
      summary: (donor.fullName || "תורם זה") + " — אין חוב פתוח. ✅",
      metrics: [], sections: [],
      conclusion: "כל החובות שולמו.",
      recommendation: "לא נדרשת פעולה.",
      suggestions: ["מצב כללי"],
    };
  }

  const oldest    = openDebts[openDebts.length - 1];
  const oldestAge = oldest ? Math.floor(daysSince(oldest.date) / 30) : 0;
  const paidRatio = stats.totalPaid + stats.totalDebt > 0
    ? ((stats.totalPaid / (stats.totalPaid + stats.totalDebt)) * 100).toFixed(0)
    : 0;

  return {
    summary: "חוב פתוח: " + fmtMoney(stats.totalDebt) + " ב-" + openDebts.length + " תרומות",
    metrics: [
      { label: "חוב כולל",   value: fmtMoney(stats.totalDebt) },
      { label: "מספר חובות", value: String(openDebts.length) },
      { label: "שולם",        value: fmtMoney(stats.totalPaid) },
      { label: "יחס פירעון",  value: paidRatio + "%" },
    ],
    sections: [
      {
        title: "ניתוח",
        items: [
          "החוב הישן ביותר: " + fmtDate(oldest ? oldest.date : null) + " (" + oldestAge + " חודשים)",
          "סה\"כ שולם בעבר: " + fmtMoney(stats.totalPaid),
        ],
      },
    ],
    conclusion: oldestAge > 12
      ? "חוב ישן מעל שנה — סיכון לאי-גביה גבוה."
      : "חוב בינוני — ניתן לגביה עם פנייה מתאימה.",
    recommendation: "להתקשר ולסדר תשלום של " + fmtMoney(stats.totalDebt) + (donor.phone ? " (" + donor.phone + ")" : "") + ".",
    suggestions: ["פרט חובות פתוחים", "היסטוריית תשלומים", "מה ההמלצה?"],
  };
}

// ─── donor_payment_history ────────────────────────────────────────────────────
function donorPaymentHistory(ctx) {
  const { donor, allDonations, stats, fmtDate, fmtMoney } = ctx;
  const paid = allDonations.filter(function (d) { return d.paid; });
  if (!paid.length) {
    return {
      summary: (donor.fullName || "תורם זה") + " לא שילם אף תשלום רשום.",
      metrics: [], sections: [],
      conclusion: stats.totalDonations > 0 ? "תרומות נרשמו אך לא שולמו." : "אין נתוני תרומה.",
      recommendation: "לוודא הזנת נתונים תקינה.",
      suggestions: ["מצב כללי", "חובות פתוחים"],
    };
  }

  const recent = paid.slice(0, 5);
  const avg    = paid.length ? Math.round(stats.totalPaid / paid.length) : 0;

  return {
    summary: paid.length + " תשלומים — סה\"כ " + fmtMoney(stats.totalPaid) + ", ממוצע " + fmtMoney(avg),
    metrics: [
      { label: "סה\"כ שולם",   value: fmtMoney(stats.totalPaid) },
      { label: "תשלומים",       value: String(paid.length) },
      { label: "ממוצע",          value: fmtMoney(avg) },
      { label: "מקסימום",        value: fmtMoney(stats.maxAmount) },
    ],
    sections: [
      {
        title: "5 תשלומים אחרונים",
        items: recent.map(function (d) {
          return fmtDate(d.date) + " — " + fmtMoney(d.amount) + (d.paymentMethod ? " | " + d.paymentMethod : "");
        }),
      },
    ],
    conclusion: "תורם אמין — שילם " + paid.length + " פעמים, סה\"כ " + fmtMoney(stats.totalPaid) + ".",
    recommendation: paid.length >= 3
      ? "תורם מגיב — כדאי לפנות לתרומה נוספת."
      : "לעודד מתן תרומות נוספות.",
    suggestions: ["תרומה אחרונה", "מצב כללי", "כמה פעמים תרם?"],
  };
}

// ─── donor_donations_stats ────────────────────────────────────────────────────
function donorDonationsStats(ctx) {
  const { donor, stats, allDonations, fmtMoney, fmtDate, globalAvgPaid } = ctx;
  if (!allDonations.length) {
    return {
      summary: "אין נתוני תרומה עבור " + (donor.fullName || "תורם זה") + ".",
      metrics: [], sections: [],
      conclusion: "לא נמצא מידע.",
      recommendation: "לוודא שהנתונים הוזנו.",
      suggestions: ["מצב כללי"],
    };
  }

  const amounts = allDonations.map(function (d) { return num(d.amount); }).filter(Boolean);
  const minAmt  = amounts.length ? Math.min.apply(null, amounts) : 0;

  return {
    summary: allDonations.length + " תרומות — ממוצע " + fmtMoney(stats.avgAmount) + ", מקסימום " + fmtMoney(stats.maxAmount),
    metrics: [
      { label: "תרומות",   value: String(stats.totalDonations) },
      { label: "ממוצע",    value: fmtMoney(stats.avgAmount) },
      { label: "מקסימום",  value: fmtMoney(stats.maxAmount) },
      { label: "מינימום",  value: fmtMoney(minAmt) },
    ],
    sections: [
      {
        title: "ניתוח",
        items: [
          "שולם: " + fmtMoney(stats.totalPaid) + " | חוב: " + fmtMoney(stats.totalDebt),
          "ביחס לממוצע המערכת: " + (stats.totalPaid > globalAvgPaid ? "מעל (" + fmtMoney(globalAvgPaid) + ")" : "מתחת (" + fmtMoney(globalAvgPaid) + ")"),
          "תרומה ראשונה: " + fmtDate(allDonations[allDonations.length - 1].date),
        ],
      },
    ],
    conclusion: stats.avgAmount > globalAvgPaid
      ? "תורם גבוה מהממוצע — נכס חשוב למערכת."
      : "תורם פעיל בסכומים בינוניים.",
    recommendation: stats.totalDebt > 0
      ? "יש לסגור חוב פתוח של " + fmtMoney(stats.totalDebt) + "."
      : "לשמר קשר לתרומות עתידיות.",
    suggestions: ["היסטוריית תשלומים", "חובות פתוחים", "ביחס לאחרים"],
  };
}

// ─── donor_contact ────────────────────────────────────────────────────────────
function donorContact(ctx) {
  const { donor } = ctx;
  const hasPhone = !!donor.phone;

  return {
    summary: "פרטי קשר: " + (donor.fullName || "ללא שם"),
    metrics: [],
    sections: [
      {
        title: "פרטי קשר",
        items: [
          hasPhone
            ? "טלפון: " + donor.phone + (donor.phone2 ? " | נוסף: " + donor.phone2 : "")
            : "❌ אין מספר טלפון",
          donor.city    ? "עיר: " + donor.city : "",
          donor.address ? "כתובת: " + donor.address : "",
          donor.email   ? "מייל: " + donor.email : "",
        ].filter(Boolean),
      },
    ],
    conclusion: hasPhone ? "ניתן ליצור קשר." : "חסר מספר טלפון — קשה ליצור קשר.",
    recommendation: !hasPhone
      ? "לעדכן מספר טלפון בכרטיס התורם."
      : "להתקשר בשעות הנוחות.",
    suggestions: ["מצב כללי", "IVR סטטוס"],
  };
}

// ─── donor_notes ─────────────────────────────────────────────────────────────
function donorNotes(ctx) {
  const { donor } = ctx;
  const notes = donor.notes || donor.note || "";

  return {
    summary: notes
      ? "הערות עבור " + (donor.fullName || "תורם זה") + ":"
      : "אין הערות רשומות עבור " + (donor.fullName || "תורם זה") + ".",
    metrics: [],
    sections: notes
      ? [{ title: "הערות", items: notes.split("\n").filter(Boolean) }]
      : [],
    conclusion: notes ? "ישנן הערות שכדאי לקרוא לפני פנייה." : "אין הערות.",
    recommendation: !notes ? "לשקול הוספת הערות בכרטיס." : "לקחת בחשבון את ההערות בפנייה.",
    suggestions: ["פרטי קשר", "מצב כללי"],
  };
}

// ─── donor_tags ───────────────────────────────────────────────────────────────
function donorTags(ctx) {
  const { donor } = ctx;
  const tags = donor.tags || [];

  return {
    summary: tags.length
      ? "תגיות: " + tags.join(", ")
      : "לא הוגדרו תגיות עבור " + (donor.fullName || "תורם זה") + ".",
    metrics: [],
    sections: tags.length ? [{ title: "תגיות", items: tags }] : [],
    conclusion: tags.length ? "תורם משויך ל-" + tags.length + " תגיות." : "ללא תיוג.",
    recommendation: !tags.length ? "לשקול הוספת תגית (VIP / חדש / פוטנציאל)." : "לעדכן תגיות לפי מצב נוכחי.",
    suggestions: ["מצב כללי", "פרטים"],
  };
}

// ─── donor_tasks ──────────────────────────────────────────────────────────────
function donorTasks(ctx) {
  const { donor, openTasks, fmtDate } = ctx;
  if (!openTasks.length) {
    return {
      summary: "אין משימות פתוחות עבור " + (donor.fullName || "תורם זה") + ". ✅",
      metrics: [], sections: [],
      conclusion: "לא נדרשת פעולה.",
      recommendation: "לוודא שאין פעולות ממתינות.",
      suggestions: ["מצב כללי"],
    };
  }

  const overdue = openTasks.filter(function (t) { return t.dueDate && new Date(t.dueDate) < new Date(); });
  const soon    = openTasks.filter(function (t) {
    if (!t.dueDate) return false;
    const d = new Date(t.dueDate);
    return d >= new Date() && d < new Date(Date.now() + 7 * 86400000);
  });

  return {
    summary: openTasks.length + " משימות פתוחות" + (overdue.length ? " — " + overdue.length + " פגו תוקף!" : ""),
    metrics: [
      { label: "פתוחות",       value: String(openTasks.length) },
      { label: "פגי תוקף",     value: String(overdue.length) },
      { label: "צפויות בשבוע", value: String(soon.length) },
    ],
    sections: [
      {
        title: "משימות",
        urgent: overdue.length > 0,
        items: openTasks.map(function (t) {
          const flag = t.dueDate && new Date(t.dueDate) < new Date() ? " ⚠️ פגי תוקף" : "";
          return (t.title || t.text || "משימה") + " | " + (t.dueDate ? fmtDate(t.dueDate) : "ללא תאריך") + flag;
        }),
      },
    ],
    conclusion: overdue.length
      ? overdue.length + " משימות פגו תוקף — דורשות טיפול מיידי."
      : openTasks.length + " משימות פתוחות — יש לטפל.",
    recommendation: overdue.length
      ? "לטפל מיד במשימה: \"" + (overdue[0].title || overdue[0].text) + "\""
      : "לעבד את " + openTasks.length + " המשימות לפי סדר עדיפות.",
    suggestions: ["מצב כללי", "חובות פתוחים"],
  };
}

// ─── donor_ivr_status ─────────────────────────────────────────────────────────
function donorIvrStatus(ctx) {
  const { donor } = ctx;
  const approved = donor.ivrApprovedPhones || [];
  const excluded = donor.includeInCalls === false;

  return {
    summary: excluded
      ? (donor.fullName || "תורם זה") + " לא נכלל בקמפיין IVR."
      : approved.length
      ? (donor.fullName || "תורם זה") + " מוכן ל-IVR — " + approved.length + " מספר מאושר."
      : (donor.fullName || "תורם זה") + " — אין מספר מאושר ל-IVR.",
    metrics: [
      { label: "מספרים מאושרים", value: String(approved.length) },
      { label: "סטטוס",           value: excluded ? "מוחרג" : approved.length ? "מוכן" : "לא מוגדר" },
    ],
    sections: approved.length
      ? [{ title: "מספרים מאושרים", items: approved }]
      : [],
    conclusion: excluded
      ? "תורם זה הוחרג מהקמפיין."
      : approved.length
      ? "ניתן לשגר לתורם זה."
      : "לא ניתן לשגר — חסר מספר מאושר.",
    recommendation: !approved.length && !excluded
      ? "להוסיף מספר מאושר בכרטיס כדי לכלול בקמפיין."
      : excluded
      ? "לבדוק אם יש סיבה להחריג — שמא ניתן לשנות."
      : "ניתן לכלול ב-IVR.",
    suggestions: ["פרטי קשר", "מצב כללי"],
  };
}

// ─── donor_timeline ───────────────────────────────────────────────────────────
function donorTimeline(ctx) {
  const { donor, allDonations, openTasks, fmtDate, fmtMoney } = ctx;
  if (!allDonations.length && !openTasks.length) {
    return {
      summary: "אין פעילות רשומה עבור " + (donor.fullName || "תורם זה") + ".",
      metrics: [], sections: [],
      conclusion: "אין היסטוריה לתצוגה.",
      recommendation: "לוודא הזנת נתונים.",
      suggestions: ["מצב כללי"],
    };
  }

  const recentDons  = allDonations.slice(0, 8);
  const recentTasks = openTasks.slice(0, 5);

  return {
    summary: "ציר זמן: " + allDonations.length + " תרומות, " + openTasks.length + " משימות פתוחות",
    metrics: [
      { label: "תרומות",  value: String(allDonations.length) },
      { label: "אחרונה",   value: allDonations[0] ? fmtDate(allDonations[0].date) : "—" },
      { label: "משימות",   value: String(openTasks.length) },
    ],
    sections: [
      recentDons.length ? {
        title: "תרומות אחרונות",
        items: recentDons.map(function (d) {
          return fmtDate(d.date) + " — " + fmtMoney(d.amount) + (d.paid ? " ✅" : " ⏳") + (d.purpose ? " | " + d.purpose : "");
        }),
      } : null,
      recentTasks.length ? {
        title: "משימות פתוחות",
        items: recentTasks.map(function (t) {
          return (t.title || t.text || "משימה") + (t.dueDate ? " | " + fmtDate(t.dueDate) : "");
        }),
      } : null,
    ].filter(Boolean),
    conclusion: "פעילות קיימת — " + allDonations.length + " תרומות בסה\"כ.",
    recommendation: recentDons[0] && !recentDons[0].paid
      ? "התשלום האחרון עדיין פתוח — לטפל."
      : "להמשיך לעקוב.",
    suggestions: ["תרומה אחרונה", "משימות", "היסטוריית תשלומים"],
  };
}

// ─── donor_risk ───────────────────────────────────────────────────────────────
function donorRisk(ctx) {
  const { donor, stats, fmtMoney } = ctx;
  const risks = [];

  if (stats.daysSinceLastDonation > 365)                               risks.push("לא תרם מעל שנה");
  if (stats.totalDebt > 0 && stats.daysSinceLastDonation > 180)        risks.push("חוב ישן ולא היה קשר");
  if (stats.totalDonations === 1)                                        risks.push("תרם פעם אחת בלבד");
  if (stats.totalPaid === 0 && stats.totalDonations > 0)                risks.push("מעולם לא שילם");
  if (!donor.phone)                                                      risks.push("אין טלפון — קשה ליצור קשר");

  const level = risks.length >= 3 ? "גבוה" : risks.length >= 2 ? "בינוני" : risks.length >= 1 ? "נמוך" : "ללא";

  return {
    summary: "סיכון נטישה: " + level + (risks.length ? " — " + risks[0] : " ✅"),
    metrics: [
      { label: "רמת סיכון",  value: level },
      { label: "סיבות",       value: String(risks.length) },
      { label: "אחרונה",      value: stats.lastDonationFmt },
    ],
    sections: risks.length ? [{ title: "גורמי סיכון", urgent: level === "גבוה", items: risks }] : [],
    conclusion: risks.length
      ? risks.length + " גורמי סיכון — " + (level === "גבוה" ? "פנייה דחופה נדרשת" : "יש לעקוב") + "."
      : "תורם פעיל ללא סיכון מיוחד.",
    recommendation: risks.length >= 2
      ? "לפנות מיד ל-" + (donor.fullName || "תורם") + " ולחדש קשר לפני שיאבד."
      : risks.length === 1
      ? "לעקוב ולפנות בהזדמנות הקרובה."
      : "לשמר קשר שוטף.",
    suggestions: ["מצב כללי", "מה ההמלצה?", "פרטי קשר"],
  };
}

// ─── donor_recommendation ─────────────────────────────────────────────────────
function donorRecommendation(ctx) {
  const { donor, stats, openDebts, openTasks, fmtMoney, daysSince } = ctx;

  const actions = [];

  if (openDebts.length && stats.totalDebt > 0) {
    const urgent = openDebts.filter(function (d) { return daysSince(d.date) > 180; });
    if (urgent.length) {
      const sum = urgent.reduce(function (s, d) { return s + num(d.remainingDebt); }, 0);
      actions.push({ priority: 1, action: "להתקשר ולסגור " + urgent.length + " חובות ישנים (" + fmtMoney(sum) + ")", tag: "דחוף" });
    } else {
      actions.push({ priority: 2, action: "לסגור חוב פתוח של " + fmtMoney(stats.totalDebt), tag: "בינוני" });
    }
  }

  if (stats.daysSinceLastDonation > 365) {
    actions.push({ priority: 1, action: "לפנות לחידוש קשר — לא תרם מעל שנה", tag: "דחוף" });
  } else if (stats.daysSinceLastDonation > 180) {
    actions.push({ priority: 2, action: "לפנות לחידוש תרומה — לא תרם חצי שנה", tag: "בינוני" });
  }

  const overdueTask = openTasks.find(function (t) { return t.dueDate && new Date(t.dueDate) < new Date(); });
  if (overdueTask) {
    actions.push({ priority: 1, action: "לטפל במשימה: \"" + (overdueTask.title || overdueTask.text) + "\"", tag: "דחוף" });
  }

  if (!donor.phone) {
    actions.push({ priority: 3, action: "לאתר מספר טלפון עדכני", tag: "נמוך" });
  }

  if (!actions.length) {
    actions.push({ priority: 3, action: "לשמר קשר שוטף — אין פעולות דחופות", tag: "נמוך" });
  }

  actions.sort(function (a, b) { return a.priority - b.priority; });

  return {
    summary: "המלצות עבור " + (donor.fullName || "תורם זה") + " (" + actions.length + " פעולות)",
    metrics: [],
    sections: [
      {
        title: "פעולות לפי עדיפות",
        urgent: actions[0].tag === "דחוף",
        items: actions.map(function (a, i) {
          const icon = a.tag === "דחוף" ? "🔴" : a.tag === "בינוני" ? "🟡" : "🟢";
          return (i + 1) + ". " + icon + " " + a.action;
        }),
      },
    ],
    conclusion: actions.filter(function (a) { return a.tag === "דחוף"; }).length + " פעולות דחופות, " +
      actions.filter(function (a) { return a.tag === "בינוני"; }).length + " בינוניות.",
    recommendation: actions[0].action,
    suggestions: ["חובות פתוחים", "פרטי קשר", "סיכון נטישה"],
  };
}

// ─── donor_vs_average ─────────────────────────────────────────────────────────
function donorVsAverage(ctx) {
  const { donor, stats, globalAvgPaid, globalAvgDebt, allDonorsCount, fmtMoney } = ctx;

  const paidDiff = stats.totalPaid - globalAvgPaid;
  const paidPct  = globalAvgPaid > 0 ? ((stats.totalPaid / globalAvgPaid) * 100).toFixed(0) : 0;

  return {
    summary: (donor.fullName || "תורם זה") + " — " + (paidDiff >= 0 ? "מעל" : "מתחת") + " לממוצע ב-" + fmtMoney(Math.abs(paidDiff)),
    metrics: [
      { label: "שילם",         value: fmtMoney(stats.totalPaid) },
      { label: "ממוצע מערכת",  value: fmtMoney(globalAvgPaid) },
      { label: "יחס",          value: paidPct + "%" },
    ],
    sections: [
      {
        title: "השוואה",
        items: [
          "סה\"כ שילם: " + fmtMoney(stats.totalPaid) + " (ממוצע: " + fmtMoney(globalAvgPaid) + ")",
          "ממוצע תרומה: " + fmtMoney(stats.avgAmount),
          "חוב: " + fmtMoney(stats.totalDebt) + " (ממוצע חייבים: " + fmtMoney(globalAvgDebt) + ")",
          "מתוך " + allDonorsCount + " תורמים במערכת",
        ],
      },
    ],
    conclusion: Number(paidPct) >= 150 ? "תורם מצטיין — מעל הממוצע בהרבה."
      : Number(paidPct) >= 80 ? "תורם בטווח הממוצע."
      : "תורם מתחת לממוצע — כדאי לטפח.",
    recommendation: Number(paidPct) < 80 && stats.totalPaid > 0
      ? "לפנות עם הצעת תרומה מותאמת."
      : Number(paidPct) >= 150
      ? "לשמר קשר VIP ולוודא שביעות רצון."
      : "לעקוב ולתת מענה.",
    suggestions: ["מצב כללי", "המלצות", "מי התורמים הגדולים?"],
  };
}

// ─── donor_campaign_fit ───────────────────────────────────────────────────────
function donorCampaignFit(ctx) {
  const { donor, stats, fmtMoney } = ctx;
  const approved = donor.ivrApprovedPhones || [];
  const excluded = donor.includeInCalls === false;
  const fit      = !excluded && approved.length > 0;

  return {
    summary: fit
      ? (donor.fullName || "תורם זה") + " — מתאים לקמפיין IVR. ✅"
      : excluded
      ? (donor.fullName || "תורם זה") + " — מוחרג מהקמפיין."
      : (donor.fullName || "תורם זה") + " — לא מוכן לקמפיין (חסר מספר מאושר).",
    metrics: [
      { label: "מוכן",     value: fit ? "כן" : "לא" },
      { label: "מספרים",   value: String(approved.length) },
      { label: "חוב פתוח", value: fmtMoney(stats.totalDebt) },
    ],
    sections: [],
    conclusion: fit ? "ניתן לשגר — " + approved.length + " מספר מאושר." : "לא ניתן לשגר בקמפיין הנוכחי.",
    recommendation: !fit && !excluded
      ? "להוסיף מספר מאושר כדי לכלול בקמפיין."
      : excluded
      ? "לבדוק אם ניתן לבטל החרגה."
      : stats.totalDebt > 0
      ? "לשגר עם הודעה על חוב: " + fmtMoney(stats.totalDebt) + "."
      : "לשגר.",
    suggestions: ["סטטוס IVR", "פרטי קשר"],
  };
}

// ─── donor_last_contact ───────────────────────────────────────────────────────
function donorLastContact(ctx) {
  const { donor, allDonations, openTasks, stats, fmtDate, daysSince } = ctx;

  const lastDon          = allDonations[0];
  const taskDates        = openTasks.map(function (t) { return t.createdAt || t.updatedAt; }).filter(Boolean);
  const lastTask         = taskDates.length ? taskDates.sort().reverse()[0] : null;
  const contactDate      = lastDon ? lastDon.date : lastTask;
  const daysSinceContact = contactDate ? daysSince(contactDate) : Infinity;

  return {
    summary: contactDate
      ? "קשר אחרון: " + fmtDate(contactDate) + " — לפני " + Math.floor(daysSinceContact / 30) + " חודשים"
      : "אין רישום קשר עבור " + (donor.fullName || "תורם זה") + ".",
    metrics: contactDate
      ? [
          { label: "תאריך", value: fmtDate(contactDate) },
          { label: "מאז",    value: Math.floor(daysSinceContact / 30) + " חודשים" },
        ]
      : [],
    sections: [],
    conclusion: daysSinceContact > 365 ? "מעל שנה ללא קשר — גבולי לנטישה."
      : daysSinceContact > 180 ? "חצי שנה ללא קשר — מומלץ לפנות."
      : daysSinceContact < Infinity ? "קשר עדכני — תורם פעיל."
      : "לא נמצא רישום קשר.",
    recommendation: daysSinceContact > 180
      ? "לפנות ל-" + (donor.fullName || "תורם") + " בהקדם לחידוש קשר."
      : "להמשיך לשמר קשר שוטף.",
    suggestions: ["מצב כללי", "ציר זמן", "סיכון נטישה"],
  };
}

// ─── donor_debt_age ───────────────────────────────────────────────────────────
function donorDebtAge(ctx) {
  const { donor, openDebts, fmtDate, fmtMoney, daysSince } = ctx;
  if (!openDebts.length) {
    return {
      summary: (donor.fullName || "תורם זה") + " — אין חובות פתוחים. ✅",
      metrics: [], sections: [],
      conclusion: "אין חובות לניתוח.",
      recommendation: "לא נדרשת פעולה.",
      suggestions: ["מצב כללי"],
    };
  }

  const sorted    = openDebts.slice().sort(function (a, b) { return new Date(a.date) - new Date(b.date); });
  const oldest    = sorted[0];
  const ageMonths = Math.floor(daysSince(oldest.date) / 30);

  return {
    summary: "חוב הישן ביותר: " + fmtDate(oldest.date) + " — " + ageMonths + " חודשים",
    metrics: [
      { label: "חוב ישן",  value: fmtDate(oldest.date) },
      { label: "גיל",      value: ageMonths + " חודשים" },
      { label: "סכום",     value: fmtMoney(oldest.remainingDebt) },
    ],
    sections: [
      {
        title: "חובות לפי גיל",
        items: sorted.map(function (d) {
          const age  = Math.floor(daysSince(d.date) / 30);
          const flag = age > 12 ? " ⚠️ מעל שנה" : "";
          return fmtDate(d.date) + " — " + fmtMoney(d.remainingDebt) + " | " + age + " חודשים" + flag;
        }),
      },
    ],
    conclusion: ageMonths > 12
      ? "חוב ישן מאוד — " + ageMonths + " חודשים. הסיכוי לגביה יורד."
      : "חוב ישן " + ageMonths + " חודשים — ניתן לגביה.",
    recommendation: ageMonths > 12
      ? "לטפל בדחיפות בחוב הישן מ-" + fmtDate(oldest.date) + "."
      : "לכלול בשיחת הגביה הקרובה.",
    suggestions: ["פרט חובות", "כמה חוב יש?", "מה ההמלצה?"],
  };
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────
function dispatch(intentName, ctx, detected) {
  switch (intentName) {
    case "donor_summary":          return donorSummary(ctx);
    case "donor_last_donation":    return donorLastDonation(ctx);
    case "donor_debt_list":        return donorDebtList(ctx);
    case "donor_debt_total":       return donorDebtTotal(ctx);
    case "donor_payment_history":  return donorPaymentHistory(ctx);
    case "donor_donations_stats":  return donorDonationsStats(ctx);
    case "donor_contact":          return donorContact(ctx);
    case "donor_notes":            return donorNotes(ctx);
    case "donor_tags":             return donorTags(ctx);
    case "donor_tasks":            return donorTasks(ctx);
    case "donor_ivr_status":       return donorIvrStatus(ctx);
    case "donor_timeline":         return donorTimeline(ctx);
    case "donor_risk":             return donorRisk(ctx);
    case "donor_recommendation":   return donorRecommendation(ctx);
    case "donor_vs_average":       return donorVsAverage(ctx);
    case "donor_campaign_fit":     return donorCampaignFit(ctx);
    case "donor_last_contact":     return donorLastContact(ctx);
    case "donor_debt_age":         return donorDebtAge(ctx);
    default: return null;
  }
}

module.exports = { dispatch };

"use strict";
// handlers/system.js — 21 system-wide intent handlers (v3)
// All handlers return ResponseObject: {summary,metrics,sections,conclusion,recommendation,suggestions}

function num(v) { return Number(v || 0); }

function urgencyTier(stats) {
  if (stats.totalDebt >= 1000 && stats.daysSinceLastDonation / 30 >= 6) return "דחוף";
  if (stats.totalDebt >= 500  || stats.daysSinceLastDonation / 30 >= 3) return "בינוני";
  return "נמוך";
}

// ─── system_summary ───────────────────────────────────────────────────────────
function systemSummary(ctx) {
  const { summary, fmtMoney } = ctx;
  const alerts = [];
  if (summary.urgentCount > 0)   alerts.push("⚠️ " + summary.urgentCount + " משימות דחופות");
  if (summary.dormant365 > 5)    alerts.push("⚠️ " + summary.dormant365 + " תורמים לא תרמו שנה");
  if (summary.totalDebt > 50000) alerts.push("⚠️ חוב כולל גבוה: " + fmtMoney(summary.totalDebt));

  return {
    summary: "מצב המערכת — " + summary.totalDonors + " תורמים, חוב פתוח: " + fmtMoney(summary.totalDebt),
    metrics: [
      { label: "תורמים",        value: String(summary.totalDonors) },
      { label: "חוב פתוח",      value: fmtMoney(summary.totalDebt) },
      { label: "גביה",           value: fmtMoney(summary.totalPaid) },
      { label: "משימות פתוחות", value: String(summary.openTasksCount) },
    ],
    sections: [
      {
        title: "פרטי מצב",
        items: [
          "פעילים: " + summary.activeDonors + " | חייבים: " + summary.withDebt,
          "לא תרמו חצי שנה: " + summary.dormant180 + " | שנה: " + summary.dormant365,
          "מוכנים לקמפיין: " + summary.campaignReady + " | ללא טלפון: " + summary.noPhone,
          "מעולם לא תרמו: " + summary.neverGiven,
        ],
      },
      alerts.length ? { title: "התראות", urgent: true, items: alerts } : null,
    ].filter(Boolean),
    conclusion: alerts.length
      ? alerts.length + " התראות דורשות תשומת לב."
      : "המערכת פעילה — אין התראות דחופות.",
    recommendation: summary.urgentCount > 0
      ? "לטפל ב-" + summary.urgentCount + " משימות דחופות לפני כל דבר אחר."
      : summary.dormant365 > 5
      ? "לפנות ל-" + summary.dormant365 + " תורמים שלא תרמו שנה."
      : summary.totalDebt > 0
      ? "לפנות לגביית " + fmtMoney(summary.totalDebt) + " מ-" + summary.withDebt + " תורמים."
      : "לשמר קשר שוטף עם התורמים.",
    suggestions: ["חובות לפי עדיפות", "למי להתקשר?", "תורמים רדומים"],
  };
}

// ─── system_dormant ───────────────────────────────────────────────────────────
function systemDormant(ctx, detected) {
  const { fmtDate, fmtMoney, getDonorStats } = ctx;
  const months    = detected.entities.months || 6;
  const threshold = months * 30;

  const list = ctx.allDonors.map(function (d) {
    return { donor: d, stats: getDonorStats(d) };
  }).filter(function (x) {
    return x.stats.daysSinceLastDonation >= threshold;
  }).sort(function (a, b) {
    return b.stats.daysSinceLastDonation - a.stats.daysSinceLastDonation;
  });

  if (!list.length) {
    return {
      summary: "לא נמצאו תורמים שלא תרמו ב-" + months + " חודשים. ✅",
      metrics: [], sections: [],
      conclusion: "כל התורמים פעילים.",
      recommendation: "להמשיך לשמר קשר שוטף.",
      suggestions: ["מצב המערכת"],
    };
  }

  const withDebt  = list.filter(function (x) { return x.stats.totalDebt > 0; });
  const withPhone = list.filter(function (x) { return x.donor.phone; });

  return {
    summary: list.length + " תורמים לא תרמו ב-" + months + " חודשים — " + withDebt.length + " עם חובות",
    metrics: [
      { label: "רדומים",   value: String(list.length) },
      { label: "עם חוב",   value: String(withDebt.length) },
      { label: "עם טלפון", value: String(withPhone.length) },
    ],
    sections: [
      {
        title: "הרדומים הוותיקים ביותר (20 ראשונים)",
        items: list.slice(0, 20).map(function (x, i) {
          const last = x.stats.lastDonationDate ? fmtDate(x.stats.lastDonationDate) : "אף פעם";
          const debt = x.stats.totalDebt > 0 ? " | חוב: " + fmtMoney(x.stats.totalDebt) : "";
          return (i + 1) + ". " + (x.donor.fullName || "ללא שם") + " | אחרונה: " + last + debt;
        }),
      },
    ],
    conclusion: "מתוכם " + withPhone.length + " עם טלפון — ניתן ליצור קשר.",
    recommendation: withDebt.length
      ? "להתחיל מ-" + withDebt.length + " הרדומים עם חובות — שתי סיבות לפנות."
      : "לפנות ל-" + withPhone.length + " הרדומים עם טלפון לחידוש קשר.",
    suggestions: ["למי להתקשר?", "חובות לפי עדיפות", "סיכון נטישה"],
  };
}

// ─── system_priority_debts ────────────────────────────────────────────────────
function systemPriorityDebts(ctx) {
  const { withDebt, fmtMoney } = ctx;
  if (!withDebt.length) {
    return {
      summary: "אין חובות פתוחים במערכת. ✅",
      metrics: [], sections: [],
      conclusion: "כל התורמים משלמים.",
      recommendation: "לא נדרשת פעולת גביה.",
      suggestions: ["מצב המערכת"],
    };
  }

  const groups = { "דחוף": [], "בינוני": [], "נמוך": [] };
  withDebt.forEach(function (x) {
    groups[urgencyTier(x.stats)].push(x);
  });
  ["דחוף", "בינוני", "נמוך"].forEach(function (k) {
    groups[k].sort(function (a, b) { return b.stats.totalDebt - a.stats.totalDebt; });
  });

  const grandTotal = withDebt.reduce(function (s, x) { return s + x.stats.totalDebt; }, 0);
  const icons      = { "דחוף": "🔴", "בינוני": "🟡", "נמוך": "🟢" };

  const sections = ["דחוף", "בינוני", "נמוך"].map(function (tier) {
    if (!groups[tier].length) return null;
    return {
      title:  icons[tier] + " " + tier + " (" + groups[tier].length + ")",
      urgent: tier === "דחוף",
      items:  groups[tier].slice(0, 8).map(function (x, i) {
        const d = x.donor;
        return (i + 1) + ". " + (d.fullName || "ללא שם") + " — " + fmtMoney(x.stats.totalDebt) +
          (d.phone ? " | " + d.phone : "");
      }),
    };
  }).filter(Boolean);

  return {
    summary: withDebt.length + " תורמים חייבים — סה\"כ " + fmtMoney(grandTotal),
    metrics: [
      { label: "סה\"כ חוב", value: fmtMoney(grandTotal) },
      { label: "דחוף",      value: String(groups["דחוף"].length) },
      { label: "בינוני",    value: String(groups["בינוני"].length) },
      { label: "נמוך",      value: String(groups["נמוך"].length) },
    ],
    sections: sections,
    conclusion: groups["דחוף"].length
      ? groups["דחוף"].length + " חובות דחופים — יש להתחיל מהם."
      : "אין חובות דחופים, אך יש " + withDebt.length + " חובות לטיפול.",
    recommendation: groups["דחוף"].length
      ? "להתחיל גביה מ-" + (groups["דחוף"][0].donor.fullName || "ללא שם") +
        " (" + fmtMoney(groups["דחוף"][0].stats.totalDebt) + ")."
      : "להתחיל מהחוב הגדול: " + (withDebt[0].donor.fullName || "ללא שם") + ".",
    suggestions: ["למי להתקשר?", "החייב הגדול", "quick wins"],
  };
}

// ─── system_top_donors ────────────────────────────────────────────────────────
function systemTopDonors(ctx, detected) {
  const { statsPerDonor, fmtMoney } = ctx;
  const n = detected.entities.topN || 10;
  const ranked = statsPerDonor
    .filter(function (x) { return x.stats.totalPaid > 0; })
    .sort(function (a, b) { return b.stats.totalPaid - a.stats.totalPaid; })
    .slice(0, n);

  if (!ranked.length) {
    return {
      summary: "לא נמצאו תורמים שתרמו.",
      metrics: [], sections: [],
      conclusion: "אין נתוני גביה.",
      recommendation: "לוודא הזנת נתונים.",
      suggestions: ["מצב המערכת"],
    };
  }
  const total = ranked.reduce(function (s, x) { return s + x.stats.totalPaid; }, 0);

  return {
    summary: n + " התורמים הגדולים — סה\"כ " + fmtMoney(total),
    metrics: [
      { label: "מוביל",    value: fmtMoney(ranked[0].stats.totalPaid) },
      { label: "ממוצע top", value: fmtMoney(Math.round(total / ranked.length)) },
    ],
    sections: [{
      title: "דירוג תורמים",
      items: ranked.map(function (x, i) {
        return (i + 1) + ". " + (x.donor.fullName || "ללא שם") + " — " +
          fmtMoney(x.stats.totalPaid) + " (" + x.stats.paidCount + " תשלומים)";
      }),
    }],
    conclusion: "תורמי ה-top אחראים על חלק גדול מהגביה.",
    recommendation: "לשמר קשר VIP עם התורמים הגדולים ולוודא שביעות רצון.",
    suggestions: ["מצב המערכת", "מגמה חודשית"],
  };
}

// ─── system_total_debt ────────────────────────────────────────────────────────
function systemTotalDebt(ctx) {
  const { summary, fmtMoney } = ctx;
  const avg = summary.withDebt > 0 ? Math.round(summary.totalDebt / summary.withDebt) : 0;
  const pct = summary.totalDonors ? ((summary.withDebt / summary.totalDonors) * 100).toFixed(0) : 0;

  return {
    summary: "חוב כולל: " + fmtMoney(summary.totalDebt) + " מ-" + summary.withDebt + " תורמים",
    metrics: [
      { label: "חוב כולל",      value: fmtMoney(summary.totalDebt) },
      { label: "תורמים חייבים", value: String(summary.withDebt) },
      { label: "ממוצע לחייב",   value: fmtMoney(avg) },
      { label: "אחוז חייבים",   value: pct + "%" },
    ],
    sections: [],
    conclusion: Number(pct) > 50
      ? "מעל מחצית התורמים חייבים — יש להאיץ גביה."
      : "פחות ממחצית חייבים — מצב סביר.",
    recommendation: summary.totalDebt > 0
      ? "לפתוח קמפיין גביה ממוקד ל-" + summary.withDebt + " התורמים החייבים."
      : "לא נדרשת גביה.",
    suggestions: ["חובות לפי עדיפות", "החייב הגדול", "quick wins"],
  };
}

// ─── system_total_paid ────────────────────────────────────────────────────────
function systemTotalPaid(ctx) {
  const { summary, statsPerDonor, fmtMoney } = ctx;
  const payers = statsPerDonor.filter(function (x) { return x.stats.totalPaid > 0; });
  const avg    = payers.length ? Math.round(summary.totalPaid / payers.length) : 0;
  const rate   = (summary.totalPaid + summary.totalDebt) > 0
    ? ((summary.totalPaid / (summary.totalPaid + summary.totalDebt)) * 100).toFixed(1)
    : 0;

  return {
    summary: "גביה כוללת: " + fmtMoney(summary.totalPaid) + " — שיעור " + rate + "%",
    metrics: [
      { label: "גביה כוללת",  value: fmtMoney(summary.totalPaid) },
      { label: "שיעור גביה",   value: rate + "%" },
      { label: "ממוצע לתורם",  value: fmtMoney(avg) },
      { label: "חוב נותר",     value: fmtMoney(summary.totalDebt) },
    ],
    sections: [],
    conclusion: Number(rate) > 75 ? "שיעור גביה טוב מאוד."
      : Number(rate) > 50 ? "שיעור גביה בינוני — יש מה לשפר."
      : "שיעור גביה נמוך — נדרשת פעולה.",
    recommendation: Number(rate) < 70
      ? "לשפר גביה — " + fmtMoney(summary.totalDebt) + " עדיין ממתינים."
      : "לשמר ביצועים.",
    suggestions: ["מגמה חודשית", "חובות לפי עדיפות"],
  };
}

// ─── system_active_count ──────────────────────────────────────────────────────
function systemActiveCount(ctx) {
  const { summary } = ctx;
  return {
    summary: "סה\"כ " + summary.totalDonors + " תורמים — " + summary.activeDonors + " פעילים",
    metrics: [
      { label: "סה\"כ",     value: String(summary.totalDonors) },
      { label: "פעילים",    value: String(summary.activeDonors) },
      { label: "עם חוב",    value: String(summary.withDebt) },
      { label: "ללא טלפון", value: String(summary.noPhone) },
    ],
    sections: [{
      title: "פירוט",
      items: [
        "לא פעילים: " + (summary.totalDonors - summary.activeDonors),
        "אף פעם לא תרמו: " + summary.neverGiven,
        "מוכנים לקמפיין: " + summary.campaignReady,
      ],
    }],
    conclusion: summary.neverGiven > 0
      ? summary.neverGiven + " תורמים מעולם לא תרמו — פוטנציאל גנוז."
      : "כל התורמים תרמו לפחות פעם אחת.",
    recommendation: summary.neverGiven > 0
      ? "לפנות ל-" + summary.neverGiven + " שמעולם לא תרמו ולעודד תרומה ראשונה."
      : "לעקוב אחר " + (summary.totalDonors - summary.activeDonors) + " הלא-פעילים.",
    suggestions: ["מצב המערכת", "תורמים רדומים"],
  };
}

// ─── system_new_donors ────────────────────────────────────────────────────────
function systemNewDonors(ctx, detected) {
  const { allDonors, fmtDate } = ctx;
  const days      = detected.entities.days || 30;
  const threshold = new Date(Date.now() - days * 86400000);
  const newOnes   = allDonors.filter(function (d) {
    return d.createdAt && new Date(d.createdAt) >= threshold;
  }).sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });

  if (!newOnes.length) {
    return {
      summary: "לא נמצאו תורמים שנוספו ב-" + days + " הימים האחרונים.",
      metrics: [], sections: [],
      conclusion: "לא הצטרפו תורמים חדשים בתקופה זו.",
      recommendation: "לשקול מבצע גיוס תורמים חדשים.",
      suggestions: ["ספירת תורמים", "מצב המערכת"],
    };
  }

  return {
    summary: newOnes.length + " תורמים חדשים ב-" + days + " הימים האחרונים",
    metrics: [{ label: "תורמים חדשים", value: String(newOnes.length) }],
    sections: [{
      title: "תורמים חדשים",
      items: newOnes.slice(0, 15).map(function (d, i) {
        return (i + 1) + ". " + (d.fullName || "ללא שם") + " | " + fmtDate(d.createdAt) + (d.city ? " | " + d.city : "");
      }),
    }],
    conclusion: "גויסו " + newOnes.length + " תורמים חדשים בתקופה זו.",
    recommendation: "ליצור קשר ראשוני עם התורמים החדשים ולוודא חוויית קבלת פנים.",
    suggestions: ["ספירת תורמים", "מצב המערכת"],
  };
}

// ─── system_by_city ───────────────────────────────────────────────────────────
function systemByCity(ctx) {
  const { citySorted } = ctx;
  if (!citySorted.length) {
    return {
      summary: "לא נמצאו נתוני עיר.",
      metrics: [], sections: [],
      conclusion: "חסרים נתוני מיקום.",
      recommendation: "לעדכן שדה עיר בכרטיסי תורמים.",
      suggestions: ["מצב המערכת"],
    };
  }
  const top = citySorted[0];
  return {
    summary: citySorted.length + " ערים — מוביל: " + top[0] + " (" + top[1] + " תורמים)",
    metrics: [
      { label: "ערים",    value: String(citySorted.length) },
      { label: "מוביל",   value: top[0] },
    ],
    sections: [{
      title: "פיזור לפי עיר",
      items: citySorted.map(function (e, i) {
        return (i + 1) + ". " + e[0] + " — " + e[1] + " תורמים";
      }),
    }],
    conclusion: "הריכוז הגדול ביותר ב-" + top[0] + ".",
    recommendation: "לשקול קמפיין ממוקד ב-" + top[0] + " — ריכוז גבוה של תורמים.",
    suggestions: ["ספירת תורמים", "מצב המערכת"],
  };
}

// ─── system_by_purpose ────────────────────────────────────────────────────────
function systemByPurpose(ctx) {
  const { purposeMap } = ctx;
  const sorted = Object.entries(purposeMap).sort(function (a, b) { return b[1] - a[1]; });
  if (!sorted.length) {
    return {
      summary: "לא נמצאו נתוני מטרה.",
      metrics: [], sections: [],
      conclusion: "חסרים נתוני מטרת תרומה.",
      recommendation: "לעדכן שדה מטרה בתרומות.",
      suggestions: ["מצב המערכת"],
    };
  }
  const total = sorted.reduce(function (s, e) { return s + e[1]; }, 0);
  return {
    summary: sorted.length + " מטרות — " + total + " תרומות סה\"כ",
    metrics: [
      { label: "מטרות",  value: String(sorted.length) },
      { label: "מוביל",  value: sorted[0][0] },
    ],
    sections: [{
      title: "תרומות לפי מטרה",
      items: sorted.map(function (e, i) {
        const pct = total ? ((e[1] / total) * 100).toFixed(0) : 0;
        return (i + 1) + ". " + e[0] + " — " + e[1] + " (" + pct + "%)";
      }),
    }],
    conclusion: "מטרת \"" + sorted[0][0] + "\" מובילה עם " + sorted[0][1] + " תרומות.",
    recommendation: "לנצל את מטרת \"" + sorted[0][0] + "\" כנושא קמפיין.",
    suggestions: ["גביה כוללת", "מצב המערכת"],
  };
}

// ─── system_open_tasks ────────────────────────────────────────────────────────
function systemOpenTasks(ctx) {
  const { openTasks, fmtDate } = ctx;
  if (!openTasks.length) {
    return {
      summary: "אין משימות פתוחות. ✅",
      metrics: [], sections: [],
      conclusion: "כל המשימות מטופלות.",
      recommendation: "לא נדרשת פעולה.",
      suggestions: ["מצב המערכת"],
    };
  }
  const now     = new Date();
  const week    = new Date(Date.now() + 7 * 86400000);
  const overdue = openTasks.filter(function (t) { return t.dueDate && new Date(t.dueDate) < now; });
  const soon    = openTasks.filter(function (t) {
    if (!t.dueDate) return false;
    const d = new Date(t.dueDate);
    return d >= now && d < week;
  });
  const noDate  = openTasks.filter(function (t) { return !t.dueDate; });

  return {
    summary: openTasks.length + " משימות פתוחות — " + overdue.length + " פגו תוקף",
    metrics: [
      { label: "פתוחות",       value: String(openTasks.length) },
      { label: "פגי תוקף",     value: String(overdue.length) },
      { label: "צפויות בשבוע", value: String(soon.length) },
      { label: "ללא תאריך",    value: String(noDate.length) },
    ],
    sections: [
      overdue.length ? {
        title: "פגי תוקף",
        urgent: true,
        items: overdue.slice(0, 8).map(function (t) {
          return (t.title || t.text || "משימה") + " | " + fmtDate(t.dueDate) + " ⚠️";
        }),
      } : null,
      soon.length ? {
        title: "צפויות השבוע",
        items: soon.slice(0, 5).map(function (t) {
          return (t.title || t.text || "משימה") + " | " + fmtDate(t.dueDate);
        }),
      } : null,
    ].filter(Boolean),
    conclusion: overdue.length ? overdue.length + " משימות פגו תוקף." : "אין משימות שפגו תוקף.",
    recommendation: overdue.length
      ? "לטפל מיד ב-" + overdue.length + " המשימות שפגו תוקף."
      : soon.length
      ? "לטפל ב-" + soon.length + " משימות צפויות השבוע."
      : "לסדר תאריכים ל-" + noDate.length + " המשימות ללא תאריך.",
    suggestions: ["משימות דחופות", "מצב המערכת"],
  };
}

// ─── system_urgent_tasks ──────────────────────────────────────────────────────
function systemUrgentTasks(ctx) {
  const { urgentTasks, fmtDate } = ctx;
  if (!urgentTasks.length) {
    return {
      summary: "אין משימות דחופות. ✅",
      metrics: [], sections: [],
      conclusion: "כל המשימות הדחופות מטופלות.",
      recommendation: "לא נדרשת פעולה דחופה.",
      suggestions: ["כל המשימות", "מצב המערכת"],
    };
  }
  const overdue = urgentTasks.filter(function (t) { return new Date(t.dueDate) < new Date(); });

  return {
    summary: urgentTasks.length + " משימות דחופות — " + overdue.length + " פגו תוקף",
    metrics: [
      { label: "דחופות",   value: String(urgentTasks.length) },
      { label: "פגי תוקף", value: String(overdue.length) },
    ],
    sections: [{
      title: "משימות דחופות",
      urgent: overdue.length > 0,
      items: urgentTasks.map(function (t, i) {
        const flag = new Date(t.dueDate) < new Date() ? " ⚠️ פגי תוקף" : " 🔜 קרוב";
        return (i + 1) + ". " + (t.title || t.text || "משימה") + " | " + fmtDate(t.dueDate) + flag;
      }),
    }],
    conclusion: overdue.length ? overdue.length + " משימות כבר עברו את התאריך!" : "משימות קרובות לתאריך.",
    recommendation: "לטפל מיד ב: " + (urgentTasks[0].title || urgentTasks[0].text || "משימה ראשונה") + ".",
    suggestions: ["כל המשימות", "מצב המערכת"],
  };
}

// ─── system_upcoming_rem ──────────────────────────────────────────────────────
function systemUpcomingRem(ctx) {
  const { upcomingReminders, fmtDate } = ctx;
  if (!upcomingReminders.length) {
    return {
      summary: "אין תזכורות קרובות ב-7 הימים הקרובים.",
      metrics: [], sections: [],
      conclusion: "לוח השבוע פנוי.",
      recommendation: "לשקול הגדרת תזכורות לפעולות קרובות.",
      suggestions: ["מצב המערכת"],
    };
  }
  return {
    summary: upcomingReminders.length + " תזכורות ב-7 הימים הקרובים",
    metrics: [{ label: "תזכורות", value: String(upcomingReminders.length) }],
    sections: [{
      title: "תזכורות קרובות",
      items: upcomingReminders.map(function (r, i) {
        return (i + 1) + ". " + (r.text || r.title || "תזכורת") + " | " + fmtDate(r.date || r.dueDate);
      }),
    }],
    conclusion: "יש " + upcomingReminders.length + " תזכורות לשבוע הקרוב.",
    recommendation: "לסקור את התזכורות ולוודא שכולן מטופלות.",
    suggestions: ["משימות דחופות", "מצב המערכת"],
  };
}

// ─── system_trend ─────────────────────────────────────────────────────────────
function systemTrend(ctx) {
  const { monthlyTrend, fmtMoney } = ctx;
  if (!monthlyTrend.length) {
    return {
      summary: "אין נתוני מגמה.",
      metrics: [], sections: [],
      conclusion: "חסרים נתוני היסטוריה.",
      recommendation: "לוודא שתרומות נרשמות עם תאריך.",
      suggestions: ["מצב המערכת"],
    };
  }
  const totalPeriod = monthlyTrend.reduce(function (s, e) { return s + e[1].total; }, 0);
  const avgMonth    = Math.round(totalPeriod / monthlyTrend.length);
  const first       = monthlyTrend[0][1].count;
  const last        = monthlyTrend[monthlyTrend.length - 1][1].count;
  const trend       = last > first ? "עולה 📈" : last < first ? "יורדת 📉" : "יציבה ➡️";

  return {
    summary: "מגמת תרומות — " + trend + " (" + monthlyTrend.length + " חודשים)",
    metrics: [
      { label: "סה\"כ תקופה", value: fmtMoney(totalPeriod) },
      { label: "ממוצע חודשי",  value: fmtMoney(avgMonth) },
      { label: "מגמה",          value: trend },
    ],
    sections: [{
      title: "12 חודשים אחרונים",
      items: monthlyTrend.map(function (e) {
        const bar = "█".repeat(Math.min(8, Math.round(e[1].count / 2))) || "░";
        return e[0] + ": " + bar + " " + e[1].count + " תרומות | " + fmtMoney(e[1].total);
      }),
    }],
    conclusion: trend.includes("עולה") ? "מגמה עולה — פעילות הולכת וגדלה."
      : trend.includes("יורדת") ? "מגמה יורדת — יש לפעול."
      : "מגמה יציבה.",
    recommendation: trend.includes("יורדת")
      ? "לנתח מה גרם לירידה ולשקול קמפיין."
      : "לנצל את המגמה לגדילה נוספת.",
    suggestions: ["גביה כוללת", "מצב המערכת"],
  };
}

// ─── system_by_tag ────────────────────────────────────────────────────────────
function systemByTag(ctx) {
  const { tagMap } = ctx;
  const sorted = Object.entries(tagMap).sort(function (a, b) { return b[1] - a[1]; });
  if (!sorted.length) {
    return {
      summary: "לא נמצאו תגיות.",
      metrics: [], sections: [],
      conclusion: "אף תורם אינו מתויג.",
      recommendation: "לשקול הוספת תגיות לסיווג תורמים.",
      suggestions: ["מצב המערכת"],
    };
  }
  return {
    summary: sorted.length + " תגיות — מובילה: " + sorted[0][0] + " (" + sorted[0][1] + ")",
    metrics: [{ label: "תגיות", value: String(sorted.length) }],
    sections: [{
      title: "תורמים לפי תגית",
      items: sorted.slice(0, 15).map(function (e, i) {
        return (i + 1) + ". " + e[0] + " — " + e[1] + " תורמים";
      }),
    }],
    conclusion: "יש " + sorted.length + " קבוצות — מועיל לקמפיינים ממוקדים.",
    recommendation: "לנצל תגיות לשגור קמפיינים ממוקדים.",
    suggestions: ["ספירת תורמים", "מצב המערכת"],
  };
}

// ─── system_payment_methods ───────────────────────────────────────────────────
function systemPaymentMethods(ctx) {
  const { methodMap } = ctx;
  const sorted = Object.entries(methodMap).sort(function (a, b) { return b[1] - a[1]; });
  if (!sorted.length) {
    return {
      summary: "לא נמצאו נתוני אמצעי תשלום.",
      metrics: [], sections: [],
      conclusion: "חסרים נתוני תשלום.",
      recommendation: "לוודא שאמצעי תשלום נרשמים.",
      suggestions: ["מצב המערכת"],
    };
  }
  const total = sorted.reduce(function (s, e) { return s + e[1]; }, 0);
  return {
    summary: sorted.length + " אמצעי תשלום — " + total + " תשלומים",
    metrics: [{ label: "מוביל", value: sorted[0][0] + " (" + sorted[0][1] + ")" }],
    sections: [{
      title: "פיזור אמצעי תשלום",
      items: sorted.map(function (e, i) {
        const pct = total ? ((e[1] / total) * 100).toFixed(0) : 0;
        return (i + 1) + ". " + e[0] + " — " + e[1] + " (" + pct + "%)";
      }),
    }],
    conclusion: sorted[0][0] + " הוא אמצעי התשלום הנפוץ ביותר.",
    recommendation: "לדאוג שקמפיין ה-IVR תומך ב-" + sorted[0][0] + ".",
    suggestions: ["גביה כוללת", "מצב המערכת"],
  };
}

// ─── system_campaign_ready ────────────────────────────────────────────────────
function systemCampaignReady(ctx) {
  const { allDonors, summary, fmtMoney, getDonorStats } = ctx;
  const ready         = allDonors.filter(function (d) {
    return (d.ivrApprovedPhones || []).length > 0 && d.includeInCalls !== false;
  });
  const readyDebtSum  = ready.reduce(function (s, d) { return s + getDonorStats(d).totalDebt; }, 0);
  const readyWithDebt = ready.filter(function (d) { return getDonorStats(d).totalDebt > 0; });

  return {
    summary: ready.length + " תורמים מוכנים לקמפיין מתוך " + summary.totalDonors,
    metrics: [
      { label: "מוכנים",    value: String(ready.length) },
      { label: "עם חוב",    value: String(readyWithDebt.length) },
      { label: "ללא מאושר", value: String(summary.totalDonors - ready.length) },
    ],
    sections: [{
      title: "מוכנות קמפיין",
      items: [
        "עם מספר מאושר: " + ready.length,
        "מתוכם עם חוב: " + readyWithDebt.length + " (" + fmtMoney(readyDebtSum) + ")",
        "ללא מספר מאושר: " + (summary.totalDonors - ready.length),
      ],
    }],
    conclusion: ready.length > 0 ? "ניתן לשגר ל-" + ready.length + " תורמים." : "אין תורמים מוכנים.",
    recommendation: ready.length > 0
      ? "לשגר ל-" + ready.length + " — להתחיל מ-" + readyWithDebt.length + " שיש להם גם חוב."
      : "להוסיף מספרים מאושרים לתורמים.",
    suggestions: ["חובות לפי עדיפות", "מצב המערכת"],
  };
}

// ─── system_biggest_debtor ────────────────────────────────────────────────────
function systemBiggestDebtor(ctx) {
  const { withDebt, fmtMoney } = ctx;
  if (!withDebt.length) {
    return {
      summary: "אין חובות פתוחים. ✅",
      metrics: [], sections: [],
      conclusion: "אין חייבים.",
      recommendation: "לא נדרשת גביה.",
      suggestions: ["מצב המערכת"],
    };
  }
  const sorted = withDebt.slice().sort(function (a, b) { return b.stats.totalDebt - a.stats.totalDebt; });
  const top    = sorted[0];
  const d      = top.donor;

  return {
    summary: "החייב הגדול: " + (d.fullName || "ללא שם") + " — " + fmtMoney(top.stats.totalDebt),
    metrics: [
      { label: "שם",    value: d.fullName || "ללא שם" },
      { label: "חוב",   value: fmtMoney(top.stats.totalDebt) },
      { label: "חובות", value: String(top.stats.openDebtsCount) },
    ],
    sections: [
      {
        title: "פרטים",
        items: [
          "עיר: " + (d.city || "לא ידוע"),
          "טלפון: " + (d.phone || "אין"),
          "שילם בעבר: " + fmtMoney(top.stats.totalPaid),
        ],
      },
      sorted.length > 1 ? {
        title: "5 הבאים",
        items: sorted.slice(1, 6).map(function (x, i) {
          return (i + 2) + ". " + (x.donor.fullName || "ללא שם") + " — " + fmtMoney(x.stats.totalDebt);
        }),
      } : null,
    ].filter(Boolean),
    conclusion: "1 תורם עם חוב גדול — דורש טיפול מיוחד.",
    recommendation: d.phone
      ? "להתקשר ל-" + d.phone + " ולסדר תשלום של " + fmtMoney(top.stats.totalDebt) + "."
      : "למצוא פרטי קשר ולפנות ל-" + (d.fullName || "תורם") + ".",
    suggestions: ["חובות לפי עדיפות", "למי להתקשר?"],
  };
}

// ─── system_recent_payments ───────────────────────────────────────────────────
function systemRecentPayments(ctx, detected) {
  const { allDonors, fmtDate, fmtMoney } = ctx;
  const days      = detected.entities.days || 30;
  const threshold = new Date(Date.now() - days * 86400000);
  const recent    = [];
  allDonors.forEach(function (d) {
    (d.donations || []).forEach(function (don) {
      if (don.paid && don.date && new Date(don.date) >= threshold) {
        recent.push({ donor: d, donation: don });
      }
    });
  });
  recent.sort(function (a, b) { return new Date(b.donation.date) - new Date(a.donation.date); });

  if (!recent.length) {
    return {
      summary: "לא נמצאו תשלומים ב-" + days + " הימים האחרונים.",
      metrics: [], sections: [],
      conclusion: "לא בוצעו תשלומים בתקופה זו.",
      recommendation: "לשקול קמפיין גביה.",
      suggestions: ["גביה כוללת", "מצב המערכת"],
    };
  }
  const total = recent.reduce(function (s, x) { return s + num(x.donation.amount) - num(x.donation.remainingDebt); }, 0);

  return {
    summary: recent.length + " תשלומים ב-" + days + " ימים — " + fmtMoney(total),
    metrics: [
      { label: "תשלומים", value: String(recent.length) },
      { label: "סה\"כ",   value: fmtMoney(total) },
    ],
    sections: [{
      title: "תשלומים אחרונים",
      items: recent.slice(0, 15).map(function (x, i) {
        return (i + 1) + ". " + fmtDate(x.donation.date) + " | " +
          (x.donor.fullName || "ללא שם") + " | " + fmtMoney(x.donation.amount);
      }),
    }],
    conclusion: "גביה של " + fmtMoney(total) + " ב-" + days + " ימים.",
    recommendation: total < 5000
      ? "גביה נמוכה — לשקול פנייה פעילה."
      : "גביה טובה — להמשיך בקצב.",
    suggestions: ["גביה כוללת", "מגמה חודשית"],
  };
}

// ─── system_no_phone ─────────────────────────────────────────────────────────
function systemNoPhone(ctx) {
  const { allDonors } = ctx;
  const noPhone = allDonors.filter(function (d) { return !d.phone; });
  if (!noPhone.length) {
    return {
      summary: "לכל התורמים יש טלפון רשום. ✅",
      metrics: [], sections: [],
      conclusion: "נתוני קשר מלאים.",
      recommendation: "לוודא שמספרים מעודכנים.",
      suggestions: ["ספירת תורמים"],
    };
  }
  return {
    summary: noPhone.length + " תורמים ללא מספר טלפון",
    metrics: [{ label: "ללא טלפון", value: String(noPhone.length) }],
    sections: [{
      title: "תורמים ללא טלפון",
      items: noPhone.slice(0, 20).map(function (d, i) {
        return (i + 1) + ". " + (d.fullName || "ללא שם") + (d.city ? " | " + d.city : "");
      }),
    }],
    conclusion: noPhone.length + " תורמים לא ניתן לפנות אליהם בטלפון.",
    recommendation: "לאתר מספרי טלפון עבור " + noPhone.length + " תורמים אלו.",
    suggestions: ["ספירת תורמים", "מצב המערכת"],
  };
}

// ─── system_debt_aging ────────────────────────────────────────────────────────
function systemDebtAging(ctx, detected) {
  const { allDonors, fmtDate, fmtMoney, daysSince } = ctx;
  const months    = detected.entities.months || 6;
  const threshold = months * 30;
  const oldDebts  = [];
  allDonors.forEach(function (d) {
    (d.donations || []).forEach(function (don) {
      if (num(don.remainingDebt) > 0 && daysSince(don.date) >= threshold) {
        oldDebts.push({ donor: d, donation: don, age: daysSince(don.date) });
      }
    });
  });
  oldDebts.sort(function (a, b) { return b.age - a.age; });

  if (!oldDebts.length) {
    return {
      summary: "אין חובות ישנים מ-" + months + " חודשים. ✅",
      metrics: [], sections: [],
      conclusion: "חובות מטופלים בזמן.",
      recommendation: "להמשיך לשמר מדיניות גביה שוטפת.",
      suggestions: ["חובות לפי עדיפות", "מצב המערכת"],
    };
  }
  const total = oldDebts.reduce(function (s, x) { return s + num(x.donation.remainingDebt); }, 0);

  return {
    summary: oldDebts.length + " חובות ישנים (מעל " + months + " חודשים) — " + fmtMoney(total),
    metrics: [
      { label: "חובות ישנים", value: String(oldDebts.length) },
      { label: "סה\"כ",       value: fmtMoney(total) },
    ],
    sections: [{
      title: "חובות ישנים",
      urgent: true,
      items: oldDebts.slice(0, 15).map(function (x, i) {
        const mos = Math.floor(x.age / 30);
        return (i + 1) + ". " + (x.donor.fullName || "ללא שם") + " | " +
          fmtDate(x.donation.date) + " | " + fmtMoney(x.donation.remainingDebt) + " | " + mos + " חודשים";
      }),
    }],
    conclusion: "חובות ישנים מצביעים על קושי בגביה — יש לטפל דחוף.",
    recommendation: "לפנות ל-" + (oldDebts[0].donor.fullName || "ללא שם") +
      " לגביית חוב מ-" + fmtDate(oldDebts[0].donation.date) + ".",
    suggestions: ["חובות לפי עדיפות", "למי להתקשר?"],
  };
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────
function dispatch(intentName, ctx, detected) {
  switch (intentName) {
    case "system_summary":          return systemSummary(ctx);
    case "system_dormant":          return systemDormant(ctx, detected);
    case "system_priority_debts":   return systemPriorityDebts(ctx);
    case "system_top_donors":       return systemTopDonors(ctx, detected);
    case "system_total_debt":       return systemTotalDebt(ctx);
    case "system_total_paid":       return systemTotalPaid(ctx);
    case "system_active_count":     return systemActiveCount(ctx);
    case "system_new_donors":       return systemNewDonors(ctx, detected);
    case "system_by_city":          return systemByCity(ctx);
    case "system_by_purpose":       return systemByPurpose(ctx);
    case "system_open_tasks":       return systemOpenTasks(ctx);
    case "system_urgent_tasks":     return systemUrgentTasks(ctx);
    case "system_upcoming_rem":     return systemUpcomingRem(ctx);
    case "system_trend":            return systemTrend(ctx);
    case "system_by_tag":           return systemByTag(ctx);
    case "system_payment_methods":  return systemPaymentMethods(ctx);
    case "system_campaign_ready":   return systemCampaignReady(ctx);
    case "system_biggest_debtor":   return systemBiggestDebtor(ctx);
    case "system_recent_payments":  return systemRecentPayments(ctx, detected);
    case "system_no_phone":         return systemNoPhone(ctx);
    case "system_debt_aging":       return systemDebtAging(ctx, detected);
    default: return null;
  }
}

module.exports = { dispatch };

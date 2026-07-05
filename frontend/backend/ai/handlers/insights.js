"use strict";
// handlers/insights.js — 8 cross-cutting insight handlers (v3)
// All handlers return ResponseObject: {summary,metrics,sections,conclusion,recommendation,suggestions}

function num(v) { return Number(v || 0); }

// ─── insight_who_to_call ──────────────────────────────────────────────────────
function insightWhoToCall(ctx) {
  const { fmtMoney, getDonorStats } = ctx;
  const candidates = ctx.allDonors.map(function (d) {
    const st = getDonorStats(d);
    var score = 0;
    if (st.totalDebt > 0)                                        score += 3;
    if (st.daysSinceLastDonation > 90 && st.daysSinceLastDonation < 730) score += 2;
    if (st.daysSinceLastDonation > 30)                           score += 1;
    if (d.phone)                                                 score += 1;
    if ((d.ivrApprovedPhones || []).length > 0)                  score += 1;
    if (st.totalPaid > 0)                                        score += 1;
    return { donor: d, stats: st, score: score };
  }).filter(function (x) { return x.score > 3 && x.donor.phone; })
    .sort(function (a, b) { return b.score - a.score || b.stats.totalDebt - a.stats.totalDebt; });

  if (!candidates.length) {
    return {
      summary: "לא נמצאו תורמים בעדיפות גבוהה לשיחות כרגע.",
      metrics: [], sections: [],
      conclusion: "כל התורמים עדכניים.",
      recommendation: "לשמר קשר שוטף.",
      suggestions: ["מצב המערכת"],
    };
  }

  return {
    summary: candidates.length + " תורמים מומלצים לשיחה היום",
    metrics: [
      { label: "מומלצים",  value: String(candidates.length) },
      { label: "עם חוב",   value: String(candidates.filter(function (x) { return x.stats.totalDebt > 0; }).length) },
    ],
    sections: [{
      title: "לפי סדר עדיפות",
      items: candidates.slice(0, 10).map(function (x, i) {
        const debtStr = x.stats.totalDebt > 0 ? " | חוב: " + fmtMoney(x.stats.totalDebt) : "";
        const months  = x.stats.daysSinceLastDonation < Infinity
          ? " | " + Math.floor(x.stats.daysSinceLastDonation / 30) + " חודשים"
          : "";
        return (i + 1) + ". " + (x.donor.fullName || "ללא שם") + " | " + x.donor.phone + debtStr + months;
      }),
    }],
    conclusion: "להתחיל מ-" + (candidates[0].donor.fullName || "ללא שם") + " — עדיפות גבוהה.",
    recommendation: "להתקשר ל-" + (candidates[0].donor.phone || "תורם") +
      (candidates[0].stats.totalDebt > 0 ? " לגביית " + fmtMoney(candidates[0].stats.totalDebt) : " לחידוש קשר") + ".",
    suggestions: ["חובות לפי עדיפות", "תורמים רדומים"],
  };
}

// ─── insight_quick_wins ───────────────────────────────────────────────────────
function insightQuickWins(ctx) {
  const { withDebt, fmtMoney } = ctx;
  const small = withDebt
    .filter(function (x) { return x.stats.totalDebt > 0 && x.stats.totalDebt < 500 && x.donor.phone; })
    .sort(function (a, b) { return a.stats.totalDebt - b.stats.totalDebt; });

  if (!small.length) {
    return {
      summary: "לא נמצאו חובות קטנים לסגירה מהירה.",
      metrics: [], sections: [],
      conclusion: "החובות הפתוחים גדולים יחסית.",
      recommendation: "לטפל בחובות לפי עדיפות גודל.",
      suggestions: ["חובות לפי עדיפות"],
    };
  }
  const total = small.reduce(function (s, x) { return s + x.stats.totalDebt; }, 0);

  return {
    summary: small.length + " חובות קטנים (מתחת ל-₪500) — " + fmtMoney(total) + " לסגירה מהירה",
    metrics: [
      { label: "חובות קטנים", value: String(small.length) },
      { label: "סה\"כ",       value: fmtMoney(total) },
    ],
    sections: [{
      title: "quick wins — מהקטן לגדול",
      items: small.slice(0, 15).map(function (x, i) {
        return (i + 1) + ". " + (x.donor.fullName || "ללא שם") + " | " +
          fmtMoney(x.stats.totalDebt) + " | " + (x.donor.phone || "ללא טלפון");
      }),
    }],
    conclusion: "חובות קטנים נסגרים מהר — השקעה מינימלית, הצלחה מקסימלית.",
    recommendation: "להתחיל מ-" + (small[0].donor.fullName || "ללא שם") +
      " — חוב של " + fmtMoney(small[0].stats.totalDebt) + " בלבד.",
    suggestions: ["למי להתקשר?", "חובות לפי עדיפות"],
  };
}

// ─── insight_at_risk ──────────────────────────────────────────────────────────
function insightAtRisk(ctx) {
  const { getDonorStats, fmtDate, fmtMoney } = ctx;
  const atRisk = ctx.allDonors.map(function (d) {
    const st    = getDonorStats(d);
    const risks = [];
    if (st.daysSinceLastDonation > 365)                     risks.push("לא תרם מעל שנה");
    if (st.totalDebt > 0 && st.daysSinceLastDonation > 180) risks.push("חוב ישן");
    if (st.totalDonations === 1 && st.daysSinceLastDonation > 180) risks.push("תרם פעם אחת");
    if (st.totalPaid === 0 && st.totalDonations > 0)        risks.push("מעולם לא שילם");
    return { donor: d, stats: st, risks: risks };
  }).filter(function (x) { return x.risks.length > 0; })
    .sort(function (a, b) { return b.risks.length - a.risks.length; });

  if (!atRisk.length) {
    return {
      summary: "לא זוהו תורמים בסיכון גבוה. ✅",
      metrics: [], sections: [],
      conclusion: "כל התורמים פעילים.",
      recommendation: "לשמר קשר שוטף.",
      suggestions: ["מצב המערכת"],
    };
  }

  const highRisk = atRisk.filter(function (x) { return x.risks.length >= 2; });

  return {
    summary: atRisk.length + " תורמים בסיכון נטישה — " + highRisk.length + " בסיכון גבוה",
    metrics: [
      { label: "בסיכון",      value: String(atRisk.length) },
      { label: "סיכון גבוה",  value: String(highRisk.length) },
    ],
    sections: [{
      title: "תורמים בסיכון",
      urgent: highRisk.length > 0,
      items: atRisk.slice(0, 15).map(function (x, i) {
        return (i + 1) + ". " + (x.donor.fullName || "ללא שם") + " | " + x.risks.join(", ");
      }),
    }],
    conclusion: highRisk.length + " תורמים בסיכון גבוה — יש לפנות בדחיפות.",
    recommendation: "לפנות מיד ל-" + (highRisk[0] ? highRisk[0].donor.fullName : atRisk[0].donor.fullName) +
      " לחידוש קשר לפני שיאבד.",
    suggestions: ["למי להתקשר?", "תורמים רדומים"],
  };
}

// ─── insight_follow_up ────────────────────────────────────────────────────────
function insightFollowUp(ctx) {
  const { openTasks, urgentTasks, upcomingReminders, fmtDate } = ctx;
  const overdue  = openTasks.filter(function (t) { return t.dueDate && new Date(t.dueDate) < new Date(); });
  const noDate   = openTasks.filter(function (t) { return !t.dueDate; });

  return {
    summary: openTasks.length + " משימות פתוחות — " + overdue.length + " פגו תוקף",
    metrics: [
      { label: "פתוחות",       value: String(openTasks.length) },
      { label: "פגי תוקף",     value: String(overdue.length) },
      { label: "תזכורות",       value: String(upcomingReminders.length) },
      { label: "ללא תאריך",    value: String(noDate.length) },
    ],
    sections: [
      overdue.length ? {
        title: "פגי תוקף — לטפל מיד",
        urgent: true,
        items: overdue.slice(0, 8).map(function (t) {
          return (t.title || t.text || "משימה") + " | " + fmtDate(t.dueDate) + " ⚠️";
        }),
      } : null,
    ].filter(Boolean),
    conclusion: overdue.length
      ? overdue.length + " משימות פגו תוקף — לא נעשה דבר בזמן."
      : noDate.length
      ? noDate.length + " משימות ללא תאריך — לא ניתן לתעדף."
      : "כל המשימות בסדר.",
    recommendation: overdue.length
      ? "לסדר מיד את " + overdue.length + " המשימות שפגו תוקף."
      : noDate.length
      ? "להוסיף תאריכי יעד ל-" + noDate.length + " משימות פתוחות."
      : "לסדר תזכורות לשבוע הקרוב.",
    suggestions: ["משימות דחופות", "תזכורות קרובות"],
  };
}

// ─── insight_potential ────────────────────────────────────────────────────────
function insightPotential(ctx) {
  const { getDonorStats, fmtMoney } = ctx;
  const potential = ctx.allDonors.map(function (d) {
    const st = getDonorStats(d);
    if (st.totalPaid > 1000 && st.daysSinceLastDonation > 90 && st.totalDebt === 0) {
      return { donor: d, stats: st };
    }
    return null;
  }).filter(Boolean)
    .sort(function (a, b) { return b.stats.totalPaid - a.stats.totalPaid; });

  if (!potential.length) {
    return {
      summary: "לא נמצאו תורמים בעלי פוטנציאל גבוה שלא פנו אליהם.",
      metrics: [], sections: [],
      conclusion: "אין פוטנציאל גנוז כרגע.",
      recommendation: "לעקוב אחר תורמים חדשים.",
      suggestions: ["מצב המערכת"],
    };
  }

  return {
    summary: potential.length + " תורמים עם פוטנציאל גבוה שלא פנו אליהם",
    metrics: [
      { label: "פוטנציאל",    value: String(potential.length) },
      { label: "פוטנציאל ממוצע", value: fmtMoney(Math.round(potential.reduce(function (s, x) { return s + x.stats.totalPaid; }, 0) / potential.length)) },
    ],
    sections: [{
      title: "תורמים בעלי פוטנציאל (שילמו בעבר, לא פנינו לאחרונה)",
      items: potential.slice(0, 12).map(function (x, i) {
        const months = Math.floor(x.stats.daysSinceLastDonation / 30);
        return (i + 1) + ". " + (x.donor.fullName || "ללא שם") + " | שילם " +
          fmtMoney(x.stats.totalPaid) + " | " + months + " חודשים | " + (x.donor.phone || "ללא טלפון");
      }),
    }],
    conclusion: "תורמים אלו הוכיחו יכולת — שווה לפנות אליהם.",
    recommendation: "לפנות ל-" + (potential[0].donor.fullName || "ללא שם") +
      " — שילם " + fmtMoney(potential[0].stats.totalPaid) + " ולא נפנה אליו " +
      Math.floor(potential[0].stats.daysSinceLastDonation / 30) + " חודשים.",
    suggestions: ["למי להתקשר?", "תורמים רדומים"],
  };
}

// ─── insight_success_rate ─────────────────────────────────────────────────────
function insightSuccessRate(ctx) {
  const { summary, monthlyTrend, fmtMoney } = ctx;
  const grandTotal = summary.totalPaid + summary.totalDebt;
  const rate       = grandTotal > 0 ? ((summary.totalPaid / grandTotal) * 100).toFixed(1) : 0;

  const sections = [];
  if (monthlyTrend.length >= 3) {
    const recent      = monthlyTrend.slice(-3);
    const recentTotal = recent.reduce(function (s, e) { return s + e[1].total; }, 0);
    sections.push({
      title: "גביה 3 חודשים אחרונים",
      items: recent.map(function (e) {
        return e[0] + ": " + e[1].count + " תרומות | " + fmtMoney(e[1].total);
      }).concat(["סה\"כ: " + fmtMoney(recentTotal)]),
    });
  }

  return {
    summary: "שיעור גביה: " + rate + "% — שולם " + fmtMoney(summary.totalPaid) + " מתוך " + fmtMoney(grandTotal),
    metrics: [
      { label: "שיעור גביה", value: rate + "%" },
      { label: "שולם",       value: fmtMoney(summary.totalPaid) },
      { label: "חוב נותר",   value: fmtMoney(summary.totalDebt) },
    ],
    sections: sections,
    conclusion: Number(rate) > 75 ? "✅ שיעור גביה טוב מאוד."
      : Number(rate) > 50 ? "⚠️ שיעור גביה בינוני — יש מה לשפר."
      : "🔴 שיעור גביה נמוך — נדרשת פעולה.",
    recommendation: Number(rate) < 70
      ? "לפתוח קמפיין גביה — " + fmtMoney(summary.totalDebt) + " עדיין ממתינים."
      : "לשמר ביצועים ולעקוב חודשית.",
    suggestions: ["חובות לפי עדיפות", "מגמה חודשית"],
  };
}

// ─── insight_debt_priority ────────────────────────────────────────────────────
function insightDebtPriority(ctx) {
  const { withDebt, fmtMoney } = ctx;
  if (!withDebt.length) {
    return {
      summary: "אין חובות פתוחים. ✅",
      metrics: [], sections: [],
      conclusion: "לא נדרש טיפול בחובות.",
      recommendation: "לא נדרשת פעולה.",
      suggestions: ["מצב המערכת"],
    };
  }

  const scored = withDebt.map(function (x) {
    const d = x.donor;
    const priority = (x.stats.totalDebt / 100) +
      (x.stats.daysSinceLastDonation / 10) +
      (d.phone ? 1 : 0);
    return Object.assign({}, x, { priority: priority });
  }).sort(function (a, b) { return b.priority - a.priority; });

  return {
    summary: "קדימות טיפול בחובות — " + scored.length + " תורמים חייבים",
    metrics: [
      { label: "חייבים",   value: String(scored.length) },
      { label: "סה\"כ חוב", value: fmtMoney(scored.reduce(function (s, x) { return s + x.stats.totalDebt; }, 0)) },
    ],
    sections: [{
      title: "לפי קדימות (גודל + ותיקות + טלפון)",
      items: scored.slice(0, 12).map(function (x, i) {
        const phone  = x.donor.phone ? "📞" : "❌";
        const months = x.stats.daysSinceLastDonation < Infinity
          ? Math.floor(x.stats.daysSinceLastDonation / 30) + " חודשים"
          : "אף פעם";
        return (i + 1) + ". " + (x.donor.fullName || "ללא שם") + " | " +
          fmtMoney(x.stats.totalDebt) + " | " + months + " | " + phone;
      }),
    }],
    conclusion: "הטיפול לפי קדימות יבטיח גביה מקסימלית.",
    recommendation: "להתחיל מ-" + (scored[0].donor.fullName || "ללא שם") + " — " +
      fmtMoney(scored[0].stats.totalDebt) + ".",
    suggestions: ["למי להתקשר?", "quick wins"],
  };
}

// ─── insight_before_holiday ───────────────────────────────────────────────────
function insightBeforeHoliday(ctx) {
  const { allDonors, summary, fmtMoney, getDonorStats } = ctx;
  const prospects = allDonors.map(function (d) {
    const st    = getDonorStats(d);
    var score   = 0;
    if (st.totalDebt > 0)                          score += 3;
    if (d.phone)                                   score += 2;
    if (st.totalPaid > 500)                        score += 2;
    if ((d.ivrApprovedPhones || []).length > 0)    score += 1;
    return { donor: d, stats: st, score: score };
  }).filter(function (x) { return x.score >= 4 && x.donor.phone; })
    .sort(function (a, b) { return b.score - a.score; });

  return {
    summary: "הכנה לקמפיין חג — " + prospects.length + " תורמים מומלצים",
    metrics: [
      { label: "מוכנים לקמפיין",  value: String(summary.campaignReady) },
      { label: "עם חוב + טלפון",  value: String(prospects.length) },
    ],
    sections: [
      {
        title: "תורמים מומלצים לקמפיין חג",
        items: prospects.slice(0, 10).map(function (x, i) {
          const debtStr = x.stats.totalDebt > 0 ? " | חוב: " + fmtMoney(x.stats.totalDebt) : "";
          return (i + 1) + ". " + (x.donor.fullName || "ללא שם") + " | " + x.donor.phone + debtStr;
        }),
      },
      {
        title: "טיפים לקמפיין חג",
        items: [
          "לשגר 2-3 ימים לפני החג",
          "הודעה מותאמת אישית — ציון שם התורם",
          "להתחיל מתורמים עם חוב — שתי סיבות לפנות",
          "שיחת חג + בקשת תרומה = עלייה של 20-40%",
        ],
      },
    ],
    conclusion: "קמפיין חג עם הודעה מותאמת אישית מגדיל גביה משמעותית.",
    recommendation: "לשגר ל-" + prospects.length + " תורמים מומלצים, להתחיל מ-" +
      (prospects[0] ? prospects[0].donor.fullName : "הרשימה") + ".",
    suggestions: ["מוכנות לקמפיין", "למי להתקשר?"],
  };
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────
function dispatch(intentName, ctx) {
  switch (intentName) {
    case "insight_who_to_call":    return insightWhoToCall(ctx);
    case "insight_quick_wins":     return insightQuickWins(ctx);
    case "insight_at_risk":        return insightAtRisk(ctx);
    case "insight_follow_up":      return insightFollowUp(ctx);
    case "insight_potential":      return insightPotential(ctx);
    case "insight_success_rate":   return insightSuccessRate(ctx);
    case "insight_debt_priority":  return insightDebtPriority(ctx);
    case "insight_before_holiday": return insightBeforeHoliday(ctx);
    default: return null;
  }
}

module.exports = { dispatch };

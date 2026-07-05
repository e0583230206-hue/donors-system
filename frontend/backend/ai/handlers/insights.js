"use strict";
// handlers/insights.js — 8 cross-cutting insight handlers

function num(v) { return Number(v || 0); }

// ─── insight_who_to_call ──────────────────────────────────────────────────────
function insightWhoToCall(ctx) {
  const { withDebt, dormant180, fmtMoney, getDonorStats } = ctx;

  // Score: has debt + dormant + has phone = high priority
  const candidates = ctx.allDonors.map(d => {
    const st = getDonorStats(d);
    let score = 0;
    if (st.totalDebt > 0) score += 3;
    if (st.daysSinceLastDonation > 90 && st.daysSinceLastDonation < 730) score += 2;
    if (st.daysSinceLastDonation > 30) score += 1;
    if (d.phone) score += 1;
    if ((d.ivrApprovedPhones || []).length > 0) score += 1;
    if (st.totalPaid > 0) score += 1; // previously paid — likely to pay again
    return { donor: d, stats: st, score };
  }).filter(x => x.score > 3 && x.donor.phone)
    .sort((a, b) => b.score - a.score || b.stats.totalDebt - a.stats.totalDebt);

  if (!candidates.length) {
    return { answer: "✅ לא נמצאו תורמים בעדיפות גבוהה לשיחות כרגע.", suggestions: ["מצב המערכת"] };
  }
  const lines = [`**📞 מי כדאי להתקשר אליו היום (לפי עדיפות):**\n`];
  candidates.slice(0, 10).forEach((x, i) => {
    const debtStr = x.stats.totalDebt > 0 ? ` | חוב: ${fmtMoney(x.stats.totalDebt)}` : "";
    const days = x.stats.daysSinceLastDonation < Infinity ? ` | ${Math.floor(x.stats.daysSinceLastDonation / 30)} חודשים` : "";
    lines.push(`${i + 1}. ${x.donor.fullName || "ללא שם"} | ${x.donor.phone}${debtStr}${days}`);
  });
  lines.push(`\n_סדר עדיפויות: חוב פתוח + ותיקות + טלפון מאושר_`);

  return {
    answer: lines.join("\n"),
    suggestions: ["חובות לפי עדיפות", "תורמים רדומים"],
  };
}

// ─── insight_quick_wins ───────────────────────────────────────────────────────
function insightQuickWins(ctx) {
  const { withDebt, fmtMoney } = ctx;
  const small = withDebt
    .filter(x => x.stats.totalDebt > 0 && x.stats.totalDebt < 500 && x.donor.phone)
    .sort((a, b) => a.stats.totalDebt - b.stats.totalDebt);

  if (!small.length) {
    return { answer: "לא נמצאו חובות קטנים פתוחים.", suggestions: ["חובות לפי עדיפות"] };
  }
  const total = small.reduce((s, x) => s + x.stats.totalDebt, 0);
  const lines = [
    `**⚡ Quick Wins — חובות קטנים לסגירה מהירה:**`,
    `${small.length} תורמים, סה"כ ${fmtMoney(total)}\n`,
  ];
  small.slice(0, 15).forEach((x, i) => {
    lines.push(`${i + 1}. ${x.donor.fullName || "ללא שם"} | ${fmtMoney(x.stats.totalDebt)}${x.donor.phone ? " | " + x.donor.phone : ""}`);
  });
  lines.push("\n_טיפ: תורמים עם חוב קטן לרוב פותחים מהר — התחל מהם._");

  return {
    answer: lines.join("\n"),
    suggestions: ["למי להתקשר?", "חובות לפי עדיפות"],
  };
}

// ─── insight_at_risk ──────────────────────────────────────────────────────────
function insightAtRisk(ctx) {
  const { getDonorStats, fmtDate, fmtMoney } = ctx;
  const atRisk = ctx.allDonors.map(d => {
    const st = getDonorStats(d);
    const risk = [];
    if (st.daysSinceLastDonation > 365) risk.push("לא תרם מעל שנה");
    if (st.totalDebt > 0 && st.daysSinceLastDonation > 180) risk.push("חוב ישן");
    if (st.totalDonations === 1 && st.daysSinceLastDonation > 180) risk.push("תרם פעם אחת");
    if (st.totalPaid === 0 && st.totalDonations > 0) risk.push("מעולם לא שילם");
    return { donor: d, stats: st, risk };
  }).filter(x => x.risk.length > 0)
    .sort((a, b) => b.risk.length - a.risk.length || b.stats.daysSinceLastDonation - a.stats.daysSinceLastDonation);

  if (!atRisk.length) {
    return { answer: "✅ לא זוהו תורמים בסיכון גבוה.", suggestions: ["מצב המערכת"] };
  }
  const lines = [`**⚠️ תורמים בסיכון נטישה — ${atRisk.length}:**\n`];
  atRisk.slice(0, 15).forEach((x, i) => {
    lines.push(`${i + 1}. ${x.donor.fullName || "ללא שם"} | ${x.risk.join(", ")}`);
  });
  lines.push("\n_טיפ: שיחת חידוש קשר עם תורמים שלא פנו אליהם יכולה להחזיר עד 30% מהם._");

  return {
    answer: lines.join("\n"),
    suggestions: ["למי להתקשר?", "תורמים רדומים"],
  };
}

// ─── insight_follow_up ────────────────────────────────────────────────────────
function insightFollowUp(ctx) {
  const { openTasks, urgentTasks, upcomingReminders, fmtDate } = ctx;
  const noProgress = openTasks.filter(t => !t.dueDate).length;
  const overdue    = openTasks.filter(t => t.dueDate && new Date(t.dueDate) < new Date());

  const lines = [
    `**🔄 מעקב נדרש:**`,
    `• משימות ללא תאריך: ${noProgress} (חסרות דחיפות)`,
    `• משימות שפג תוקפן: ${overdue.length}`,
    `• תזכורות ב-7 ימים: ${upcomingReminders.length}`,
    `• משימות דחופות: ${urgentTasks.length}\n`,
  ];
  if (overdue.length) {
    lines.push("משימות שפג תוקפן:");
    overdue.slice(0, 8).forEach((t, i) => {
      lines.push(`${i + 1}. ${t.title || t.text || "משימה"} | ${fmtDate(t.dueDate)}`);
    });
  }
  if (!overdue.length && !urgentTasks.length) {
    lines.push("✅ כל המשימות הדחופות מטופלות.");
  }

  return {
    answer: lines.join("\n"),
    suggestions: ["משימות דחופות", "תזכורות קרובות"],
  };
}

// ─── insight_potential ────────────────────────────────────────────────────────
function insightPotential(ctx) {
  const { getDonorStats, fmtMoney } = ctx;
  const potential = ctx.allDonors.map(d => {
    const st = getDonorStats(d);
    // High potential: paid well in the past but hasn't given recently
    if (st.totalPaid > 1000 && st.daysSinceLastDonation > 90 && st.totalDebt === 0) {
      return { donor: d, stats: st, potential: st.totalPaid };
    }
    return null;
  }).filter(Boolean)
    .sort((a, b) => b.potential - a.potential);

  if (!potential.length) {
    return { answer: "לא נמצאו תורמים בעלי פוטנציאל גבוה שלא פנו אליהם לאחרונה.", suggestions: ["מצב המערכת"] };
  }
  const lines = [`**💎 פוטנציאל גבוה — ${potential.length} תורמים:**\n`];
  potential.slice(0, 12).forEach((x, i) => {
    const months = Math.floor(x.stats.daysSinceLastDonation / 30);
    lines.push(
      `${i + 1}. ${x.donor.fullName || "ללא שם"} | שילם ${fmtMoney(x.stats.totalPaid)} | ` +
      `${months} חודשים מאז | ${x.donor.phone || "ללא טלפון"}`
    );
  });
  lines.push("\n_אלו תורמים שהוכיחו כי ביכולתם לתרום — שווה ליצור קשר._");

  return {
    answer: lines.join("\n"),
    suggestions: ["למי להתקשר?", "תורמים רדומים"],
  };
}

// ─── insight_success_rate ─────────────────────────────────────────────────────
function insightSuccessRate(ctx) {
  const { summary, fmtMoney, monthlyTrend } = ctx;
  const paidTotal = summary.totalPaid;
  const debtTotal = summary.totalDebt;
  const grandTotal = paidTotal + debtTotal;
  const rate = grandTotal > 0 ? ((paidTotal / grandTotal) * 100).toFixed(1) : 0;

  const lines = [
    `**📊 שיעור גביה:**`,
    `• שיעור גביה כולל: ${rate}%`,
    `• שולם: ${fmtMoney(paidTotal)}`,
    `• נותר חוב: ${fmtMoney(debtTotal)}`,
    `• סה"כ ניהול: ${fmtMoney(grandTotal)}`,
    `• תורמים ששילמו: ${summary.activeDonors} מתוך ${summary.totalDonors}`,
  ];

  if (monthlyTrend.length >= 3) {
    const recent = monthlyTrend.slice(-3);
    const recentTotal = recent.reduce((s, [, d]) => s + d.total, 0);
    lines.push(`\n📅 גביה ב-3 חודשים אחרונים: ${fmtMoney(recentTotal)}`);
  }

  let assessment = "";
  if (Number(rate) > 75) assessment = "✅ שיעור גביה טוב מאוד.";
  else if (Number(rate) > 50) assessment = "⚠️ שיעור גביה בינוני — יש מה לשפר.";
  else assessment = "🔴 שיעור גביה נמוך — דרושה פעולה.";
  lines.push("\n" + assessment);

  return {
    answer: lines.join("\n"),
    suggestions: ["מגמה חודשית", "חובות לפי עדיפות"],
  };
}

// ─── insight_debt_priority ────────────────────────────────────────────────────
function insightDebtPriority(ctx) {
  const { withDebt, fmtMoney, daysSince } = ctx;
  // Score: size of debt + time since last payment + has phone
  const scored = withDebt.map(x => {
    const d = x.donor;
    const debt = x.stats.totalDebt;
    const age = x.stats.daysSinceLastDonation;
    const phoneBonus = d.phone ? 1 : 0;
    const priority = (debt / 100) + (age / 10) + phoneBonus;
    return { ...x, priority };
  }).sort((a, b) => b.priority - a.priority);

  if (!scored.length) {
    return { answer: "✅ אין חובות פתוחים.", suggestions: ["מצב המערכת"] };
  }
  const lines = [`**🎯 חובות לפי קדימות טיפול:**\n`];
  scored.slice(0, 12).forEach((x, i) => {
    const phone = x.donor.phone ? "📞" : "❌";
    const months = x.stats.daysSinceLastDonation < Infinity
      ? `${Math.floor(x.stats.daysSinceLastDonation / 30)} חודשים`
      : "אף פעם";
    lines.push(`${i + 1}. ${x.donor.fullName || "ללא שם"} | ${fmtMoney(x.stats.totalDebt)} | ${months} | ${phone}`);
  });
  lines.push("\n_קריטריונים: גודל חוב + ותיקות + זמינות טלפון_");

  return {
    answer: lines.join("\n"),
    suggestions: ["למי להתקשר?", "quick wins"],
  };
}

// ─── insight_before_holiday ───────────────────────────────────────────────────
function insightBeforeHoliday(ctx) {
  const { withDebt, fmtMoney, summary, getDonorStats } = ctx;
  // Best prospects: has debt + phone + donated in the past near holidays
  const prospects = ctx.allDonors
    .map(d => {
      const st = getDonorStats(d);
      const score =
        (st.totalDebt > 0 ? 3 : 0) +
        (d.phone ? 2 : 0) +
        (st.totalPaid > 500 ? 2 : 0) +
        ((d.ivrApprovedPhones || []).length > 0 ? 1 : 0);
      return { donor: d, stats: st, score };
    })
    .filter(x => x.score >= 4 && x.donor.phone)
    .sort((a, b) => b.score - a.score);

  const lines = [
    `**🕍 הכנה לקמפיין חג:**`,
    `• תורמים מוכנים לחיוג: ${summary.campaignReady}`,
    `• עם חוב פתוח וטלפון: ${withDebt.filter(x => x.donor.phone).length}`,
    `• המלצה לקמפיין: ${prospects.length} תורמים בעדיפות גבוהה\n`,
  ];
  if (prospects.length) {
    lines.push("תורמים מומלצים לקמפיין חג:");
    prospects.slice(0, 10).forEach((x, i) => {
      const debtStr = x.stats.totalDebt > 0 ? ` | חוב: ${fmtMoney(x.stats.totalDebt)}` : "";
      lines.push(`${i + 1}. ${x.donor.fullName || "ללא שם"} | ${x.donor.phone}${debtStr}`);
    });
  }
  lines.push("\n_טיפ: קמפיין חג עם הודעה מותאמת אישית מגדיל גביה ב-20-40%._");

  return {
    answer: lines.join("\n"),
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

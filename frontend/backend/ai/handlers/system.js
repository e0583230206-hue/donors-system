"use strict";
// handlers/system.js — all 21 system-wide intent handlers

function num(v) { return Number(v || 0); }

// ─── system_summary ───────────────────────────────────────────────────────────
function systemSummary(ctx) {
  const { summary, fmtMoney, urgentTasks } = ctx;
  const lines = [
    "**📊 סיכום מצב המערכת:**",
    `• תורמים: ${summary.totalDonors} (פעילים: ${summary.activeDonors})`,
    `• סה"כ חוב פתוח: ${fmtMoney(summary.totalDebt)} (${summary.withDebt} תורמים)`,
    `• סה"כ שולם: ${fmtMoney(summary.totalPaid)}`,
    `• לא תרמו חצי שנה: ${summary.dormant180} תורמים`,
    `• לא תרמו שנה: ${summary.dormant365} תורמים`,
    `• משימות פתוחות: ${summary.openTasksCount}${summary.urgentCount > 0 ? ` (${summary.urgentCount} דחופות!)` : ""}`,
    `• מוכנים לקמפיין: ${summary.campaignReady} תורמים`,
    `• ללא טלפון: ${summary.noPhone}`,
  ];
  const alerts = [];
  if (summary.urgentCount > 0) alerts.push(`⚠️ ${summary.urgentCount} משימות דחופות!`);
  if (summary.dormant365 > 5) alerts.push(`⚠️ ${summary.dormant365} תורמים לא תרמו מעל שנה.`);
  if (summary.totalDebt > 50000) alerts.push(`⚠️ חוב כולל גבוה: ${fmtMoney(summary.totalDebt)}`);
  if (alerts.length) lines.push("\n" + alerts.join("\n"));

  return {
    answer: lines.join("\n"),
    suggestions: ["חובות לפי עדיפות", "למי כדאי להתקשר?", "תורמים שלא תרמו זמן רב"],
  };
}

// ─── system_dormant ───────────────────────────────────────────────────────────
function systemDormant(ctx, detected) {
  const { fmtDate, fmtMoney, getDonorStats } = ctx;
  const months = detected.entities.months || 6;
  const threshold = months * 30;

  const dormantList = ctx.allDonors.filter(d => {
    const st = getDonorStats(d);
    return st.daysSinceLastDonation >= threshold;
  }).map(d => {
    const st = getDonorStats(d);
    return { donor: d, stats: st };
  }).sort((a, b) => (a.stats.lastDonationDate || "0").localeCompare(b.stats.lastDonationDate || "0"));

  if (!dormantList.length) {
    return {
      answer: `✅ לא נמצאו תורמים שלא תרמו ב-${months} חודשים האחרונים.`,
      suggestions: ["מצב כללי של המערכת", "חובות לפי עדיפות"],
    };
  }
  const withDebt = dormantList.filter(x => x.stats.totalDebt > 0);
  const lines = [
    `**תורמים שלא תרמו ב-${months} חודשים — ${dormantList.length} תורמים:**`,
    `(מתוכם ${withDebt.length} עם חובות פתוחים)\n`,
  ];
  dormantList.slice(0, 20).forEach((x, i) => {
    const last = x.stats.lastDonationDate ? fmtDate(x.stats.lastDonationDate) : "אף פעם";
    const debt = x.stats.totalDebt > 0 ? ` | חוב: ${fmtMoney(x.stats.totalDebt)}` : "";
    lines.push(`${i + 1}. ${x.donor.fullName || "ללא שם"} | אחרונה: ${last}${debt}`);
  });
  if (dormantList.length > 20) lines.push(`... ועוד ${dormantList.length - 20}.`);

  return {
    answer: lines.join("\n"),
    suggestions: ["למי כדאי להתקשר?", "חובות לפי עדיפות", "תורמים שלא תרמו שנה"],
  };
}

// ─── system_priority_debts ────────────────────────────────────────────────────
function systemPriorityDebts(ctx) {
  const { withDebt, fmtMoney, summary } = ctx;
  if (!withDebt.length) {
    return { answer: "✅ אין חובות פתוחים במערכת.", suggestions: ["מצב המערכת"] };
  }
  const sorted = withDebt.slice().sort((a, b) => b.stats.totalDebt - a.stats.totalDebt);
  const grandTotal = sorted.reduce((s, x) => s + x.stats.totalDebt, 0);
  const lines = [
    `**חובות פתוחים לפי עדיפות — ${sorted.length} תורמים, סה"כ ${fmtMoney(grandTotal)}:**\n`,
  ];
  sorted.slice(0, 20).forEach((x, i) => {
    const d = x.donor;
    lines.push(
      `${i + 1}. ${d.fullName || "ללא שם"} — ${fmtMoney(x.stats.totalDebt)}` +
      `${d.city ? " | " + d.city : ""}${d.phone ? " | " + d.phone : ""}`
    );
  });
  if (sorted.length > 20) lines.push(`... ועוד ${sorted.length - 20} תורמים.`);

  return {
    answer: lines.join("\n"),
    suggestions: ["למי כדאי להתקשר?", "תורמים שלא תרמו זמן רב"],
  };
}

// ─── system_top_donors ────────────────────────────────────────────────────────
function systemTopDonors(ctx, detected) {
  const { statsPerDonor, fmtMoney } = ctx;
  const n = detected.entities.topN || 10;
  const ranked = statsPerDonor
    .filter(x => x.stats.totalPaid > 0)
    .sort((a, b) => b.stats.totalPaid - a.stats.totalPaid)
    .slice(0, n);

  if (!ranked.length) {
    return { answer: "לא נמצאו תרומות שולמו.", suggestions: ["מצב המערכת"] };
  }
  const lines = [`**${n} התורמים הגדולים ביותר:**\n`];
  ranked.forEach((x, i) => {
    lines.push(
      `${i + 1}. ${x.donor.fullName || "ללא שם"} — ${fmtMoney(x.stats.totalPaid)} (${x.stats.paidCount} תשלומים)`
    );
  });

  return {
    answer: lines.join("\n"),
    suggestions: ["מצב המערכת", "חובות לפי עדיפות"],
  };
}

// ─── system_total_debt ────────────────────────────────────────────────────────
function systemTotalDebt(ctx) {
  const { summary, fmtMoney } = ctx;
  const avg = summary.withDebt > 0 ? Math.round(summary.totalDebt / summary.withDebt) : 0;
  const lines = [
    `**חוב כולל במערכת:**`,
    `• סה"כ: ${fmtMoney(summary.totalDebt)}`,
    `• תורמים עם חוב: ${summary.withDebt} מתוך ${summary.totalDonors}`,
    `• ממוצע לתורם חייב: ${fmtMoney(avg)}`,
    `• אחוז חייבים: ${summary.totalDonors ? ((summary.withDebt / summary.totalDonors) * 100).toFixed(0) : 0}%`,
  ];

  return {
    answer: lines.join("\n"),
    suggestions: ["חובות לפי עדיפות", "החייב הגדול ביותר"],
  };
}

// ─── system_total_paid ────────────────────────────────────────────────────────
function systemTotalPaid(ctx) {
  const { summary, statsPerDonor, fmtMoney } = ctx;
  const payers = statsPerDonor.filter(x => x.stats.totalPaid > 0);
  const avg = payers.length ? Math.round(summary.totalPaid / payers.length) : 0;
  const lines = [
    `**גביה כוללת:**`,
    `• סה"כ שולם: ${fmtMoney(summary.totalPaid)}`,
    `• תורמים ששילמו: ${payers.length}`,
    `• ממוצע לתורם: ${fmtMoney(avg)}`,
    `• חוב נותר: ${fmtMoney(summary.totalDebt)}`,
    `• שיעור גביה: ${(summary.totalPaid + summary.totalDebt) > 0 ? ((summary.totalPaid / (summary.totalPaid + summary.totalDebt)) * 100).toFixed(1) : 0}%`,
  ];

  return {
    answer: lines.join("\n"),
    suggestions: ["מגמה חודשית", "התורמים הגדולים"],
  };
}

// ─── system_active_count ──────────────────────────────────────────────────────
function systemActiveCount(ctx) {
  const { summary, fmtMoney } = ctx;
  const lines = [
    `**ספירת תורמים:**`,
    `• סה"כ תורמים: ${summary.totalDonors}`,
    `• פעילים: ${summary.activeDonors}`,
    `• לא פעילים: ${summary.totalDonors - summary.activeDonors}`,
    `• אף פעם לא תרמו: ${summary.neverGiven}`,
    `• עם חוב פתוח: ${summary.withDebt}`,
    `• ללא טלפון: ${summary.noPhone}`,
    `• מוכנים לקמפיין: ${summary.campaignReady}`,
  ];

  return {
    answer: lines.join("\n"),
    suggestions: ["מצב המערכת", "תורמים שלא תרמו זמן רב"],
  };
}

// ─── system_new_donors ────────────────────────────────────────────────────────
function systemNewDonors(ctx, detected) {
  const { allDonors, fmtDate } = ctx;
  const days = detected.entities.days || 30;
  const threshold = new Date(Date.now() - days * 86400000);
  const newOnes = allDonors.filter(d => {
    const created = d.createdAt || d.id;
    if (!d.createdAt) return false;
    return new Date(d.createdAt) >= threshold;
  }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (!newOnes.length) {
    return {
      answer: `לא נמצאו תורמים שנוספו ב-${days} הימים האחרונים.`,
      suggestions: ["ספירת תורמים", "מצב המערכת"],
    };
  }
  const lines = [`**תורמים חדשים (${days} יום אחרון) — ${newOnes.length}:**\n`];
  newOnes.slice(0, 15).forEach((d, i) => {
    lines.push(`${i + 1}. ${d.fullName || "ללא שם"} | ${fmtDate(d.createdAt)}${d.city ? " | " + d.city : ""}`);
  });

  return {
    answer: lines.join("\n"),
    suggestions: ["ספירת תורמים", "מצב המערכת"],
  };
}

// ─── system_by_city ───────────────────────────────────────────────────────────
function systemByCity(ctx) {
  const { citySorted } = ctx;
  if (!citySorted.length) {
    return { answer: "לא נמצאו נתוני עיר.", suggestions: ["מצב המערכת"] };
  }
  const lines = [`**פיזור תורמים לפי עיר (${citySorted.length} ערים):**\n`];
  citySorted.forEach(([city, count], i) => {
    lines.push(`${i + 1}. ${city} — ${count} תורמים`);
  });

  return {
    answer: lines.join("\n"),
    suggestions: ["ספירת תורמים", "מצב המערכת"],
  };
}

// ─── system_by_purpose ────────────────────────────────────────────────────────
function systemByPurpose(ctx) {
  const { purposeMap } = ctx;
  const sorted = Object.entries(purposeMap).sort((a, b) => b[1] - a[1]);
  if (!sorted.length) {
    return { answer: "לא נמצאו תרומות.", suggestions: ["מצב המערכת"] };
  }
  const total = sorted.reduce((s, e) => s + e[1], 0);
  const lines = [`**תרומות לפי מטרה (${total} סה"כ):**\n`];
  sorted.forEach(([purpose, count], i) => {
    const pct = total ? ((count / total) * 100).toFixed(0) : 0;
    lines.push(`${i + 1}. ${purpose} — ${count} (${pct}%)`);
  });

  return {
    answer: lines.join("\n"),
    suggestions: ["מצב המערכת", "גביה כוללת"],
  };
}

// ─── system_open_tasks ────────────────────────────────────────────────────────
function systemOpenTasks(ctx) {
  const { openTasks, fmtDate } = ctx;
  if (!openTasks.length) {
    return { answer: "✅ אין משימות פתוחות.", suggestions: ["מצב המערכת"] };
  }
  const overdue = openTasks.filter(t => t.dueDate && new Date(t.dueDate) < new Date());
  const soon    = openTasks.filter(t => t.dueDate && new Date(t.dueDate) < new Date(Date.now() + 7 * 86400000) && new Date(t.dueDate) >= new Date());
  const lines = [
    `**משימות פתוחות — ${openTasks.length} סה"כ:**`,
    `• פגי תוקף: ${overdue.length}`,
    `• צפויות ב-7 ימים: ${soon.length}`,
    `• ללא תאריך: ${openTasks.filter(t => !t.dueDate).length}\n`,
  ];
  const toShow = [...overdue, ...soon].slice(0, 10);
  if (toShow.length) {
    lines.push("המשימות הדחופות:");
    toShow.forEach((t, i) => {
      const due = t.dueDate ? fmtDate(t.dueDate) : "ללא תאריך";
      const flag = new Date(t.dueDate) < new Date() ? " ⚠️" : "";
      lines.push(`${i + 1}. ${t.title || t.text || "משימה"} | ${due}${flag}`);
    });
  }

  return {
    answer: lines.join("\n"),
    suggestions: ["משימות דחופות", "מצב המערכת"],
  };
}

// ─── system_urgent_tasks ──────────────────────────────────────────────────────
function systemUrgentTasks(ctx) {
  const { urgentTasks, fmtDate } = ctx;
  if (!urgentTasks.length) {
    return { answer: "✅ אין משימות דחופות.", suggestions: ["כל המשימות", "מצב המערכת"] };
  }
  const overdue = urgentTasks.filter(t => new Date(t.dueDate) < new Date());
  const lines = [`**משימות דחופות — ${urgentTasks.length}:**\n`];
  urgentTasks.forEach((t, i) => {
    const flag = new Date(t.dueDate) < new Date() ? "⚠️ פג תוקף" : "🔜 קרוב";
    lines.push(`${i + 1}. ${t.title || t.text || "משימה"} | ${fmtDate(t.dueDate)} | ${flag}`);
  });
  if (overdue.length) lines.push(`\n🔴 ${overdue.length} משימות כבר עברו את התאריך!`);

  return {
    answer: lines.join("\n"),
    suggestions: ["כל המשימות", "מצב המערכת"],
  };
}

// ─── system_upcoming_rem ──────────────────────────────────────────────────────
function systemUpcomingRem(ctx) {
  const { upcomingReminders, fmtDate } = ctx;
  if (!upcomingReminders.length) {
    return { answer: "אין תזכורות קרובות ב-7 הימים הקרובים.", suggestions: ["מצב המערכת"] };
  }
  const lines = [`**תזכורות קרובות (7 ימים) — ${upcomingReminders.length}:**\n`];
  upcomingReminders.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.text || r.title || "תזכורת"} | ${fmtDate(r.date || r.dueDate)}`);
  });

  return {
    answer: lines.join("\n"),
    suggestions: ["משימות דחופות", "מצב המערכת"],
  };
}

// ─── system_trend ─────────────────────────────────────────────────────────────
function systemTrend(ctx) {
  const { monthlyTrend, fmtMoney } = ctx;
  if (!monthlyTrend.length) {
    return { answer: "אין נתוני מגמה.", suggestions: ["מצב המערכת"] };
  }
  const lines = [`**מגמת תרומות — 12 חודשים אחרונים:**\n`];
  monthlyTrend.forEach(([month, data]) => {
    const bar = "█".repeat(Math.min(10, Math.round(data.count / 2))) || "░";
    lines.push(`${month}: ${bar} ${data.count} תרומות | ${fmtMoney(data.total)}`);
  });
  if (monthlyTrend.length >= 2) {
    const first = monthlyTrend[0][1].count;
    const last  = monthlyTrend[monthlyTrend.length - 1][1].count;
    if (last > first) lines.push(`\n📈 מגמה עולה (${first} → ${last})`);
    else if (last < first) lines.push(`\n📉 מגמה יורדת (${first} → ${last})`);
    else lines.push(`\n➡️ מגמה יציבה`);
  }

  return {
    answer: lines.join("\n"),
    suggestions: ["גביה כוללת", "מצב המערכת"],
  };
}

// ─── system_by_tag ────────────────────────────────────────────────────────────
function systemByTag(ctx) {
  const { tagMap } = ctx;
  const sorted = Object.entries(tagMap).sort((a, b) => b[1] - a[1]);
  if (!sorted.length) {
    return { answer: "לא נמצאו תגיות.", suggestions: ["מצב המערכת"] };
  }
  const lines = [`**תורמים לפי תגית (${sorted.length} תגיות):**\n`];
  sorted.slice(0, 15).forEach(([tag, count], i) => {
    lines.push(`${i + 1}. ${tag} — ${count} תורמים`);
  });

  return {
    answer: lines.join("\n"),
    suggestions: ["ספירת תורמים", "מצב המערכת"],
  };
}

// ─── system_payment_methods ───────────────────────────────────────────────────
function systemPaymentMethods(ctx) {
  const { methodMap } = ctx;
  const sorted = Object.entries(methodMap).sort((a, b) => b[1] - a[1]);
  if (!sorted.length) {
    return { answer: "לא נמצאו נתוני תשלום.", suggestions: ["מצב המערכת"] };
  }
  const total = sorted.reduce((s, e) => s + e[1], 0);
  const lines = [`**אמצעי תשלום (${total} תשלומים):**\n`];
  sorted.forEach(([method, count], i) => {
    const pct = total ? ((count / total) * 100).toFixed(0) : 0;
    lines.push(`${i + 1}. ${method} — ${count} (${pct}%)`);
  });

  return {
    answer: lines.join("\n"),
    suggestions: ["גביה כוללת", "מצב המערכת"],
  };
}

// ─── system_campaign_ready ────────────────────────────────────────────────────
function systemCampaignReady(ctx) {
  const { allDonors, summary, fmtMoney, getDonorStats } = ctx;
  const ready = allDonors.filter(d => (d.ivrApprovedPhones || []).length > 0 && d.includeInCalls !== false);
  const readyWithDebt = ready.filter(d => getDonorStats(d).totalDebt > 0);
  const lines = [
    `**מוכנות לקמפיין:**`,
    `• תורמים עם מספר מאושר: ${ready.length} מתוך ${summary.totalDonors}`,
    `• מתוכם עם חוב פתוח: ${readyWithDebt.length}`,
    `• ללא מספר מאושר: ${summary.totalDonors - ready.length}`,
    `\n${ready.length > 0 ? `✅ ניתן לשגר ל-${ready.length} תורמים.` : "❌ אין תורמים מוכנים לקמפיין."}`,
  ];

  return {
    answer: lines.join("\n"),
    suggestions: ["חובות לפי עדיפות", "מצב המערכת"],
  };
}

// ─── system_biggest_debtor ────────────────────────────────────────────────────
function systemBiggestDebtor(ctx) {
  const { withDebt, fmtMoney } = ctx;
  if (!withDebt.length) {
    return { answer: "✅ אין חובות פתוחים.", suggestions: ["מצב המערכת"] };
  }
  const top = withDebt.slice().sort((a, b) => b.stats.totalDebt - a.stats.totalDebt)[0];
  const d = top.donor;
  const lines = [
    `**החייב הגדול ביותר:**`,
    `• שם: ${d.fullName || "ללא שם"}`,
    `• חוב: ${fmtMoney(top.stats.totalDebt)}`,
    `• עיר: ${d.city || "לא ידוע"}`,
    `• טלפון: ${d.phone || "לא ידוע"}`,
    `• מספר חובות: ${top.stats.openDebtsCount}`,
  ];

  return {
    answer: lines.join("\n"),
    suggestions: ["חובות לפי עדיפות", "למי כדאי להתקשר?"],
  };
}

// ─── system_recent_payments ───────────────────────────────────────────────────
function systemRecentPayments(ctx, detected) {
  const { allDonors, fmtDate, fmtMoney } = ctx;
  const days = detected.entities.days || 30;
  const threshold = new Date(Date.now() - days * 86400000);
  const recentList = [];
  allDonors.forEach(d => {
    (d.donations || []).forEach(don => {
      if (don.paid && don.date && new Date(don.date) >= threshold) {
        recentList.push({ donor: d, donation: don });
      }
    });
  });
  recentList.sort((a, b) => new Date(b.donation.date) - new Date(a.donation.date));

  if (!recentList.length) {
    return {
      answer: `לא נמצאו תשלומים ב-${days} הימים האחרונים.`,
      suggestions: ["גביה כוללת", "מצב המערכת"],
    };
  }
  const total = recentList.reduce((s, x) => s + num(x.donation.amount) - num(x.donation.remainingDebt), 0);
  const lines = [
    `**תשלומים אחרונים (${days} יום) — ${recentList.length} תשלומים, ${fmtMoney(total)}:**\n`,
  ];
  recentList.slice(0, 15).forEach((x, i) => {
    lines.push(`${i + 1}. ${fmtDate(x.donation.date)} | ${x.donor.fullName || "ללא שם"} | ${fmtMoney(x.donation.amount)}`);
  });

  return {
    answer: lines.join("\n"),
    suggestions: ["גביה כוללת", "מגמה חודשית"],
  };
}

// ─── system_no_phone ─────────────────────────────────────────────────────────
function systemNoPhone(ctx) {
  const { allDonors } = ctx;
  const noPhone = allDonors.filter(d => !d.phone);
  if (!noPhone.length) {
    return { answer: "✅ לכל התורמים יש טלפון רשום.", suggestions: ["ספירת תורמים"] };
  }
  const lines = [`**תורמים ללא טלפון — ${noPhone.length}:**\n`];
  noPhone.slice(0, 20).forEach((d, i) => {
    lines.push(`${i + 1}. ${d.fullName || "ללא שם"}${d.city ? " | " + d.city : ""}`);
  });
  if (noPhone.length > 20) lines.push(`... ועוד ${noPhone.length - 20}.`);

  return {
    answer: lines.join("\n"),
    suggestions: ["ספירת תורמים", "מצב המערכת"],
  };
}

// ─── system_debt_aging ────────────────────────────────────────────────────────
function systemDebtAging(ctx, detected) {
  const { allDonors, fmtDate, fmtMoney, daysSince } = ctx;
  const months = detected.entities.months || 6;
  const threshold = months * 30;

  const oldDebts = [];
  allDonors.forEach(d => {
    (d.donations || []).forEach(don => {
      if (num(don.remainingDebt) > 0 && daysSince(don.date) >= threshold) {
        oldDebts.push({ donor: d, donation: don, age: daysSince(don.date) });
      }
    });
  });
  oldDebts.sort((a, b) => b.age - a.age);

  if (!oldDebts.length) {
    return {
      answer: `✅ אין חובות ישנים מ-${months} חודשים.`,
      suggestions: ["חובות לפי עדיפות", "מצב המערכת"],
    };
  }
  const total = oldDebts.reduce((s, x) => s + num(x.donation.remainingDebt), 0);
  const lines = [
    `**חובות ישנים (מעל ${months} חודשים) — ${oldDebts.length} חובות, ${fmtMoney(total)}:**\n`,
  ];
  oldDebts.slice(0, 15).forEach((x, i) => {
    lines.push(
      `${i + 1}. ${x.donor.fullName || "ללא שם"} | ${fmtDate(x.donation.date)} | ` +
      `${fmtMoney(x.donation.remainingDebt)} | ${Math.floor(x.age / 30)} חודשים`
    );
  });

  return {
    answer: lines.join("\n"),
    suggestions: ["חובות לפי עדיפות", "למי כדאי להתקשר?"],
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

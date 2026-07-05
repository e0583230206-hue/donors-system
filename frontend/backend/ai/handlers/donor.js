"use strict";
// handlers/donor.js — all 18 donor-specific intent handlers
// Each exported function receives (ctx, detected) and returns { answer, suggestions }
// ctx = buildDonorContext() result   detected = { intent, entities, isFollowUp, followUpType }

function num(v) { return Number(v || 0); }

// ─── donor_summary ────────────────────────────────────────────────────────────
function donorSummary(ctx) {
  const { donor, stats, openDebts, openTasks, globalAvgPaid, fmtDate, fmtMoney } = ctx;
  const name = donor.fullName || "תורם";

  const lines = [
    `**${name}**`,
    `• עיר: ${donor.city || "לא ידוע"} | טלפון: ${donor.phone || "לא ידוע"}`,
    `• תרומות: ${stats.totalDonations} | שולם: ${fmtMoney(stats.totalPaid)} | חוב פתוח: ${fmtMoney(stats.totalDebt)}`,
    `• תרומה אחרונה: ${stats.lastDonationDate ? fmtDate(stats.lastDonationDate) + ` (לפני ${stats.daysSinceLastDonation} ימים)` : "אין רשומה"}`,
    `• משימות פתוחות: ${openTasks.length} | חובות פתוחים: ${openDebts.length}`,
  ];
  if (donor.status) lines.push(`• סטטוס: ${donor.status}`);
  if (donor.tags && donor.tags.length) lines.push(`• תגיות: ${donor.tags.join(", ")}`);
  if (stats.totalPaid > 0 && globalAvgPaid > 0) {
    const ratio = ((stats.totalPaid / globalAvgPaid) * 100).toFixed(0);
    lines.push(`• ביחס לממוצע: ${ratio}% (ממוצע מערכת: ${fmtMoney(globalAvgPaid)})`);
  }

  if (stats.totalDebt > 0) lines.push(`\n⚠️ יש ${openDebts.length} חובות פתוחים בסך ${fmtMoney(stats.totalDebt)}.`);
  if (!stats.lastDonationDate) lines.push(`\nℹ️ לא תרם מעולם — נדרשת פניה ראשונית.`);
  else if (stats.daysSinceLastDonation > 365) lines.push(`\n⚠️ לא תרם מעל שנה — תורם בסיכון נטישה.`);
  else if (stats.daysSinceLastDonation > 180) lines.push(`\n⚠️ לא תרם כבר חצי שנה.`);

  const sugg = [];
  if (openDebts.length) sugg.push("פרט את כל החובות הפתוחים");
  sugg.push("מה ההמלצה לטיפול?");
  sugg.push("ציר זמן פעילות");
  return { answer: lines.join("\n"), suggestions: sugg };
}

// ─── donor_last_donation ──────────────────────────────────────────────────────
function donorLastDonation(ctx, detected) {
  const { donor, allDonations, fmtDate, fmtMoney } = ctx;
  const name = donor.fullName || "התורם";

  if (!allDonations.length) {
    return {
      answer: `${name} — לא נמצאו תרומות רשומות.`,
      suggestions: ["מה מצב התורם?", "מה ההמלצה?"],
    };
  }
  const last = allDonations[0];
  const days = ctx.stats.daysSinceLastDonation;

  const lines = [
    `התרומה האחרונה של **${name}**:`,
    `• תאריך: ${fmtDate(last.date)} (לפני ${days} ימים)`,
    `• סכום: ${fmtMoney(last.amount)}`,
    `• מטרה: ${last.purpose || "לא צוין"}`,
    `• שולם: ${last.paid ? "כן ✅" : "לא ❌"}`,
  ];
  if (num(last.remainingDebt) > 0) lines.push(`• יתרת חוב: ${fmtMoney(last.remainingDebt)}`);
  if (last.paymentMethod) lines.push(`• אמצעי תשלום: ${last.paymentMethod}`);
  if (allDonations.length > 1) {
    const prev = allDonations[1];
    lines.push(`\nהתרומה שלפניה: ${fmtDate(prev.date)} | ${fmtMoney(prev.amount)}`);
  }

  const sugg = [
    "כמה תרומות יש סה\"כ?",
    "כמה חייב?",
  ];
  if (days > 180) sugg.push("מה ההמלצה לתורם שלא תרם זמן רב?");
  return { answer: lines.join("\n"), suggestions: sugg };
}

// ─── donor_debt_list ──────────────────────────────────────────────────────────
function donorDebtList(ctx) {
  const { donor, openDebts, fmtDate, fmtMoney } = ctx;
  const name = donor.fullName || "התורם";

  if (!openDebts.length) {
    return {
      answer: `${name} — אין חובות פתוחים. 🟢`,
      suggestions: ["מצב התורם", "מתי תרם לאחרונה?"],
    };
  }
  const total = openDebts.reduce((s, d) => s + num(d.remainingDebt), 0);
  const lines = [`**${name}** — ${openDebts.length} חובות פתוחים, סה"כ ${fmtMoney(total)}:\n`];
  openDebts.forEach((d, i) => {
    const age = ctx.daysSince(d.date);
    lines.push(
      `${i + 1}. ${fmtDate(d.date)} | ${d.purpose || "ללא מטרה"} | ${fmtMoney(d.remainingDebt)} (מתוך ${fmtMoney(d.amount)}) | גיל: ${age} ימים`
    );
  });
  const oldest = openDebts[0];
  lines.push(`\nהחוב הכי ישן: ${fmtDate(oldest.date)} — ${fmtMoney(oldest.remainingDebt)}`);

  return {
    answer: lines.join("\n"),
    suggestions: ["מה ההמלצה לטיפול?", "מה מצב ה-IVR שלו?", "האם יש משימות פתוחות?"],
  };
}

// ─── donor_debt_total ─────────────────────────────────────────────────────────
function donorDebtTotal(ctx) {
  const { donor, stats, openDebts, fmtMoney } = ctx;
  const name = donor.fullName || "התורם";

  if (stats.totalDebt === 0) {
    return {
      answer: `${name} — אין חוב פתוח. סה"כ שילם ${fmtMoney(stats.totalPaid)}. 🟢`,
      suggestions: ["מצב התורם", "היסטוריית תשלומים"],
    };
  }
  const lines = [
    `**${name}** חייב ${fmtMoney(stats.totalDebt)} ב-${openDebts.length} חובות פתוחים.`,
    `• ממוצע לחוב: ${fmtMoney(Math.round(stats.totalDebt / openDebts.length))}`,
    `• סה"כ שולם בעבר: ${fmtMoney(stats.totalPaid)}`,
  ];
  if (stats.totalDebt > ctx.globalAvgDebt && ctx.globalAvgDebt > 0) {
    lines.push(`⚠️ חוב גבוה מממוצע המערכת (${fmtMoney(ctx.globalAvgDebt)})`);
  }

  return {
    answer: lines.join("\n"),
    suggestions: ["פרט את החובות", "מה ההמלצה?", "מה מצב ה-IVR?"],
  };
}

// ─── donor_payment_history ────────────────────────────────────────────────────
function donorPaymentHistory(ctx) {
  const { donor, allDonations, stats, fmtDate, fmtMoney } = ctx;
  const name = donor.fullName || "התורם";
  const paid = allDonations.filter(d => d.paid);

  if (!paid.length) {
    return {
      answer: `${name} — לא נמצאו תשלומים שולמו.`,
      suggestions: ["מה החובות הפתוחים?", "מצב התורם"],
    };
  }
  const totalPaid = paid.reduce((s, d) => s + num(d.amount) - num(d.remainingDebt), 0);
  const lines = [
    `**${name}** — ${paid.length} תשלומים, סה"כ ${fmtMoney(totalPaid)}:`,
  ];
  paid.slice(0, 10).forEach((d, i) => {
    lines.push(`${i + 1}. ${fmtDate(d.date)} | ${fmtMoney(d.amount)} | ${d.purpose || ""} | ${d.paymentMethod || ""}`);
  });
  if (paid.length > 10) lines.push(`... ועוד ${paid.length - 10} תשלומים.`);

  return {
    answer: lines.join("\n"),
    suggestions: ["מתי תרם לאחרונה?", "כמה חייב?", "סטטיסטיקות תרומות"],
  };
}

// ─── donor_donations_stats ────────────────────────────────────────────────────
function donorDonationsStats(ctx) {
  const { donor, stats, allDonations, fmtMoney } = ctx;
  const name = donor.fullName || "התורם";
  if (!allDonations.length) {
    return { answer: `${name} — אין תרומות רשומות.`, suggestions: ["מצב התורם"] };
  }
  const lines = [
    `**סטטיסטיקות תרומות — ${name}:**`,
    `• סה"כ תרומות: ${stats.totalDonations}`,
    `• שולמו: ${stats.paidCount} | לא שולמו: ${stats.totalDonations - stats.paidCount}`,
    `• סה"כ שולם: ${fmtMoney(stats.totalPaid)}`,
    `• ממוצע לתרומה: ${fmtMoney(stats.avgAmount)}`,
    `• התרומה הגדולה: ${fmtMoney(stats.maxAmount)}`,
  ];
  if (stats.totalPaid > 0 && ctx.globalAvgPaid > 0) {
    const pct = ((stats.totalPaid / ctx.globalAvgPaid) * 100).toFixed(0);
    lines.push(`• ביחס לממוצע מערכת: ${pct}%`);
  }

  return {
    answer: lines.join("\n"),
    suggestions: ["היסטוריית תשלומים", "מתי תרם לאחרונה?", "ביחס לאחרים"],
  };
}

// ─── donor_contact ────────────────────────────────────────────────────────────
function donorContact(ctx) {
  const { donor } = ctx;
  const name = donor.fullName || "התורם";
  const lines = [
    `**פרטי קשר — ${name}:**`,
    `• טלפון: ${donor.phone || "לא רשום"}`,
    `• עיר: ${donor.city || "לא ידוע"}`,
    `• כתובת: ${donor.address || "לא ידוע"}`,
  ];
  if (donor.phone2) lines.push(`• טלפון 2: ${donor.phone2}`);
  if (donor.phone3) lines.push(`• טלפון 3: ${donor.phone3}`);
  const approved = (donor.ivrApprovedPhones || []);
  if (approved.length) lines.push(`• מספרים מאושרים ל-IVR: ${approved.join(", ")}`);
  else lines.push(`• אין מספרים מאושרים ל-IVR`);

  return {
    answer: lines.join("\n"),
    suggestions: ["מה סטטוס ה-IVR?", "מצב התורם"],
  };
}

// ─── donor_notes ─────────────────────────────────────────────────────────────
function donorNotes(ctx) {
  const { donor } = ctx;
  const name = donor.fullName || "התורם";
  const hasNotes = donor.notes || donor.internalStaffNote || donor.publicPhoneNote;
  if (!hasNotes) {
    return { answer: `${name} — אין הערות רשומות.`, suggestions: ["מצב התורם"] };
  }
  const lines = [`**הערות — ${name}:**`];
  if (donor.internalStaffNote) lines.push(`• הערה פנימית: ${donor.internalStaffNote}`);
  if (donor.publicPhoneNote) lines.push(`• הערה לטלפון: ${donor.publicPhoneNote}`);
  if (donor.notes) lines.push(`• הערות כלליות: ${donor.notes}`);
  return {
    answer: lines.join("\n"),
    suggestions: ["מצב התורם", "מה התגיות?"],
  };
}

// ─── donor_tags ──────────────────────────────────────────────────────────────
function donorTags(ctx) {
  const { donor } = ctx;
  const name = donor.fullName || "התורם";
  const tags = donor.tags || [];
  if (!tags.length) {
    return { answer: `${name} — אין תגיות.`, suggestions: ["מצב התורם"] };
  }
  return {
    answer: `**תגיות — ${name}:**\n${tags.map((t, i) => `${i + 1}. ${t}`).join("\n")}`,
    suggestions: ["מצב התורם", "מה הערות?"],
  };
}

// ─── donor_tasks ─────────────────────────────────────────────────────────────
function donorTasks(ctx) {
  const { donor, openTasks, fmtDate } = ctx;
  const name = donor.fullName || "התורם";
  if (!openTasks.length) {
    return { answer: `${name} — אין משימות פתוחות. ✅`, suggestions: ["מצב התורם", "מה החובות?"] };
  }
  const lines = [`**משימות פתוחות — ${name}** (${openTasks.length}):\n`];
  openTasks.slice(0, 12).forEach((t, i) => {
    const due = t.dueDate ? ` | עד: ${fmtDate(t.dueDate)}` : "";
    const overdue = t.dueDate && new Date(t.dueDate) < new Date() ? " ⚠️ פג תוקף" : "";
    lines.push(`${i + 1}. ${t.title || t.text || "משימה"}${due}${overdue}`);
  });
  return {
    answer: lines.join("\n"),
    suggestions: ["מה ההמלצה?", "מה מצב החובות?"],
  };
}

// ─── donor_ivr_status ─────────────────────────────────────────────────────────
function donorIvrStatus(ctx) {
  const { donor } = ctx;
  const name = donor.fullName || "התורם";
  const settings = donor.phoneMessageSettings || {};
  const approved = donor.ivrApprovedPhones || [];
  const inList = donor.includeInCalls !== false;

  const lines = [
    `**סטטוס IVR — ${name}:**`,
    `• ברשימת חיוג: ${inList ? "כן ✅" : "לא ❌"}`,
    `• מספרים מאושרים: ${approved.length ? approved.join(", ") : "אין"}`,
    `• אפשר תשלום: ${settings.allowPayment !== false ? "כן" : "לא"}`,
    `• אפשר שמיעת חובות: ${settings.allowPreviousDebts !== false ? "כן" : "לא"}`,
    `• אפשר השארת הודעה: ${settings.allowCallback !== false ? "כן" : "לא"}`,
  ];
  const hasApproved = approved.length > 0;
  if (!hasApproved) lines.push(`\n⚠️ אין מספרים מאושרים — התורם לא ישתתף בקמפיינים.`);

  return {
    answer: lines.join("\n"),
    suggestions: ["פרטי קשר", "מצב התורם"],
  };
}

// ─── donor_timeline ───────────────────────────────────────────────────────────
function donorTimeline(ctx) {
  const { donor, allDonations, openTasks, fmtDate, fmtMoney } = ctx;
  const name = donor.fullName || "התורם";
  const items = [];

  allDonations.forEach(d => items.push({
    date: d.date,
    label: (d.paid ? "✅ תשלום" : "❌ חוב") + ` — ${fmtMoney(d.amount)}` + (d.purpose ? ` (${d.purpose})` : ""),
  }));
  openTasks.forEach(t => items.push({
    date: t.dueDate || t.createdAt,
    label: `📋 משימה: ${t.title || t.text || "משימה"}`,
  }));
  items.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

  if (!items.length) {
    return { answer: `${name} — אין פעילות רשומה.`, suggestions: ["מצב התורם"] };
  }
  const lines = [`**ציר זמן — ${name}** (${items.length} אירועים, מהאחרון):\n`];
  items.slice(0, 15).forEach(it => lines.push(`• ${fmtDate(it.date)} — ${it.label}`));
  if (items.length > 15) lines.push(`... ועוד ${items.length - 15} אירועים קודמים.`);

  return {
    answer: lines.join("\n"),
    suggestions: ["מה החובות?", "מה המשימות?"],
  };
}

// ─── donor_risk ───────────────────────────────────────────────────────────────
function donorRisk(ctx) {
  const { donor, stats, openDebts, fmtMoney } = ctx;
  const name = donor.fullName || "התורם";
  const days = stats.daysSinceLastDonation;
  const risks = [];

  if (!stats.lastDonationDate) risks.push("⛔ אף פעם לא תרם — נדרשת פניה ראשונית");
  else if (days > 730) risks.push(`🔴 לא תרם כבר ${Math.floor(days / 365)} שנים — סיכון גבוה מאוד לנטישה`);
  else if (days > 365) risks.push(`🟠 לא תרם מעל שנה — סיכון גבוה`);
  else if (days > 180) risks.push(`🟡 לא תרם כבר חצי שנה — נדרש מעקב`);
  else risks.push(`🟢 תרם לאחרונה לפני ${days} ימים — פעיל`);

  if (openDebts.length) risks.push(`⚠️ יש ${openDebts.length} חובות פתוחים: ${fmtMoney(stats.totalDebt)}`);
  if (!donor.phone) risks.push(`⚠️ אין טלפון — לא ניתן לפנות`);
  if ((donor.ivrApprovedPhones || []).length === 0) risks.push(`ℹ️ אין מספר מאושר ל-IVR`);
  if (donor.status === "לא פעיל") risks.push(`ℹ️ מסומן כ"לא פעיל" במערכת`);

  const answer = `**הערכת סיכון — ${name}:**\n\n${risks.join("\n")}`;
  return {
    answer,
    suggestions: ["מה ההמלצה?", "מה ציר הזמן?", "פרט חובות"],
  };
}

// ─── donor_recommendation ─────────────────────────────────────────────────────
function donorRecommendation(ctx) {
  const { donor, stats, openDebts, openTasks, fmtMoney } = ctx;
  const name = donor.fullName || "התורם";
  const recs = [];

  if (!donor.phone) {
    recs.push("🔴 **השלם פרטי טלפון** — לא ניתן לפנות ללא טלפון.");
  }
  if (openDebts.length > 0) {
    const oldest = openDebts[0];
    const oldDays = ctx.daysSince(oldest.date);
    recs.push(`⚠️ **טפל בחוב הפתוח** — יש ${openDebts.length} חובות, סה"כ ${fmtMoney(stats.totalDebt)}. החוב הכי ישן: ${oldDays} ימים.`);
    if ((donor.ivrApprovedPhones || []).length > 0) {
      recs.push("📞 **שקול לכלול בקמפיין IVR** — יש מספר מאושר, ניתן לשגר הודעת תשלום.");
    } else {
      recs.push("📞 **אשר מספר ל-IVR** — כדי לאפשר גביה אוטומטית.");
    }
  }
  if (openTasks.length > 0) {
    recs.push(`📋 **טפל ב-${openTasks.length} משימות פתוחות** — חלקן עשויות להיות פגי תוקף.`);
  }
  if (!stats.lastDonationDate) {
    recs.push("📬 **פנה לתורם** — אף פעם לא תרם, כדאי לבצע פניה ראשונית.");
  } else if (stats.daysSinceLastDonation > 180) {
    recs.push(`⏰ **צור קשר** — לא תרם כבר ${stats.daysSinceLastDonation} ימים.`);
  }
  if (!recs.length) {
    recs.push("✅ אין פעולות דחופות נדרשות כרגע. התורם נמצא במצב תקין.");
  }

  return {
    answer: `**המלצות לטיפול — ${name}:**\n\n${recs.join("\n\n")}`,
    suggestions: ["ציר זמן", "מצב ה-IVR", "משימות פתוחות"],
  };
}

// ─── donor_vs_average ─────────────────────────────────────────────────────────
function donorVsAverage(ctx) {
  const { donor, stats, globalAvgPaid, fmtMoney } = ctx;
  const name = donor.fullName || "התורם";

  const lines = [
    `**השוואה לממוצע — ${name}:**`,
    `• שולם: ${fmtMoney(stats.totalPaid)}`,
    `• ממוצע מערכת: ${fmtMoney(globalAvgPaid)}`,
  ];
  if (globalAvgPaid > 0) {
    const pct = ((stats.totalPaid / globalAvgPaid) * 100).toFixed(0);
    const diff = stats.totalPaid - globalAvgPaid;
    lines.push(`• יחס: ${pct}% מהממוצע`);
    if (diff > 0) lines.push(`✅ תורם ${fmtMoney(diff)} **יותר** מהממוצע`);
    else if (diff < 0) lines.push(`📉 תורם ${fmtMoney(Math.abs(diff))} **פחות** מהממוצע`);
    else lines.push(`➡️ בדיוק בממוצע`);
  }
  lines.push(`• ממוצע לתרומה שלו: ${fmtMoney(stats.avgAmount)}`);
  lines.push(`• תרומה גדולה ביותר: ${fmtMoney(stats.maxAmount)}`);

  return {
    answer: lines.join("\n"),
    suggestions: ["סטטיסטיקות תרומות", "מצב התורם"],
  };
}

// ─── donor_campaign_fit ───────────────────────────────────────────────────────
function donorCampaignFit(ctx) {
  const { donor, stats, openDebts, fmtMoney } = ctx;
  const name = donor.fullName || "התורם";
  const approved = donor.ivrApprovedPhones || [];
  const fit = approved.length > 0 && donor.includeInCalls !== false;

  const lines = [
    `**התאמה לקמפיין — ${name}:**`,
    `• מספרים מאושרים: ${approved.length ? approved.join(", ") : "אין"}`,
    `• כלול ברשימת חיוג: ${donor.includeInCalls !== false ? "כן" : "לא"}`,
    `• חובות פתוחים: ${openDebts.length ? fmtMoney(stats.totalDebt) : "אין"}`,
    `\n${fit ? "✅ **מתאים לקמפיין IVR**" : "❌ **לא מתאים לקמפיין**"}`,
  ];
  if (!fit && approved.length === 0) lines.push("פתרון: אשר מספר ב-IVR settings.");

  return {
    answer: lines.join("\n"),
    suggestions: ["מצב ה-IVR", "פרטי קשר"],
  };
}

// ─── donor_last_contact ───────────────────────────────────────────────────────
function donorLastContact(ctx) {
  const { donor, fmtDate } = ctx;
  const name = donor.fullName || "התורם";
  const calls = donor.click2callLogs || [];

  if (!calls.length) {
    return {
      answer: `${name} — אין רישום של צינתוקים במערכת.\nניתן לבדוק בלשונית "היסטוריית צינתוקים" בכרטיס התורם.`,
      suggestions: ["מצב התורם", "מה המשימות?"],
    };
  }
  const last = calls[0];
  return {
    answer: [
      `**קשר אחרון — ${name}:**`,
      `• תאריך: ${fmtDate(last.createdAt)}`,
      `• סטטוס: ${last.status || "לא ידוע"}`,
      `• עובד: ${last.workerName || "לא ידוע"}`,
    ].join("\n"),
    suggestions: ["מצב התורם", "מה ציר הזמן?"],
  };
}

// ─── donor_debt_age ───────────────────────────────────────────────────────────
function donorDebtAge(ctx) {
  const { donor, openDebts, fmtDate, fmtMoney } = ctx;
  const name = donor.fullName || "התורם";

  if (!openDebts.length) {
    return { answer: `${name} — אין חובות פתוחים.`, suggestions: ["מצב התורם"] };
  }
  const oldest = openDebts[0]; // already sorted oldest-first
  const age = ctx.daysSince(oldest.date);
  const lines = [
    `**גיל חובות — ${name}:**`,
    `• החוב הכי ישן: ${fmtDate(oldest.date)} — ${fmtMoney(oldest.remainingDebt)} (${age} ימים!)`,
    `• מטרה: ${oldest.purpose || "לא צוין"}`,
  ];
  if (openDebts.length > 1) {
    lines.push(`\nכל החובות לפי גיל:`);
    openDebts.forEach((d, i) => {
      lines.push(`${i + 1}. ${fmtDate(d.date)} | ${fmtMoney(d.remainingDebt)} | ${ctx.daysSince(d.date)} ימים`);
    });
  }
  if (age > 365) lines.push(`\n🔴 חוב ישן מעל שנה — דחוף לטיפול.`);

  return {
    answer: lines.join("\n"),
    suggestions: ["מה ההמלצה?", "פרט את החובות"],
  };
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────
function dispatch(intentName, ctx, detected) {
  switch (intentName) {
    case "donor_summary":         return donorSummary(ctx);
    case "donor_last_donation":   return donorLastDonation(ctx, detected);
    case "donor_debt_list":       return donorDebtList(ctx);
    case "donor_debt_total":      return donorDebtTotal(ctx);
    case "donor_payment_history": return donorPaymentHistory(ctx);
    case "donor_donations_stats": return donorDonationsStats(ctx);
    case "donor_contact":         return donorContact(ctx);
    case "donor_notes":           return donorNotes(ctx);
    case "donor_tags":            return donorTags(ctx);
    case "donor_tasks":           return donorTasks(ctx);
    case "donor_ivr_status":      return donorIvrStatus(ctx);
    case "donor_timeline":        return donorTimeline(ctx);
    case "donor_risk":            return donorRisk(ctx);
    case "donor_recommendation":  return donorRecommendation(ctx);
    case "donor_vs_average":      return donorVsAverage(ctx);
    case "donor_campaign_fit":    return donorCampaignFit(ctx);
    case "donor_last_contact":    return donorLastContact(ctx);
    case "donor_debt_age":        return donorDebtAge(ctx);
    default: return null;
  }
}

module.exports = { dispatch };

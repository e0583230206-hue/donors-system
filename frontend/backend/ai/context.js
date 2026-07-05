"use strict";
// context.js — builds rich context objects from the DB for AI handlers
const { getAppState } = require("../db");

function num(v) { return Number(v || 0); }

function daysSince(d) {
  if (!d) return Infinity;
  const ms = Date.now() - new Date(d).getTime();
  return ms < 0 ? 0 : Math.floor(ms / 86400000);
}

function fmtDate(d) {
  if (!d) return "לא ידוע";
  const dt = new Date(d);
  if (isNaN(dt)) return String(d);
  return dt.toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function fmtMoney(n) {
  return "₪" + num(n).toLocaleString("he-IL");
}

// Per-donor statistics (shared by both context types)
function getDonorStats(donor) {
  const donations = donor.donations || [];
  const openDebts = donations.filter(d => num(d.remainingDebt) > 0);
  const paid      = donations.filter(d => d.paid);
  const totalDebt = openDebts.reduce((s, d) => s + num(d.remainingDebt), 0);
  const totalPaid = paid.reduce((s, d) => s + num(d.amount) - num(d.remainingDebt), 0);
  const sorted    = donations.slice().sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  const lastDate  = sorted[0] ? sorted[0].date : null;
  const allAmts   = donations.map(d => num(d.amount));
  const avgAmount = allAmts.length ? allAmts.reduce((s, v) => s + v, 0) / allAmts.length : 0;
  const maxAmount = allAmts.length ? Math.max(...allAmts) : 0;
  return {
    totalDonations: donations.length,
    totalPaid,
    totalDebt,
    openDebtsCount: openDebts.length,
    avgAmount: Math.round(avgAmount),
    maxAmount,
    lastDonationDate: lastDate,
    lastDonationFmt: fmtDate(lastDate),
    daysSinceLastDonation: daysSince(lastDate),
    paidCount: paid.length,
  };
}

function buildDonorContext(donorId) {
  const allDonors = getAppState("donors") || [];
  const tasks     = getAppState("tasks")  || [];
  const donor     = allDonors.find(d => d.id === Number(donorId));
  if (!donor) return null;

  const stats       = getDonorStats(donor);
  const donations   = donor.donations || [];
  const openDebts   = donations
    .filter(d => num(d.remainingDebt) > 0)
    .sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0)); // oldest first
  const sortedDons  = donations.slice()
    .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  const donorTasks  = tasks.filter(t =>
    !t.done &&
    (String(t.donorId) === String(donor.id) || String(t.relatedDonorId) === String(donor.id))
  );

  // For "vs average" comparison
  const allStats       = allDonors.map(getDonorStats);
  const globalAvgPaid  = allStats.length
    ? Math.round(allStats.reduce((s, st) => s + st.totalPaid, 0) / allStats.length)
    : 0;
  const globalAvgDebt  = allStats.filter(st => st.totalDebt > 0).length
    ? Math.round(allStats.reduce((s, st) => s + st.totalDebt, 0) / allStats.filter(st => st.totalDebt > 0).length)
    : 0;

  return {
    type: "donor",
    donor,
    stats,
    openDebts,
    recentDonations: sortedDons.slice(0, 15),
    allDonations: sortedDons,
    openTasks: donorTasks,
    globalAvgPaid,
    globalAvgDebt,
    allDonorsCount: allDonors.length,
    fmtDate,
    fmtMoney,
    daysSince,
  };
}

function buildGlobalContext() {
  const rawDonors  = getAppState("donors");
  const allDonors  = Array.isArray(rawDonors) ? rawDonors : [];
  const rawTasks   = getAppState("tasks");
  const tasks      = Array.isArray(rawTasks) ? rawTasks : [];
  const rawRem     = getAppState("reminders");
  const reminders  = Array.isArray(rawRem) ? rawRem : [];

  const statsPerDonor = allDonors.map(d => ({ donor: d, stats: getDonorStats(d) }));
  const now = Date.now();

  const totalDebt   = statsPerDonor.reduce((s, x) => s + x.stats.totalDebt,   0);
  const totalPaid   = statsPerDonor.reduce((s, x) => s + x.stats.totalPaid,   0);
  const withDebt    = statsPerDonor.filter(x => x.stats.totalDebt > 0);
  const dormant90   = statsPerDonor.filter(x => x.stats.daysSinceLastDonation >= 90);
  const dormant180  = statsPerDonor.filter(x => x.stats.daysSinceLastDonation >= 180);
  const dormant365  = statsPerDonor.filter(x => x.stats.daysSinceLastDonation >= 365);
  const neverGiven  = statsPerDonor.filter(x => !x.stats.lastDonationDate);
  const openTasks   = tasks.filter(t => !t.done);
  const urgentTasks = openTasks.filter(t =>
    t.dueDate && new Date(t.dueDate) < new Date(now + 3 * 86400000)
  );
  const upcomingRem = reminders.filter(r => {
    if (!r.date && !r.dueDate) return false;
    const d = new Date(r.date || r.dueDate);
    return d >= new Date() && d <= new Date(now + 7 * 86400000);
  });

  // City breakdown
  const cityMap = {};
  allDonors.forEach(d => {
    const city = (d.city || "").trim();
    if (city) cityMap[city] = (cityMap[city] || 0) + 1;
  });
  const citySorted = Object.entries(cityMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  // Purpose breakdown
  const purposeMap = {};
  allDonors.forEach(d => {
    (d.donations || []).forEach(don => {
      const p = (don.purpose || "ללא מטרה").trim();
      purposeMap[p] = (purposeMap[p] || 0) + 1;
    });
  });

  // Tag breakdown
  const tagMap = {};
  allDonors.forEach(d => {
    (d.tags || []).forEach(t => {
      if (t) tagMap[t.trim()] = (tagMap[t.trim()] || 0) + 1;
    });
  });

  // Payment method breakdown
  const methodMap = {};
  allDonors.forEach(d => {
    (d.donations || []).forEach(don => {
      if (don.paid && don.paymentMethod) {
        methodMap[don.paymentMethod] = (methodMap[don.paymentMethod] || 0) + 1;
      }
    });
  });

  // Monthly trend (last 12 months)
  const monthlyDonations = {};
  allDonors.forEach(d => {
    (d.donations || []).forEach(don => {
      if (!don.date) return;
      const key = don.date.slice(0, 7); // YYYY-MM
      if (!monthlyDonations[key]) monthlyDonations[key] = { count: 0, paid: 0, total: 0 };
      monthlyDonations[key].count++;
      if (don.paid) {
        monthlyDonations[key].paid++;
        monthlyDonations[key].total += num(don.amount) - num(don.remainingDebt);
      }
    });
  });
  const months12 = Object.entries(monthlyDonations)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-12);

  return {
    type: "global",
    allDonors,
    statsPerDonor,
    tasks,
    reminders,
    openTasks,
    urgentTasks,
    upcomingReminders: upcomingRem,
    withDebt,
    dormant90,
    dormant180,
    dormant365,
    neverGiven,
    summary: {
      totalDonors:     allDonors.length,
      activeDonors:    allDonors.filter(d => d.status !== "לא פעיל").length,
      withDebt:        withDebt.length,
      totalDebt,
      totalPaid,
      dormant90:       dormant90.length,
      dormant180:      dormant180.length,
      dormant365:      dormant365.length,
      neverGiven:      neverGiven.length,
      openTasksCount:  openTasks.length,
      urgentCount:     urgentTasks.length,
      campaignReady:   allDonors.filter(d => (d.ivrApprovedPhones || []).length > 0).length,
      noPhone:         allDonors.filter(d => !d.phone).length,
    },
    citySorted,
    purposeMap,
    tagMap,
    methodMap,
    monthlyTrend: months12,
    fmtDate,
    fmtMoney,
    daysSince,
    getDonorStats,
  };
}

module.exports = { buildDonorContext, buildGlobalContext, getDonorStats, fmtDate, fmtMoney, daysSince };

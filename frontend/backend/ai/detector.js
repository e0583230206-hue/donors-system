"use strict";
// detector.js — intent detection, entity extraction, follow-up resolution

// ─── Intent catalogue ──────────────────────────────────────────────────────────
// scope: "donor" | "system" | "any"
const INTENTS = [
  // Donor-specific
  { name: "donor_summary",         scope: "donor",  kw: ["מצב", "סיכום", "ספר לי", "מה עם", "פרטים", "מי הוא", "כרטיס", "מה קורה עם"] },
  { name: "donor_last_donation",   scope: "donor",  kw: ["תרם לאחרונה", "תרומה אחרונה", "מתי תרם", "תרם בפעם", "תרומה אחרון"] },
  { name: "donor_debt_list",       scope: "donor",  kw: ["אילו חובות", "הצג חובות", "רשימת חובות", "חובות פתוחים", "מה חובות"] },
  { name: "donor_debt_total",      scope: "donor",  kw: ["כמה חייב", "סכום חוב", "כמה חוב", "חייב כמה", "כמה הוא חייב"] },
  { name: "donor_payment_history", scope: "donor",  kw: ["שילם", "תשלומים", "היסטוריית תשלום", "כמה שילם", "מה שילם", "תשלום שלו"] },
  { name: "donor_donations_stats", scope: "donor",  kw: ["כמה פעמים תרם", "ממוצע תרומה", "תרומה גדולה", "סטטיסטיקות", "כמה תרם"] },
  { name: "donor_contact",         scope: "donor",  kw: ["טלפון", "כתובת", "עיר", "פרטי קשר", "איפה גר", "רחוב"] },
  { name: "donor_notes",           scope: "donor",  kw: ["הערות", "הערה", "כתוב עליו", "פתק", "מה רשום"] },
  { name: "donor_tags",            scope: "donor",  kw: ["תגיות", "תגית", "קבוצה", "שייך", "לאיזה קטגוריה"] },
  { name: "donor_tasks",           scope: "donor",  kw: ["משימות", "לעשות", "משימה", "תזכורת", "מה פתוח"] },
  { name: "donor_ivr_status",      scope: "donor",  kw: ["ivr", "סטטוס ivr", "מערכת טלפונית", "ברשימת חיוג", "טלפון מאושר"] },
  { name: "donor_timeline",        scope: "donor",  kw: ["ציר זמן", "היסטוריה", "מה קרה", "שנה אחרונה", "פעילות", "לוח זמנים"] },
  { name: "donor_risk",            scope: "donor",  kw: ["בסיכון", "יתרום שוב", "עדיין פעיל", "כמה זמן לא", "האם פעיל", "אבד"] },
  { name: "donor_recommendation",  scope: "donor",  kw: ["המלצה", "מה כדאי", "מה לעשות", "לפנות", "לטפל", "מה עושים"] },
  { name: "donor_vs_average",      scope: "donor",  kw: ["ביחס לאחרים", "יותר מהממוצע", "פחות מהממוצע", "מיקום", "השוואה"] },
  { name: "donor_campaign_fit",    scope: "donor",  kw: ["קמפיין", "מתאים לשיגור", "שיגור", "טלפון מאושר לקמפיין"] },
  { name: "donor_last_contact",    scope: "donor",  kw: ["פנינו", "צינתוק", "שיחה אחרונה", "קשר אחרון", "מתי דיברנו"] },
  { name: "donor_debt_age",        scope: "donor",  kw: ["חוב ישן", "ישן ביותר", "חוב עתיק", "הכי ישן", "הכי קדום"] },

  // System-wide
  { name: "system_summary",        scope: "system", kw: ["מצב המערכת", "סיכום כללי", "ברק מהיר", "תמונה כללית", "מה קורה במערכת", "סיכום יומי"] },
  { name: "system_dormant",        scope: "system", kw: ["לא תרמו", "רדומים", "לא פעילים", "תורמים שלא", "חצי שנה", "חודשים"] },
  { name: "system_priority_debts", scope: "system", kw: ["חובות לפי עדיפות", "עדיפות חובות", "הכי גדול", "גדולים ביותר", "רשימת חובות כל"] },
  { name: "system_top_donors",     scope: "system", kw: ["תורמים גדולים", "הכי הרבה תרמו", "מובילים", "הגדולים ביותר", "מי תרם הכי"] },
  { name: "system_total_debt",     scope: "system", kw: ["חוב כולל", "סה\"כ חובות", "כמה חוב יש", "כמה חובות במערכת", "סה\"כ חוב"] },
  { name: "system_total_paid",     scope: "system", kw: ["כמה גבינו", "סה\"כ שולם", "גביה כוללת", "כמה נגבה", "כמה שולם"] },
  { name: "system_active_count",   scope: "system", kw: ["כמה תורמים", "מספר תורמים", "כמה רשומים", "סה\"כ תורמים", "כמה נרשמו"] },
  { name: "system_new_donors",     scope: "system", kw: ["חדשים", "נוספו", "תורמים חדשים", "הצטרפו", "חדש במערכת"] },
  { name: "system_by_city",        scope: "system", kw: ["לפי עיר", "ערים", "ישובים", "פיזור גיאוגרפי", "כמה מ"] },
  { name: "system_by_purpose",     scope: "system", kw: ["לפי מטרה", "מטרות", "גליון מתאחדת", "פרנס", "פילוח מטרות"] },
  { name: "system_open_tasks",     scope: "system", kw: ["משימות פתוחות", "כמה משימות", "מה יש לעשות", "משימות מערכת"] },
  { name: "system_urgent_tasks",   scope: "system", kw: ["משימות דחופות", "פג תוקף", "עבר התאריך", "דחוף", "אחרי הדד-ליין"] },
  { name: "system_upcoming_rem",   scope: "system", kw: ["תזכורות", "קרובות", "שבוע הבא", "ימים הקרובים", "מה מחכה"] },
  { name: "system_trend",          scope: "system", kw: ["מגמה", "עולה", "יורד", "גידול", "ירידה", "שנתי", "חודשי", "טרנד"] },
  { name: "system_by_tag",         scope: "system", kw: ["לפי תגית", "תגיות", "vip", "קבוצות", "פילוח תגיות"] },
  { name: "system_payment_methods",scope: "system", kw: ["אמצעי תשלום", "מזומן", "אשראי", "צ'ק", "העברה בנקאית", "שיטת תשלום"] },
  { name: "system_campaign_ready", scope: "system", kw: ["קמפיין", "מוכנים", "מאושרים לחיוג", "רשימת שיגור"] },
  { name: "system_biggest_debtor", scope: "system", kw: ["החייב הגדול", "מי חייב הכי", "חוב הגדול ביותר", "הגדול ביותר"] },
  { name: "system_recent_payments",scope: "system", kw: ["תשלומים אחרונים", "שולם לאחרונה", "השבוע שולם", "תשלומים אחרון"] },
  { name: "system_no_phone",       scope: "system", kw: ["בלי טלפון", "חסרי טלפון", "אין טלפון", "פרטי קשר חסרים", "ללא טלפון"] },
  { name: "system_debt_aging",     scope: "system", kw: ["חובות ישנים", "ישנים", "זמן רב", "עתיקים", "ישן מ"] },

  // Insights
  { name: "insight_who_to_call",   scope: "any",    kw: ["למי להתקשר", "למי לפנות", "סדר עדיפויות שיחות", "מי ראשון", "שיחות היום", "לשלוח ראשון"] },
  { name: "insight_quick_wins",    scope: "any",    kw: ["קל לגבות", "קל לסגור", "חובות קטנים", "הכי מהיר", "win", "לסגור מהר"] },
  { name: "insight_at_risk",       scope: "any",    kw: ["בסיכון", "לנטוש", "יאבד", "לאבד", "מאבדים", "עזוב"] },
  { name: "insight_follow_up",     scope: "any",    kw: ["מעקב", "לחזור", "לבדוק", "follow", "לא נעשה כלום", "תקוע"] },
  { name: "insight_potential",     scope: "any",    kw: ["פוטנציאל", "יכול לתרום", "עלול לתרום", "בעלי יכולת"] },
  { name: "insight_success_rate",  scope: "any",    kw: ["שיעור גביה", "אחוז הצלחה", "כמה הצלחנו", "יחס גביה"] },
  { name: "insight_debt_priority", scope: "any",    kw: ["איזה חוב לטפל", "קדימות טיפול", "ראשון לטפל", "לפי דחיפות"] },
  { name: "insight_before_holiday",scope: "any",    kw: ["לפני חג", "ראש השנה", "פסח", "חג", "הכנה לחג", "ערב חג"] },
];

// ─── Follow-up patterns ────────────────────────────────────────────────────────
const FOLLOWUP = [
  { kw: ["ספר לי יותר", "הרחב", "עוד פרטים", "יותר מידע", "הרחב על"], type: "expand" },
  { kw: ["הבא", "עוד", "הבא בתור", "מה הלאה"], type: "next" },
  { kw: ["למה", "כי מה", "מה הסיבה", "הסבר לי", "מדוע"], type: "why" },
  { kw: ["כמה בדיוק", "מה הסכום המדויק", "פרטים על"], type: "amount" },
  { kw: ["ומה עם", "ואיך", "ומה לגבי", "גם"], type: "related" },
  { kw: ["מה ההמלצה", "מה כדאי לעשות", "מה עושים"], type: "recommend" },
];

// ─── Entity extraction ─────────────────────────────────────────────────────────
function extractEntities(q) {
  const entities = {};

  // Months / years
  const mMatch = q.match(/(\d+)\s*חודש/);
  if (mMatch) entities.months = parseInt(mMatch[1]);
  if (/חצי שנה/.test(q)) entities.months = 6;
  if (/\bשנה\b/.test(q) && !entities.months) entities.months = 12;
  if (/שנתיים/.test(q)) entities.months = 24;
  if (entities.months) entities.thresholdDays = entities.months * 30;

  // Days
  const dMatch = q.match(/(\d+)\s*ימים?/);
  if (dMatch) entities.days = parseInt(dMatch[1]);

  // Money amount
  const amtMatch = q.match(/([\d,]+)\s*(?:₪|שקל|ש"ח)/);
  if (amtMatch) entities.amount = parseInt(amtMatch[1].replace(/,/g, ""));

  // Amount operator
  if (/מעל|יותר מ/.test(q)) entities.amountOp = "gt";
  if (/מתחת|פחות מ/.test(q)) entities.amountOp = "lt";

  // Top N
  const topMatch = q.match(/(\d+)\s*(?:ראשונ|גדול|מובי)/);
  if (topMatch) entities.topN = parseInt(topMatch[1]);
  if (!entities.topN) entities.topN = 10; // default

  // Time reference
  if (/היום/.test(q)) entities.timeRef = "today";
  if (/השבוע/.test(q)) entities.timeRef = "week";
  if (/החודש/.test(q)) entities.timeRef = "month";
  if (/השנה/.test(q)) entities.timeRef = "year";

  return entities;
}

// ─── Main detection function ───────────────────────────────────────────────────
function detectIntent(question, history) {
  const q = String(question || "").toLowerCase();
  const entities = extractEntities(q);

  // Last assistant intent from history
  const lastAsst = history && history.slice().reverse().find(m => m.role === "assistant");
  const lastIntent = lastAsst ? lastAsst.intent : null;

  // Check for follow-up
  for (const fp of FOLLOWUP) {
    if (fp.kw.some(kw => q.includes(kw))) {
      if (lastIntent && lastIntent !== "general") {
        return {
          intent: lastIntent,
          isFollowUp: true,
          followUpType: fp.type,
          confidence: 0.78,
          entities,
          scope: null,
        };
      }
    }
  }

  // Score intents
  const scored = INTENTS.map(intent => {
    const hits = intent.kw.filter(kw => q.includes(kw.toLowerCase()));
    return { ...intent, score: hits.length, hits };
  })
    .filter(i => i.score > 0)
    .sort((a, b) => b.score - a.score || b.kw.length - a.kw.length);

  if (!scored.length) {
    return { intent: "general", confidence: 0.1, entities, scope: "any", isFollowUp: false };
  }

  const best       = scored[0];
  const confidence = Math.min(0.95, 0.3 + best.score * 0.22);

  return {
    intent:     best.name,
    scope:      best.scope,
    confidence,
    entities,
    isFollowUp: false,
  };
}

module.exports = { detectIntent, extractEntities, INTENTS };

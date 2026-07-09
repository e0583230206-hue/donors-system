"use strict";
// detector.js — intent detection v3: fuzzy matching, synonyms, pageContext bias, disambiguation

// ─── Intent catalogue ──────────────────────────────────────────────────────────
const INTENTS = [
  // Donor-specific
  { name: "donor_summary",         scope: "donor",  kw: ["מצב", "סיכום", "ספר לי", "מה עם", "פרטים", "מי הוא", "כרטיס", "מה קורה עם", "עדכן אותי", "תן לי תמונה"] },
  { name: "donor_last_donation",   scope: "donor",  kw: ["תרם לאחרונה", "תרומה אחרונה", "מתי תרם", "תרם בפעם", "הפעם האחרונה", "מתי תרם", "תרומה אחרון", "אחרונה שלו"] },
  { name: "donor_debt_list",       scope: "donor",  kw: ["אילו חובות", "הצג חובות", "רשימת חובות", "חובות פתוחים", "מה חובות", "מה חוב", "פירוט חובות", "כל החובות"] },
  { name: "donor_debt_total",      scope: "donor",  kw: ["כמה חייב", "סכום חוב", "כמה חוב", "חייב כמה", "כמה הוא חייב", "יתרת חוב", "חוב כולל", "סה\"כ חוב"] },
  { name: "donor_payment_history", scope: "donor",  kw: ["שילם", "תשלומים", "היסטוריית תשלום", "כמה שילם", "מה שילם", "תשלום שלו", "תשלום אחרון", "היסטוריה פיננסית"] },
  { name: "donor_donations_stats", scope: "donor",  kw: ["כמה פעמים תרם", "ממוצע תרומה", "תרומה גדולה", "סטטיסטיקות", "כמה תרם", "ניתוח תרומות", "דפוס תרומה"] },
  { name: "donor_contact",         scope: "donor",  kw: ["טלפון", "כתובת", "עיר", "פרטי קשר", "איפה גר", "רחוב", "מספר", "ניצור קשר", "נתקשר"] },
  { name: "donor_notes",           scope: "donor",  kw: ["הערות", "הערה", "כתוב עליו", "פתק", "מה רשום", "פרטים נוספים", "מה יש עליו"] },
  { name: "donor_tags",            scope: "donor",  kw: ["תגיות", "תגית", "קבוצה", "שייך", "לאיזה קטגוריה", "סיווג", "VIP", "קטגוריה"] },
  { name: "donor_tasks",           scope: "donor",  kw: ["משימות", "לעשות", "משימה", "תזכורת", "מה פתוח", "מה עומד", "פעולות", "todo"] },
  { name: "donor_ivr_status",      scope: "donor",  kw: ["ivr", "סטטוס ivr", "מערכת טלפונית", "ברשימת חיוג", "טלפון מאושר", "צינתוק", "חיוג אוטומטי", "אוטומטי"] },
  { name: "donor_timeline",        scope: "donor",  kw: ["ציר זמן", "היסטוריה", "מה קרה", "שנה אחרונה", "פעילות", "לוח זמנים", "כרונולוגיה", "אירועים"] },
  { name: "donor_risk",            scope: "donor",  kw: ["בסיכון", "יתרום שוב", "עדיין פעיל", "כמה זמן לא", "האם פעיל", "אבד", "סיכון נטישה", "מסוכן"] },
  { name: "donor_recommendation",  scope: "donor",  kw: ["המלצה", "מה כדאי", "מה לעשות", "לפנות", "לטפל", "מה עושים", "מה הצעד", "תמליץ", "איך ממשיכים"] },
  { name: "donor_vs_average",      scope: "donor",  kw: ["ביחס לאחרים", "יותר מהממוצע", "פחות מהממוצע", "מיקום", "השוואה", "ממוצע", "מעל ממוצע"] },
  { name: "donor_campaign_fit",    scope: "donor",  kw: ["קמפיין", "מתאים לשיגור", "שיגור", "טלפון מאושר לקמפיין", "לשגר", "קמפיין חג"] },
  { name: "donor_last_contact",    scope: "donor",  kw: ["פנינו", "צינתוק", "שיחה אחרונה", "קשר אחרון", "מתי דיברנו", "פעם אחרונה שדיברנו", "מתי יצרנו קשר"] },
  { name: "donor_debt_age",        scope: "donor",  kw: ["חוב ישן", "ישן ביותר", "חוב עתיק", "הכי ישן", "הכי קדום", "ותיק", "חוב מ"] },

  // System-wide
  { name: "system_summary",        scope: "system", kw: ["מצב המערכת", "סיכום כללי", "ברק מהיר", "תמונה כללית", "מה קורה במערכת", "סיכום יומי", "מצב כללי", "דאשבורד"] },
  { name: "system_dormant",        scope: "system", kw: ["לא תרמו", "רדומים", "לא פעילים", "תורמים שלא", "חצי שנה", "חודשים", "נעלמו", "לא נראו", "לא שמענו"] },
  { name: "system_priority_debts", scope: "system", kw: ["חובות לפי עדיפות", "עדיפות חובות", "הכי גדול", "גדולים ביותר", "רשימת חובות כל", "חובות דחופים", "כל החובות"] },
  { name: "system_top_donors",     scope: "system", kw: ["תורמים גדולים", "הכי הרבה תרמו", "מובילים", "הגדולים ביותר", "מי תרם הכי", "top", "מיטב"] },
  { name: "system_total_debt",     scope: "system", kw: ["חוב כולל", "סה\"כ חובות", "כמה חוב יש", "כמה חובות במערכת", "סה\"כ חוב", "כמה חייבים", "כמה כולל"] },
  { name: "system_total_paid",     scope: "system", kw: ["כמה גבינו", "סה\"כ שולם", "גביה כוללת", "כמה נגבה", "כמה שולם", "גביה", "הכנסות"] },
  { name: "system_active_count",   scope: "system", kw: ["כמה תורמים", "מספר תורמים", "כמה רשומים", "סה\"כ תורמים", "כמה נרשמו", "ספירה", "כמה יש"] },
  { name: "system_new_donors",     scope: "system", kw: ["חדשים", "נוספו", "תורמים חדשים", "הצטרפו", "חדש במערכת", "נרשמו לאחרונה"] },
  { name: "system_by_city",        scope: "system", kw: ["לפי עיר", "ערים", "ישובים", "פיזור גיאוגרפי", "כמה מ", "אזורים", "גאוגרפי"] },
  { name: "system_by_purpose",     scope: "system", kw: ["לפי מטרה", "מטרות", "גליון", "פרנס", "פילוח מטרות", "מטרת תרומה"] },
  { name: "system_open_tasks",     scope: "system", kw: ["משימות פתוחות", "כמה משימות", "מה יש לעשות", "משימות מערכת", "כל המשימות", "פתוחות"] },
  { name: "system_urgent_tasks",   scope: "system", kw: ["משימות דחופות", "פג תוקף", "עבר התאריך", "דחוף", "אחרי הדד-ליין", "בוערות"] },
  { name: "system_upcoming_rem",   scope: "system", kw: ["תזכורות", "קרובות", "שבוע הבא", "ימים הקרובים", "מה מחכה", "לוח שבועי"] },
  { name: "system_trend",          scope: "system", kw: ["מגמה", "עולה", "יורד", "גידול", "ירידה", "שנתי", "חודשי", "טרנד", "גרף", "ביצועים"] },
  { name: "system_by_tag",         scope: "system", kw: ["לפי תגית", "תגיות", "vip", "קבוצות", "פילוח תגיות", "סיווגים"] },
  { name: "system_payment_methods",scope: "system", kw: ["אמצעי תשלום", "מזומן", "אשראי", "צ'ק", "העברה בנקאית", "שיטת תשלום", "איך משלמים"] },
  { name: "system_campaign_ready", scope: "system", kw: ["קמפיין", "מוכנים", "מאושרים לחיוג", "רשימת שיגור", "מוכן לקמפיין", "להשיק"] },
  { name: "system_biggest_debtor", scope: "system", kw: ["החייב הגדול", "מי חייב הכי", "חוב הגדול ביותר", "הגדול ביותר", "מי הכי חייב"] },
  { name: "system_recent_payments",scope: "system", kw: ["תשלומים אחרונים", "שולם לאחרונה", "השבוע שולם", "תשלומים אחרון", "גבינו לאחרונה"] },
  { name: "system_no_phone",       scope: "system", kw: ["בלי טלפון", "חסרי טלפון", "אין טלפון", "פרטי קשר חסרים", "ללא טלפון", "לא מושג"] },
  { name: "system_debt_aging",     scope: "system", kw: ["חובות ישנים", "ישנים", "זמן רב", "עתיקים", "ישן מ", "מזמן", "ותיקים"] },

  // Insights (any scope)
  { name: "insight_who_to_call",   scope: "any",    kw: ["למי להתקשר", "למי לפנות", "סדר עדיפויות שיחות", "מי ראשון", "שיחות היום", "לשלוח ראשון", "להתקשר", "לצלצל"] },
  { name: "insight_quick_wins",    scope: "any",    kw: ["קל לגבות", "קל לסגור", "חובות קטנים", "הכי מהיר", "win", "לסגור מהר", "קל", "פשוט לסגור"] },
  { name: "insight_at_risk",       scope: "any",    kw: ["בסיכון", "לנטוש", "יאבד", "לאבד", "מאבדים", "עזוב", "נטישה", "סכנת אובדן"] },
  { name: "insight_follow_up",     scope: "any",    kw: ["מעקב", "לחזור", "לבדוק", "follow", "לא נעשה כלום", "תקוע", "מי מחכה", "עומד ומחכה"] },
  { name: "insight_potential",     scope: "any",    kw: ["פוטנציאל", "יכול לתרום", "עלול לתרום", "בעלי יכולת", "תורמים פוטנציאלים", "ישנים שחזרו"] },
  { name: "insight_success_rate",  scope: "any",    kw: ["שיעור גביה", "אחוז הצלחה", "כמה הצלחנו", "יחס גביה", "ביצועי גביה", "מה האחוז"] },
  { name: "insight_debt_priority", scope: "any",    kw: ["איזה חוב לטפל", "קדימות טיפול", "ראשון לטפל", "לפי דחיפות", "טיפול בחובות", "לסדר"] },
  { name: "insight_before_holiday",scope: "any",    kw: ["לפני חג", "ראש השנה", "פסח", "חג", "הכנה לחג", "ערב חג", "קמפיין חג", "לפני החג"] },
];

// ─── Follow-up patterns ────────────────────────────────────────────────────────
const FOLLOWUP = [
  { kw: ["ספר לי יותר", "הרחב", "עוד פרטים", "יותר מידע", "הרחב על", "פרט יותר"], type: "expand" },
  { kw: ["הבא", "עוד", "הבא בתור", "מה הלאה", "מה עוד"], type: "next" },
  { kw: ["למה", "כי מה", "מה הסיבה", "הסבר לי", "מדוע", "בגלל מה"], type: "why" },
  { kw: ["כמה בדיוק", "מה הסכום המדויק", "פרטים על", "בדיוק כמה"], type: "amount" },
  { kw: ["ומה עם", "ואיך", "ומה לגבי", "גם"], type: "related" },
  { kw: ["מה ההמלצה", "מה כדאי לעשות", "מה עושים", "תמליץ"], type: "recommend" },
];

// ─── Synonym groups ────────────────────────────────────────────────────────────
const SYNONYM_GROUPS = [
  ["חוב", "חייב", "חייבים", "יתרה", "פתוח", "לשלם"],
  ["תשלום", "שילם", "שולם", "גביה", "גבייה", "לשלם", "שלם"],
  ["תרם", "תרומה", "תרומות", "נתן", "נדבה"],
  ["לא פעיל", "רדום", "לא תרם", "לא שמענו", "נעלם", "לא נראה"],
  ["משימה", "משימות", "לעשות", "todo", "פעולה", "פעולות"],
  ["תזכורת", "תזכורות", "להזכיר", "ריימיינדר"],
  ["טלפון", "פלאפון", "נייד", "מספר", "לצלצל"],
  ["ivr", "צינתוק", "חיוג אוטומטי", "מערכת חיוג"],
  ["סיכום", "מצב", "מה קורה", "עדכון", "תמונה"],
  ["קמפיין", "שיגור", "לשגר", "מבצע"],
  ["דחוף", "דחופות", "בוערות", "בדחיפות", "מיד"],
];

// Synonym lookup map built from groups
const SYNONYM_MAP = {};
SYNONYM_GROUPS.forEach(function (group) {
  group.forEach(function (term) {
    SYNONYM_MAP[normalize(term)] = group.map(normalize);
  });
});

// ─── Page context → intent bias ───────────────────────────────────────────────
const PAGE_INTENT_BIAS = {
  donor:     ["donor_summary", "donor_debt_list", "donor_debt_total", "donor_payment_history", "donor_tasks", "donor_timeline", "donor_recommendation"],
  debts:     ["system_priority_debts", "system_total_debt", "system_debt_aging", "system_biggest_debtor", "insight_debt_priority", "insight_quick_wins"],
  tasks:     ["system_open_tasks", "system_urgent_tasks", "insight_follow_up"],
  reminders: ["system_upcoming_rem", "insight_follow_up"],
  reports:   ["system_trend", "system_total_paid", "system_payment_methods", "insight_success_rate"],
  phone:     ["insight_who_to_call", "system_no_phone", "system_campaign_ready"],
  global:    [],
};

// ─── Clarifying questions for ambiguous input ─────────────────────────────────
const CLARIFYING = [
  "האם אתה מתכוון לתורם ספציפי, או לכל המערכת?",
  "תוכל לפרט? למשל: שם תורם, סוג חוב, או תקופת זמן.",
  "לא הצלחתי להבין את השאלה. מה תרצה לדעת — על תורם מסוים, על חובות, או על המצב הכללי?",
];

// ─── Text normalization ────────────────────────────────────────────────────────
function normalize(q) {
  return String(q || "")
    .toLowerCase()
    .replace(/[֑-ׇ]/g, "")   // strip Hebrew niqqud/cantillation
    .replace(/['"״׳`]/g, '"')
    .replace(/₪/g, "שקל")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Fuzzy keyword matching ───────────────────────────────────────────────────
function matchKw(normalizedQ, kw) {
  const nkw = normalize(kw);

  // 1. Exact substring
  if (normalizedQ.includes(nkw)) return true;

  // 2. Synonym expansion
  const synonyms = SYNONYM_MAP[nkw];
  if (synonyms && synonyms.some(function (s) { return normalizedQ.includes(s); })) return true;

  // 3. Multi-word partial — all words of kw appear somewhere in q
  const kwWords = nkw.split(" ").filter(Boolean);
  if (kwWords.length > 1 && kwWords.every(function (w) { return normalizedQ.includes(w); })) return true;

  return false;
}

// ─── Entity extraction ─────────────────────────────────────────────────────────
function extractEntities(q) {
  const entities = {};

  const mMatch = q.match(/(\d+)\s*חודש/);
  if (mMatch) entities.months = parseInt(mMatch[1]);
  if (/חצי שנה/.test(q)) entities.months = 6;
  // \b is a no-op around Hebrew letters (they aren't \w in JS regex), so
  // /\bשנה\b/ never matched at all — not even "לפני שנה". Use explicit
  // non-Hebrew-letter boundaries instead, so "שנה" alone still matches but
  // "ישנה" (old, fem.) or "השנה" (this year — handled separately below) don't.
  if (/(^|[^א-ת])שנה([^א-ת]|$)/.test(q) && !entities.months) entities.months = 12;
  if (/שנתיים/.test(q)) entities.months = 24;
  if (entities.months) entities.thresholdDays = entities.months * 30;

  const dMatch = q.match(/(\d+)\s*ימים?/);
  if (dMatch) entities.days = parseInt(dMatch[1]);

  const amtMatch = q.match(/([\d,]+)\s*(?:שקל|ש"ח|₪)/);
  if (amtMatch) entities.amount = parseInt(amtMatch[1].replace(/,/g, ""));

  if (/מעל|יותר מ/.test(q)) entities.amountOp = "gt";
  if (/מתחת|פחות מ/.test(q)) entities.amountOp = "lt";

  const topMatch = q.match(/(\d+)\s*(?:ראשונ|גדול|מובי)/);
  if (topMatch) entities.topN = parseInt(topMatch[1]);
  if (!entities.topN) entities.topN = 10;

  if (/היום/.test(q))    entities.timeRef = "today";
  if (/השבוע/.test(q))   entities.timeRef = "week";
  if (/החודש/.test(q))   entities.timeRef = "month";
  if (/השנה/.test(q))    entities.timeRef = "year";

  return entities;
}

// ─── Main detection function ───────────────────────────────────────────────────
function detectIntent(question, history, pageContext) {
  const raw = String(question || "");
  const q   = normalize(raw);
  const entities = extractEntities(raw.toLowerCase());

  // Last assistant intent from history
  const lastAsst = history && history.slice().reverse().find(function (m) { return m.role === "assistant"; });
  const lastIntent = lastAsst ? lastAsst.intent : null;

  // Check for follow-up
  for (var fi = 0; fi < FOLLOWUP.length; fi++) {
    var fp = FOLLOWUP[fi];
    if (fp.kw.some(function (kw) { return matchKw(q, kw); })) {
      if (lastIntent && lastIntent !== "general" && lastIntent !== "disambiguate") {
        return {
          intent:      lastIntent,
          scope:       null,
          confidence:  0.78,
          entities:    entities,
          isFollowUp:  true,
          followUpType: fp.type,
        };
      }
    }
  }

  // Score intents with fuzzy matching — weight longer keywords higher
  var scored = INTENTS.map(function (intent) {
    var hits = intent.kw.filter(function (kw) { return matchKw(q, kw); });
    var score = hits.reduce(function (s, kw) {
      return s + Math.max(1, normalize(kw).split(" ").filter(Boolean).length);
    }, 0);
    return Object.assign({}, intent, { score: score, hits: hits });
  })
    .filter(function (i) { return i.score > 0; })
    .sort(function (a, b) { return b.score - a.score || b.kw.length - a.kw.length; });

  // Apply page context bias (+1.5 score for relevant intents)
  if (pageContext && PAGE_INTENT_BIAS[pageContext]) {
    var biased = PAGE_INTENT_BIAS[pageContext];
    scored = scored.map(function (s) {
      return biased.indexOf(s.name) !== -1
        ? Object.assign({}, s, { score: s.score + 1.5 })
        : s;
    }).sort(function (a, b) { return b.score - a.score; });
  }

  if (!scored.length) {
    // Low confidence — check if we should ask for clarification
    if (raw.length > 3 && raw.length < 80) {
      return {
        intent:     "disambiguate",
        scope:      "any",
        confidence: 0.1,
        entities:   entities,
        isFollowUp: false,
        clarifyQ:   CLARIFYING[Math.floor(Math.random() * CLARIFYING.length)],
      };
    }
    return { intent: "general", confidence: 0.1, entities: entities, scope: "any", isFollowUp: false };
  }

  const best       = scored[0];
  const confidence = Math.min(0.96, 0.3 + best.score * 0.2);

  // If confidence is very low and multiple intents tie — ask for clarification
  if (confidence < 0.35 && scored.length > 2 && scored[0].score === scored[1].score) {
    return {
      intent:     "disambiguate",
      scope:      "any",
      confidence: confidence,
      entities:   entities,
      isFollowUp: false,
      clarifyQ:   CLARIFYING[0],
    };
  }

  return {
    intent:     best.name,
    scope:      best.scope,
    confidence: confidence,
    entities:   entities,
    isFollowUp: false,
  };
}

module.exports = { detectIntent, extractEntities, normalize, matchKw, INTENTS };

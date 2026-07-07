// ivr-audio.service.js — business logic for settings.html "ניהול הקלטות" tab.
// IMPORTANT: this is a management/staging tool for the FUTURE Yiddish IVR audio
// files. It does NOT connect to ivr.js / ivr.service.js / Technoline in any way —
// see docs/ivr-audio/ivr-audio-spec-v1.0-FROZEN.md for the source spec this seeds from.

const {
  getIvrAudioRecordings,
  getIvrAudioRecordingById,
  countIvrAudioRecordings,
  seedIvrAudioRecordingIfMissing,
  createIvrAudioRecording,
  updateIvrAudioRecording,
  setIvrAudioRecordingFile,
  clearIvrAudioRecordingFile,
} = require("./db");

const STATUSES = ["חסר", "תורגם", "הוקלט", "נבדק", "אושר"];
const STATUS_ORDER = STATUSES;

function isValidStatus(status) {
  return STATUSES.includes(status);
}

function bumpStatusOnUpload(currentStatus) {
  const idx = STATUS_ORDER.indexOf(currentStatus);
  const uploadIdx = STATUS_ORDER.indexOf("הוקלט");
  if (idx < uploadIdx) return "הוקלט";
  return currentStatus;
}

// Audio IDs are Latin (OPEN-001, NUM-DIGIT-7, ...) — this only guards against
// path traversal / odd characters when building filenames on disk.
function sanitizeAudioIdForFilename(audioId) {
  return String(audioId || "").trim().replace(/[^a-zA-Z0-9_-]/g, "_") || "audio";
}

// ── Seed data — copied verbatim from the frozen v1.0 spec ───────────────────
// docs/ivr-audio/ivr-audio-static-v1.0.csv (29 rows) +
// docs/ivr-audio/ivr-audio-numbers-v1.0.csv (44 number/currency files, expanded
// here from category rows into individually-uploadable Audio IDs).
//
// sourceTextHe below is a plain-Hebrew *reference* default — it stays fully
// editable in the table like every other field, this just avoids starting
// from 73 blank rows.

const STATIC_SEED = [
  { audioId: "OPEN-001", category: "open", sourceTextHe: "שלום וברכה, הגעתם למערכת תשלומים של א בלאט גמרא.", usageDescription: "פתיחה יחידה לכל שיחה — אין ברכה נוספת אחריה", notes: "שאלה למתרגם: הגיית שם הארגון באידיש?" },
  { audioId: "MENU-001", category: "menu", sourceTextHe: "למעבר לתשלום הקישו 1. לשמיעת חובות קודמים הקישו 2. להשארת הודעה הקישו 3.", usageDescription: "תפריט ראשי מלא", notes: "1/2/3 כספרות בודדות. שאלה למתרגם: האם \"הקישו\" אחיד בכל 6 התפריטים?" },
  { audioId: "MENU-002", category: "menu", sourceTextHe: "למעבר לתשלום הקישו 1. להשארת הודעה הקישו 3.", usageDescription: "יש חוב, אין חובות קודמים", notes: "" },
  { audioId: "MENU-003", category: "menu", sourceTextHe: "לתרומה הקישו 1. להשארת הודעה הקישו 3.", usageDescription: "אין חוב, מותר לתרום", notes: "\"תרומה\" שונה מ-\"תשלום\". שאלה למתרגם: יש הבחנה ברורה באידיש?" },
  { audioId: "MENU-004", category: "menu", sourceTextHe: "להשארת הודעה הקישו 3.", usageDescription: "רק הודעה", notes: "" },
  { audioId: "MENU-005", category: "menu", sourceTextHe: "למעבר לתשלום הקישו 1.", usageDescription: "וריאציה קצרה", notes: "" },
  { audioId: "MENU-006", category: "menu", sourceTextHe: "לתרומה הקישו 1.", usageDescription: "וריאציה קצרה", notes: "" },
  { audioId: "DEBT-001", category: "debt", sourceTextHe: "יש לך חוב על סכום", usageDescription: "פתיח הודעת חוב, סכום מוזרק אחריו", notes: "משפט נחתך. שאלה למתרגם: היכן החיתוך נכון באידיש?" },
  { audioId: "DEBT-002", category: "debt", sourceTextHe: "שקלים עבור", usageDescription: "מחבר משותף (חוב נוכחי + כל שורה ברשימה + PURP-004)", notes: "מכיל \"עבור\"" },
  { audioId: "DEBT-003", category: "debt", sourceTextHe: "לא נמצא חוב פתוח.", usageDescription: "תורם ידוע ללא חוב", notes: "" },
  { audioId: "DEBT-004", category: "debt", sourceTextHe: "לא נמצאו חובות קודמים.", usageDescription: "תפריט חובות קודמים ריק", notes: "" },
  { audioId: "DEBT-005", category: "debt", sourceTextHe: "לתשלום כל החובות הקישו 1. לתשלום סכום אחר הקישו 2. לסיום הקישו 9.", usageDescription: "תפריט אחרי רשימת חובות", notes: "\"9\" כספרה בודדת" },
  { audioId: "DEBT-006", category: "debt", sourceTextHe: "הסכום גבוה, אנא פנו לנציג.", usageDescription: "חוב מעל 99999 — לא מוקרא מספר", notes: "לשון רבים" },
  { audioId: "PAY-001", category: "pay", sourceTextHe: "לתשלום הסכום המלא,", usageDescription: "פתיח תת-תפריט תשלום", notes: "" },
  { audioId: "PAY-002", category: "pay", sourceTextHe: "שקלים, הקישו 1. לתשלום סכום אחר הקישו 2.", usageDescription: "סיום אותו משפט", notes: "" },
  { audioId: "PAY-003", category: "pay", sourceTextHe: "אנא הזינו את הסכום בשקלים ולחצו סולמית.", usageDescription: "בקשת סכום", notes: "\"סולמית\" = #. שאלה למתרגם: מונח מקביל באידיש?" },
  { audioId: "PAY-004", category: "pay", sourceTextHe: "הסכום שהוזן אינו תקין. אנא נסו שוב.", usageDescription: "סכום לא תקין", notes: "לשון רבים, מאוחד עם PAY-007/SYS-002" },
  { audioId: "PAY-005", category: "pay", sourceTextHe: "הסכום שהוזן גבוה מדי. אנא פנו לנציג.", usageDescription: "תשלום גבוה מדי", notes: "לשון רבים" },
  { audioId: "PAY-006", category: "pay", sourceTextHe: "התשלום התקבל בהצלחה. תודה רבה.", usageDescription: "הצלחת תשלום (בלי תלות בשם)", notes: "" },
  { audioId: "PAY-007", category: "pay", sourceTextHe: "התשלום לא הושלם. אנא נסו שוב מאוחר יותר.", usageDescription: "כישלון תשלום", notes: "לשון רבים, מאוחד" },
  { audioId: "PAY-008", category: "pay", sourceTextHe: "התשלום בכרטיס אשראי אינו זמין כרגע. נציג ייצור איתך קשר בהקדם. תודה.", usageDescription: "אין טרמינל / תשלום כבוי", notes: "לשון עתיד. שאלה למתרגם: ניסוח מקביל תקין?" },
  { audioId: "VM-001", category: "voicemail", sourceTextHe: "אנא השאירו הודעתכם לאחר הצליל.", usageDescription: "לפני הקלטה", notes: "הצליל עצמו מובנה בטכנוליין, לא קובץ שלנו" },
  { audioId: "VM-002", category: "voicemail", sourceTextHe: "הודעתכם התקבלה. תודה.", usageDescription: "אחרי הקלטה", notes: "" },
  { audioId: "SYS-001", category: "system", sourceTextHe: "תודה על התקשרותך. להתראות.", usageDescription: "סיום שיחה (הכי ממוחזר)", notes: "" },
  { audioId: "SYS-002", category: "system", sourceTextHe: "אירעה שגיאה. אנא נסו שוב מאוחר יותר.", usageDescription: "שגיאת מערכת גנרית", notes: "לשון רבים, מאוחד" },
  { audioId: "PURP-001", category: "purpose", sourceTextHe: "גליון מתאחדת", usageDescription: "מטרת חוב/תרומה", notes: "מונח מוסדי. שאלה למתרגם: מונח/הגייה מקובלים בקהילה?" },
  { audioId: "PURP-002", category: "purpose", sourceTextHe: "פרנס", usageDescription: "מטרת חוב/תרומה", notes: "מונח מוסדי. שאלה למתרגם: מונח/הגייה מקובלים בקהילה?" },
  { audioId: "PURP-003", category: "purpose", sourceTextHe: "כללי", usageDescription: "ברירת מחדל", notes: "" },
  { audioId: "PURP-004", category: "purpose", sourceTextHe: "המטרה הרשומה בכרטיסכם", usageDescription: "מטרה = \"אחר\" (טקסט חופשי)", notes: "נעול — בלי \"עבור\" בפתיח" },
];

// ── Numbers/currency (44) — expanded from the 6 category rows, standard
// dictionary Hebrew (masculine forms, matching the masculine noun "שקל"),
// per the number-composition design in the frozen spec §13. Fully editable.

const DIGIT_WORDS = ["אפס", "אחד", "שניים", "שלושה", "ארבעה", "חמישה", "שישה", "שבעה", "שמונה", "תשעה"];
const TEEN_WORDS = {
  10: "עשרה", 11: "אחד עשר", 12: "שנים עשר", 13: "שלושה עשר", 14: "ארבעה עשר",
  15: "חמישה עשר", 16: "שישה עשר", 17: "שבעה עשר", 18: "שמונה עשר", 19: "תשעה עשר",
};
const TENS_WORDS = { 20: "עשרים", 30: "שלושים", 40: "ארבעים", 50: "חמישים", 60: "שישים", 70: "שבעים", 80: "שמונים", 90: "תשעים" };
const HUNDRED_WORDS = { 100: "מאה", 200: "מאתיים", 300: "שלוש מאות", 400: "ארבע מאות", 500: "חמש מאות", 600: "שש מאות", 700: "שבע מאות", 800: "שמונה מאות", 900: "תשע מאות" };

const NUMBER_SEED = [];
for (let d = 0; d <= 9; d++) {
  NUMBER_SEED.push({
    audioId: "NUM-DIGIT-" + d, category: "number", sourceTextHe: DIGIT_WORDS[d],
    usageDescription: "בניית מספרים — ספרה בודדת (זכר, תואם \"שקל\")", notes: "שאלה למתרגם: התאמת מין באידיש?",
  });
}
for (let t = 10; t <= 19; t++) {
  NUMBER_SEED.push({
    audioId: "NUM-TEEN-" + t, category: "number", sourceTextHe: TEEN_WORDS[t],
    usageDescription: "בניית מספרים — עשרות-יחיד (10–19)", notes: "שאלה למתרגם: התאמת מין באידיש?",
  });
}
[20, 30, 40, 50, 60, 70, 80, 90].forEach(function (t) {
  NUMBER_SEED.push({
    audioId: "NUM-TENS-" + t, category: "number", sourceTextHe: TENS_WORDS[t],
    usageDescription: "בניית מספרים — עשרות", notes: "שאלה למתרגם: התאמת מין באידיש?",
  });
});
[100, 200, 300, 400, 500, 600, 700, 800, 900].forEach(function (h) {
  NUMBER_SEED.push({
    audioId: "NUM-HUNDRED-" + h, category: "number", sourceTextHe: HUNDRED_WORDS[h],
    usageDescription: "בניית מספרים — מאות (9 מילים עצמאיות, לא הרכבה)",
    notes: "שאלה למתרגם: 9 צורות ייחודיות באידיש, או הרכבה רגילה?",
  });
});
NUMBER_SEED.push(
  { audioId: "NUM-THOUSAND-1", category: "number", sourceTextHe: "אלף", usageDescription: "בניית מספרים — 1,000 (וגם מכפלות עשרת-אלפים ומעלה)", notes: "שאלה למתרגם: התנהגות דומה באידיש (יחיד/זוגי/רבים/חוזר ליחיד)?" },
  { audioId: "NUM-THOUSAND-2", category: "number", sourceTextHe: "אלפיים", usageDescription: "בניית מספרים — 2,000 בדיוק (צורת זוגי חריגה)", notes: "" },
  { audioId: "NUM-THOUSAND-PLURAL", category: "number", sourceTextHe: "אלפים", usageDescription: "בניית מספרים — סמן רבים ל-3,000–10,000", notes: "" },
  { audioId: "CUR-001", category: "currency", sourceTextHe: "שקל", usageDescription: "רכיב הרכבה כללי — יחיד", notes: "" },
  { audioId: "CUR-002", category: "currency", sourceTextHe: "שקלים", usageDescription: "רכיב הרכבה כללי — רבים", notes: "" },
  { audioId: "CUR-003", category: "currency", sourceTextHe: "שקל אחד", usageDescription: "ביטוי שלם קבוע ל-n=1 (סדר מילים הפוך, לא מורכב)", notes: "שאלה למתרגם: חריגה דומה ל-1 באידיש?" },
  { audioId: "CUR-004", category: "currency", sourceTextHe: "שני שקלים", usageDescription: "ביטוי שלם קבוע ל-n=2 (צורת סמיכות, לא מורכב)", notes: "שאלה למתרגם: חריגה דומה ל-2 באידיש?" }
);

const SEED_RECORDINGS = STATIC_SEED.concat(NUMBER_SEED);

// Idempotent — only inserts rows whose Audio ID doesn't exist yet. Safe to
// call on every server start; never touches/overwrites existing rows.
function seedIfEmpty() {
  if (countIvrAudioRecordings() > 0) return { seeded: 0, skipped: SEED_RECORDINGS.length };
  let seeded = 0;
  for (const rec of SEED_RECORDINGS) {
    if (seedIvrAudioRecordingIfMissing(rec)) seeded++;
  }
  return { seeded: seeded, skipped: SEED_RECORDINGS.length - seeded };
}

module.exports = {
  STATUSES,
  isValidStatus,
  bumpStatusOnUpload,
  sanitizeAudioIdForFilename,
  seedIfEmpty,
  getIvrAudioRecordings,
  getIvrAudioRecordingById,
  createIvrAudioRecording,
  updateIvrAudioRecording,
  setIvrAudioRecordingFile,
  clearIvrAudioRecordingFile,
};

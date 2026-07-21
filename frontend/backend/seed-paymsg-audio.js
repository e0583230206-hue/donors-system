// seed-paymsg-audio.js — idempotent seed for the 24 Technoline creditCard
// module systemMessages texts (S3000..S3023 -> PAYMSG-3000..PAYMSG-3023).
// Mirrors seed-ident-audio.js exactly. Safe to run any number of times, on
// any environment: only INSERTS a row when its audioId is completely
// missing — never touches an existing row, never overwrites, never
// duplicates.
//
// Usage (run from frontend/backend/):
//   node seed-paymsg-audio.js
//
// PAYMSG-<N> <-> S<N> is a deliberate 1:1 numeric mapping (see
// docs/ivr-audio/ivr-audio-paymsg-v1.0-DRAFT.md §2) — kept in a distinct
// "paymsg" category / distinct ID namespace from the pre-existing
// PAY-001..008 (unrelated: those are the pre-creditCard-module IVR prompts,
// not Technoline's own systemMessages).
//
// usageDescription doubles as the on-screen "what to record" note in the
// admin table — see docs/ivr-audio/ivr-audio-paymsg-v1.0-DRAFT.md §3 for
// the full per-line dynamic-value-cutoff analysis these notes summarize.
// No Yiddish translation is seeded here — recording/translation happens
// later, entirely through the admin UI (see §9 of the same doc).

const {
  getIvrAudioRecordingById,
  createIvrAudioRecording,
  updateIvrAudioRecording,
} = require("./db");

const PAYMSG_RECORDINGS = [
  { audioId: "PAYMSG-3000", category: "paymsg",
    sourceTextHe: "הנכם מועברים לביצוע תשלום על סך",
    usageDescription: "פתיח מודול סליקה — נחתך לפני שהסכום מוקרא (הסכום מוקרא בנפרד ע\"י טכנוליין, אין להקליטו)" },
  { audioId: "PAYMSG-3001", category: "paymsg",
    sourceTextHe: "לאישור הקישו 1, להקשת סכום אחר הקישו 2",
    usageDescription: "תפריט אישור סכום — משפט סגור, כולל את הספרות 1/2" },
  { audioId: "PAYMSG-3002", category: "paymsg",
    sourceTextHe: "נא הקישו את הסכום הכולל לתרומה, וסולמית לסיום",
    usageDescription: "בקשת קלט DTMF לסכום — משפט סגור, אין להקליט שום סכום" },
  { audioId: "PAYMSG-3003", category: "paymsg",
    sourceTextHe: "נא הקישו את מספר כרטיס האשראי, וסולמית לסיום",
    usageDescription: "בקשת קלט DTMF למספר כרטיס — משפט סגור" },
  { audioId: "PAYMSG-3004", category: "paymsg",
    sourceTextHe: "נא הקישו את תוקף האשראי בארבע ספרות",
    usageDescription: "בקשת קלט DTMF לתוקף — משפט סגור" },
  { audioId: "PAYMSG-3005", category: "paymsg",
    sourceTextHe: "התוקף שהוקש אינו תקין",
    usageDescription: "הודעת שגיאת תוקף — משפט סגור, עצמאי" },
  { audioId: "PAYMSG-3006", category: "paymsg",
    sourceTextHe: "נא הקישו את ספרות הביטחון אשר בגב הכרטיס",
    usageDescription: "בקשת קלט DTMF ל-CVV — משפט סגור" },
  { audioId: "PAYMSG-3007", category: "paymsg",
    sourceTextHe: "נא הקישו מספר תעודת זהות וסולמית לסיום",
    usageDescription: "בקשת קלט DTMF לתעודת זהות — משפט סגור" },
  { audioId: "PAYMSG-3008", category: "paymsg",
    sourceTextHe: "נא בחרו מספר תשלומים",
    usageDescription: "בקשת קלט DTMF למספר תשלומים — משפט סגור" },
  { audioId: "PAYMSG-3009", category: "paymsg",
    sourceTextHe: "ניתן לבחור עד",
    usageDescription: "נחתך לפני שמספר התשלומים המקסימלי מוקרא (מוקרא בנפרד ע\"י טכנוליין) — ממשיך במשפט ל-PAYMSG-3010" },
  { audioId: "PAYMSG-3010", category: "paymsg",
    sourceTextHe: "תשלומים",
    usageDescription: "מגיע אחרי המספר הדינמי של PAYMSG-3009, לא לפניו — משלים את המשפט \"ניתן לבחור עד N תשלומים\"" },
  { audioId: "PAYMSG-3011", category: "paymsg",
    sourceTextHe: "העסקה נכשלה",
    usageDescription: "הודעת כישלון עסקה — משפט סגור, עצמאי" },
  { audioId: "PAYMSG-3012", category: "paymsg",
    sourceTextHe: "הודעת השגיאה שהתקבלה",
    usageDescription: "נחתך לפני שטקסט/קוד השגיאה מהסולק מוקרא (מוקרא בנפרד, אין להקליטו)" },
  { audioId: "PAYMSG-3013", category: "paymsg",
    sourceTextHe: "העסקה נקלטה בהצלחה",
    usageDescription: "הודעת הצלחת עסקה — משפט סגור, עצמאי" },
  { audioId: "PAYMSG-3014", category: "paymsg",
    sourceTextHe: "מספר אישור",
    usageDescription: "נחתך לפני שמספר האישור בפועל מוקרא (מוקרא בנפרד ע\"י טכנוליין, אין להקליטו)" },
  { audioId: "PAYMSG-3015", category: "paymsg",
    sourceTextHe: "לשמיעה חוזרת הקישו 1, ליציאה הקישו 2",
    usageDescription: "תפריט סיום/חזרה — משפט סגור, כולל את הספרות 1/2" },
  { audioId: "PAYMSG-3016", category: "paymsg",
    sourceTextHe: "לתרומה בהוראת קבע הקישו 1",
    usageDescription: "אפשרות תרומה בהוראת קבע — משפט סגור" },
  { audioId: "PAYMSG-3017", category: "paymsg",
    sourceTextHe: "לתשלום חודשי באשראי ללא תפיסת מסגרת הקישו 2",
    usageDescription: "אפשרות תשלום חודשי — משפט סגור" },
  { audioId: "PAYMSG-3018", category: "paymsg",
    sourceTextHe: "לתרומה חד־פעמית הקישו 3",
    usageDescription: "אפשרות תרומה חד-פעמית — משפט סגור" },
  { audioId: "PAYMSG-3019", category: "paymsg",
    sourceTextHe: "לתרומה קבועה ללא הגבלת מספר חודשים הקישו 1",
    usageDescription: "תת-אפשרות הוראת קבע — משפט סגור" },
  { audioId: "PAYMSG-3020", category: "paymsg",
    sourceTextHe: "להגדרת מספר חודשים לתרומה הקישו 2",
    usageDescription: "תת-אפשרות הוראת קבע — משפט סגור" },
  { audioId: "PAYMSG-3021", category: "paymsg",
    sourceTextHe: "נא הקישו את מספר החודשים לתרומה",
    usageDescription: "בקשת קלט DTMF למספר חודשים — משפט סגור" },
  { audioId: "PAYMSG-3022", category: "paymsg",
    sourceTextHe: "נא הקישו את סכום התרומה החודשית, וסולמית לסיום",
    usageDescription: "בקשת קלט DTMF לסכום חודשי — משפט סגור" },
  { audioId: "PAYMSG-3023", category: "paymsg",
    sourceTextHe: "נא בחרו את יום החיוב בחודש הלועזי, בין 1 ל־28",
    usageDescription: "בקשת קלט DTMF ליום חיוב, טווח 1-28 — משפט סגור" },
];

function seed() {
  const report = {
    total: PAYMSG_RECORDINGS.length,
    created: 0,
    alreadyExisted: 0,
    createdIds: [],
    alreadyExistedIds: [],
  };

  for (const rec of PAYMSG_RECORDINGS) {
    const existing = getIvrAudioRecordingById(rec.audioId);
    if (existing) {
      report.alreadyExisted++;
      report.alreadyExistedIds.push(rec.audioId);
      continue; // never touch an existing row — no update, no overwrite
    }
    createIvrAudioRecording(rec.audioId);
    updateIvrAudioRecording(rec.audioId, {
      category: rec.category,
      sourceTextHe: rec.sourceTextHe,
      usageDescription: rec.usageDescription,
    });
    report.created++;
    report.createdIds.push(rec.audioId);
  }

  return report;
}

if (require.main === module) {
  const report = seed();
  console.log(JSON.stringify(report, null, 2));
}

module.exports = { seed, PAYMSG_RECORDINGS };

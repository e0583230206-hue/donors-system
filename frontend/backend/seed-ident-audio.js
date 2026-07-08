// seed-ident-audio.js — idempotent seed for the 10 caller-identification
// audio texts (IDENT-001..010) added to the "ניהול הקלטות" table after the
// frozen v1.0 73-row spec. Safe to run any number of times, on any
// environment: only INSERTS a row when its audioId is completely missing —
// never touches an existing row (including any of the original 73), never
// overwrites, never duplicates.
//
// Usage (run from frontend/backend/):
//   node seed-ident-audio.js
//
// Two name-containing texts (IDENT-001, IDENT-006) are deliberately
// fragments ending right before where the name would go — donor names are
// never spoken/recorded, same convention as the existing DEBT-001 row
// ("יש לך חוב על סכום").

const {
  getIvrAudioRecordingById,
  createIvrAudioRecording,
  updateIvrAudioRecording,
} = require("./db");

const IDENT_RECORDINGS = [
  { audioId: "IDENT-001", category: "ident",
    sourceTextHe: "המערכת זיהתה אותך על שם",
    usageDescription: "פתיח לפני שם התורם המזוהה (המשלם) — השם עצמו אינו מוקלט, בהתאם לעיקרון שקבענו שלא מקליטים שמות תורמים" },
  { audioId: "IDENT-002", category: "ident",
    sourceTextHe: "להמשך לתשלום עבור עצמך הקישו 1. למעבר לתשלום עבור מישהו אחר הקישו 2.",
    usageDescription: "תפריט בחירה מיד אחרי זיהוי מוצלח של המשלם" },
  { audioId: "IDENT-003", category: "ident",
    sourceTextHe: "המערכת לא זיהתה את מספר הטלפון שממנו התקשרתם.",
    usageDescription: "Caller ID לא תואם אף תורם רשום" },
  { audioId: "IDENT-004", category: "ident",
    sourceTextHe: "נא הכניסו מספר טלפון או מספר זהות, ולסיום הקישו סולמית.",
    usageDescription: "בקשת זיהוי עצמי ידני (טלפון לא זוהה, או לאחר ריבוי התאמות)" },
  { audioId: "IDENT-005", category: "ident",
    sourceTextHe: "נא הכניסו את מספר הטלפון או מספר הזהות של התורם שעבורו תרצו לשלם, ולסיום הקישו סולמית.",
    usageDescription: "בקשת זיהוי תורם עבור \"תשלום עבור מישהו אחר\"" },
  { audioId: "IDENT-006", category: "ident",
    sourceTextHe: "המערכת זיהתה את התורם על שם",
    usageDescription: "פתיח לפני שם התורם המוטב שנמצא בחיפוש — השם עצמו אינו מוקלט" },
  { audioId: "IDENT-007", category: "ident",
    sourceTextHe: "לאישור והמשך לתשלום הקישו 1. לחיפוש מחדש הקישו 2.",
    usageDescription: "אישור זהות התורם המוטב לפני שממשיכים לתשלום" },
  { audioId: "IDENT-008", category: "ident",
    sourceTextHe: "לא נמצא תורם לפי הזיהוי שהוקש.",
    usageDescription: "זיהוי לא נמצא — הן בזיהוי עצמי והן בחיפוש מוטב" },
  { audioId: "IDENT-009", category: "ident",
    sourceTextHe: "לא ניתן לזהות בבירור לפי המספר שהוקש.",
    usageDescription: "כמה תורמים תואמים לאותו זיהוי — לא נבחר אוטומטית (בטיחות)" },
  { audioId: "IDENT-010", category: "ident",
    sourceTextHe: "לא הצלחנו לזהות אתכם. ניתן להשאיר הודעה, ואנו נחזור אליכם.",
    usageDescription: "אחרי 3 ניסיונות זיהוי כושלים — מעבר להשארת הודעה קולית" },
];

function seed() {
  const report = {
    total: IDENT_RECORDINGS.length,
    created: 0,
    alreadyExisted: 0,
    createdIds: [],
    alreadyExistedIds: [],
  };

  for (const rec of IDENT_RECORDINGS) {
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

module.exports = { seed, IDENT_RECORDINGS };

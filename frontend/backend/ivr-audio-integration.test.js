// ivr-audio-integration.test.js — REAL integration test, deliberately NOT
// using makeAlwaysResolvingAudio() or any other hand-written fake. This is
// exactly the kind of test that would have caught the IDENT-002 bug (a
// fake resolver that "always succeeds" can never reveal a text-lookup gap
// caused by real data living in two separate arrays).
//
// Uses:
//   - the REAL db.js IVR_AUDIO_CANONICAL_RECORDINGS (73 rows) + the REAL
//     seed-ident-audio.js IDENT_RECORDINGS (10 rows) — combined, exactly the
//     two authoritative sources, never hand-retyped text.
//   - a TEMPORARY sqlite DB (own file under os.tmpdir(), cleaned up after)
//     with the real ivr_audio_recordings schema.
//   - TEMPORARY real files physically written to a temp uploads directory —
//     fs.existsSync() checks a real file, not a mock.
//   - the REAL createAudioResolver() from ivr-audio-resolver.service.js and
//     the REAL createAudioContext() from ivr-audio-context.service.js —
//     the exact same functions production uses, wired to the temp DB/dir
//     instead of the real ones.
//
// Never touches the real production DB, uploads directory, or .env.
//
// הרצה: node ivr-audio-integration.test.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const db = require("./db"); // IVR_AUDIO_CANONICAL_RECORDINGS only — no writes anywhere
const { IDENT_RECORDINGS } = require("./seed-ident-audio");
const { createAudioResolver } = require("./ivr-audio-resolver.service");
const { createAudioContext, textToAudioIdFrom } = require("./ivr-audio-context.service");
const { computeDerivedFilename } = require("./scripts/convert-ivr-audio-to-wav");
const ivr = require("./ivr");

const ALL_CANONICAL = db.IVR_AUDIO_CANONICAL_RECORDINGS.concat(IDENT_RECORDINGS);

// The audioId set requirement 8 explicitly asks to cover, plus IDENT-001/002
// (already the requirement-7 subject) and IDENT-006/007 (its beneficiary
// counterpart).
const TEST_AUDIO_IDS = [
  "OPEN-001",
  "IDENT-001", "IDENT-002", "IDENT-006", "IDENT-007",
  "DEBT-001", "DEBT-002", "DEBT-003",
  "MENU-001", "MENU-002", "MENU-003", "MENU-004", "MENU-005", "MENU-006",
  "PAY-001", "PAY-002", "PAY-003", "PAY-004", "PAY-005", "PAY-006", "PAY-007", "PAY-008",
  "PURP-001", "PURP-002", "PURP-003", "PURP-004",
  "SYS-001", "SYS-002",
];

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name: name, ok: true });
  } catch (err) {
    results.push({ name: name, ok: false, error: err.message });
  }
}

// ── Fixture setup: temp DB + temp uploads dir, real rows, real files ─────────
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ivr-audio-it-"));
const uploadDir = path.join(tmpRoot, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });
const dbPath = path.join(tmpRoot, "test.sqlite");

const setupDb = new DatabaseSync(dbPath);
setupDb.exec(`
  CREATE TABLE ivr_audio_recordings (
    audioId          TEXT PRIMARY KEY,
    category         TEXT NOT NULL DEFAULT '',
    sourceTextHe     TEXT NOT NULL DEFAULT '',
    translation      TEXT NOT NULL DEFAULT '',
    usageDescription TEXT NOT NULL DEFAULT '',
    audioFile1       TEXT NOT NULL DEFAULT '',
    audioFile2       TEXT NOT NULL DEFAULT '',
    audioFile3       TEXT NOT NULL DEFAULT '',
    status           TEXT NOT NULL DEFAULT 'חסר',
    notes            TEXT NOT NULL DEFAULT '',
    createdAt        TEXT NOT NULL,
    updatedAt        TEXT NOT NULL
  )
`);

const now = new Date().toISOString();
const insertRow = setupDb.prepare(`
  INSERT INTO ivr_audio_recordings
    (audioId, category, sourceTextHe, translation, usageDescription, audioFile1, audioFile2, audioFile3, status, notes, createdAt, updatedAt)
  VALUES (?, ?, ?, '', '', ?, '', '', 'אושר', '', ?, ?)
`);

TEST_AUDIO_IDS.forEach(function (audioId) {
  const canon = ALL_CANONICAL.find(function (r) { return r.audioId === audioId; });
  if (!canon) {
    throw new Error("No canonical entry for " + audioId + " in IVR_AUDIO_CANONICAL_RECORDINGS/IDENT_RECORDINGS — cannot build fixture");
  }
  const sourceFilename = audioId + "-1-testfixture.mp3";
  const derivedFilename = computeDerivedFilename(sourceFilename);
  fs.writeFileSync(path.join(uploadDir, derivedFilename), "fake-wav-bytes-for-integration-test");
  insertRow.run(audioId, canon.category, canon.sourceTextHe, sourceFilename, now, now);
});
setupDb.close();

// חיבור readOnly יחיד, לכל הבדיקות בקובץ הזה — נסגר במפורש לפני הניקוי
// בסוף הקובץ, כדי שלא יישארו File handles פתוחים (על Windows זה גורם ל-
// EPERM ב-fs.rmSync על תיקיית ה-DB הזמנית).
const sharedReadDb = new DatabaseSync(dbPath, { readOnly: true });

function makeRealAudioContext() {
  const resolveAudio = createAudioResolver({
    getRecordByAudioId: function (audioId) {
      return sharedReadDb.prepare("SELECT * FROM ivr_audio_recordings WHERE audioId = ?").get(String(audioId));
    },
    fileExists: fs.existsSync,
    uploadDir: uploadDir,
    baseUrl: "https://test.example/uploads/ivr-audio",
    fallbackTextByAudioId: {},
  });
  return createAudioContext({
    textToAudioId: textToAudioIdFrom(ALL_CANONICAL),
    resolveAudio: resolveAudio,
  });
}

function expectedFileLink(audioId) {
  const sourceFilename = audioId + "-1-testfixture.mp3";
  const derivedFilename = computeDerivedFilename(sourceFilename);
  return "https://test.example/uploads/ivr-audio/" + derivedFilename;
}

// ── Requirement 7: self_menu, real end-to-end, exact 4-item sequence ────────
check("[אינטגרציה אמיתית] self_menu turn ראשון: בדיוק 4 פריטים — OPEN-001, IDENT-001, {text:name}, IDENT-002", function () {
  const audio = makeRealAudioContext();
  const identState = { kind: "self_menu", donor: { fullName: "רבקה כהן" } };
  const res = ivr.buildIdentificationResponse({}, identState, audio);
  const files = res.files;

  assert.strictEqual(files.length, 4, "אמורים להיות בדיוק 4 פריטים");
  assert.deepStrictEqual(files[0], { fileLink: expectedFileLink("OPEN-001"), fileName: computeDerivedFilename("OPEN-001-1-testfixture.mp3").replace(/\.wav$/, "") });
  assert.strictEqual(files[1].fileLink, expectedFileLink("IDENT-001"));
  assert.deepStrictEqual(files[2], { text: "רבקה כהן" });
  // הבדיקה הזו הייתה נכשלת לפני התיקון — files[3] היה חוזר כ-{text:...}.
  assert.ok(files[3].fileLink, "IDENT-002 חייב fileLink אמיתי — זה בדיוק הבאג שתוקן");
  assert.strictEqual(files[3].fileLink, expectedFileLink("IDENT-002"));
  files.forEach(function (f) {
    if (f.fileLink) assert.ok(!("text" in f), "פריט עם fileLink לא אמור לכלול גם text");
  });
});

// ── IDENT-006 + name + IDENT-007 (מקביל לדרישה 7, עבור המוטב) ────────────────
check("[אינטגרציה אמיתית] beneficiary_confirm: IDENT-006, {text:name}, IDENT-007 — כולם fileLink אמיתי", function () {
  const audio = makeRealAudioContext();
  const identState = { kind: "beneficiary_confirm", donor: { fullName: "משה גולד" } };
  const res = ivr.buildIdentificationResponse({}, identState, audio);
  assert.strictEqual(res.files.length, 3);
  assert.strictEqual(res.files[0].fileLink, expectedFileLink("IDENT-006"));
  assert.deepStrictEqual(res.files[1], { text: "משה גולד" });
  assert.strictEqual(res.files[2].fileLink, expectedFileLink("IDENT-007"));
});

// ── DEBT-001/002/003 ──────────────────────────────────────────────────────
check("[אינטגרציה אמיתית] DEBT-001 ו-DEBT-002 מסביב לסכום (buildHasDebtSegment)", function () {
  const audio = makeRealAudioContext();
  const items = ivr.buildHasDebtSegment(audio, 3, "פרנס", "פרנס");
  assert.strictEqual(items[0].fileLink, expectedFileLink("DEBT-001"));
  const debt002Item = items.find(function (it) { return it.fileLink === expectedFileLink("DEBT-002"); });
  assert.ok(debt002Item, "DEBT-002 חייב להופיע ברצף");
});

check("[אינטגרציה אמיתית] DEBT-003 (NO_OPEN_DEBT) דרך buildResponse מלא", function () {
  const audio = makeRealAudioContext();
  const donor = {
    fullName: "יעל שדה", currentDebt: null, previousDebts: [], publicPhoneNote: "",
    settings: { allowPayment: true, allowPreviousDebts: true, allowCallback: true },
  };
  const res = ivr.buildResponse({}, donor, audio);
  const files = res.files;
  const debt003Item = files.find(function (f) { return f.fileLink === expectedFileLink("DEBT-003"); });
  assert.ok(debt003Item, "DEBT-003 (לא נמצא חוב פתוח) חייב להיפתר לאודיו אמיתי");
});

// ── MENU-001..006 — כל אחד דרך תרחיש buildResponse אמיתי שמייצר אותו ────────
check("[אינטגרציה אמיתית] MENU-001..006 — כל תרחיש מייצר את ה-fileLink הנכון", function () {
  const audio = makeRealAudioContext();

  function lastFileLink(donor, query) {
    const res = ivr.buildResponse(query || {}, donor, audio);
    const files = res.files;
    return files[files.length - 1].fileLink;
  }

  const withDebtAndPrev = {
    fullName: "א", currentDebt: { amount: 10, purpose: "כללי", purposeType: "" },
    previousDebts: [{ amount: 5, purpose: "כללי", purposeType: "" }], publicPhoneNote: "",
    settings: { allowPayment: true, allowPreviousDebts: true, allowCallback: true },
  };
  assert.strictEqual(lastFileLink(withDebtAndPrev), expectedFileLink("MENU-001"));

  const withDebtNoPrevCallback = {
    fullName: "ב", currentDebt: { amount: 10, purpose: "כללי", purposeType: "" },
    previousDebts: [], publicPhoneNote: "",
    settings: { allowPayment: true, allowPreviousDebts: true, allowCallback: true },
  };
  assert.strictEqual(lastFileLink(withDebtNoPrevCallback), expectedFileLink("MENU-002"));

  const donationOnly = {
    fullName: "ג", currentDebt: null, previousDebts: [], publicPhoneNote: "",
    settings: { allowPayment: true, allowPreviousDebts: true, allowCallback: true },
  };
  assert.strictEqual(lastFileLink(donationOnly), expectedFileLink("MENU-003"));

  const messageOnly = {
    fullName: "ד", currentDebt: null, previousDebts: [], publicPhoneNote: "",
    settings: { allowPayment: false, allowPreviousDebts: false, allowCallback: true },
  };
  assert.strictEqual(lastFileLink(messageOnly), expectedFileLink("MENU-004"));

  const payOnlyNoCallback = {
    fullName: "ה", currentDebt: { amount: 10, purpose: "כללי", purposeType: "" },
    previousDebts: [], publicPhoneNote: "",
    settings: { allowPayment: true, allowPreviousDebts: true, allowCallback: false },
  };
  assert.strictEqual(lastFileLink(payOnlyNoCallback), expectedFileLink("MENU-005"));

  const donateOnlyNoCallback = {
    fullName: "ו", currentDebt: null, previousDebts: [], publicPhoneNote: "",
    settings: { allowPayment: true, allowPreviousDebts: true, allowCallback: false },
  };
  assert.strictEqual(lastFileLink(donateOnlyNoCallback), expectedFileLink("MENU-006"));
});

// ── PAY-001..008 ─────────────────────────────────────────────────────────
check("[אינטגרציה אמיתית] PAY-001/PAY-002 מסביב לסכום (buildPayFullOrCustomSegment)", function () {
  const audio = makeRealAudioContext();
  const items = ivr.buildPayFullOrCustomSegment(audio, 100);
  assert.strictEqual(items[0].fileLink, expectedFileLink("PAY-001"));
  assert.strictEqual(items[items.length - 1].fileLink, expectedFileLink("PAY-002"));
});

check("[אינטגרציה אמיתית] PAY-003 (ENTER_AMOUNT) — mainChoice=1 בלי חוב", function () {
  const audio = makeRealAudioContext();
  const donor = {
    fullName: "ז", currentDebt: null, previousDebts: [], publicPhoneNote: "",
    settings: { allowPayment: true, allowPreviousDebts: true, allowCallback: true },
  };
  const res = ivr.buildResponse({ mainChoice: "1" }, donor, audio);
  assert.strictEqual(res.files[0].fileLink, expectedFileLink("PAY-003"));
});

check("[אינטגרציה אמיתית] PAY-004 (AMOUNT_INVALID) ו-PAY-005 (AMOUNT_TOO_HIGH)", function () {
  const audio = makeRealAudioContext();
  const donor = {
    fullName: "ח", currentDebt: null, previousDebts: [], publicPhoneNote: "",
    settings: { allowPayment: true, allowPreviousDebts: true, allowCallback: true },
  };
  const invalidRes = ivr.buildResponse({ mainChoice: "1", amount: "abc" }, donor, audio);
  assert.strictEqual(invalidRes[0].files[0].fileLink, expectedFileLink("PAY-004"));

  const tooHighRes = ivr.buildResponse({ mainChoice: "1", amount: "999999" }, donor, audio);
  assert.strictEqual(tooHighRes[0].files[0].fileLink, expectedFileLink("PAY-005"));
});

check("[אינטגרציה אמיתית] PAY-006 (PAYMENT_SUCCESS tail) ו-PAY-007 (PAYMENT_FAILED)", function () {
  const audio = makeRealAudioContext();
  const successItems = ivr.buildPaymentSuccessSegment(audio, null);
  assert.strictEqual(successItems[0].fileLink, expectedFileLink("PAY-006"));

  const donor = {
    fullName: "ט", currentDebt: null, previousDebts: [], publicPhoneNote: "",
    settings: { allowPayment: true, allowPreviousDebts: true, allowCallback: true },
  };
  const failedRes = ivr.buildResponse({ payment: "ERROR" }, donor, audio);
  assert.strictEqual(failedRes[0].files[0].fileLink, expectedFileLink("PAY-007"));
});

check("[אינטגרציה אמיתית] PAY-008 (PAYMENT_UNAVAILABLE) — תשלום מבוטל להורה", function () {
  const audio = makeRealAudioContext();
  const donor = {
    fullName: "י", currentDebt: null, previousDebts: [], publicPhoneNote: "",
    settings: { allowPayment: false, allowPreviousDebts: true, allowCallback: true },
  };
  const res = ivr.buildResponse({ mainChoice: "1" }, donor, audio);
  assert.strictEqual(res[0].files[0].fileLink, expectedFileLink("PAY-008"));
});

// ── PURP-001..004 ────────────────────────────────────────────────────────
check("[אינטגרציה אמיתית] PURP-001..004 — כולם מזוהים נכון דרך ה-resolver האמיתי", function () {
  const audio = makeRealAudioContext();
  assert.strictEqual(ivr.buildPurposeSegment(audio, "גליון מתאחדת", "גליון מתאחדת")[0].fileLink, expectedFileLink("PURP-001"));
  assert.strictEqual(ivr.buildPurposeSegment(audio, "פרנס", "פרנס")[0].fileLink, expectedFileLink("PURP-002"));
  assert.strictEqual(ivr.buildPurposeSegment(audio, "כללי", "")[0].fileLink, expectedFileLink("PURP-003"));
  assert.strictEqual(ivr.buildPurposeSegment(audio, "כל מטרה", "אחר")[0].fileLink, expectedFileLink("PURP-004"));
});

// ── SYS-001/SYS-002 ──────────────────────────────────────────────────────
check("[אינטגרציה אמיתית] SYS-001 (GOODBYE) — mainChoice=ERROR", function () {
  const audio = makeRealAudioContext();
  const donor = {
    fullName: "כ", currentDebt: null, previousDebts: [], publicPhoneNote: "",
    settings: { allowPayment: true, allowPreviousDebts: true, allowCallback: true },
  };
  const res = ivr.buildResponse({ mainChoice: "ERROR" }, donor, audio);
  assert.strictEqual(res[0].files[0].fileLink, expectedFileLink("SYS-001"));
});

check("[אינטגרציה אמיתית] SYS-002 — לא מחובר לזרימה החיה כרגע, אבל הרשומה עצמה נפתרת נכון דרך ה-resolver", function () {
  const audio = makeRealAudioContext();
  // SYS-002 משמש כרגע רק כטקסט ה-fallback הגנרי בקוד ה-resolver עצמו — אין
  // לו עדיין אתר קריאה חי ב-ivr.js. בודקים ישירות מול ה-resolveOrText/
  // resolveAudioId שהרשומה עצמה תקינה וניתנת לפתרון (לא שהיא "מחוברת").
  const result = audio.resolveAudioId("SYS-002", "אירעה שגיאה. אנא נסו שוב מאוחר יותר.");
  assert.strictEqual(result.fileLink, expectedFileLink("SYS-002"));
});

// ── ניקוי ────────────────────────────────────────────────────────────────
try {
  sharedReadDb.close();
} catch (e) {
  console.warn("[ivr-audio-integration.test.js] sharedReadDb close warning:", e.message);
}
try {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch (e) {
  console.warn("[ivr-audio-integration.test.js] cleanup warning:", e.message);
}

// ── סיכום ────────────────────────────────────────────────────────────────
const failed = results.filter(function (r) { return !r.ok; });
results.forEach(function (r) {
  console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : " — " + r.error));
});
console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");
process.exit(failed.length ? 1 : 0);

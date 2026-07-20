// ivr.test.js — בדיקות לחיבור ההקלטות לתוך ivr.js (buildResponse/
// buildIdentificationResponse + פונקציות ה-composer שמיוצאות מהן). כל
// הבדיקות משתמשות ב-audio מוזרק ידנית (dependency injection) — לא נוגעות
// ב-DB/דיסק/ffprobe/resolver האמיתי בכלל. בדיקות הניתוב לפי מצב/טלפון
// (off/trial/on ← IVR_AUDIO_MODE) נמצאות ב-ivr-audio-context.service.test.js
// — כאן נבדק רק "מה ivr.js עושה עם מה שה-audio context נותן לו", לא איך
// ה-context עצמו נבנה.
//
// הרצה: node ivr.test.js

const assert = require("assert");
const ivr = require("./ivr");

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name: name, ok: true });
  } catch (err) {
    results.push({ name: name, ok: false, error: err.message });
  }
}

// ── fakes ל-audio context (DI טהור) ──────────────────────────────────────────

// שום דבר לא נפתר — זהה במפורש למצב IVR_AUDIO_MODE=off (passthrough).
function makeOffAudio() {
  return {
    resolveOrText: function (text) { return { text: text }; },
    resolveAudioId: function (id, fallbackText) { return { text: fallbackText }; },
  };
}

// הכול נפתר בהצלחה — מדמה מצב שבו כל ה-audioId המבוקשים קיימים ומאושרים.
function makeAlwaysResolvingAudio() {
  return {
    resolveOrText: function (text) { return { fileLink: "https://fake/text.wav", fileName: "TXT-MATCH" }; },
    resolveAudioId: function (id, fallbackText) { return { fileLink: "https://fake/" + id + ".wav", fileName: id }; },
  };
}

// כמו "הכול נפתר", אבל resolveOrText מזהה רק טקסטים ספציפיים (כמו שה-resolver
// האמיתי מזהה רק טקסט שתואם בדיוק להקלטה מאושרת) — לבדיקת "כללי"→PURP-003
// מול מטרה חופשית שלא תואמת שום דבר.
function makeRealisticAudio(matchingTexts) {
  return {
    resolveOrText: function (text) {
      var trimmed = String(text).trim();
      if (matchingTexts.indexOf(trimmed) !== -1) {
        return { fileLink: "https://fake/text.wav", fileName: "TXT-" + trimmed };
      }
      return { text: text };
    },
    resolveAudioId: function (id, fallbackText) { return { fileLink: "https://fake/" + id + ".wav", fileName: id }; },
  };
}

// כמו "הכול נפתר", חוץ מ-audioId אחד ספציפי שנכשל (מדמה נגזרת/מקור חסרים).
function makeAudioWithMissingId(missingId) {
  return {
    resolveOrText: function (text) { return { text: text }; },
    resolveAudioId: function (id, fallbackText) {
      if (id === missingId) return { text: fallbackText };
      return { fileLink: "https://fake/" + id + ".wav", fileName: id };
    },
  };
}

// זורק תמיד — לבדיקת ההתנהגות כשה-audio context עצמו נכשל (לא ה-DB/דיסק
// שכבר נבדקו ב-ivr-audio-resolver.service.test.js, אלא שכבת ivr.js עצמה).
function makeThrowingAudio() {
  return {
    resolveOrText: function () { throw new Error("boom"); },
    resolveAudioId: function () { throw new Error("boom"); },
  };
}

function hasFileLink(item) { return item && typeof item.fileLink === "string"; }
function allFilesArray(response) {
  // buildResponse/buildIdentificationResponse מחזירים לפעמים module יחיד,
  // לפעמים מערך — משטחים ל-files[] הבודד הרלוונטי לכל בדיקה בנפרד.
  return response.files || [];
}
function wordsOf(text) {
  return String(text).replace(/[.,]/g, " ").trim().split(/\s+/).filter(Boolean);
}
function concatText(files) {
  return files.map(function (f) { return f.text || ""; }).join(" ");
}

function baseDonor(overrides) {
  return Object.assign({
    fullName: "דוד לוי",
    currentDebt: null,
    previousDebts: [],
    publicPhoneNote: "",
    settings: { allowPayment: true, allowPreviousDebts: true, allowCallback: true },
  }, overrides || {});
}

// ═══ 1. mode=off — פונקציונלית זהה ל-TTS הקיים, אין fileLink בשום מקום ═══════

check("1. mode=off: תפריט ראשי עם חוב — כל הפריטים {text}, אין fileLink אחד", function () {
  var donor = baseDonor({ currentDebt: { amount: 583, purpose: "פרנס", purposeType: "פרנס" } });
  var res = ivr.buildResponse({}, donor, makeOffAudio());
  var files = allFilesArray(res);
  files.forEach(function (f) { assert.ok(!hasFileLink(f), "לא אמור להיות fileLink במצב off"); });
});

check("1. mode=off: התוכן המילולי זהה למה שהיה (מודבק ממקטעים, לא ממחרוזת אחת — אך אותן מילים)", function () {
  var donor = baseDonor({ currentDebt: { amount: 583, purpose: "פרנס", purposeType: "פרנס" } });
  var res = ivr.buildResponse({}, donor, makeOffAudio());
  var got = wordsOf(concatText(allFilesArray(res)));
  var expectedOld = wordsOf(
    "שלום דוד לוי." + " יש לך חוב על סכום 583 שקלים עבור פרנס." + " למעבר לתשלום הקישו 1. להשארת הודעה הקישו 3."
  );
  assert.deepStrictEqual(got, expectedOld);
});

check("1. mode=off: ללא audio בכלל (undefined) — זהה במדויק ל-audio=off מפורש", function () {
  var donor = baseDonor({ currentDebt: { amount: 100, purpose: "כללי", purposeType: "" } });
  var withUndefined = ivr.buildResponse({}, donor); // בלי ארגומנט שלישי כלל
  var withOff        = ivr.buildResponse({}, donor, makeOffAudio());
  assert.deepStrictEqual(withUndefined, withOff);
});

check("1. mode=off: תשלום הצליח עם שם תורם — עדיין רק {text}", function () {
  var res = ivr.buildResponse({ payment: "OK" }, baseDonor(), makeOffAudio());
  res[0].files.forEach(function (f) { assert.ok(!hasFileLink(f)); });
  assert.deepStrictEqual(wordsOf(concatText(res[0].files)), wordsOf("תודה דוד לוי. התשלום התקבל בהצלחה. תודה רבה."));
});

// ═══ 4. mode=on — הקלטות מופעלות לכל מספר (audio "מלא") ════════════════════

check("4. mode=on: DEBT-001/DEBT-002/PURP-002 הופכים ל-fileLink כשהם ידועים ומאושרים", function () {
  var donor = baseDonor({ currentDebt: { amount: 25, purpose: "פרנס", purposeType: "פרנס" } });
  var res = ivr.buildResponse({}, donor, makeAlwaysResolvingAudio());
  var files = allFilesArray(res);
  var ids = files.map(function (f) { return f.fileName; }).filter(Boolean);
  assert.ok(ids.includes("DEBT-001"));
  assert.ok(ids.includes("DEBT-002"));
  assert.ok(ids.includes("PURP-002"));
});

check("4. mode=on: שם התורם עדיין נשאר {text}, לעולם לא fileLink — אין audioId תואם ל'שלום {שם}'", function () {
  var donor = baseDonor({ currentDebt: { amount: 25, purpose: "פרנס", purposeType: "פרנס" } });
  var res = ivr.buildResponse({}, donor, makeAlwaysResolvingAudio());
  var greetingItem = allFilesArray(res)[0];
  assert.deepStrictEqual(greetingItem, { text: "שלום דוד לוי." });
});

// ═══ 5. שם תורם: הקלטה + {text:name} + הקלטה, בסדר הנכון ══════════════════════

check("5. self_menu (identKnown): IDENT-001 (audio) → {text:name} → IDENT-002 (audio, rid מפורש — לא עוד TXT-MATCH)", function () {
  var identState = { kind: "self_menu", donor: { fullName: "רבקה כהן" } };
  var res = ivr.buildIdentificationResponse({ identChoice: "x" }, identState, makeAlwaysResolvingAudio());
  var files = res.files; // אין opening (לא first turn, כי identChoice מוגדר)
  assert.strictEqual(files.length, 3);
  assert.strictEqual(files[0].fileName, "IDENT-001");
  assert.deepStrictEqual(files[1], { text: "רבקה כהן" });
  assert.strictEqual(files[2].fileName, "IDENT-002");
});

check("5. beneficiary_confirm (identBeneficiaryFound): IDENT-006 (audio) → {text:name} → IDENT-007 (audio, rid מפורש)", function () {
  var identState = { kind: "beneficiary_confirm", donor: { fullName: "משה גולד" } };
  var res = ivr.buildIdentificationResponse({}, identState, makeAlwaysResolvingAudio());
  assert.strictEqual(res.files.length, 3);
  assert.strictEqual(res.files[0].fileName, "IDENT-006");
  assert.deepStrictEqual(res.files[1], { text: "משה גולד" });
  assert.strictEqual(res.files[2].fileName, "IDENT-007");
});

check('5. (דרישה 7 — הבאג האמפירי) self_menu בתור first turn: בדיוק 4 איברים בסדר הנכון — OPEN-001, IDENT-001, {text:name}, IDENT-002', function () {
  var identState = { kind: "self_menu", donor: { fullName: "רבקה כהן" } };
  var res = ivr.buildIdentificationResponse({}, identState, makeAlwaysResolvingAudio());
  var files = res.files;
  assert.strictEqual(files.length, 4);
  assert.strictEqual(files[0].fileName, "OPEN-001", "פריט 1 חייב להיות fileLink של OPEN-001");
  assert.strictEqual(files[1].fileName, "IDENT-001", "פריט 2 חייב להיות fileLink של IDENT-001");
  assert.deepStrictEqual(files[2], { text: "רבקה כהן" }, "פריט 3 חייב להיות {text: donorName}");
  assert.strictEqual(files[3].fileName, "IDENT-002", "פריט 4 חייב להיות fileLink של IDENT-002, לא {text:...} — זה בדיוק הבאג שתוקן");
  assert.ok(hasFileLink(files[3]), "IDENT-002 חייב fileLink — הבדיקה נכשלת אם הוא חוזר כ-{text:...}");
});

check('5. PAYMENT_SUCCESS עם שם: {text:"תודה {name}. "} ואז PAY-006 (audio) — לא הקלטה נפרדת ל"תודה", לפי העיצוב', function () {
  var res = ivr.buildResponse({ payment: "OK" }, baseDonor({ fullName: "אסתר בר" }), makeAlwaysResolvingAudio());
  var files = res[0].files;
  assert.deepStrictEqual(files[0], { text: "תודה אסתר בר. " });
  assert.strictEqual(files[1].fileName, "PAY-006");
});

check("5. PAYMENT_SUCCESS בלי שם: רק PAY-006, אין פריט {text} ריק", function () {
  var res = ivr.buildResponse({ payment: "OK" }, baseDonor({ fullName: "" }), makeAlwaysResolvingAudio());
  assert.strictEqual(res[0].files.length, 1);
  assert.strictEqual(res[0].files[0].fileName, "PAY-006");
});

// ═══ 6. סכומים: רצף מלא תקין לכל הסכומים המייצגים ══════════════════════════

var AMOUNT_EXPECTATIONS = {
  1:     ["NUM-DIGIT-001"],
  2:     ["NUM-DIGIT-002"],
  25:    ["NUM-TENS-020", "NUM-DIGIT-005"],
  100:   ["NUM-HUNDRED-100"],
  583:   ["NUM-HUNDRED-500", "NUM-TENS-080", "NUM-DIGIT-003"],
  1000:  ["NUM-THOUSAND-001"],
  2000:  ["NUM-THOUSAND-002"],
  11000: ["NUM-TEEN-011", "NUM-THOUSAND-PLURAL"],
  99999: ["NUM-TENS-090", "NUM-DIGIT-009", "NUM-THOUSAND-PLURAL", "NUM-HUNDRED-900", "NUM-TENS-090", "NUM-DIGIT-009"],
};

Object.keys(AMOUNT_EXPECTATIONS).forEach(function (amountStr) {
  var amount = Number(amountStr);
  var expectedIds = AMOUNT_EXPECTATIONS[amountStr];
  check("6. סכום " + amount + " ₪: רצף audioId מדויק, כולו fileLink", function () {
    var items = ivr.buildAmountSegment(makeAlwaysResolvingAudio(), amount);
    var ids = items.map(function (it) { return it.fileName; });
    assert.deepStrictEqual(ids, expectedIds);
    items.forEach(function (it) { assert.ok(hasFileLink(it)); });
  });
});

check("6. סכומים 1/2: לא משתמשים ב-CUR-003/CUR-004 בהטמעה (הכפילות עם 'שקלים' של DEBT-002/PAY-002 נמנעת)", function () {
  var ids1 = ivr.buildAmountSegment(makeAlwaysResolvingAudio(), 1).map(function (it) { return it.fileName; });
  var ids2 = ivr.buildAmountSegment(makeAlwaysResolvingAudio(), 2).map(function (it) { return it.fileName; });
  assert.ok(!ids1.includes("CUR-003"));
  assert.ok(!ids2.includes("CUR-004"));
});

// ═══ 7. רכיב אחד ברצף הסכום חסר → כל הסכום חוזר ל-TTS, לא רצף חלקי ═══════════

check("7. NUM-DIGIT-003 חסר בתוך סכום 583 → כל הרצף חוזר ל-{text:'583'} בלבד", function () {
  var items = ivr.buildAmountSegment(makeAudioWithMissingId("NUM-DIGIT-003"), 583);
  assert.deepStrictEqual(items, [{ text: "583" }]);
});

check("7. NUM-TENS-020 (הרכיב הראשון) חסר בתוך סכום 25 → עדיין חוזר לרצף מלא, לא לחלק שכן הצליח", function () {
  var items = ivr.buildAmountSegment(makeAudioWithMissingId("NUM-TENS-020"), 25);
  assert.deepStrictEqual(items, [{ text: "25" }]);
});

check("7. סכום שלא ניתן להרכבה כלל (0, שלילי, לא שלם) → TTS של הסכום המלא, לא נכשל", function () {
  assert.deepStrictEqual(ivr.buildAmountSegment(makeAlwaysResolvingAudio(), 0), [{ text: "0" }]);
  assert.deepStrictEqual(ivr.buildAmountSegment(makeAlwaysResolvingAudio(), -5), [{ text: "-5" }]);
  assert.deepStrictEqual(ivr.buildAmountSegment(makeAlwaysResolvingAudio(), 100.5), [{ text: "100.5" }]);
});

// ═══ 8. purposeType: ארבעת PURP ממופים נכון; ערך לא מוכר נשאר TTS ═══════════

check('8. purposeType="גליון מתאחדת" → PURP-001', function () {
  var items = ivr.buildPurposeSegment(makeAlwaysResolvingAudio(), "גליון מתאחדת", "גליון מתאחדת");
  assert.strictEqual(items[0].fileName, "PURP-001");
});

check('8. purposeType="פרנס" → PURP-002', function () {
  var items = ivr.buildPurposeSegment(makeAlwaysResolvingAudio(), "פרנס", "פרנס");
  assert.strictEqual(items[0].fileName, "PURP-002");
});

check('8. purposeType="אחר" → PURP-004, בלי קשר לטקסט המטרה החופשי', function () {
  var items = ivr.buildPurposeSegment(makeAlwaysResolvingAudio(), "תרומה מיוחדת לבניין", "אחר");
  assert.strictEqual(items[0].fileName, "PURP-004");
});

check('8. purposeType חסר, purpose="כללי" (ברירת מחדל) → נמצא אוטומטית כ-PURP-003 דרך התאמת טקסט מדויקת', function () {
  var audio = makeRealisticAudio(["כללי"]);
  var items = ivr.buildPurposeSegment(audio, "כללי", "");
  assert.ok(hasFileLink(items[0]));
});

check("8. purposeType חסר, מטרה חופשית שלא תואמת שום הקלטה → נשארת TTS של טקסט המטרה עצמו", function () {
  var audio = makeRealisticAudio(["כללי"]); // "תרומה לבית כנסת" לא ברשימה
  var items = ivr.buildPurposeSegment(audio, "תרומה לבית כנסת", "");
  assert.deepStrictEqual(items, [{ text: "תרומה לבית כנסת" }]);
});

check("8. purposeType לא מוכר (ערך זר, לא אחד משלושת הסגורים) → נשאר TTS של טקסט המטרה", function () {
  var items = ivr.buildPurposeSegment(makeAlwaysResolvingAudio(), "משהו", "ערך-לא-קיים");
  // makeAlwaysResolvingAudio.resolveOrText תמיד "מצליח" — הבדיקה כאן היא
  // שההתנהגות עוברת ל-resolveOrText (המסלול הנכון) ולא ל-resolveAudioId עם id שגוי.
  assert.strictEqual(items[0].fileName, "TXT-MATCH");
});

// ═══ 9. DEBT_ITEM ו-publicPhoneNote לעולם לא עוברים ל-resolver ═════════════

check("9. DEBT_ITEM ברשימת חובות קודמים: תמיד {text}, גם כש-audio 'תמיד מצליח'", function () {
  var donor = baseDonor({
    currentDebt: { amount: 100, purpose: "פרנס", purposeType: "פרנס" },
    previousDebts: [{ amount: 50, purpose: "כללי", purposeType: "" }],
    settings: { allowPayment: true, allowPreviousDebts: true, allowCallback: true },
  });
  var res = ivr.buildResponse({ mainChoice: "2" }, donor, makeAlwaysResolvingAudio());
  var files = res.files;
  // שני פריטי DEBT_ITEM (חוב נוכחי + קודם) + פריט תפריט אחד בסוף
  assert.strictEqual(files.length, 3);
  assert.deepStrictEqual(files[0], { text: "1. סכום 100 שקלים עבור פרנס." });
  assert.deepStrictEqual(files[1], { text: "2. סכום 50 שקלים עבור כללי." });
  assert.ok(!hasFileLink(files[0]));
  assert.ok(!hasFileLink(files[1]));
});

check("9. publicPhoneNote: תמיד {text}, גם כש-audio 'תמיד מצליח' וגם אם התוכן מזדמן להתאים טקסטואלית", function () {
  var donor = baseDonor({ publicPhoneNote: "כללי" }); // מכוון בכוונה — "כללי" תואם PURP-003, אבל זו לא מטרה
  var res = ivr.buildResponse({}, donor, makeAlwaysResolvingAudio());
  var noteItem = allFilesArray(res)[1]; // אחרי הברכה
  assert.deepStrictEqual(noteItem, { text: " כללי" });
});

// ═══ 10. חריגה ב-audio context → השיחה מקבלת את הטקסט המקורי, לא קורסת ═══════

check("10. audio.resolveOrText זורק חריגה → rtxt מחזיר את הטקסט המקורי, לא קורס", function () {
  var res = ivr.buildResponse({ mainChoice: "3" }, baseDonor(), makeThrowingAudio());
  assert.deepStrictEqual(res[0].files[0], { text: "אנא השאירו הודעתכם לאחר הצליל." });
});

check("10. audio.resolveAudioId זורק חריגה → rid מחזיר את fallbackText, לא קורס", function () {
  var donor = baseDonor({ currentDebt: { amount: 50, purpose: "פרנס", purposeType: "פרנס" } });
  var res = ivr.buildResponse({}, donor, makeThrowingAudio());
  var files = allFilesArray(res);
  // כל הפריטים חייבים להיות {text} תקינים ולא ריקים — אף חריגה לא דלפה.
  files.forEach(function (f) {
    assert.ok(!hasFileLink(f));
    assert.strictEqual(typeof f.text, "string");
  });
});

check("10. buildResponse כולו לא זורק חריגה גם כש-audio זורק בכל קריאה", function () {
  var donor = baseDonor({ currentDebt: { amount: 25000, purpose: "אחר", purposeType: "אחר" } });
  assert.doesNotThrow(function () { ivr.buildResponse({}, donor, makeThrowingAudio()); });
});

// ═══ סיכום ═══════════════════════════════════════════════════════════════════
const failed = results.filter(function (r) { return !r.ok; });
results.forEach(function (r) {
  console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : " — " + r.error));
});
console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");
process.exit(failed.length ? 1 : 0);

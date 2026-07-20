// ivr-number-compose.service.test.js — בדיקות טהורות ל-amountToAudioIds().
// לא נוגע ב-DB/דיסק בכלל. requires ./ivr.js רק בשביל MAX_PAYMENT_AMOUNT —
// ivr.js עצמו לא עושה שום I/O ב-require (נבדק: אין בו require("./db")).
// הרצה: node ivr-number-compose.service.test.js

const assert = require("assert");
const { amountToAudioIds, composeTwoDigitGroup, composeThousandsGroup } = require("./ivr-number-compose.service");
const { MAX_PAYMENT_AMOUNT } = require("./ivr-constants");

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name: name, ok: true });
  } catch (err) {
    results.push({ name: name, ok: false, error: err.message });
  }
}

// ── מקרים מיוחדים: 1 ו-2 ────────────────────────────────────────────────────
check("1 ₪ → CUR-003 בלבד (שקל אחד, לא DIGIT-001+CUR)", function () {
  assert.deepStrictEqual(amountToAudioIds(1), { ok: true, audioIds: ["CUR-003"] });
});

check("2 ₪ → CUR-004 בלבד (שני שקלים)", function () {
  assert.deepStrictEqual(amountToAudioIds(2), { ok: true, audioIds: ["CUR-004"] });
});

// ── ספרות בודדות (3-9) ──────────────────────────────────────────────────────
check("3 ₪ → NUM-DIGIT-003 + CUR-002", function () {
  assert.deepStrictEqual(amountToAudioIds(3), { ok: true, audioIds: ["NUM-DIGIT-003", "CUR-002"] });
});

check("9 ₪ → NUM-DIGIT-009 + CUR-002", function () {
  assert.deepStrictEqual(amountToAudioIds(9), { ok: true, audioIds: ["NUM-DIGIT-009", "CUR-002"] });
});

// ── טווח 10-19 (מילה שלמה אחת) ───────────────────────────────────────────────
check("10 ₪ → NUM-TEEN-010 + CUR-002", function () {
  assert.deepStrictEqual(amountToAudioIds(10), { ok: true, audioIds: ["NUM-TEEN-010", "CUR-002"] });
});

check("19 ₪ → NUM-TEEN-019 + CUR-002", function () {
  assert.deepStrictEqual(amountToAudioIds(19), { ok: true, audioIds: ["NUM-TEEN-019", "CUR-002"] });
});

// ── עשרות עגולות ומורכבות ────────────────────────────────────────────────────
check("20 ₪ → NUM-TENS-020 + CUR-002 (בלי ספרת יחידות)", function () {
  assert.deepStrictEqual(amountToAudioIds(20), { ok: true, audioIds: ["NUM-TENS-020", "CUR-002"] });
});

check("25 ₪ → NUM-TENS-020 + NUM-DIGIT-005 + CUR-002", function () {
  assert.deepStrictEqual(amountToAudioIds(25), { ok: true, audioIds: ["NUM-TENS-020", "NUM-DIGIT-005", "CUR-002"] });
});

check("99 ₪ → NUM-TENS-090 + NUM-DIGIT-009 + CUR-002", function () {
  assert.deepStrictEqual(amountToAudioIds(99), { ok: true, audioIds: ["NUM-TENS-090", "NUM-DIGIT-009", "CUR-002"] });
});

// ── מאות ──────────────────────────────────────────────────────────────────────
check("100 ₪ → NUM-HUNDRED-100 + CUR-002 (בלי שארית)", function () {
  assert.deepStrictEqual(amountToAudioIds(100), { ok: true, audioIds: ["NUM-HUNDRED-100", "CUR-002"] });
});

check("101 ₪ → NUM-HUNDRED-100 + NUM-DIGIT-001 + CUR-002", function () {
  assert.deepStrictEqual(amountToAudioIds(101), { ok: true, audioIds: ["NUM-HUNDRED-100", "NUM-DIGIT-001", "CUR-002"] });
});

check("199 ₪ → NUM-HUNDRED-100 + NUM-TENS-090 + NUM-DIGIT-009 + CUR-002", function () {
  assert.deepStrictEqual(amountToAudioIds(199), {
    ok: true,
    audioIds: ["NUM-HUNDRED-100", "NUM-TENS-090", "NUM-DIGIT-009", "CUR-002"],
  });
});

check("999 ₪ → NUM-HUNDRED-900 + NUM-TENS-090 + NUM-DIGIT-009 + CUR-002", function () {
  assert.deepStrictEqual(amountToAudioIds(999), {
    ok: true,
    audioIds: ["NUM-HUNDRED-900", "NUM-TENS-090", "NUM-DIGIT-009", "CUR-002"],
  });
});

// ── אלפים — 1000/2000 מילה ייעודית, 3000+ מורכב ────────────────────────────────
check("1000 ₪ → NUM-THOUSAND-001 + CUR-002", function () {
  assert.deepStrictEqual(amountToAudioIds(1000), { ok: true, audioIds: ["NUM-THOUSAND-001", "CUR-002"] });
});

check("2000 ₪ → NUM-THOUSAND-002 + CUR-002", function () {
  assert.deepStrictEqual(amountToAudioIds(2000), { ok: true, audioIds: ["NUM-THOUSAND-002", "CUR-002"] });
});

check("1001 ₪ → NUM-THOUSAND-001 + NUM-DIGIT-001 + CUR-002", function () {
  assert.deepStrictEqual(amountToAudioIds(1001), {
    ok: true,
    audioIds: ["NUM-THOUSAND-001", "NUM-DIGIT-001", "CUR-002"],
  });
});

check("3000 ₪ → NUM-DIGIT-003 + NUM-THOUSAND-PLURAL + CUR-002", function () {
  assert.deepStrictEqual(amountToAudioIds(3000), {
    ok: true,
    audioIds: ["NUM-DIGIT-003", "NUM-THOUSAND-PLURAL", "CUR-002"],
  });
});

check("15000 ₪ → NUM-TEEN-015 + NUM-THOUSAND-PLURAL + CUR-002", function () {
  assert.deepStrictEqual(amountToAudioIds(15000), {
    ok: true,
    audioIds: ["NUM-TEEN-015", "NUM-THOUSAND-PLURAL", "CUR-002"],
  });
});

check("20000 ₪ → NUM-TENS-020 + NUM-THOUSAND-PLURAL + CUR-002", function () {
  assert.deepStrictEqual(amountToAudioIds(20000), {
    ok: true,
    audioIds: ["NUM-TENS-020", "NUM-THOUSAND-PLURAL", "CUR-002"],
  });
});

check("23000 ₪ → NUM-TENS-020 + NUM-DIGIT-003 + NUM-THOUSAND-PLURAL + CUR-002", function () {
  assert.deepStrictEqual(amountToAudioIds(23000), {
    ok: true,
    audioIds: ["NUM-TENS-020", "NUM-DIGIT-003", "NUM-THOUSAND-PLURAL", "CUR-002"],
  });
});

// ── קצה עליון: MAX_PAYMENT_AMOUNT (99999) ────────────────────────────────────
check("MAX_PAYMENT_AMOUNT (99999) → מרכיב במלואו, לא נכשל", function () {
  const result = amountToAudioIds(MAX_PAYMENT_AMOUNT);
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.audioIds, [
    "NUM-TENS-090", "NUM-DIGIT-009", "NUM-THOUSAND-PLURAL",
    "NUM-HUNDRED-900",
    "NUM-TENS-090", "NUM-DIGIT-009",
    "CUR-002",
  ]);
});

check("MAX_PAYMENT_AMOUNT + 1 → ok:false (מעל הטווח)", function () {
  assert.deepStrictEqual(amountToAudioIds(MAX_PAYMENT_AMOUNT + 1), { ok: false });
});

// ── קלטים לא תקינים — תמיד ok:false, לעולם לא רצף חלקי ──────────────────────
check("0 → ok:false", function () {
  assert.deepStrictEqual(amountToAudioIds(0), { ok: false });
});

check("מספר שלילי → ok:false", function () {
  assert.deepStrictEqual(amountToAudioIds(-5), { ok: false });
});

check("מספר עשרוני (אגורות) → ok:false, לא מעגל בשקט", function () {
  assert.deepStrictEqual(amountToAudioIds(100.5), { ok: false });
});

check("NaN / מחרוזת לא מספרית → ok:false", function () {
  assert.deepStrictEqual(amountToAudioIds("abc"), { ok: false });
  assert.deepStrictEqual(amountToAudioIds(NaN), { ok: false });
});

check("undefined/null → ok:false", function () {
  assert.deepStrictEqual(amountToAudioIds(undefined), { ok: false });
  assert.deepStrictEqual(amountToAudioIds(null), { ok: false });
});

check("תוצאת ok:false אף פעם לא כוללת audioIds חלקי", function () {
  const result = amountToAudioIds(-1);
  assert.ok(!("audioIds" in result), "ok:false לא אמור לכלול audioIds בכלל, גם לא ריק");
});

// ── בדיקת עזר: composeTwoDigitGroup / composeThousandsGroup ────────────────
check("composeTwoDigitGroup(0) → []", function () {
  assert.deepStrictEqual(composeTwoDigitGroup(0), []);
});

check("composeThousandsGroup(3) → NUM-DIGIT-003 + NUM-THOUSAND-PLURAL", function () {
  assert.deepStrictEqual(composeThousandsGroup(3), ["NUM-DIGIT-003", "NUM-THOUSAND-PLURAL"]);
});

// ── סיכום ────────────────────────────────────────────────────────────────────
const failed = results.filter(function (r) { return !r.ok; });
results.forEach(function (r) {
  console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : " — " + r.error));
});
console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");
process.exit(failed.length ? 1 : 0);

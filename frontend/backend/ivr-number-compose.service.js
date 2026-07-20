// ivr-number-compose.service.js
//
// Pure function: converts a whole-shekel amount into a sequence of
// pre-recorded audioIds from the approved NUM-*/CUR-* set (see db.js's
// IVR_AUDIO_CANONICAL_RECORDINGS — the 44-row number/currency sheet). Never
// invents an audioId that isn't in that canonical set.
//
// No Hebrew "ו" (and) conjunction recording exists among the 83 approved
// recordings, so composed multi-word numbers are read as consecutive words
// without it — e.g. 25 → "עשרים חמש", not the grammatically fuller "עשרים
// וחמש". This is a deliberate consequence of only using already-approved
// audio, not an oversight.
//
// If the amount can't be fully composed (non-integer, zero/negative, or
// above the max), returns {ok:false} with no audioIds at all — callers must
// fall back to speaking the WHOLE amount via TTS, never a partial sequence.

const { MAX_PAYMENT_AMOUNT } = require("./ivr-constants");

function pad3(n) {
  return String(n).padStart(3, "0");
}

// n: 0..99 — shared by both "count of thousands" (3..99) and the final
// tens/ones remainder (0..99); both follow identical digit/teen/tens rules.
function composeTwoDigitGroup(n) {
  if (n === 0) return [];
  if (n < 10) return ["NUM-DIGIT-" + pad3(n)];
  if (n < 20) return ["NUM-TEEN-" + pad3(n)];
  const tens = Math.floor(n / 10) * 10;
  const ones = n % 10;
  const out = ["NUM-TENS-" + pad3(tens)];
  if (ones > 0) out.push("NUM-DIGIT-" + pad3(ones));
  return out;
}

// n: 3..99 — the thousands-count itself, followed by the plural "אלפים".
// (1 and 2 thousand use their own dedicated words — see amountToAudioIds.)
function composeThousandsGroup(n) {
  return composeTwoDigitGroup(n).concat(["NUM-THOUSAND-PLURAL"]);
}

function amountToAudioIds(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false };
  if (n <= 0 || n > MAX_PAYMENT_AMOUNT) return { ok: false };

  // 1 ₪ / 2 ₪ have dedicated whole-phrase recordings ("שקל אחד" / "שני
  // שקלים") — not composed from a digit + currency word.
  if (n === 1) return { ok: true, audioIds: ["CUR-003"] };
  if (n === 2) return { ok: true, audioIds: ["CUR-004"] };

  const thousands = Math.floor(n / 1000);
  const remainder = n % 1000;
  const hundreds = Math.floor(remainder / 100);
  const tensOnes = remainder % 100;

  let words = [];

  if (thousands === 1) {
    words.push("NUM-THOUSAND-001");
  } else if (thousands === 2) {
    words.push("NUM-THOUSAND-002");
  } else if (thousands >= 3) {
    words = words.concat(composeThousandsGroup(thousands));
  }

  if (hundreds > 0) {
    words.push("NUM-HUNDRED-" + pad3(hundreds * 100));
  }

  words = words.concat(composeTwoDigitGroup(tensOnes));

  if (words.length === 0) {
    // ביטחון בלבד: לא אמור לקרות (n>=3 מבטיח לפחות קבוצה אחת לא-ריקה) —
    // אם בכל זאת קרה, נופלים ל-TTS מלא ולא משמיעים "שקלים" לבד.
    return { ok: false };
  }

  words.push("CUR-002"); // "שקלים" — רבים, לכל סכום 3+
  return { ok: true, audioIds: words };
}

module.exports = { amountToAudioIds, composeTwoDigitGroup, composeThousandsGroup };

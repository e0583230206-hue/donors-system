// Technoline PBX IVR — stateless flow — v2026.06.30
// Accumulated query params drive the state machine:
//   mainChoice  — initial menu (1=pay, 2=prev-debts, 3=record)
//   payChoice   — payment sub-menu (1=full debt, 2=custom) — only when mainChoice=1 + has debt
//   debtChoice  — debt list menu (1=pay all, 2=custom, 9=end) — only when mainChoice=2
//   amount      — getDTMF result
//   payment     — creditCard result (OK / anything else)
//   voiceMessage — record result
//
// ── Pre-recorded audio ──────────────────────────────────────────────────────
// Every buildResponse()/buildIdentificationResponse() call takes an optional
// 3rd `audio` argument — an object with resolveOrText(text)/resolveAudioId
// (id, fallbackText) built by ivr-audio-context.service.js per call, based
// on IVR_AUDIO_MODE. Omitting it (or passing null) is fully safe and
// preserves the exact pre-existing TTS-only behavior — this file never
// requires that module, never touches the DB/filesystem itself, and stays
// 100% pure. resolveOrText looks a plain Hebrew string up against the
// approved 83-recording set by exact text match; anything without an exact
// match (donor-name greetings, dead/unreachable menu variants, etc.)
// automatically stays TTS — nothing here "guesses" an audioId.

// ── Texts ─────────────────────────────────────────────────────────────────────
// All TTS phrases are defined here. To switch languages, replace the values.
// Static phrases are strings; dynamic phrases (with variables) are functions.
// These strings also double as the FALLBACK TEXT used whenever audio can't
// be resolved — nothing here changed just because audio now exists.

var T = {
  // ── Greetings ──────────────────────────────────────────────────────────────
  // No canonical recording matches these two (donor name is never recorded;
  // "ברוך הבא." isn't in the approved 83) — always TTS, audio or not.
  GREETING_KNOWN:   function (name)            { return "שלום " + name + "."; },
  GREETING_UNKNOWN: "ברוך הבא.",

  // ── Debt announcement (follows greeting) ───────────────────────────────────
  HAS_DEBT:         function (amount, purpose) { return " יש לך חוב על סכום " + amount + " שקלים עבור " + purpose + "."; },
  NO_OPEN_DEBT:     " לא נמצא חוב פתוח.",

  // ── Main menu options (appended after greeting + debt) ─────────────────────
  MENU_WITH_PREV_DEBTS:    " למעבר לתשלום הקישו 1. לשמיעת חובות קודמים הקישו 2. להשארת הודעה הקישו 3.",
  MENU_WITHOUT_PREV_DEBTS: " למעבר לתשלום הקישו 1. להשארת הודעה הקישו 3.",
  MENU_DONATION_ONLY:      " לתרומה הקישו 1. להשארת הודעה הקישו 3.",
  MENU_DONATION_WITH_PREV_DEBTS: " לתרומה הקישו 1. לשמיעת חובות קודמים הקישו 2. להשארת הודעה הקישו 3.",
  MENU_MESSAGE_ONLY:       " להשארת הודעה הקישו 3.",
  // שני אלה קיימים כתפריטים חלופיים כש-canCallback=false, בלי ערך T ייעודי
  // עד כה (מחרוזת מקומית בקוד) — הועברו לכאן כדי לעבור באותו מנגנון resolveOrText
  // כמו כל שאר הטקסטים; זהים מילה-במילה למה שהיה שם קודם.
  MENU_PAY_ONLY_NO_CALLBACK:      " למעבר לתשלום הקישו 1.",
  MENU_DONATE_ONLY_NO_CALLBACK:   " לתרומה הקישו 1.",
  MENU_DONATE_WITH_PREV_NO_CALLBACK: " לתרומה הקישו 1. לשמיעת חובות קודמים הקישו 2.",

  // ── Payment sub-menu ───────────────────────────────────────────────────────
  PAY_FULL_OR_CUSTOM: function (amount) { return "לתשלום הסכום המלא, " + amount + " שקלים, הקישו 1. לתשלום סכום אחר הקישו 2."; },
  ENTER_AMOUNT:       "אנא הזינו את הסכום בשקלים ולחצו סולמית.",
  AMOUNT_INVALID:     "הסכום שהוזן אינו תקין. אנא נסה שנית.",
  AMOUNT_TOO_HIGH:    "הסכום שהוזן גבוה מדי. אנא פנה לנציג.",

  // ── Debt list ──────────────────────────────────────────────────────────────
  // DEBT_ITEM נשאר TTS מלא תמיד — דרישה מפורשת, אף פעם לא עובר resolveOrText.
  DEBT_ITEM:         function (n, amount, purpose) { return n + ". סכום " + amount + " שקלים עבור " + purpose + "."; },
  DEBT_MENU_CHOICES: "לתשלום כל החובות הקישו 1. לתשלום סכום אחר הקישו 2. לסיום הקישו 9.",
  NO_PREVIOUS_DEBTS: "לא נמצאו חובות קודמים.",

  // ── Voice recording ────────────────────────────────────────────────────────
  LEAVE_MESSAGE:      "אנא השאירו הודעתכם לאחר הצליל.",
  VOICE_MSG_RECEIVED: "הודעתכם התקבלה. תודה.",

  // ── Payment result ─────────────────────────────────────────────────────────
  PAYMENT_SUCCESS: function (name) { return (name ? "תודה " + name + ". " : "") + "התשלום התקבל בהצלחה. תודה רבה."; },
  PAYMENT_FAILED:  "התשלום לא הושלם. אנא נסה שנית מאוחר יותר.",

  // ── Fallback when credit-card terminal is not configured ───────────────────
  PAYMENT_UNAVAILABLE: "התשלום בכרטיס אשראי אינו זמין כרגע. נציג ייצור איתך קשר בהקדם. תודה.",

  // ── Opening ────────────────────────────────────────────────────────────────
  OPENING: "שלום וברכה, הגעתם למערכת תשלומים של א בלאט גמרא.",

  // ── Goodbye ────────────────────────────────────────────────────────────────
  GOODBYE: "תודה על התקשרותך. להתראות.",

  // ── Caller identification (payer vs. beneficiary) ───────────────────────────
  IDENT_KNOWN:                   function (name) { return "המערכת זיהתה אותך על שם " + name + "."; },
  IDENT_SELF_OR_OTHER_MENU:      "להמשך לתשלום עבור עצמך הקישו 1. למעבר לתשלום עבור מישהו אחר הקישו 2.",
  IDENT_UNKNOWN_ANI:             "המערכת לא זיהתה את מספר הטלפון שממנו התקשרתם.",
  ENTER_PHONE_OR_ID_SELF:        "נא הכניסו מספר טלפון או מספר זהות, ולסיום הקישו סולמית.",
  ENTER_PHONE_OR_ID_BENEFICIARY: "נא הכניסו את מספר הטלפון או מספר הזהות של התורם שעבורו תרצו לשלם, ולסיום הקישו סולמית.",
  IDENT_BENEFICIARY_FOUND:       function (name) { return "המערכת זיהתה את התורם על שם " + name + "."; },
  CONFIRM_OR_RESEARCH_MENU:      "לאישור והמשך לתשלום הקישו 1. לחיפוש מחדש הקישו 2.",
  IDENT_NOT_FOUND:               "לא נמצא תורם לפי הזיהוי שהוקש.",
  IDENT_MULTIPLE_MATCHES:        "לא ניתן לזהות בבירור לפי המספר שהוקש.",
  IDENT_MAX_ATTEMPTS:            "לא הצלחנו לזהות אתכם. ניתן להשאיר הודעה, ואנו נחזור אליכם.",
};

// Maximum single payment allowed through IVR (prevents accidental large
// charges). Sourced from ivr-constants.js (not defined here) so that
// ivr-number-compose.service.js (which ivr.js itself requires below) never
// has to require ivr.js back — avoids a circular dependency.
var MAX_PAYMENT_AMOUNT = require("./ivr-constants").MAX_PAYMENT_AMOUNT;
var amountToAudioIds = require("./ivr-number-compose.service").amountToAudioIds;

// ── Helpers ─────────────────────────────────────────────────────────────────

function txt(text)    { return { text: text }; }

// Technoline may accumulate duplicate params as an array; always take last value.
function p(query, name) {
  var val = query[name];
  if (Array.isArray(val)) return val[val.length - 1];
  return val;
}

// audio-less default — identical in effect to the plain txt()-only behavior
// this file had before pre-recorded audio existed at all.
var DEFAULT_AUDIO = {
  resolveOrText: function (text) { return { text: text }; },
  resolveAudioId: function (audioId, fallbackText) { return { text: fallbackText }; },
};

// Drop-in replacement for txt(text) — looks the text up against the approved
// recordings (via `audio`, injected per call) and falls back to plain TTS
// (byte-identical to the old txt(text)) whenever there's no match, audio is
// disabled for this call, or resolution fails for any reason. The resolver
// itself already catches its own exceptions (see
// ivr-audio-resolver.service.js), but `audio` is an injected object this
// file doesn't control — wrapping the call here too means a bug anywhere in
// that chain degrades to the original text instead of crashing the whole
// response, matching "a resolver failure must never fail the call."
function rtxt(audio, text) {
  try {
    return (audio || DEFAULT_AUDIO).resolveOrText(text);
  } catch (e) {
    return txt(text);
  }
}

// Same idea, but for spots where the audioId is already known (composite
// messages built from an ID fragment + a donor name, or from
// amountToAudioIds()'s output) rather than looked up by exact text.
function rid(audio, audioId, fallbackText) {
  try {
    return (audio || DEFAULT_AUDIO).resolveAudioId(audioId, fallbackText);
  } catch (e) {
    return txt(fallbackText);
  }
}

// ── Module builders ──────────────────────────────────────────────────────────

function simpleMessage(files) {
  return { type: "simpleMessage", files: files };
}

function simpleMenu(files, name, enabledKeys, times, timeout) {
  return {
    type: "simpleMenu",
    name: name,
    enabledKeys: enabledKeys,
    times: times || 3,
    timeout: timeout || 5,
    files: files,
  };
}

// confirmType controls whether/how Technoline reads the collected digits
// back to the caller before returning. Defaults to "number" (existing
// behavior — correct for a payment amount, e.g. "500"). Pass confirmType:
// null for identifier input (phone / teudat zehut) — reading a 9-digit ID
// back as one giant number sounds wrong; omitting the field entirely
// suppresses that readback.
function getDTMF(name, files, max, min, timeout, confirmType) {
  var mod = {
    type: "getDTMF",
    name: name,
    max: max || 6,
    min: min || 1,
    timeout: timeout || 7,
    skipKey: "#",
    files: files,
  };
  var effectiveConfirmType = confirmType !== undefined ? confirmType : "number";
  if (effectiveConfirmType) mod.confirmType = effectiveConfirmType;
  return mod;
}

// Splits a digit string into space-separated digits ("0501234567" ->
// "0 5 0 1 2 3 4 5 6 7") so it CAN be read back digit-by-digit via TTS if a
// future identification prompt ever needs to. Not currently used anywhere —
// the identification flow prefers not reading the entered number back at
// all (see getDTMF above) — kept ready in case that's needed later.
function spellDigitsForTTS(input) {
  return String(input || "").replace(/\D/g, "").split("").join(" ");
}

function record(name) {
  return {
    type: "record",
    name: name,
    max: 60,
    min: 1,
    confirm: false,
  };
}

function hangup() { return { type: "hangup" }; }

function creditCardModule(amount) {
  return {
    type: "creditCard",
    name: "payment",
    sum: amount,
    sumChangeable: "no",
    cvv: "yes",
    tz: "yes",
    payments: 1,
    category: "תרומה",
    // Set CREDIT_CARD_TERMINAL in .env once Technoline provides the terminal ID.
    terminal: process.env.CREDIT_CARD_TERMINAL || "",
  };
}

function paymentPlaceholder(audio) {
  return [
    simpleMessage([rtxt(audio, T.PAYMENT_UNAVAILABLE)]),
    hangup(),
  ];
}

function validateAmount(numAmount) {
  if (isNaN(numAmount) || numAmount <= 0)          return "invalid";
  if (numAmount > MAX_PAYMENT_AMOUNT)               return "too_high";
  return "ok";
}

// ── Composite audio segments ─────────────────────────────────────────────────
// Each of these returns an ARRAY of files[] items (mixing {fileLink,fileName}
// and {text:...}), for the handful of messages that combine a fixed phrase
// with a donor name, a composed amount, or a purpose — never a single
// txt()/rtxt() call. Donor names ALWAYS stay {text: name} — never looked up,
// never sent through the resolver.

function buildIdentKnownSegment(audio, name) {
  return [rid(audio, "IDENT-001", "המערכת זיהתה אותך על שם"), txt(name)];
}

function buildIdentBeneficiaryFoundSegment(audio, name) {
  return [rid(audio, "IDENT-006", "המערכת זיהתה את התורם על שם"), txt(name)];
}

function buildPaymentSuccessSegment(audio, name) {
  var tail = rid(audio, "PAY-006", "התשלום התקבל בהצלחה. תודה רבה.");
  if (!name) return [tail];
  // "תודה {name}." אינה הקלטה קיימת (שם תורם) — נשארת TTS מורכבת מראש, בדיוק
  // כמו שהייתה משורשרת לתחילת T.PAYMENT_SUCCESS(name) לפני השינוי הזה.
  return [txt("תודה " + name + ". "), tail];
}

// purposeType (קבוצה סגורה: "גליון מתאחדת"/"פרנס"/"אחר", ראו donor.service.js)
// ממופה ל-PURP-001/002/004. purposeType חסר/לא מוכר → TTS של טקסט המטרה
// עצמו — וזה כולל את המקרה "כללי" (ברירת המחדל כשאין מטרה כלל), כי "כללי"
// כבר תואם מילה-במילה את PURP-003 ויימצא אוטומטית דרך resolveOrText הרגיל.
var PURPOSE_TYPE_TO_AUDIO_ID = {
  "גליון מתאחדת": "PURP-001",
  "פרנס": "PURP-002",
  "אחר": "PURP-004",
};

function buildPurposeSegment(audio, purpose, purposeType) {
  var id = purposeType ? PURPOSE_TYPE_TO_AUDIO_ID[purposeType] : null;
  if (!id) return [rtxt(audio, purpose)];
  return [rid(audio, id, purpose)];
}

// סכום מורכב מ-NUM-*/CUR-* (amountToAudioIds) המוטמע בין שני משפטים קבועים
// שכבר מכילים את מילת המטבע בעצמם (DEBT-002="שקלים עבור",
// PAY-002="שקלים, הקישו 1...") — ולכן פלט amountToAudioIds() (שמסתיים תמיד
// ב-CUR-002/003/004, "שקלים"/"שקל אחד"/"שני שקלים") היה יוצר כפילות מילולית
// ("...חמש מאות שקלים שקלים עבור..."). כדי למנוע זאת בלי להמציא הקלטה חדשה:
// CUR-002 (רבים) פשוט מוסר מסוף הרצף; CUR-003/CUR-004 (הביטויים השלמים "שקל
// אחד"/"שני שקלים" לסכומים 1/2, שאי אפשר "לחתוך" חלקית) מוחלפים בספרה חשופה
// מקבילה שכבר קיימת ומאושרת — NUM-DIGIT-001 ("אחד") / NUM-DIGIT-002
// ("שניים") — לא הקלטה חדשה, רק ID אחר מתוך אותם 83. אם החלטה זו שגויה
// מבחינת הניסוח הרצוי, זו נקודה מפורשת לתקן בהמשך, לא ניחוש שקט.
function buildAmountSegment(audio, amount) {
  var bareFallback = txt(String(amount));
  var composed = amountToAudioIds(amount);
  if (!composed.ok) return [bareFallback];

  var ids = composed.audioIds.slice();
  var last = ids[ids.length - 1];
  if (last === "CUR-002") {
    ids.pop();
  } else if (last === "CUR-003") {
    ids[ids.length - 1] = "NUM-DIGIT-001";
  } else if (last === "CUR-004") {
    ids[ids.length - 1] = "NUM-DIGIT-002";
  }
  if (ids.length === 0) return [bareFallback];

  var items = [];
  for (var i = 0; i < ids.length; i++) {
    var result = rid(audio, ids[i], "");
    // רצף חלקי אסור: אם ולו רכיב אחד לא הפך לקובץ שמע אמיתי (fileLink), כל
    // הסכום חוזר לטקסט מלא — לא ממשיכים עם מה שכבר הצטבר.
    if (!result || !result.fileLink) {
      return [bareFallback];
    }
    items.push(result);
  }
  return items;
}

function buildHasDebtSegment(audio, amount, purpose, purposeType) {
  return [rid(audio, "DEBT-001", "יש לך חוב על סכום")]
    .concat(buildAmountSegment(audio, amount))
    .concat([rid(audio, "DEBT-002", "שקלים עבור")])
    .concat(buildPurposeSegment(audio, purpose, purposeType));
}

function buildPayFullOrCustomSegment(audio, amount) {
  return [rid(audio, "PAY-001", "לתשלום הסכום המלא,")]
    .concat(buildAmountSegment(audio, amount))
    .concat([rid(audio, "PAY-002", "שקלים, הקישו 1. לתשלום סכום אחר הקישו 2.")]);
}

// GREETING_KNOWN/UNKNOWN ותוספת publicPhoneNote — אין שום audioId תואם
// (שם תורם אף פעם לא מוקלט; publicPhoneNote נשאר TTS מלא במפורש) — תמיד TTS.
function buildGreetingSegment(donorName, publicNote) {
  var text = donorName ? T.GREETING_KNOWN(donorName) : T.GREETING_UNKNOWN;
  var items = [txt(text)];
  if (publicNote) items.push(txt(" " + publicNote));
  return items;
}

// ── Caller identification ───────────────────────────────────────────────────
//
// Builds the Technoline response for every step of the identification phase
// (before a beneficiary donor has been confirmed). ivr.service.js resolves
// WHO was found (via donor.service's multi-match-aware lookups) and WHICH
// prompt is needed next (identState.kind); this function only turns that
// into spoken text + the right module. No debt is ever read here — that only
// happens in buildResponse(), reached once identification is confirmed.
//
// identState: { kind, donor?, method?, reason? }
//   kind: "self_menu" | "self_input" | "self_input_retry" |
//         "beneficiary_input" | "beneficiary_input_retry" |
//         "beneficiary_confirm" | "max_attempts"
//   reason (on *_retry only): "not_found" | "multiple"
function buildIdentificationResponse(query, identState, audio) {
  // OPENING plays exactly once per call — on the very first request, before
  // any identification param has been submitted at all. Every retry/submenu
  // after that omits it (matches how every other prompt in this file works).
  var isFirstTurn = query.identChoice === undefined && query.selfIdentInput === undefined;
  var opening = isFirstTurn ? [rtxt(audio, T.OPENING)] : [];

  function retryText(reason) {
    return reason === "multiple" ? T.IDENT_MULTIPLE_MATCHES : T.IDENT_NOT_FOUND;
  }

  switch (identState.kind) {
    case "self_menu":
      return simpleMenu(
        opening
          .concat(buildIdentKnownSegment(audio, identState.donor.fullName))
          .concat([rtxt(audio, T.IDENT_SELF_OR_OTHER_MENU)]),
        "identChoice", "1,2", 3, 7
      );

    case "self_input":
      return getDTMF("selfIdentInput",
        opening.concat([rtxt(audio, T.IDENT_UNKNOWN_ANI), rtxt(audio, T.ENTER_PHONE_OR_ID_SELF)]),
        10, 5, 10, null);

    case "self_input_retry":
      return getDTMF("selfIdentInput",
        [rtxt(audio, retryText(identState.reason)), rtxt(audio, T.ENTER_PHONE_OR_ID_SELF)],
        10, 5, 10, null);

    case "beneficiary_input":
      return getDTMF("beneficiaryIdentInput", [rtxt(audio, T.ENTER_PHONE_OR_ID_BENEFICIARY)], 10, 5, 10, null);

    case "beneficiary_input_retry":
      return getDTMF("beneficiaryIdentInput",
        [rtxt(audio, retryText(identState.reason)), rtxt(audio, T.ENTER_PHONE_OR_ID_BENEFICIARY)],
        10, 5, 10, null);

    case "beneficiary_confirm":
      return simpleMenu(
        buildIdentBeneficiaryFoundSegment(audio, identState.donor.fullName)
          .concat([rtxt(audio, T.CONFIRM_OR_RESEARCH_MENU)]),
        "identConfirm", "1,2", 3, 7
      );

    case "max_attempts":
      // Reuses the exact existing voicemail module chain (same as
      // mainChoice=3 below) — no new recording mechanism.
      return [
        simpleMessage([rtxt(audio, T.IDENT_MAX_ATTEMPTS), rtxt(audio, T.LEAVE_MESSAGE)]),
        record("voiceMessage"),
      ];

    default:
      console.error("[IVR] buildIdentificationResponse: unknown kind:", identState.kind);
      return [simpleMessage([rtxt(audio, T.GOODBYE)]), hangup()];
  }
}

// ── Flow ─────────────────────────────────────────────────────────────────────

function buildResponse(query, donor, audio) {
  console.log("[IVR:buildResponse] keys:", Object.keys(query).join(","));

  var callStatus = p(query, "PBXcallStatus");
  var mainChoice = p(query, "mainChoice");
  var payChoice  = p(query, "payChoice");
  var debtChoice = p(query, "debtChoice");
  var amount     = p(query, "amount");
  var payment    = p(query, "payment");
  var voiceMsg   = p(query, "voiceMessage");

  var donorName     = donor ? donor.fullName : null;
  var currentDebt   = donor ? donor.currentDebt   : null;
  var previousDebts = donor ? (donor.previousDebts || []) : [];
  var publicNote    = donor && donor.publicPhoneNote ? donor.publicPhoneNote : "";
  var hasTerminal   = !!(process.env.CREDIT_CARD_TERMINAL);

  // Per-donor IVR permissions (default: allow everything)
  var settings = (donor && donor.settings) || {
    allowPayment:       true,
    allowPreviousDebts: true,
    allowCallback:      true,
  };

  // ── HANGUP ────────────────────────────────────────────────────────────────
  if (callStatus === "HANGUP") return null;

  // ── Voice message received → thank and end ────────────────────────────────
  if (voiceMsg !== undefined) {
    return [simpleMessage([rtxt(audio, T.VOICE_MSG_RECEIVED)]), hangup()];
  }

  // ── Payment result ────────────────────────────────────────────────────────
  if (payment !== undefined) {
    if (payment === "OK") {
      return [simpleMessage(buildPaymentSuccessSegment(audio, donorName)), hangup()];
    }
    return [simpleMessage([rtxt(audio, T.PAYMENT_FAILED)]), hangup()];
  }

  // ── mainChoice = ERROR — caller timed out without selecting ─────────────
  if (mainChoice === "ERROR") {
    return [simpleMessage([rtxt(audio, T.GOODBYE)]), hangup()];
  }

  // ── mainChoice = 1 — Payment / Donation ──────────────────────────────────
  if (mainChoice === "1") {
    if (!settings.allowPayment) {
      // Donor has payment disabled — treat as unknown and offer goodbye
      return [simpleMessage([rtxt(audio, T.PAYMENT_UNAVAILABLE)]), hangup()];
    }

    if (payChoice === "ERROR") {
      return [simpleMessage([rtxt(audio, T.GOODBYE)]), hangup()];
    }

    // Donor has debt → show payment sub-menu (pay full or custom)
    if (currentDebt && !payChoice) {
      return simpleMenu(
        buildPayFullOrCustomSegment(audio, currentDebt.amount),
        "payChoice", "1,2", 3, 7
      );
    }

    // payChoice=1 → charge full debt amount
    if (payChoice === "1" && currentDebt) {
      if (validateAmount(currentDebt.amount) === "too_high") {
        return [simpleMessage([rtxt(audio, T.AMOUNT_TOO_HIGH)]), hangup()];
      }
      if (!hasTerminal) return paymentPlaceholder(audio);
      return creditCardModule(currentDebt.amount);
    }

    // payChoice=2 or no debt → collect amount then charge
    if (amount !== undefined) {
      var numAmount1 = parseFloat(amount);
      var check1     = validateAmount(numAmount1);
      if (check1 === "invalid")  return [simpleMessage([rtxt(audio, T.AMOUNT_INVALID)]),  hangup()];
      if (check1 === "too_high") return [simpleMessage([rtxt(audio, T.AMOUNT_TOO_HIGH)]), hangup()];
      if (!hasTerminal) return paymentPlaceholder(audio);
      return creditCardModule(numAmount1);
    }

    return getDTMF("amount", [rtxt(audio, T.ENTER_AMOUNT)], 6, 1, 7);
  }

  // ── mainChoice = 2 — Previous debts ──────────────────────────────────────
  if (mainChoice === "2") {
    if (!settings.allowPreviousDebts) {
      return [simpleMessage([rtxt(audio, T.GOODBYE)]), hangup()];
    }

    // debtChoice=9 → end call
    if (debtChoice === "9") {
      return [simpleMessage([rtxt(audio, T.GOODBYE)]), hangup()];
    }

    // Aggregate: all open debts
    var allDebts = (currentDebt ? [currentDebt] : []).concat(previousDebts);

    // debtChoice=1 → pay total of all debts
    if (debtChoice === "1") {
      var totalDebt = allDebts.reduce(function (s, d) { return s + d.amount; }, 0);
      if (!totalDebt) return paymentPlaceholder(audio);
      if (validateAmount(totalDebt) === "too_high") {
        return [simpleMessage([rtxt(audio, T.AMOUNT_TOO_HIGH)]), hangup()];
      }
      if (!hasTerminal) return paymentPlaceholder(audio);
      return creditCardModule(totalDebt);
    }

    // debtChoice=2 → custom amount
    if (debtChoice === "2") {
      if (amount !== undefined) {
        var numAmount2 = parseFloat(amount);
        var check2     = validateAmount(numAmount2);
        if (check2 === "invalid")  return [simpleMessage([rtxt(audio, T.AMOUNT_INVALID)]),  hangup()];
        if (check2 === "too_high") return [simpleMessage([rtxt(audio, T.AMOUNT_TOO_HIGH)]), hangup()];
        if (!hasTerminal) return paymentPlaceholder(audio);
        return creditCardModule(numAmount2);
      }
      return getDTMF("amount", [rtxt(audio, T.ENTER_AMOUNT)], 6, 1, 7);
    }

    // debtChoice=ERROR — caller timed out → say goodbye
    if (debtChoice === "ERROR") {
      return [simpleMessage([rtxt(audio, T.GOODBYE)]), hangup()];
    }

    // Other unexpected debtChoice value — show menu again
    if (debtChoice !== undefined && debtChoice !== "1" && debtChoice !== "2" && debtChoice !== "9") {
      console.warn("[IVR] Unexpected debtChoice:", debtChoice, "— re-showing debt list");
    }

    // No debtChoice yet (or unexpected value) → read all debts then show debt menu
    if (allDebts.length === 0) {
      return [simpleMessage([rtxt(audio, T.NO_PREVIOUS_DEBTS)]), hangup()];
    }

    // DEBT_ITEM נשאר TTS מלא תמיד — לא עובר resolveOrText/resolveAudioId בכלל.
    var debtFiles = allDebts.map(function (d, i) {
      return txt(T.DEBT_ITEM(i + 1, d.amount, d.purpose));
    });
    debtFiles.push(rtxt(audio, T.DEBT_MENU_CHOICES));
    return simpleMenu(debtFiles, "debtChoice", "1,2,9", 2, 7);
  }

  // ── mainChoice = 3 — Leave a voice message ────────────────────────────────
  if (mainChoice === "3") {
    if (!settings.allowCallback) {
      return [simpleMessage([rtxt(audio, T.GOODBYE)]), hangup()];
    }
    return [
      simpleMessage([rtxt(audio, T.LEAVE_MESSAGE)]),
      record("voiceMessage"),
    ];
  }

  // ── Initial menu ──────────────────────────────────────────────────────────
  var greetingItems, menuText, enabledKeys;

  var canPay      = settings.allowPayment;
  var canPrevDebt = settings.allowPreviousDebts && previousDebts.length > 0;
  var canCallback = settings.allowCallback;

  if (donorName && currentDebt && canPay) {
    greetingItems = buildGreetingSegment(donorName, publicNote)
      .concat(buildHasDebtSegment(audio, currentDebt.amount, currentDebt.purpose, currentDebt.purposeType));
    if (canPrevDebt) {
      menuText    = T.MENU_WITH_PREV_DEBTS;
      enabledKeys = canCallback ? "1,2,3" : "1,2";
    } else {
      menuText    = canCallback ? T.MENU_WITHOUT_PREV_DEBTS : T.MENU_PAY_ONLY_NO_CALLBACK;
      enabledKeys = canCallback ? "1,3" : "1";
    }
  } else if (donorName && canPay) {
    greetingItems = buildGreetingSegment(donorName, publicNote).concat([rtxt(audio, T.NO_OPEN_DEBT)]);
    // A donor with no CURRENT debt can still have previous (already-closed
    // or older) debts worth offering — key 2 must not depend on currentDebt.
    if (canPrevDebt) {
      menuText    = canCallback ? T.MENU_DONATION_WITH_PREV_DEBTS : T.MENU_DONATE_WITH_PREV_NO_CALLBACK;
      enabledKeys = canCallback ? "1,2,3" : "1,2";
    } else {
      menuText    = canCallback ? T.MENU_DONATION_ONLY : T.MENU_DONATE_ONLY_NO_CALLBACK;
      enabledKeys = canCallback ? "1,3" : "1";
    }
  } else if (canCallback) {
    greetingItems = buildGreetingSegment(donorName, publicNote);
    menuText    = T.MENU_MESSAGE_ONLY;
    enabledKeys = "3";
  } else {
    // Nothing allowed — politely say goodbye
    greetingItems = buildGreetingSegment(donorName, publicNote);
    return [simpleMessage(greetingItems.concat([rtxt(audio, T.GOODBYE)])), hangup()];
  }

  // NOTE: T.OPENING is intentionally NOT repeated here. With the
  // caller-identification flow, this point is only ever reached AFTER at
  // least one identification round-trip (buildIdentificationResponse already
  // played OPENING once, on the true first turn of the call).
  return simpleMenu(greetingItems.concat([rtxt(audio, menuText)]), "mainChoice", enabledKeys, 3, 5);
}

module.exports = {
  buildResponse,
  buildIdentificationResponse,
  MAX_PAYMENT_AMOUNT,
  // מיוצאים גם לבדיקות ישירות (DI מלא, בלי DB/דיסק) — לא היו קיימים כלל לפני
  // חיבור ההקלטות, תוספת טהורה שלא משנה שום קורא קיים.
  buildAmountSegment,
  buildPurposeSegment,
  buildHasDebtSegment,
  buildPayFullOrCustomSegment,
  buildIdentKnownSegment,
  buildIdentBeneficiaryFoundSegment,
  buildPaymentSuccessSegment,
  buildGreetingSegment,
};

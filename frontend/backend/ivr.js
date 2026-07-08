// Technoline PBX IVR — stateless flow — v2026.06.30
// Accumulated query params drive the state machine:
//   mainChoice  — initial menu (1=pay, 2=prev-debts, 3=record)
//   payChoice   — payment sub-menu (1=full debt, 2=custom) — only when mainChoice=1 + has debt
//   debtChoice  — debt list menu (1=pay all, 2=custom, 9=end) — only when mainChoice=2
//   amount      — getDTMF result
//   payment     — creditCard result (OK / anything else)
//   voiceMessage — record result

// ── Texts ─────────────────────────────────────────────────────────────────────
// All TTS phrases are defined here. To switch languages, replace the values.
// Static phrases are strings; dynamic phrases (with variables) are functions.

var T = {
  // ── Greetings ──────────────────────────────────────────────────────────────
  GREETING_KNOWN:   function (name)            { return "שלום " + name + "."; },
  GREETING_UNKNOWN: "ברוך הבא.",

  // ── Debt announcement (follows greeting) ───────────────────────────────────
  HAS_DEBT:         function (amount, purpose) { return " יש לך חוב על סכום " + amount + " שקלים עבור " + purpose + "."; },
  NO_OPEN_DEBT:     " לא נמצא חוב פתוח.",

  // ── Main menu options (appended after greeting + debt) ─────────────────────
  MENU_WITH_PREV_DEBTS:    " למעבר לתשלום הקישו 1. לשמיעת חובות קודמים הקישו 2. להשארת הודעה הקישו 3.",
  MENU_WITHOUT_PREV_DEBTS: " למעבר לתשלום הקישו 1. להשארת הודעה הקישו 3.",
  MENU_DONATION_ONLY:      " לתרומה הקישו 1. להשארת הודעה הקישו 3.",
  MENU_MESSAGE_ONLY:       " להשארת הודעה הקישו 3.",

  // ── Payment sub-menu ───────────────────────────────────────────────────────
  PAY_FULL_OR_CUSTOM: function (amount) { return "לתשלום הסכום המלא, " + amount + " שקלים, הקישו 1. לתשלום סכום אחר הקישו 2."; },
  ENTER_AMOUNT:       "אנא הזינו את הסכום בשקלים ולחצו סולמית.",
  AMOUNT_INVALID:     "הסכום שהוזן אינו תקין. אנא נסה שנית.",
  AMOUNT_TOO_HIGH:    "הסכום שהוזן גבוה מדי. אנא פנה לנציג.",

  // ── Debt list ──────────────────────────────────────────────────────────────
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

// Maximum single payment allowed through IVR (prevents accidental large charges)
var MAX_PAYMENT_AMOUNT = 99999;

// ── Helpers ─────────────────────────────────────────────────────────────────

function txt(text)    { return { text: text }; }

// Technoline may accumulate duplicate params as an array; always take last value.
function p(query, name) {
  var val = query[name];
  if (Array.isArray(val)) return val[val.length - 1];
  return val;
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

function paymentPlaceholder() {
  return [
    simpleMessage([txt(T.PAYMENT_UNAVAILABLE)]),
    hangup(),
  ];
}

function validateAmount(numAmount) {
  if (isNaN(numAmount) || numAmount <= 0)          return "invalid";
  if (numAmount > MAX_PAYMENT_AMOUNT)               return "too_high";
  return "ok";
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
function buildIdentificationResponse(query, identState) {
  // OPENING plays exactly once per call — on the very first request, before
  // any identification param has been submitted at all. Every retry/submenu
  // after that omits it (matches how every other prompt in this file works).
  var isFirstTurn = query.identChoice === undefined && query.selfIdentInput === undefined;
  var opening = isFirstTurn ? [txt(T.OPENING)] : [];

  function retryText(reason) {
    return reason === "multiple" ? T.IDENT_MULTIPLE_MATCHES : T.IDENT_NOT_FOUND;
  }

  switch (identState.kind) {
    case "self_menu":
      return simpleMenu(
        opening.concat([txt(T.IDENT_KNOWN(identState.donor.fullName)), txt(T.IDENT_SELF_OR_OTHER_MENU)]),
        "identChoice", "1,2", 3, 7
      );

    case "self_input":
      return getDTMF("selfIdentInput",
        opening.concat([txt(T.IDENT_UNKNOWN_ANI), txt(T.ENTER_PHONE_OR_ID_SELF)]),
        10, 5, 10, null);

    case "self_input_retry":
      return getDTMF("selfIdentInput",
        [txt(retryText(identState.reason)), txt(T.ENTER_PHONE_OR_ID_SELF)],
        10, 5, 10, null);

    case "beneficiary_input":
      return getDTMF("beneficiaryIdentInput", [txt(T.ENTER_PHONE_OR_ID_BENEFICIARY)], 10, 5, 10, null);

    case "beneficiary_input_retry":
      return getDTMF("beneficiaryIdentInput",
        [txt(retryText(identState.reason)), txt(T.ENTER_PHONE_OR_ID_BENEFICIARY)],
        10, 5, 10, null);

    case "beneficiary_confirm":
      return simpleMenu(
        [txt(T.IDENT_BENEFICIARY_FOUND(identState.donor.fullName)), txt(T.CONFIRM_OR_RESEARCH_MENU)],
        "identConfirm", "1,2", 3, 7
      );

    case "max_attempts":
      // Reuses the exact existing voicemail module chain (same as
      // mainChoice=3 below) — no new recording mechanism.
      return [
        simpleMessage([txt(T.IDENT_MAX_ATTEMPTS), txt(T.LEAVE_MESSAGE)]),
        record("voiceMessage"),
      ];

    default:
      console.error("[IVR] buildIdentificationResponse: unknown kind:", identState.kind);
      return [simpleMessage([txt(T.GOODBYE)]), hangup()];
  }
}

// ── Flow ─────────────────────────────────────────────────────────────────────

function buildResponse(query, donor) {
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
    return [simpleMessage([txt(T.VOICE_MSG_RECEIVED)]), hangup()];
  }

  // ── Payment result ────────────────────────────────────────────────────────
  if (payment !== undefined) {
    if (payment === "OK") {
      return [simpleMessage([txt(T.PAYMENT_SUCCESS(donorName))]), hangup()];
    }
    return [simpleMessage([txt(T.PAYMENT_FAILED)]), hangup()];
  }

  // ── mainChoice = ERROR — caller timed out without selecting ─────────────
  if (mainChoice === "ERROR") {
    return [simpleMessage([txt(T.GOODBYE)]), hangup()];
  }

  // ── mainChoice = 1 — Payment / Donation ──────────────────────────────────
  if (mainChoice === "1") {
    if (!settings.allowPayment) {
      // Donor has payment disabled — treat as unknown and offer goodbye
      return [simpleMessage([txt(T.PAYMENT_UNAVAILABLE)]), hangup()];
    }

    if (payChoice === "ERROR") {
      return [simpleMessage([txt(T.GOODBYE)]), hangup()];
    }

    // Donor has debt → show payment sub-menu (pay full or custom)
    if (currentDebt && !payChoice) {
      return simpleMenu(
        [txt(T.PAY_FULL_OR_CUSTOM(currentDebt.amount))],
        "payChoice", "1,2", 3, 7
      );
    }

    // payChoice=1 → charge full debt amount
    if (payChoice === "1" && currentDebt) {
      if (validateAmount(currentDebt.amount) === "too_high") {
        return [simpleMessage([txt(T.AMOUNT_TOO_HIGH)]), hangup()];
      }
      if (!hasTerminal) return paymentPlaceholder();
      return creditCardModule(currentDebt.amount);
    }

    // payChoice=2 or no debt → collect amount then charge
    if (amount !== undefined) {
      var numAmount1 = parseFloat(amount);
      var check1     = validateAmount(numAmount1);
      if (check1 === "invalid")  return [simpleMessage([txt(T.AMOUNT_INVALID)]),  hangup()];
      if (check1 === "too_high") return [simpleMessage([txt(T.AMOUNT_TOO_HIGH)]), hangup()];
      if (!hasTerminal) return paymentPlaceholder();
      return creditCardModule(numAmount1);
    }

    return getDTMF("amount", [txt(T.ENTER_AMOUNT)], 6, 1, 7);
  }

  // ── mainChoice = 2 — Previous debts ──────────────────────────────────────
  if (mainChoice === "2") {
    if (!settings.allowPreviousDebts) {
      return [simpleMessage([txt(T.GOODBYE)]), hangup()];
    }

    // debtChoice=9 → end call
    if (debtChoice === "9") {
      return [simpleMessage([txt(T.GOODBYE)]), hangup()];
    }

    // Aggregate: all open debts
    var allDebts = (currentDebt ? [currentDebt] : []).concat(previousDebts);

    // debtChoice=1 → pay total of all debts
    if (debtChoice === "1") {
      var totalDebt = allDebts.reduce(function (s, d) { return s + d.amount; }, 0);
      if (!totalDebt) return paymentPlaceholder();
      if (validateAmount(totalDebt) === "too_high") {
        return [simpleMessage([txt(T.AMOUNT_TOO_HIGH)]), hangup()];
      }
      if (!hasTerminal) return paymentPlaceholder();
      return creditCardModule(totalDebt);
    }

    // debtChoice=2 → custom amount
    if (debtChoice === "2") {
      if (amount !== undefined) {
        var numAmount2 = parseFloat(amount);
        var check2     = validateAmount(numAmount2);
        if (check2 === "invalid")  return [simpleMessage([txt(T.AMOUNT_INVALID)]),  hangup()];
        if (check2 === "too_high") return [simpleMessage([txt(T.AMOUNT_TOO_HIGH)]), hangup()];
        if (!hasTerminal) return paymentPlaceholder();
        return creditCardModule(numAmount2);
      }
      return getDTMF("amount", [txt(T.ENTER_AMOUNT)], 6, 1, 7);
    }

    // debtChoice=ERROR — caller timed out → say goodbye
    if (debtChoice === "ERROR") {
      return [simpleMessage([txt(T.GOODBYE)]), hangup()];
    }

    // Other unexpected debtChoice value — show menu again
    if (debtChoice !== undefined && debtChoice !== "1" && debtChoice !== "2" && debtChoice !== "9") {
      console.warn("[IVR] Unexpected debtChoice:", debtChoice, "— re-showing debt list");
    }

    // No debtChoice yet (or unexpected value) → read all debts then show debt menu
    if (allDebts.length === 0) {
      return [simpleMessage([txt(T.NO_PREVIOUS_DEBTS)]), hangup()];
    }

    var debtFiles = allDebts.map(function (d, i) {
      return txt(T.DEBT_ITEM(i + 1, d.amount, d.purpose));
    });
    debtFiles.push(txt(T.DEBT_MENU_CHOICES));
    return simpleMenu(debtFiles, "debtChoice", "1,2,9", 2, 7);
  }

  // ── mainChoice = 3 — Leave a voice message ────────────────────────────────
  if (mainChoice === "3") {
    if (!settings.allowCallback) {
      return [simpleMessage([txt(T.GOODBYE)]), hangup()];
    }
    return [
      simpleMessage([txt(T.LEAVE_MESSAGE)]),
      record("voiceMessage"),
    ];
  }

  // ── Initial menu ──────────────────────────────────────────────────────────
  var noteSegment  = publicNote ? " " + publicNote : "";
  var greeting, menuText, enabledKeys;

  var canPay      = settings.allowPayment;
  var canPrevDebt = settings.allowPreviousDebts && previousDebts.length > 0;
  var canCallback = settings.allowCallback;

  if (donorName && currentDebt && canPay) {
    greeting = T.GREETING_KNOWN(donorName) + noteSegment + T.HAS_DEBT(currentDebt.amount, currentDebt.purpose);
    if (canPrevDebt) {
      menuText    = T.MENU_WITH_PREV_DEBTS;
      enabledKeys = canCallback ? "1,2,3" : "1,2";
    } else {
      menuText    = canCallback ? T.MENU_WITHOUT_PREV_DEBTS : " למעבר לתשלום הקישו 1.";
      enabledKeys = canCallback ? "1,3" : "1";
    }
  } else if (donorName && canPay) {
    greeting    = T.GREETING_KNOWN(donorName) + noteSegment + T.NO_OPEN_DEBT;
    menuText    = canCallback ? T.MENU_DONATION_ONLY : " לתרומה הקישו 1.";
    enabledKeys = canCallback ? "1,3" : "1";
  } else if (canCallback) {
    greeting    = donorName ? T.GREETING_KNOWN(donorName) + noteSegment : T.GREETING_UNKNOWN;
    menuText    = T.MENU_MESSAGE_ONLY;
    enabledKeys = "3";
  } else {
    // Nothing allowed — politely say goodbye
    greeting = donorName ? T.GREETING_KNOWN(donorName) + noteSegment : T.GREETING_UNKNOWN;
    return [simpleMessage([txt(greeting + " " + T.GOODBYE)]), hangup()];
  }

  // NOTE: T.OPENING is intentionally NOT repeated here. With the
  // caller-identification flow, this point is only ever reached AFTER at
  // least one identification round-trip (buildIdentificationResponse already
  // played OPENING once, on the true first turn of the call).
  return simpleMenu([txt(greeting + menuText)], "mainChoice", enabledKeys, 3, 5);
}

module.exports = { buildResponse, buildIdentificationResponse };

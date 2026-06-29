// Technoline PBX IVR — stateless flow
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

  // ── Payment sub-menu ───────────────────────────────────────────────────────
  PAY_FULL_OR_CUSTOM: function (amount) { return "לתשלום הסכום המלא, " + amount + " שקלים, הקישו 1. לתשלום סכום אחר הקישו 2."; },
  ENTER_AMOUNT:       "אנא הזינו את הסכום בשקלים ולחצו סולמית.",
  AMOUNT_INVALID:     "הסכום שהוזן אינו תקין. אנא נסה שנית.",

  // ── Debt list ──────────────────────────────────────────────────────────────
  DEBT_ITEM:         function (n, amount, purpose) { return n + ". סכום " + amount + " שקלים עבור " + purpose + "."; },
  DEBT_MENU_CHOICES: "לתשלום כל החובות הקישו 1. לתשלום סכום אחר הקישו 2. לסיום הקישו 9.",
  NO_PREVIOUS_DEBTS: "לא נמצאו חובות קודמים.",

  // ── Voice recording ────────────────────────────────────────────────────────
  LEAVE_MESSAGE:         "אנא השאירו הודעתכם לאחר הצליל.",
  VOICE_MSG_RECEIVED:    "הודעתכם התקבלה. תודה.",

  // ── Payment result ─────────────────────────────────────────────────────────
  PAYMENT_SUCCESS: function (name) { return (name ? "תודה " + name + ". " : "") + "התשלום התקבל בהצלחה. תודה רבה."; },
  PAYMENT_FAILED:  "התשלום לא הושלם. אנא נסה שנית מאוחר יותר.",

  // ── Fallback when credit-card terminal is not configured ───────────────────
  PAYMENT_UNAVAILABLE: "התשלום בכרטיס אשראי אינו זמין כרגע. נציג ייצור איתך קשר בהקדם. תודה.",

  // ── Goodbye ────────────────────────────────────────────────────────────────
  GOODBYE: "תודה על התקשרותך. להתראות.",
};

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

function getDTMF(name, files, max, min, timeout) {
  return {
    type: "getDTMF",
    name: name,
    max: max || 6,
    min: min || 1,
    timeout: timeout || 7,
    skipKey: "#",
    confirmType: "number",
    files: files,
  };
}

// NOTE: verify exact `record` module params with Technoline support before using.
function record(name) {
  return {
    type: "record",
    name: name,
    timeout: 5,
    maxTime: 60,
    skipKey: "#",
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
    terminal: process.env.CREDIT_CARD_TERMINAL || "",
  };
}

function paymentPlaceholder() {
  return [
    simpleMessage([txt(T.PAYMENT_UNAVAILABLE)]),
    hangup(),
  ];
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
  var currentDebt   = donor ? donor.currentDebt   : null;   // { amount, purpose }
  var previousDebts = donor ? (donor.previousDebts || []) : []; // [{ amount, purpose }]
  var publicNote    = donor && donor.publicPhoneNote ? donor.publicPhoneNote : "";
  var hasTerminal   = !!(process.env.CREDIT_CARD_TERMINAL);

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

  // ── mainChoice = 1 — Payment / Donation ──────────────────────────────────
  if (mainChoice === "1") {

    // Donor has debt → show payment sub-menu (pay full or custom)
    if (currentDebt && !payChoice) {
      return simpleMenu(
        [txt(T.PAY_FULL_OR_CUSTOM(currentDebt.amount))],
        "payChoice", "1,2", 3, 7
      );
    }

    // payChoice=1 → charge full debt amount
    if (payChoice === "1" && currentDebt) {
      if (!hasTerminal) return paymentPlaceholder();
      return creditCardModule(currentDebt.amount);
    }

    // payChoice=2 or no debt → collect amount then charge
    if (amount !== undefined) {
      var numAmount = parseFloat(amount);
      if (isNaN(numAmount) || numAmount <= 0) {
        return [simpleMessage([txt(T.AMOUNT_INVALID)]), hangup()];
      }
      if (!hasTerminal) return paymentPlaceholder();
      return creditCardModule(numAmount);
    }

    return getDTMF("amount", [txt(T.ENTER_AMOUNT)], 6, 1, 7);
  }

  // ── mainChoice = 2 — Previous debts ──────────────────────────────────────
  if (mainChoice === "2") {

    // debtChoice=9 → end call
    if (debtChoice === "9") {
      return [simpleMessage([txt(T.GOODBYE)]), hangup()];
    }

    // Aggregate: all open debts for paying "all"
    var allDebts = (currentDebt ? [currentDebt] : []).concat(previousDebts);

    // debtChoice=1 → pay total of all debts
    if (debtChoice === "1") {
      var totalDebt = allDebts.reduce(function (s, d) { return s + d.amount; }, 0);
      if (!totalDebt || !hasTerminal) return paymentPlaceholder();
      return creditCardModule(totalDebt);
    }

    // debtChoice=2 → custom amount
    if (debtChoice === "2") {
      if (amount !== undefined) {
        var customAmt = parseFloat(amount);
        if (isNaN(customAmt) || customAmt <= 0) {
          return [simpleMessage([txt(T.AMOUNT_INVALID)]), hangup()];
        }
        if (!hasTerminal) return paymentPlaceholder();
        return creditCardModule(customAmt);
      }
      return getDTMF("amount", [txt(T.ENTER_AMOUNT)], 6, 1, 7);
    }

    // No debtChoice yet → read all debts then show debt menu
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
    return [
      simpleMessage([txt(T.LEAVE_MESSAGE)]),
      record("voiceMessage"),
    ];
  }

  // ── Initial menu ──────────────────────────────────────────────────────────
  var noteSegment = publicNote ? " " + publicNote : "";
  var greeting, menuText, enabledKeys;

  if (donorName && currentDebt) {
    greeting = T.GREETING_KNOWN(donorName) + noteSegment + T.HAS_DEBT(currentDebt.amount, currentDebt.purpose);
    if (previousDebts.length > 0) {
      menuText    = T.MENU_WITH_PREV_DEBTS;
      enabledKeys = "1,2,3";
    } else {
      menuText    = T.MENU_WITHOUT_PREV_DEBTS;
      enabledKeys = "1,3";
    }
  } else if (donorName) {
    greeting    = T.GREETING_KNOWN(donorName) + noteSegment + T.NO_OPEN_DEBT;
    menuText    = T.MENU_DONATION_ONLY;
    enabledKeys = "1,3";
  } else {
    greeting    = T.GREETING_UNKNOWN;
    menuText    = T.MENU_DONATION_ONLY;
    enabledKeys = "1,3";
  }

  return simpleMenu([txt(greeting + menuText)], "mainChoice", enabledKeys, 3, 5);
}

module.exports = { buildResponse };

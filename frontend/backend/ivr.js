// Technoline PBX IVR — stateless flow
// Accumulated query params drive the state machine:
//   mainChoice  — initial menu (1=pay, 2=prev-debts, 3=record)
//   payChoice   — payment sub-menu (1=full debt, 2=custom) — only when mainChoice=1 + has debt
//   debtChoice  — debt list menu (1=pay all, 2=custom, 9=end) — only when mainChoice=2
//   amount      — getDTMF result
//   payment     — creditCard result (OK / anything else)
//   voiceMessage — record result

// ── Helpers ─────────────────────────────────────────────────────────────────

function txt(text)    { return { text: text }; }
function spokenNum(n) { return { number: String(n) }; }

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
    simpleMessage([txt("התשלום בכרטיס אשראי אינו זמין כרגע. נציג ייצור איתך קשר בהקדם. תודה.")]),
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
    return [simpleMessage([txt("הודעתכם התקבלה. תודה.")]), hangup()];
  }

  // ── Payment result ────────────────────────────────────────────────────────
  if (payment !== undefined) {
    if (payment === "OK") {
      var okGreeting = donorName ? "תודה " + donorName + ". " : "";
      return [simpleMessage([txt(okGreeting + "התשלום התקבל בהצלחה. תודה רבה.")]), hangup()];
    }
    return [simpleMessage([txt("התשלום לא הושלם. אנא נסה שנית מאוחר יותר.")]), hangup()];
  }

  // ── mainChoice = 1 — Payment / Donation ──────────────────────────────────
  if (mainChoice === "1") {

    // Donor has debt → show payment sub-menu (pay full or custom)
    if (currentDebt && !payChoice) {
      return simpleMenu(
        [txt("לתשלום הסכום המלא, " + currentDebt.amount + " שקלים, הקישו 1. לתשלום סכום אחר הקישו 2.")],
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
        return [simpleMessage([txt("הסכום שהוזן אינו תקין. אנא נסה שנית.")]), hangup()];
      }
      if (!hasTerminal) return paymentPlaceholder();
      return creditCardModule(numAmount);
    }

    return getDTMF("amount", [txt("אנא הזינו את הסכום בשקלים ולחצו סולמית.")], 6, 1, 7);
  }

  // ── mainChoice = 2 — Previous debts ──────────────────────────────────────
  if (mainChoice === "2") {

    // debtChoice=9 → end call
    if (debtChoice === "9") {
      return [simpleMessage([txt("תודה על התקשרותך. להתראות.")]), hangup()];
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
          return [simpleMessage([txt("הסכום שהוזן אינו תקין. אנא נסה שנית.")]), hangup()];
        }
        if (!hasTerminal) return paymentPlaceholder();
        return creditCardModule(customAmt);
      }
      return getDTMF("amount", [txt("אנא הזינו את הסכום בשקלים ולחצו סולמית.")], 6, 1, 7);
    }

    // No debtChoice yet → read all debts then show debt menu
    if (allDebts.length === 0) {
      return [simpleMessage([txt("לא נמצאו חובות קודמים.")]), hangup()];
    }

    var debtFiles = allDebts.map(function (d, i) {
      return txt((i + 1) + ". סכום " + d.amount + " שקלים עבור " + d.purpose + ".");
    });
    debtFiles.push(txt("לתשלום כל החובות הקישו 1. לתשלום סכום אחר הקישו 2. לסיום הקישו 9."));
    return simpleMenu(debtFiles, "debtChoice", "1,2,9", 2, 7);
  }

  // ── mainChoice = 3 — Leave a voice message ────────────────────────────────
  if (mainChoice === "3") {
    return [
      simpleMessage([txt("אנא השאירו הודעתכם לאחר הצליל.")]),
      record("voiceMessage"),
    ];
  }

  // ── Initial menu ──────────────────────────────────────────────────────────
  var noteSegment = publicNote ? " " + publicNote : "";
  var greeting, menuText, enabledKeys;

  if (donorName && currentDebt) {
    greeting = "שלום " + donorName + "." + noteSegment +
      " יש לך חוב על סכום " + currentDebt.amount +
      " שקלים עבור " + currentDebt.purpose + ".";
    if (previousDebts.length > 0) {
      menuText = " למעבר לתשלום הקישו 1. לשמיעת חובות קודמים הקישו 2. להשארת הודעה הקישו 3.";
      enabledKeys = "1,2,3";
    } else {
      menuText = " למעבר לתשלום הקישו 1. להשארת הודעה הקישו 3.";
      enabledKeys = "1,3";
    }
  } else if (donorName) {
    greeting = "שלום " + donorName + "." + noteSegment + " לא נמצא חוב פתוח.";
    menuText  = " לתרומה הקישו 1. להשארת הודעה הקישו 3.";
    enabledKeys = "1,3";
  } else {
    greeting  = "ברוך הבא.";
    menuText  = " לתרומה הקישו 1. להשארת הודעה הקישו 3.";
    enabledKeys = "1,3";
  }

  return simpleMenu([txt(greeting + menuText)], "mainChoice", enabledKeys, 3, 5);
}

module.exports = { buildResponse };

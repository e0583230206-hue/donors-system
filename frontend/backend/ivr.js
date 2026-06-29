// Technoline PBX IVR — stateless flow
// PBX sends GET with ALL accumulated query params on every round-trip.
// State is derived solely from which params exist in req.query.
//
// buildResponse(query, donor)
//   query — req.query from Express (PBX fixed params + accumulated name values)
//   donor — { id, fullName, suggestedAmount } from DB, or null

// ── Audio item helpers ───────────────────────────────────────────

function txt(text)    { return { text: text }; }
function fName(name)  { return { fileName: name }; }
function spokenNum(n) { return { number: String(n) }; }

// ── Module builders ──────────────────────────────────────────────

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
    extensionChange: "..",
    files: files,
  };
}

function getDTMF(name, files, max, min, timeout, skipKey, confirmType) {
  return {
    type: "getDTMF",
    name: name,
    max: max || 6,
    min: min || 1,
    timeout: timeout || 7,
    skipKey: skipKey || "#",
    confirmType: confirmType || "number",
    files: files,
  };
}

function hangup() {
  return { type: "hangup" };
}

// ── Flow ─────────────────────────────────────────────────────────
//
//  HANGUP:         PBXcallStatus === "HANGUP"     → null (empty 200)
//  payment result: payment param exists            → thank-you or error + hangup
//  amount entered: menuChoice=1 + amount exists    → placeholder until creditCard terminal ready
//  choice 1:       menuChoice=1, no amount         → getDTMF(amount)
//  choice 2:       menuChoice=2                    → inquiry + hangup
//  choice 3:       menuChoice=3                    → goodbye + hangup
//  initial:        no menuChoice                   → simpleMenu

function buildResponse(query, donor) {
  var callStatus = query.PBXcallStatus;
  var menuChoice = query.menuChoice;
  var amount     = query.amount;
  var payment    = query.payment;

  var donorName       = donor ? donor.fullName : null;
  var suggestedAmount = donor && donor.suggestedAmount ? donor.suggestedAmount : null;

  // ── HANGUP ─────────────────────────────────────────────────────
  if (callStatus === "HANGUP") {
    return null;
  }

  // ── Payment result ─────────────────────────────────────────────
  if (payment !== undefined) {
    if (payment === "OK") {
      var thankFiles = donorName
        ? [txt("תודה " + donorName + "."), fName("thank_you")]
        : [fName("thank_you")];
      return [simpleMessage(thankFiles), hangup()];
    }
    return [
      simpleMessage([txt("הסכום לא חויב. אנא נסה שנית מאוחר יותר.")]),
      hangup(),
    ];
  }

  // ── Amount entered → creditCard (pending terminal) ─────────────
  if (menuChoice === "1" && amount !== undefined) {
    var numericAmount = parseFloat(amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
      return [
        simpleMessage([txt("הסכום שהוזן אינו תקין. אנא נסה שנית.")]),
        hangup(),
      ];
    }

    // TODO: uncomment when CREDIT_CARD_TERMINAL is set in .env
    //
    // return {
    //   type:          "creditCard",
    //   name:          "payment",
    //   sum:           numericAmount,
    //   sumChangeable: "no",
    //   cvv:           "yes",
    //   tz:            "yes",
    //   payments:      1,
    //   category:      "תרומה",
    //   terminal:      process.env.CREDIT_CARD_TERMINAL || "",
    // };

    return [
      simpleMessage([txt("קיבלנו את פנייתך. נציג ייצור איתך קשר לביצוע התרומה. תודה.")]),
      hangup(),
    ];
  }

  // ── Menu choice 1 → collect donation amount ────────────────────
  if (menuChoice === "1") {
    var amountFiles;
    if (donorName && suggestedAmount) {
      amountFiles = [
        txt("שלום " + donorName + "."),
        txt("תרומתך הקודמת הייתה "),
        spokenNum(suggestedAmount),
        txt("שקלים."),
        fName("enter_amount"),
      ];
    } else if (donorName) {
      amountFiles = [txt("שלום " + donorName + "."), fName("enter_amount")];
    } else {
      amountFiles = [fName("enter_amount")];
    }
    return getDTMF("amount", amountFiles, 6, 1, 7, "#", "number");
  }

  // ── Menu choice 2 → inquiry ────────────────────────────────────
  if (menuChoice === "2") {
    return [
      simpleMessage([txt("לבירורים, אנא פנה למשרד בשעות הפעילות. תודה.")]),
      hangup(),
    ];
  }

  // ── Menu choice 3 → goodbye ────────────────────────────────────
  if (menuChoice === "3") {
    return [simpleMessage([fName("goodbye")]), hangup()];
  }

  // ── Initial menu ───────────────────────────────────────────────
  var menuFiles = donorName
    ? [txt("שלום " + donorName + "."), fName("main_menu")]
    : [fName("unknown_donor"), fName("main_menu")];

  return simpleMenu(menuFiles, "menuChoice", "1,2,3", 3, 5);
}

module.exports = { buildResponse };

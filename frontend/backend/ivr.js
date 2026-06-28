// Technoline PBX IVR — stateless flow
// Every request from the PBX carries ALL accumulated query params.
// State is derived solely from which params exist in req.query.
//
// buildResponse(query, donor)
//   query  — req.query from Express (all PBX params)
//   donor  — { id, fullName } from DB, or null/undefined for anonymous

// ── Module builders ──────────────────────────────────────────────

function simpleMenu(options) {
  return { type: "simpleMenu", options: options };
}

function getDTMF(name, description) {
  return { type: "getDTMF", name: name, description: description };
}

function creditCard(name, sum) {
  return {
    type: "creditCard",
    name: name,
    sum: String(sum),
    cvv: "yes",
    tz: "yes",
    payments: "1",
  };
}

function simpleMessage(text) {
  return { type: "simpleMessage", text: text };
}

function hangup() {
  return { type: "hangup" };
}

// ── Flow ─────────────────────────────────────────────────────────
//
//  Step 0 — HANGUP:          PBXcallStatus === "HANGUP"  → null (empty 200)
//  Step 4 — payment result:  payment param exists        → message + hangup
//  Step 3 — creditCard:      menuChoice=1 + amount       → creditCard module
//  Step 2 — get amount:      menuChoice=1                → getDTMF(amount)
//  Step 1 — initial menu:    no menuChoice               → simpleMenu

function buildResponse(query, donor) {
  var callStatus = query.PBXcallStatus;
  var menuChoice = query.menuChoice;
  var amount     = query.amount;
  var payment    = query.payment;

  var donorName  = donor ? donor.fullName : null;
  var suggestedAmount = donor && donor.suggestedAmount ? donor.suggestedAmount : null;

  // ── Step 0: HANGUP ──────────────────────────────────────────
  if (callStatus === "HANGUP") {
    return null;
  }

  // ── Step 4: Payment result ───────────────────────────────────
  if (payment !== undefined) {
    if (payment === "OK") {
      var thankYou = donorName
        ? "שלום " + donorName + ", תודה על תרומתך"
        : "תודה על תרומתך! הסכום התקבל בהצלחה.";
      return [simpleMessage(thankYou), hangup()];
    }
    return [
      simpleMessage("אירעה שגיאה בביצוע התשלום. אנא נסה שנית."),
      hangup(),
    ];
  }

  // ── Step 3: Trigger credit-card module ───────────────────────
  if (menuChoice === "1" && amount !== undefined) {
    var numericAmount = parseFloat(amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
      return [
        simpleMessage("הסכום שהוזן אינו תקין. אנא נסה שנית."),
        hangup(),
      ];
    }
    return creditCard("payment", numericAmount);
  }

  // ── Step 2: Collect donation amount ──────────────────────────
  if (menuChoice === "1") {
    var amountPrompt = donorName
      ? "שלום " + donorName + ". אנא הזן את סכום התרומה ולחץ על סולמית"
      : "אנא הזן את סכום התרומה ולחץ על סולמית";

    if (suggestedAmount) {
      amountPrompt += ". סכום התרומה הקודם שלך היה " + suggestedAmount + " שקלים";
    }

    return getDTMF("amount", amountPrompt);
  }

  // ── menuChoice=2: Inquiry ────────────────────────────────────
  if (menuChoice === "2") {
    return [
      simpleMessage("לבירורים, אנא פנה למשרד בשעות הפעילות. תודה."),
      hangup(),
    ];
  }

  // ── menuChoice=3: End call ───────────────────────────────────
  if (menuChoice === "3") {
    return [
      simpleMessage("תודה על התקשרותך. להתראות."),
      hangup(),
    ];
  }

  // ── Step 1: Initial menu ─────────────────────────────────────
  return simpleMenu([
    { num: "1", description: "תרומה" },
    { num: "2", description: "בירור" },
    { num: "3", description: "סיום" },
  ]);
}

module.exports = { buildResponse };

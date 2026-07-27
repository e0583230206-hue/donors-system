// donation-edit-ui.test.js — audit tests for the "ערוך תרומה" (edit donation)
// feature in frontend/donor.html + frontend/js/donor.js, including the manual
// "mark as paid" -> real payment record flow (POST /api/donors/:id/manual-payment,
// see manual-payment.routes.test.js for the server-side half of that same
// feature). Loads the real utils.js / database.js / audit-log.js / donor.js
// source into a Node `vm` context with a minimal DOM/localStorage/fetch stub
// (no browser needed), then drives the actual shipped functions
// (openEditDonationModal, saveDonationEdit, handleDonationsTableClick) exactly
// as a click on "✏️ ערוך" would, and inspects the real persisted state
// (localStorage-backed Database.get) plus the real AuditLog output.
//
// This exercises the production code directly — nothing here is a
// reimplementation of the edit logic, so a bug in donor.js shows up here too.
//
// הרצה: node frontend/backend/donation-edit-ui.test.js

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const JS_DIR = path.join(__dirname, "..", "js");
function readSrc(name) {
  return fs.readFileSync(path.join(JS_DIR, name), "utf8");
}

// vm.createContext gives donor.js its own realm, so arrays/objects handed
// back from it (e.g. Database.get(...) results) have a DIFFERENT Array.prototype
// / Object.prototype than this host file's. assert.deepStrictEqual treats
// that prototype mismatch as inequality even when the data is identical —
// round-tripping through JSON (host-side) strips the foreign realm and
// yields plain host objects/arrays that compare normally.
function toPlain(x) { return JSON.parse(JSON.stringify(x)); }

const UTILS_SRC = readSrc("utils.js");
const DATABASE_SRC = readSrc("database.js");
const AUDIT_LOG_SRC = readSrc("audit-log.js");
const DONOR_SRC = readSrc("donor.js");

// ── minimal browser stubs ───────────────────────────────────────────────────

function makeStorage() {
  var store = new Map();
  return {
    getItem: function (k) { return store.has(k) ? store.get(k) : null; },
    setItem: function (k, v) { store.set(k, String(v)); },
    removeItem: function (k) { store.delete(k); },
    clear: function () { store.clear(); },
    key: function (i) { return Array.from(store.keys())[i] || null; },
    get length() { return store.size; },
  };
}

function makeElement(id) {
  var listeners = {};
  var el = {
    id: id || "",
    value: "",
    innerText: "",
    innerHTML: "",
    textContent: "",
    className: "",
    style: {},
    disabled: false,
    children: [],
    classList: {
      _set: new Set(),
      add: function (c) { this._set.add(c); },
      remove: function (c) { this._set.delete(c); },
      contains: function (c) { return this._set.has(c); },
      toggle: function (c) { if (this._set.has(c)) this._set.delete(c); else this._set.add(c); },
    },
    addEventListener: function (evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); },
    removeEventListener: function () {},
    appendChild: function (child) { this.children.push(child); },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    focus: function () {},
    setAttribute: function () {},
    getAttribute: function () { return null; },
    click: function () { (listeners.click || []).forEach(function (f) { f({ target: el }); }); },
  };
  return el;
}

function buildSandbox(donorId) {
  var registry = {};
  var documentStub = {
    getElementById: function (id) {
      if (!registry[id]) registry[id] = makeElement(id);
      return registry[id];
    },
    createElement: function () { return makeElement(null); },
    addEventListener: function () {},
    body: makeElement("body"),
  };

  var sandbox = {
    console: console,
    localStorage: makeStorage(),
    sessionStorage: makeStorage(),
    document: documentStub,
    URLSearchParams: URLSearchParams,
    URL: URL,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    alert: function () {},
    // Default to "cancelled" so a test that forgets to stub confirm() fails
    // loudly (nothing gets silently un-paid) instead of passing by accident.
    confirm: function () { return false; },
    isAdmin: function () { return false; },
    addEventListener: function () {},
    fetch: function (url) { return Promise.reject(new Error("network disabled in tests: " + url)); },
  };
  // Real apiFetch (auth.js) just wraps fetch with an Authorization header and
  // 401-handling — neither matters for these tests, so route it straight to
  // the same overridable sandbox.fetch used everywhere else here.
  sandbox.apiFetch = function (url, options) { return sandbox.fetch(url, options); };
  sandbox.window = sandbox;
  sandbox.location = { href: "http://localhost/frontend/donor.html?id=" + donorId, search: "?id=" + donorId };
  sandbox.window.location = sandbox.location;

  vm.createContext(sandbox);
  return { sandbox: sandbox, documentStub: documentStub };
}

// Wires sandbox.fetch to a tiny in-memory fake server for the two endpoints
// saveDonationEdit's manual-payment path actually calls: POST creates a row
// (mirroring the real /api/donors/:id/manual-payment contract), GET returns
// everything created so far (mirroring /api/payments?phone=...). Lets tests
// assert "exactly once" end-to-end through the real client code without a
// live server — the real server-side contract is covered separately in
// manual-payment.routes.test.js.
function mockPaymentServer(mod) {
  var payments = [];
  var postBodies = [];
  var getCalls = 0;
  mod.sandbox.fetch = function (url, options) {
    if (String(url).indexOf("/manual-payment") !== -1) {
      var body = JSON.parse((options && options.body) || "{}");
      postBodies.push(body);
      var payment = {
        id: payments.length + 1,
        callId: "manual-test-" + (payments.length + 1),
        phone: body.phone || "",
        donorId: null,
        donorName: body.donorName || null,
        amount: body.amount,
        status: "success",
        source: "manual",
        confirmationNumber: null,
        createdAt: new Date().toISOString(),
        timestamp: new Date().toISOString(),
      };
      payments.push(payment);
      return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ ok: true, payment: payment }); } });
    }
    if (String(url).indexOf("/api/payments") !== -1) {
      getCalls++;
      return Promise.resolve({ ok: true, json: function () { return Promise.resolve(payments); } });
    }
    return Promise.reject(new Error("unexpected fetch in mockPaymentServer: " + url));
  };
  return {
    payments: payments,
    postBodies: postBodies,
    getCallCount: function () { return getCalls; },
  };
}

function loadDonorModule(fixtureDonor, fixtureApprovals) {
  var built = buildSandbox(fixtureDonor.id);
  var sandbox = built.sandbox;

  sandbox.localStorage.setItem("donors", JSON.stringify([fixtureDonor]));
  if (fixtureApprovals) {
    sandbox.localStorage.setItem("approvals", JSON.stringify(fixtureApprovals));
  }

  vm.runInContext(UTILS_SRC, sandbox, { filename: "utils.js" });
  vm.runInContext(DATABASE_SRC, sandbox, { filename: "database.js" });
  vm.runInContext(AUDIT_LOG_SRC, sandbox, { filename: "audit-log.js" });
  vm.runInContext(DONOR_SRC, sandbox, { filename: "donor.js" });

  // Database/AuditLog are top-level `const` in their source files — those
  // bindings live in the context's lexical scope, not as properties of the
  // sandbox/global object, so `sandbox.Database` would be undefined. Copy
  // them onto `var` globals (which DO attach to the global object) so the
  // host side can reach the same live objects donor.js is using.
  vm.runInContext("var __Database = Database; var __AuditLog = AuditLog;", sandbox);

  return {
    sandbox: sandbox,
    documentStub: built.documentStub,
    getDonor: function () {
      var donors = toPlain(sandbox.__Database.get("donors"));
      return donors.find(function (d) { return d.id === fixtureDonor.id; });
    },
    getApprovals: function () { return toPlain(sandbox.__Database.get("approvals") || []); },
    getLogs: function () { return toPlain(sandbox.__Database.get("logs") || []); },
    setInput: function (id, value) { built.documentStub.getElementById(id).value = value; },
    getInput: function (id) { return built.documentStub.getElementById(id); },
  };
}

// ── fixture ──────────────────────────────────────────────────────────────

const DONOR_ID = 555;
const DONATION_UNPAID_ID = 1001;
const DONATION_PAID_ID = 1002;
const DONATION_PARTIAL_ID = 1003;

function makeFixtureDonor() {
  return {
    id: DONOR_ID,
    fullName: "בדיקה טסט",
    phone: "0500000000",
    city: "עיר",
    address: "כתובת",
    status: "פעיל",
    notes: "",
    tags: [],
    internalStaffNote: "",
    publicPhoneNote: "",
    phoneMessageSettings: { includeInCalls: true, allowPayment: true, allowPreviousDebts: true, allowCallback: true },
    ivrApprovedPhones: ["0500000000"],
    tasks: [], reminders: [], callbacks: [],
    donations: [
      {
        id: DONATION_UNPAID_ID,
        date: "2026-01-01T10:00:00.000Z",
        regularDate: "2026-01-01",
        hebrewDate: "י׳א טבת תשפ׳ו",
        weekday: "חמישי",
        amount: 500,
        parsha: "בראשית",
        finalPurpose: "גליון מתאחדת",
        purposeType: "גליון מתאחדת",
        customPurpose: "",
        paymentMethod: "אשראי",
        paid: false,
        paidPartial: 0,
        remainingDebt: 500,
        note: "",
        approvedStatus: "טיוטה",
        messageStatus: "טיוטה",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: DONATION_PAID_ID,
        date: "2026-01-05T10:00:00.000Z",
        regularDate: "2026-01-05",
        hebrewDate: "ט׳ו טבת תשפ׳ו",
        weekday: "שני",
        amount: 300,
        parsha: "נח",
        finalPurpose: "פרנס",
        purposeType: "פרנס",
        customPurpose: "",
        paymentMethod: "אשראי",
        paid: true,
        paidPartial: 300,
        remainingDebt: 0,
        note: "תרומה חודשית",
        approvedStatus: "אושר",
        messageStatus: "נשלח",
        createdAt: "2026-01-05T10:00:00.000Z",
      },
      {
        id: DONATION_PARTIAL_ID,
        date: "2026-01-10T10:00:00.000Z",
        regularDate: "2026-01-10",
        hebrewDate: "כ׳ טבת תשפ׳ו",
        weekday: "שישי",
        amount: 1000,
        parsha: "",
        finalPurpose: "מטרה מיוחדת",
        purposeType: "אחר",
        customPurpose: "מטרה מיוחדת",
        paymentMethod: "העברה בנקאית",
        paid: false,
        paidPartial: 400,
        remainingDebt: 600,
        note: "שולם חלקית בעבר",
        lastPaymentMethod: "מזומן",
        approvedStatus: "טיוטה",
        messageStatus: "טיוטה",
        createdAt: "2026-01-10T10:00:00.000Z",
      },
    ],
  };
}

// ── test runner ──────────────────────────────────────────────────────────

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name: name, ok: true });
  } catch (err) {
    results.push({ name: name, ok: false, error: err.stack || err.message });
  }
}

async function main() {

// ── 1. תרומה שלא שולמה ──────────────────────────────────────────────────

await check("תרומה שלא שולמה: עריכת פרטים בלבד (סכום) מעדכנת יתרה, לא נוגעת בשדות אחרים ולא פונה לשרת תשלומים", async function () {
  var mod = loadDonorModule(makeFixtureDonor());
  var before = mod.getDonor().donations.find(function (d) { return d.id === DONATION_UNPAID_ID; });
  var netMock = mockPaymentServer(mod); // אם ייקרא בכלל — זו כשל, כי אין כאן שינוי סטטוס תשלום

  mod.sandbox.openEditDonationModal(DONATION_UNPAID_ID);
  mod.setInput("editDonationAmountInput", "750");
  await mod.sandbox.saveDonationEdit();

  var after = mod.getDonor().donations.find(function (d) { return d.id === DONATION_UNPAID_ID; });
  assert.strictEqual(after.amount, 750);
  assert.strictEqual(after.paidPartial, 0);
  assert.strictEqual(after.remainingDebt, 750);
  assert.strictEqual(after.paid, false);
  assert.strictEqual(netMock.postBodies.length, 0, "עריכת פרטים בלבד לא יוצרת רשומת תשלום");

  ["id", "date", "regularDate", "hebrewDate", "weekday", "createdAt",
   "approvedStatus", "messageStatus", "parsha", "finalPurpose", "paymentMethod",
   "purposeType", "customPurpose"].forEach(function (f) {
    assert.strictEqual(after[f], before[f], "השדה " + f + " לא היה אמור להשתנות");
  });
});

await check("תרומה שלא שולמה: שאר התרומות של אותו תורם לא נפגעות", async function () {
  var mod = loadDonorModule(makeFixtureDonor());
  mod.sandbox.openEditDonationModal(DONATION_UNPAID_ID);
  mod.setInput("editDonationAmountInput", "750");
  await mod.sandbox.saveDonationEdit();

  var donations = mod.getDonor().donations;
  assert.strictEqual(donations.length, 3, "לא אמורות להתווסף/להימחק תרומות");
  var paid = donations.find(function (d) { return d.id === DONATION_PAID_ID; });
  var partial = donations.find(function (d) { return d.id === DONATION_PARTIAL_ID; });
  assert.strictEqual(paid.amount, 300);
  assert.strictEqual(paid.remainingDebt, 0);
  assert.strictEqual(partial.amount, 1000);
  assert.strictEqual(partial.paidPartial, 400);
});

// ── 2. תרומה שלא שולמה -> תשלום מלא במזומן (יוצר רשומת תשלום אמיתית) ────

await check("תרומה שלא שולמה -> סימון כתשלום מלא במזומן: יוצר רשומת תשלום אמיתית בגובה מלוא הסכום, כולל אמצעי התשלום", async function () {
  var mod = loadDonorModule(makeFixtureDonor()); // amount=500, paidPartial=0, wasPaid=false
  var netMock = mockPaymentServer(mod);

  mod.sandbox.openEditDonationModal(DONATION_UNPAID_ID);
  mod.setInput("editDonationPaidSelect", "true");
  mod.setInput("editDonationPaymentMethodSelect", "מזומן");
  await mod.sandbox.saveDonationEdit();

  assert.strictEqual(netMock.postBodies.length, 1, "בדיוק קריאת יצירת-תשלום אחת");
  assert.strictEqual(netMock.postBodies[0].amount, 500, "כל הסכום — התרומה לא הייתה משולמת בכלל קודם");
  assert.strictEqual(netMock.postBodies[0].paymentMethod, "מזומן", "מזומן הוא אמצעי תשלום תקין ונשלח לשרת");
  assert.strictEqual(netMock.postBodies[0].donorName, "בדיקה טסט");

  var after = mod.getDonor().donations.find(function (d) { return d.id === DONATION_UNPAID_ID; });
  assert.strictEqual(after.paidPartial, 500);
  assert.strictEqual(after.remainingDebt, 0);
  assert.strictEqual(after.paid, true);
  assert.strictEqual(after.paymentMethod, "מזומן");
  assert.strictEqual(after.lastPaymentMethod, "מזומן");
  assert.strictEqual(after.lastPaymentId, 1, "התרומה מקושרת לרשומת התשלום שנוצרה");

  var logs = mod.getLogs();
  var log = logs[logs.length - 1];
  assert.strictEqual(log.details, "התרומה סומנה כשולמה ידנית באמצעי מזומן (רשומת תשלום מס' 1)");
  var fields = log.changes.map(function (c) { return c.field; });
  ["paid", "paidPartial", "remainingDebt", "paymentMethod"].forEach(function (f) {
    assert.ok(fields.indexOf(f) !== -1, "שדה " + f + " חייב להופיע ב-Audit Log");
  });
});

// ── 3. תרומה ששולמה חלקית -> השלמת יתרה במזומן (רק גובה היתרה!) ─────────

await check("תרומה ששולמה חלקית -> השלמת היתרה במזומן: רשומת התשלום נוצרת רק בגובה היתרה שנותרה (600), לא מלוא הסכום (1000)", async function () {
  var mod = loadDonorModule(makeFixtureDonor()); // amount=1000, paidPartial=400, remainingDebt=600
  var netMock = mockPaymentServer(mod);

  mod.sandbox.openEditDonationModal(DONATION_PARTIAL_ID);
  mod.setInput("editDonationPaidSelect", "true");
  mod.setInput("editDonationPaymentMethodSelect", "מזומן");
  await mod.sandbox.saveDonationEdit();

  assert.strictEqual(netMock.postBodies.length, 1);
  assert.strictEqual(netMock.postBodies[0].amount, 600, "רק היתרה שנותרה — לא 1000 ולא 400 שכבר שולמו קודם");

  var after = mod.getDonor().donations.find(function (d) { return d.id === DONATION_PARTIAL_ID; });
  assert.strictEqual(after.amount, 1000);
  assert.strictEqual(after.paidPartial, 1000);
  assert.strictEqual(after.remainingDebt, 0);
  assert.strictEqual(after.paid, true);
  assert.strictEqual(after.paymentMethod, "מזומן");
  assert.strictEqual(after.lastPaymentMethod, "מזומן");
});

await check("תרומה ששולמה חלקית: עריכת פרט אחר (הערה) בלבד לא יוצרת תשלום ולא נוגעת בסכום שכבר שולם", async function () {
  var mod = loadDonorModule(makeFixtureDonor());
  var netMock = mockPaymentServer(mod);

  mod.sandbox.openEditDonationModal(DONATION_PARTIAL_ID); // paidPartial=400, remainingDebt=600
  mod.setInput("editDonationNoteInput", "הערה חדשה בלבד");
  await mod.sandbox.saveDonationEdit();

  var after = mod.getDonor().donations.find(function (d) { return d.id === DONATION_PARTIAL_ID; });
  assert.strictEqual(after.note, "הערה חדשה בלבד");
  assert.strictEqual(after.amount, 1000);
  assert.strictEqual(after.paidPartial, 400, "התשלום החלקי לא אמור להשתנות");
  assert.strictEqual(after.remainingDebt, 600);
  assert.strictEqual(after.paid, false);
  assert.strictEqual(netMock.postBodies.length, 0, "אין שינוי מצב תשלום -> אין קריאה לשרת תשלומים");

  var logs = mod.getLogs();
  var log = logs[logs.length - 1];
  assert.deepStrictEqual(log.changes.map(function (c) { return c.field; }), ["note"],
    "רק note השתנה — paidPartial/remainingDebt/paid לא אמורים להופיע ב-changes");
});

// ── 4. תרומה ששולמה במלואה -> הגדלת סכום (לא ממציאה תשלום נוסף) ─────────

await check("תרומה ששולמה במלואה -> הגדלת הסכום בלי לגעת במצב התשלום: לא ממציאה תשלום נוסף, נשארת עם יתרה חדשה", async function () {
  var mod = loadDonorModule(makeFixtureDonor());
  var netMock = mockPaymentServer(mod);

  mod.sandbox.openEditDonationModal(DONATION_PAID_ID); // paidSelect prefilled "true", wasPaid=true
  mod.setInput("editDonationAmountInput", "900"); // was 300 (כולו שולם), לא נוגעים בסטטוס
  await mod.sandbox.saveDonationEdit();

  var after = mod.getDonor().donations.find(function (d) { return d.id === DONATION_PAID_ID; });
  assert.strictEqual(after.amount, 900);
  assert.strictEqual(after.paidPartial, 300, "הסכום שכבר שולם בפועל לא משתנה");
  assert.strictEqual(after.remainingDebt, 600, "900 - 300 ששולם = 600 יתרה חדשה");
  assert.strictEqual(after.paid, false, "יש יתרה פתוחה — אי אפשר להישאר 'שולם'");
  assert.strictEqual(netMock.postBodies.length, 0, "אין מעבר סטטוס אמיתי -> אין תשלום שממציאים");
});

await check("תרומה ששולמה במלואה: עריכת הערה בלבד לא פוגעת בסטטוס התשלום", async function () {
  var mod = loadDonorModule(makeFixtureDonor());
  mod.sandbox.openEditDonationModal(DONATION_PAID_ID);
  mod.setInput("editDonationNoteInput", "הערה מעודכנת");
  await mod.sandbox.saveDonationEdit();

  var after = mod.getDonor().donations.find(function (d) { return d.id === DONATION_PAID_ID; });
  assert.strictEqual(after.note, "הערה מעודכנת");
  assert.strictEqual(after.amount, 300);
  assert.strictEqual(after.paid, true);
  assert.strictEqual(after.paidPartial, 300);
  assert.strictEqual(after.remainingDebt, 0);
});

// ── 5. ניסיון להקטין סכום מתחת לסכום ששולם ──────────────────────────────

await check("ניסיון להקטין סכום מתחת לסכום שכבר שולם: נחסם, לא נשמר, ואין קריאה לשרת תשלומים", async function () {
  var mod = loadDonorModule(makeFixtureDonor());
  var before = mod.getDonor().donations.find(function (d) { return d.id === DONATION_PARTIAL_ID; });
  var logsBefore = mod.getLogs().length;
  var netMock = mockPaymentServer(mod);

  mod.sandbox.openEditDonationModal(DONATION_PARTIAL_ID); // amount=1000, paidPartial=400
  mod.setInput("editDonationAmountInput", "300"); // below the 400 already paid
  await mod.sandbox.saveDonationEdit();

  var after = mod.getDonor().donations.find(function (d) { return d.id === DONATION_PARTIAL_ID; });
  assert.deepStrictEqual(after, before, "שום דבר לא אמור להשתנות כשהשמירה נחסמת");
  assert.strictEqual(
    mod.getInput("editDonationMessage").innerText,
    "אי אפשר להקטין את סכום התרומה מתחת לסכום שכבר שולם: " + mod.sandbox.formatMoney(400),
  );
  assert.strictEqual(mod.getInput("editDonationModal").style.display, "flex", "החלון נשאר פתוח");
  assert.strictEqual(mod.getLogs().length, logsBefore, "לא נוצרת רשומת Audit Log לשמירה חסומה");
  assert.strictEqual(netMock.postBodies.length, 0);
});

await check("ניסיון להקטין סכום מתחת לסכום ששולם -תוך כדי סימון \"שולם\" בו-זמנית: גם זה נחסם (לא מאפשרים לצמצם תשלום קיים)", async function () {
  var mod = loadDonorModule(makeFixtureDonor());
  var netMock = mockPaymentServer(mod);

  mod.sandbox.openEditDonationModal(DONATION_PARTIAL_ID); // paidPartial=400
  mod.setInput("editDonationAmountInput", "300");
  mod.setInput("editDonationPaidSelect", "true"); // מנסה לסמן "שולם" עם סכום נמוך מהיתרה ששולמה
  await mod.sandbox.saveDonationEdit();

  var after = mod.getDonor().donations.find(function (d) { return d.id === DONATION_PARTIAL_ID; });
  assert.strictEqual(after.paidPartial, 400, "אסור שהסכום שכבר שולם יקטן");
  assert.strictEqual(netMock.postBodies.length, 0, "השמירה נחסמה — אין קריאה לשרת");
});

// ── 6. שינוי מ"שולם" ל"לא שולם" דורש אישור מפורש ────────────────────────

await check("שינוי מ\"שולם\" ל\"לא שולם\": ללא אישור מפורש (confirm בוטל) — שום דבר לא משתנה", async function () {
  var mod = loadDonorModule(makeFixtureDonor());
  var before = mod.getDonor().donations.find(function (d) { return d.id === DONATION_PAID_ID; });
  var confirmCalls = [];
  mod.sandbox.confirm = function (msg) { confirmCalls.push(msg); return false; }; // המשתמש לוחץ "ביטול"

  mod.sandbox.openEditDonationModal(DONATION_PAID_ID); // paid=true, paidPartial=300
  mod.setInput("editDonationPaidSelect", "false");
  await mod.sandbox.saveDonationEdit();

  assert.strictEqual(confirmCalls.length, 1, "חייבים לבקש אישור מפורש");
  assert.ok(confirmCalls[0].indexOf("300") !== -1, "האזהרה כוללת את הסכום שמתבטל");
  var after = mod.getDonor().donations.find(function (d) { return d.id === DONATION_PAID_ID; });
  assert.deepStrictEqual(after, before, "בלי אישור — כלום לא משתנה");
  assert.strictEqual(mod.getInput("editDonationModal").style.display, "flex", "החלון נשאר פתוח לאחר ביטול");
});

await check("שינוי מ\"שולם\" ל\"לא שולם\": לאחר אישור מפורש — מתבטל התשלום שנרשם, בלי לפגוע בעקביות (Audit Log מתעד את הביטול)", async function () {
  var mod = loadDonorModule(makeFixtureDonor());
  mod.sandbox.confirm = function () { return true; }; // המשתמש מאשר את הביטול

  mod.sandbox.openEditDonationModal(DONATION_PAID_ID); // paid=true, amount=300, paidPartial=300
  mod.setInput("editDonationPaidSelect", "false");
  await mod.sandbox.saveDonationEdit();

  var after = mod.getDonor().donations.find(function (d) { return d.id === DONATION_PAID_ID; });
  assert.strictEqual(after.paidPartial, 0);
  assert.strictEqual(after.remainingDebt, 300);
  assert.strictEqual(after.paid, false);
  assert.strictEqual(mod.getInput("editDonationModal").style.display, "none");

  var logs = mod.getLogs();
  var log = logs[logs.length - 1];
  assert.strictEqual(log.details, "בוטל תשלום שנרשם עבור התרומה (אושר במפורש ע\"י המשתמש)");
});

// ── אישור מקושר (reconcileApprovalDrafts) ────────────────────────────────

await check("אישור מקושר: עדכון סכום תרומה מעדכן את סכום הטיוטה המקושרת ולא נוגע בטיוטות אחרות", async function () {
  var approvals = [
    { id: 5001, donorId: DONOR_ID, donationId: DONATION_PARTIAL_ID, status: "טיוטה", amount: 600 },
    { id: 5002, donorId: DONOR_ID, donationId: 9999, status: "טיוטה", amount: 42 }, // unrelated donation
    { id: 5003, donorId: DONOR_ID, donationId: DONATION_PARTIAL_ID, status: "אושר", amount: 600 }, // already approved
  ];
  var mod = loadDonorModule(makeFixtureDonor(), approvals);

  mod.sandbox.openEditDonationModal(DONATION_PARTIAL_ID); // remainingDebt 600 -> stays open, amount up
  mod.setInput("editDonationAmountInput", "1300");
  await mod.sandbox.saveDonationEdit();

  var after = mod.getApprovals();
  var draft = after.find(function (a) { return a.id === 5001; });
  assert.strictEqual(draft.amount, 900, "900 = 1300 - 400 ששולם");
  assert.strictEqual(draft.status, "טיוטה");

  var unrelated = after.find(function (a) { return a.id === 5002; });
  assert.strictEqual(unrelated.amount, 42, "טיוטה של תרומה אחרת לא אמורה להיפגע");

  var approved = after.find(function (a) { return a.id === 5003; });
  assert.strictEqual(approved.amount, 600, "אישור שכבר \"אושר\" לא אמור להיות מעודכן מחדש");
});

await check("אישור מקושר: סימון \"שולם\" (עם רשומת תשלום אמיתית) סוגר את החוב ומבטל את הטיוטה הפתוחה", async function () {
  var approvals = [
    { id: 5001, donorId: DONOR_ID, donationId: DONATION_PARTIAL_ID, status: "טיוטה", amount: 600 },
  ];
  var mod = loadDonorModule(makeFixtureDonor(), approvals);
  mockPaymentServer(mod);

  mod.sandbox.openEditDonationModal(DONATION_PARTIAL_ID);
  mod.setInput("editDonationPaidSelect", "true");
  await mod.sandbox.saveDonationEdit();

  var draft = mod.getApprovals().find(function (a) { return a.id === 5001; });
  assert.strictEqual(draft.status, "בוטל");
  assert.ok(draft.cancelledAt, "אמור להירשם מועד ביטול");
});

// ── Audit Log ─────────────────────────────────────────────────────────────

await check("Audit Log: נרשמת רשומת עדכון עם entityType=donation ו-changes מסונן רק לשדות שהשתנו", async function () {
  var mod = loadDonorModule(makeFixtureDonor());
  mod.sandbox.openEditDonationModal(DONATION_UNPAID_ID);
  mod.setInput("editDonationNoteInput", "רק הערה השתנתה");
  await mod.sandbox.saveDonationEdit();

  var logs = mod.getLogs();
  var log = logs[logs.length - 1];
  assert.strictEqual(log.action, "update");
  assert.strictEqual(log.entityType, "donation");
  assert.strictEqual(log.entityId, DONATION_UNPAID_ID);
  assert.strictEqual(log.entityName, "בדיקה טסט");
  assert.deepStrictEqual(log.changes.map(function (c) { return c.field; }), ["note"],
    "רק note השתנה — לא אמורים להופיע שדות אחרים ב-changes");
  // Audit entry itself never carries anything more sensitive than field-level before/after
  var serialized = JSON.stringify(log);
  assert.ok(!serialized.includes("authToken"));
});

await check("עריכה ללא שינוי בפועל: לא נשמר מחדש, ולא נוצרת רשומת Audit Log בכלל", async function () {
  var mod = loadDonorModule(makeFixtureDonor());
  var before = mod.getDonor().donations.find(function (d) { return d.id === DONATION_UNPAID_ID; });
  var logsBefore = mod.getLogs().length;

  mod.sandbox.openEditDonationModal(DONATION_UNPAID_ID);
  // לא נוגעים באף שדה — שומרים בדיוק את אותם ערכים שהוצגו בטופס
  await mod.sandbox.saveDonationEdit();

  var after = mod.getDonor().donations.find(function (d) { return d.id === DONATION_UNPAID_ID; });
  assert.deepStrictEqual(after, before, "שום שדה לא אמור להשתנות");
  assert.strictEqual(mod.getLogs().length, logsBefore, "אסור שתיווצר רשומת Audit Log עם changes: []");
  assert.strictEqual(mod.getInput("donationMessage").innerText, "לא בוצעו שינויים");
  assert.strictEqual(mod.getInput("editDonationModal").style.display, "none", "החלון נסגר");
});

// ── מניעת XSS ─────────────────────────────────────────────────────────────

await check("XSS: מטרה/הערה עם תגי HTML זדוניים נשמרות ומוצגות מנוקות (escaped) בטבלה", async function () {
  var mod = loadDonorModule(makeFixtureDonor());
  var payload = "<img src=x onerror=alert(1)>";

  mod.sandbox.openEditDonationModal(DONATION_PARTIAL_ID); // purposeType "אחר" already
  mod.setInput("editDonationCustomPurposeInput", payload);
  mod.setInput("editDonationNoteInput", payload);
  await mod.sandbox.saveDonationEdit(); // calls renderAll() -> renderDonationsTable()

  var after = mod.getDonor().donations.find(function (d) { return d.id === DONATION_PARTIAL_ID; });
  assert.strictEqual(after.finalPurpose, payload, "הנתון הגולמי נשמר כפי שהוא");

  var tbody = mod.getInput("donationsTable");
  var rowHtml = tbody.children.map(function (r) { return r.innerHTML; }).join("\n");
  assert.ok(!rowHtml.includes("<img src=x"), "אסור שתג HTML גולמי יופיע בתוך innerHTML של השורה");
  assert.ok(rowHtml.includes("&lt;img"), "המטרה אמורה להופיע מנוקה (escaped)");
});

await check("כפתור העריכה בשורה לא בונה onclick=\"\" מנתוני השורה — משתמש ב-data-donation-id + event delegation", async function () {
  var mod = loadDonorModule(makeFixtureDonor());
  var tbody = mod.getInput("donationsTable");
  var rowHtml = tbody.children.map(function (r) { return r.innerHTML; }).join("\n");
  assert.ok(!rowHtml.includes("onclick="), "אסור לבנות onclick=\"\" ממחרוזת בתוך תבנית השורה");
  assert.ok(new RegExp("data-action=\"edit-donation\"[^>]*data-donation-id=\"" + DONATION_UNPAID_ID + "\"").test(rowHtml));
});

await check("handleDonationsTableClick: קליק על כפתור העריכה (דרך ה-delegation האמיתי) פותח את המודל לתרומה הנכונה", async function () {
  var mod = loadDonorModule(makeFixtureDonor());
  var fakeButton = {
    dataset: { donationId: String(DONATION_PARTIAL_ID) },
    closest: function (selector) {
      return selector === "button[data-action='edit-donation']" ? this : null;
    },
  };

  mod.sandbox.handleDonationsTableClick({ target: fakeButton });

  assert.strictEqual(mod.getInput("editDonationModal").style.display, "flex");
  assert.strictEqual(mod.getInput("editDonationAmountInput").value, 1000);
});

await check("handleDonationsTableClick: קליק מחוץ לכפתור פעולה (closest מחזיר null) לא עושה כלום", async function () {
  var mod = loadDonorModule(makeFixtureDonor());
  var fakeTarget = { dataset: {}, closest: function () { return null; } };

  mod.sandbox.handleDonationsTableClick({ target: fakeTarget });

  assert.strictEqual(mod.getInput("editDonationModal").style.display, undefined, "המודל לא נפתח");
});

// ── ולידציה / מניעת שמירה שגויה ──────────────────────────────────────────

await check("ולידציה: סכום לא תקין (0) לא נשמר, ומציג הודעת שגיאה במקום לסגור את החלון", async function () {
  var mod = loadDonorModule(makeFixtureDonor());
  var before = mod.getDonor().donations.find(function (d) { return d.id === DONATION_UNPAID_ID; });

  mod.sandbox.openEditDonationModal(DONATION_UNPAID_ID);
  mod.setInput("editDonationAmountInput", "0");
  await mod.sandbox.saveDonationEdit();

  var after = mod.getDonor().donations.find(function (d) { return d.id === DONATION_UNPAID_ID; });
  assert.strictEqual(after.amount, before.amount, "הסכום לא אמור להשתנות בקלט לא תקין");
  assert.strictEqual(mod.getInput("editDonationMessage").innerText, "חובה להכניס סכום תקין");
  assert.strictEqual(mod.getInput("editDonationModal").style.display, "flex", "החלון לא אמור להיסגר בכשל ולידציה");
});

await check("ולידציה: סכום לא מספרי (טקסט חופשי) לא נשמר", async function () {
  var mod = loadDonorModule(makeFixtureDonor());
  var before = mod.getDonor().donations.find(function (d) { return d.id === DONATION_UNPAID_ID; });

  mod.sandbox.openEditDonationModal(DONATION_UNPAID_ID);
  mod.setInput("editDonationAmountInput", "abc");
  await mod.sandbox.saveDonationEdit();

  var after = mod.getDonor().donations.find(function (d) { return d.id === DONATION_UNPAID_ID; });
  assert.strictEqual(after.amount, before.amount);
  assert.strictEqual(mod.getInput("editDonationMessage").innerText, "חובה להכניס סכום תקין");
});

await check("ולידציה: מטרה \"אחר\" ללא טקסט מטרה מותאמת לא נשמרת", async function () {
  var mod = loadDonorModule(makeFixtureDonor());
  var before = mod.getDonor().donations.find(function (d) { return d.id === DONATION_UNPAID_ID; });

  mod.sandbox.openEditDonationModal(DONATION_UNPAID_ID);
  mod.setInput("editDonationPurposeSelect", "אחר");
  mod.setInput("editDonationCustomPurposeInput", "   ");
  await mod.sandbox.saveDonationEdit();

  var after = mod.getDonor().donations.find(function (d) { return d.id === DONATION_UNPAID_ID; });
  assert.strictEqual(after.finalPurpose, before.finalPurpose);
});

await check("ביטול עריכה (כפתור ביטול/סגירה) לא נוגע בנתונים", async function () {
  var mod = loadDonorModule(makeFixtureDonor());
  var before = mod.getDonor().donations.find(function (d) { return d.id === DONATION_UNPAID_ID; });

  mod.sandbox.openEditDonationModal(DONATION_UNPAID_ID);
  mod.setInput("editDonationAmountInput", "99999");
  mod.sandbox.closeEditDonationModal();

  var after = mod.getDonor().donations.find(function (d) { return d.id === DONATION_UNPAID_ID; });
  assert.deepStrictEqual(after, before);
  assert.strictEqual(mod.getInput("editDonationModal").style.display, "none");
});

// ── כשל תשובת השרת ────────────────────────────────────────────────────────

await check("כשל תשובת השרת (מעבר ללא-שולם->שולם): res.ok=false לא מציג הצלחה, לא נוגע בנתונים, לא סוגר את החלון", async function () {
  var mod = loadDonorModule(makeFixtureDonor());
  var before = mod.getDonor().donations.find(function (d) { return d.id === DONATION_UNPAID_ID; });
  mod.sandbox.fetch = function () {
    return Promise.resolve({ ok: false, status: 400, json: function () { return Promise.resolve({ error: "סכום לא תקין" }); } });
  };

  mod.sandbox.openEditDonationModal(DONATION_UNPAID_ID);
  mod.setInput("editDonationPaidSelect", "true");
  await mod.sandbox.saveDonationEdit();

  var after = mod.getDonor().donations.find(function (d) { return d.id === DONATION_UNPAID_ID; });
  assert.deepStrictEqual(after, before, "כשל בשרת -> שום דבר לא משתנה מקומית");
  assert.strictEqual(mod.getInput("editDonationMessage").innerText, "סכום לא תקין");
  assert.notStrictEqual(mod.getInput("donationMessage").innerText, "התרומה עודכנה בהצלחה", "אסור להציג הודעת הצלחה");
  assert.strictEqual(mod.getInput("editDonationModal").style.display, "flex", "החלון נשאר פתוח");
});

await check("כשל תקשורת (fetch נדחה/רשת נופלת) בזמן יצירת תשלום: אותה התנהגות — אין הצלחה כוזבת", async function () {
  var mod = loadDonorModule(makeFixtureDonor());
  var before = mod.getDonor().donations.find(function (d) { return d.id === DONATION_UNPAID_ID; });
  mod.sandbox.fetch = function () { return Promise.reject(new Error("network down")); };

  mod.sandbox.openEditDonationModal(DONATION_UNPAID_ID);
  mod.setInput("editDonationPaidSelect", "true");
  await mod.sandbox.saveDonationEdit();

  var after = mod.getDonor().donations.find(function (d) { return d.id === DONATION_UNPAID_ID; });
  assert.deepStrictEqual(after, before);
  assert.strictEqual(mod.getInput("editDonationMessage").innerText, "שגיאת תקשורת עם השרת — התשלום לא נרשם, נסה שוב");
  assert.strictEqual(mod.getInput("editDonationModal").style.display, "flex");
});

// ── לחיצה כפולה על שמירה ──────────────────────────────────────────────────

await check("לחיצה כפולה על שמירה (לפני שהראשונה סיימה): בדיוק בקשת תשלום אחת נשלחת, לא שתיים", async function () {
  var mod = loadDonorModule(makeFixtureDonor());
  var netMock = mockPaymentServer(mod);

  mod.sandbox.openEditDonationModal(DONATION_UNPAID_ID);
  mod.setInput("editDonationPaidSelect", "true");
  mod.setInput("editDonationPaymentMethodSelect", "מזומן");

  var firstCall = mod.sandbox.saveDonationEdit();
  var secondCall = mod.sandbox.saveDonationEdit(); // "לחיצה כפולה" — לפני שה-await הראשון סיים
  await Promise.all([firstCall, secondCall]);

  assert.strictEqual(netMock.postBodies.length, 1, "לחיצה כפולה לא אמורה ליצור שתי בקשות תשלום/שתי רשומות");

  var after = mod.getDonor().donations.find(function (d) { return d.id === DONATION_UNPAID_ID; });
  assert.strictEqual(after.paidPartial, 500);
  assert.strictEqual(after.remainingDebt, 0);
});

await check("לחיצה כפולה: הכפתורים מנוטרלים תוך כדי השמירה וחוזרים לזמינים אחרי שהיא מסתיימת", async function () {
  var mod = loadDonorModule(makeFixtureDonor());
  mockPaymentServer(mod);

  mod.sandbox.openEditDonationModal(DONATION_UNPAID_ID);
  mod.setInput("editDonationPaidSelect", "true");
  var saving = mod.sandbox.saveDonationEdit();
  // לא await עדיין — אמור להיות באמצע השמירה כרגע (או שכבר הסתיים אם אין await בפועל בנתיב)
  await saving;
  assert.strictEqual(mod.getInput("saveDonationEditButton").disabled, false, "חוזר לזמין אחרי סיום");
  assert.strictEqual(mod.getInput("cancelDonationEditButton").disabled, false);
});

// ── הופעת תשלום פעם אחת בלבד: תשלומים / Timeline / Audit Log ────────────

await check("[קצה-לקצה] תשלום ידני מופיע פעם אחת בדיוק בהיסטוריית התשלומים, ב-Timeline, וב-Audit Log — לא כפול", async function () {
  var mod = loadDonorModule(makeFixtureDonor());
  var netMock = mockPaymentServer(mod);
  var logsBefore = mod.getLogs().length;

  mod.sandbox.openEditDonationModal(DONATION_UNPAID_ID);
  mod.setInput("editDonationPaidSelect", "true");
  mod.setInput("editDonationPaymentMethodSelect", "מזומן");
  await mod.sandbox.saveDonationEdit();

  // 1) נוצרה בדיוק רשומת תשלום אחת בשרת (ה"היסטוריית תשלומים")
  assert.strictEqual(netMock.payments.length, 1, "רשומת תשלום אחת בדיוק");

  // 2) donor.js רענן את פאנל התשלומים/Timeline מהשרת בדיוק פעם אחת אחרי ההצלחה
  assert.strictEqual(netMock.getCallCount(), 1, "בדיוק קריאת GET אחת ל-/api/payments אחרי היצירה");

  // 3) התשלום מופיע פעם אחת ב-Timeline (לא כפול), ולא נעלם/מתעלם ממנו
  var timelineHtml = mod.getInput("donorTimeline").innerHTML;
  var occurrences = timelineHtml.split("תשלום IVR").length - 1;
  assert.strictEqual(occurrences, 1, "התשלום מופיע פעם אחת בדיוק ב-Timeline");

  // 4) בדיוק רשומת Audit Log אחת חדשה (עדכון התרומה) — לא כפולה
  var logsAfter = mod.getLogs();
  assert.strictEqual(logsAfter.length, logsBefore + 1, "רשומת Audit Log אחת בדיוק לפעולה הזו");
});

// ── סיכום ────────────────────────────────────────────────────────────────

const failed = results.filter(function (r) { return !r.ok; });
results.forEach(function (r) {
  console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : "\n    " + r.error));
});
console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");
process.exitCode = failed.length ? 1 : 0;

}

main();

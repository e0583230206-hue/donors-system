// donor-phone-duplicate-warning.test.js — proves the manual donor
// create/edit duplicate-phone check (decision D.1 of the post-audit plan):
//   - checked against EVERY phone field of every other donor (phone/
//     phone2/phone3/phone4/phones[]/ivrApprovedPhones[]), not just the
//     primary phone — matching how Excel-import matching already works
//     (donorAllPhones() in donors.js) and how the rest of the app already
//     treats those fields as valid identifying numbers.
//   - WARNS (via confirm()) rather than blocks: cancelling the confirm
//     leaves the donor unsaved and untouched; accepting it proceeds with
//     the save exactly as if no duplicate existed.
//   - never merges donors, never mutates the OTHER donor(s) that matched.
//
// Loads the real donor.js / donors.js source into a Node vm context with a
// minimal DOM/localStorage/fetch stub, same technique as
// donation-edit-ui.test.js, and drives the real shipped functions directly.
//
// הרצה: node frontend/backend/donor-phone-duplicate-warning.test.js

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const JS_DIR = path.join(__dirname, "..", "js");
function readSrc(name) { return fs.readFileSync(path.join(JS_DIR, name), "utf8"); }

const UTILS_SRC    = readSrc("utils.js");
const DATABASE_SRC = readSrc("database.js");
const AUDIT_LOG_SRC = readSrc("audit-log.js");

function toPlain(x) { return JSON.parse(JSON.stringify(x)); }

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
    id: id || "", value: "", innerText: "", innerHTML: "", textContent: "", className: "",
    style: {}, disabled: false, children: [], options: [],
    classList: {
      _set: new Set(),
      add: function (c) { this._set.add(c); }, remove: function (c) { this._set.delete(c); },
      contains: function (c) { return this._set.has(c); }, toggle: function (c) { if (this._set.has(c)) this._set.delete(c); else this._set.add(c); },
    },
    addEventListener: function (evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); },
    removeEventListener: function () {},
    appendChild: function (child) { this.children.push(child); },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    focus: function () {}, setAttribute: function () {}, getAttribute: function () { return null; },
    click: function () { (listeners.click || []).forEach(function (f) { f({ target: el }); }); },
  };
  return el;
}

function buildSandbox(locationSuffix) {
  var registry = {};
  var documentStub = {
    getElementById: function (id) { if (!registry[id]) registry[id] = makeElement(id); return registry[id]; },
    createElement: function () { return makeElement(null); },
    querySelectorAll: function () { return []; },
    addEventListener: function () {},
    body: makeElement("body"),
  };

  var confirmQueue = [];
  var confirmCalls = [];

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
    confirm: function (msg) {
      confirmCalls.push(msg);
      return confirmQueue.length ? confirmQueue.shift() : false;
    },
    isAdmin: function () { return true; },
    addEventListener: function () {},
    fetch: function (url) { return Promise.reject(new Error("network disabled in tests: " + url)); },
  };
  sandbox.apiFetch = function (url, options) { return sandbox.fetch(url, options); };
  sandbox.window = sandbox;
  sandbox.location = { href: "http://localhost/frontend/" + locationSuffix, search: "" };
  sandbox.window.location = sandbox.location;

  vm.createContext(sandbox);
  return {
    sandbox: sandbox,
    documentStub: documentStub,
    queueConfirm: function (result) { confirmQueue.push(result); },
    getConfirmCalls: function () { return confirmCalls; },
    setInput: function (id, value) { documentStub.getElementById(id).value = value; },
  };
}

const results = [];

// ── Section A: donor.html / donor.js — saveDonorEdit() ─────────────────────

function loadDonorEditModule(allDonors, editingDonorId) {
  var built = buildSandbox("donor.html?id=" + editingDonorId);
  var sandbox = built.sandbox;
  sandbox.location.search = "?id=" + editingDonorId;
  built.sandbox.localStorage.setItem("donors", JSON.stringify(allDonors));

  vm.runInContext(UTILS_SRC, sandbox, { filename: "utils.js" });
  vm.runInContext(DATABASE_SRC, sandbox, { filename: "database.js" });
  vm.runInContext(AUDIT_LOG_SRC, sandbox, { filename: "audit-log.js" });
  vm.runInContext(readSrc("donor.js"), sandbox, { filename: "donor.js" });
  vm.runInContext("var __Database = Database;", sandbox);

  return {
    sandbox: sandbox,
    built: built,
    getDonors: function () { return toPlain(sandbox.__Database.get("donors")); },
  };
}

// ── Section B: donors.html / donors.js — addDonor() ─────────────────────────

function loadDonorsListModule(allDonors) {
  var built = buildSandbox("donors.html");
  var sandbox = built.sandbox;
  built.sandbox.localStorage.setItem("donors", JSON.stringify(allDonors));

  vm.runInContext(UTILS_SRC, sandbox, { filename: "utils.js" });
  vm.runInContext(DATABASE_SRC, sandbox, { filename: "database.js" });
  vm.runInContext(AUDIT_LOG_SRC, sandbox, { filename: "audit-log.js" });
  vm.runInContext(readSrc("donors.js"), sandbox, { filename: "donors.js" });
  vm.runInContext("var __Database = Database;", sandbox);

  return {
    sandbox: sandbox,
    built: built,
    getDonors: function () { return toPlain(sandbox.__Database.get("donors")); },
  };
}

// ── run ──────────────────────────────────────────────────────────────────

async function main() {
  var checks = [];
  function asyncCheck(name, fn) {
    checks.push(
      Promise.resolve()
        .then(fn)
        .then(function () { results.push({ name: name, ok: true }); })
        .catch(function (err) { results.push({ name: name, ok: false, error: err.stack || err.message }); })
    );
  }

  // Section A
  (function () {
    var editedId = 1, otherId = 2;
    var baseDonors = [
      { id: editedId, fullName: "תורם נערך", phone: "0501111111", city: "", address: "", status: "פעיל", notes: "", tags: [], donations: [] },
      { id: otherId,  fullName: "תורם אחר",  phone: "0509999999", phone2: "0502222222", city: "", address: "", status: "פעיל", notes: "", tags: [], donations: [] },
    ];

    asyncCheck("saveDonorEdit: שינוי לטלפון שכבר קיים כ-phone2 אצל תורם אחר -> confirm() נקרא, ביטול -> לא נשמר", function () {
      var mod = loadDonorEditModule(JSON.parse(JSON.stringify(baseDonors)), editedId);
      mod.built.setInput("editFullNameInput", "תורם נערך");
      mod.built.setInput("editPhoneInput", "0502222222");
      mod.built.setInput("editCityInput", ""); mod.built.setInput("editAddressInput", "");
      mod.built.setInput("editStatusSelect", "פעיל"); mod.built.setInput("editNotesInput", "");
      mod.built.queueConfirm(false);
      return vm.runInContext("saveDonorEdit()", mod.sandbox).then(function () {
        var calls = mod.built.getConfirmCalls();
        assert.strictEqual(calls.length, 1);
        assert.ok(calls[0].indexOf("תורם אחר") !== -1, calls[0]);
        var edited = mod.getDonors().find(function (d) { return d.id === editedId; });
        assert.strictEqual(edited.phone, "0501111111");
      });
    });

    asyncCheck("saveDonorEdit: אישור מפורש על אף האזהרה -> נשמר, שום מיזוג/שינוי בתורם האחר", function () {
      var mod = loadDonorEditModule(JSON.parse(JSON.stringify(baseDonors)), editedId);
      mod.built.setInput("editFullNameInput", "תורם נערך");
      mod.built.setInput("editPhoneInput", "0502222222");
      mod.built.setInput("editCityInput", ""); mod.built.setInput("editAddressInput", "");
      mod.built.setInput("editStatusSelect", "פעיל"); mod.built.setInput("editNotesInput", "");
      mod.built.queueConfirm(true);
      return vm.runInContext("saveDonorEdit()", mod.sandbox).then(function () {
        var donorsAfter = mod.getDonors();
        var edited = donorsAfter.find(function (d) { return d.id === editedId; });
        var other  = donorsAfter.find(function (d) { return d.id === otherId; });
        assert.strictEqual(edited.phone, "0502222222");
        assert.strictEqual(other.phone, "0509999999");
        assert.strictEqual(other.phone2, "0502222222");
        assert.strictEqual(donorsAfter.length, 2);
      });
    });

    asyncCheck("saveDonorEdit: טלפון שאינו כפול -> אין קריאה ל-confirm(), נשמר ישירות", function () {
      var mod = loadDonorEditModule(JSON.parse(JSON.stringify(baseDonors)), editedId);
      mod.built.setInput("editFullNameInput", "תורם נערך");
      mod.built.setInput("editPhoneInput", "0505555555");
      mod.built.setInput("editCityInput", ""); mod.built.setInput("editAddressInput", "");
      mod.built.setInput("editStatusSelect", "פעיל"); mod.built.setInput("editNotesInput", "");
      return vm.runInContext("saveDonorEdit()", mod.sandbox).then(function () {
        assert.strictEqual(mod.built.getConfirmCalls().length, 0);
        assert.strictEqual(mod.getDonors().find(function (d) { return d.id === editedId; }).phone, "0505555555");
      });
    });
  })();

  // Section B
  (function () {
    var existingId = 10;
    var baseDonors = [
      { id: existingId, fullName: "תורם קיים", phone: "0501112222", ivrApprovedPhones: ["0503334444"], city: "", address: "", status: "פעיל", notes: "", donations: [] },
    ];

    asyncCheck("addDonor: מספר שכבר קיים כ-ivrApprovedPhones -> confirm() נקרא, ביטול -> לא נוצר תורם", function () {
      var mod = loadDonorsListModule(JSON.parse(JSON.stringify(baseDonors)));
      mod.built.setInput("nameInput", "תורם חדש"); mod.built.setInput("phoneInput", "0503334444");
      mod.built.setInput("cityInput", ""); mod.built.setInput("addressInput", ""); mod.built.setInput("notesInput", "");
      mod.built.queueConfirm(false);
      return vm.runInContext("addDonor()", mod.sandbox).then(function () {
        var calls = mod.built.getConfirmCalls();
        assert.strictEqual(calls.length, 1);
        assert.ok(calls[0].indexOf("תורם קיים") !== -1, calls[0]);
        assert.strictEqual(mod.getDonors().length, 1);
      });
    });

    asyncCheck("addDonor: אישור מפורש -> נוצר תורם שני, הקיים לא השתנה", function () {
      var mod = loadDonorsListModule(JSON.parse(JSON.stringify(baseDonors)));
      mod.built.setInput("nameInput", "תורם חדש"); mod.built.setInput("phoneInput", "0503334444");
      mod.built.setInput("cityInput", ""); mod.built.setInput("addressInput", ""); mod.built.setInput("notesInput", "");
      mod.built.queueConfirm(true);
      return vm.runInContext("addDonor()", mod.sandbox).then(function () {
        var donorsAfter = mod.getDonors();
        assert.strictEqual(donorsAfter.length, 2);
        var existing = donorsAfter.find(function (d) { return d.id === existingId; });
        assert.deepStrictEqual(existing.ivrApprovedPhones, ["0503334444"]);
      });
    });

    asyncCheck("addDonor: מספר שלא קיים בשום מקום -> אין קריאה ל-confirm()", function () {
      var mod = loadDonorsListModule(JSON.parse(JSON.stringify(baseDonors)));
      mod.built.setInput("nameInput", "תורם אחר לגמרי"); mod.built.setInput("phoneInput", "0509990000");
      mod.built.setInput("cityInput", ""); mod.built.setInput("addressInput", ""); mod.built.setInput("notesInput", "");
      return vm.runInContext("addDonor()", mod.sandbox).then(function () {
        assert.strictEqual(mod.built.getConfirmCalls().length, 0);
        assert.strictEqual(mod.getDonors().length, 2);
      });
    });
  })();

  await Promise.all(checks);

  const failed = results.filter(function (r) { return !r.ok; });
  results.forEach(function (r) {
    console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : "\n    " + r.error));
  });
  console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");
  process.exitCode = failed.length ? 1 : 0;
}

main();

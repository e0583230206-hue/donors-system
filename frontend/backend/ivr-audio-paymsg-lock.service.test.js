// ivr-audio-paymsg-lock.service.test.js
// הרצה: node ivr-audio-paymsg-lock.service.test.js

const assert = require("assert");
const { tryLock, unlock, _reset } = require("./ivr-audio-paymsg-lock.service");

const results = [];
function check(name, fn) {
  _reset();
  try {
    fn();
    results.push({ name: name, ok: true });
  } catch (err) {
    results.push({ name: name, ok: false, error: err.message });
  }
}

check("tryLock ראשון על audioId חדש מצליח (true)", function () {
  assert.strictEqual(tryLock("PAYMSG-3000"), true);
});

check("[עומק 409] tryLock שני על אותו audioId בזמן שהראשון עדיין נעול נכשל (false)", function () {
  assert.strictEqual(tryLock("PAYMSG-3000"), true);
  assert.strictEqual(tryLock("PAYMSG-3000"), false);
});

check("tryLock על audioId שונה לא מושפע מנעילה קיימת על audioId אחר", function () {
  assert.strictEqual(tryLock("PAYMSG-3000"), true);
  assert.strictEqual(tryLock("PAYMSG-3001"), true);
});

check("unlock משחרר, ומאפשר tryLock הבא להצליח שוב", function () {
  assert.strictEqual(tryLock("PAYMSG-3000"), true);
  unlock("PAYMSG-3000");
  assert.strictEqual(tryLock("PAYMSG-3000"), true);
});

check("unlock על audioId שלא נעול לא זורק שגיאה", function () {
  assert.doesNotThrow(function () { unlock("PAYMSG-9999"); });
});

check("finally-style שימוש: unlock קורה גם אחרי חריגה בגוף הפעולה", function () {
  var locked = tryLock("PAYMSG-3000");
  assert.strictEqual(locked, true);
  try {
    try {
      throw new Error("סימולציה של כישלון בפעולה");
    } finally {
      unlock("PAYMSG-3000");
    }
  } catch (e) {
    // ignore — expected, only checking that unlock still ran
  }
  assert.strictEqual(tryLock("PAYMSG-3000"), true, "אחרי finally, הנעילה חייבת להיות חופשית");
});

// ── סיכום ────────────────────────────────────────────────────────────────
const failed = results.filter(function (r) { return !r.ok; });
results.forEach(function (r) {
  console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : " — " + r.error));
});
console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");
process.exit(failed.length ? 1 : 0);

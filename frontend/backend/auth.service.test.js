// auth.service.test.js — covers the two things every protected route in the
// app depends on: who is allowed to log in, and whether requireAuth/
// requireRole correctly gate a request. Neither had any test coverage before
// this file (server.js/auth.service.js were the two files handling
// money/PII-adjacent access with zero tests — see production audit).
//
// Uses a TEMPORARY sqlite file (own os.tmpdir() path, set via DB_PATH before
// requiring db.js/auth.service.js) — same pattern as seed-paymsg-audio.test.js
// and seed-ident-audio-based tests. Never opens/touches the real data.sqlite.
//
// הרצה: node auth.service.test.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const bcrypt = require("bcryptjs");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "auth-service-test-"));
process.env.DB_PATH = path.join(tmpRoot, "test.sqlite");
// NODE_ENV must not be "production" here, or auth.service.js's own
// JWT_SECRET placeholder guard would call process.exit(1) since no real
// secret is configured for this throwaway test run.
delete process.env.NODE_ENV;

const db = require("./db"); // opens the temp DB above — never the real one
const auth = require("./auth.service");

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name: name, ok: true });
  } catch (err) {
    results.push({ name: name, ok: false, error: err.stack || err.message });
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    results.push({ name: name, ok: true });
  } catch (err) {
    results.push({ name: name, ok: false, error: err.stack || err.message });
  }
}

check("[בטיחות] הבדיקה פועלת מול DB זמני, לא מול data.sqlite האמיתי", function () {
  assert.ok(db.DB_PATH.indexOf(tmpRoot) === 0, "DB_PATH חייב להיות תחת תיקיית ה-tmp, לא הנתיב האמיתי");
});

function makeMockRes() {
  return {
    statusCode: null,
    body: null,
    status: function (code) { this.statusCode = code; return this; },
    json: function (payload) { this.body = payload; return this; },
  };
}

// ── loginWorker ──────────────────────────────────────────────────────────────

let activeAdminId, inactiveAdminId, noPasswordWorkerId;

(async function setupWorkers() {
  activeAdminId = db.createWorkerInDb("מנהל בדיקה", "מנהל", "פעיל", bcrypt.hashSync("Str0ngPass!", 10));
  db.clearMustChangePassword(activeAdminId); // isolate login tests from the must_change_password flow, tested separately below

  inactiveAdminId = db.createWorkerInDb("מנהל מושבת", "מנהל", "לא פעיל", bcrypt.hashSync("Str0ngPass!", 10));
  db.clearMustChangePassword(inactiveAdminId);

  noPasswordWorkerId = db.createWorkerInDb("עובד בלי סיסמה", "מזכיר", "פעיל", null);
})().then(runAllChecks);

async function runAllChecks() {
  await checkAsync("loginWorker: התחברות מוצלחת עם סיסמה נכונה מחזירה token ותפקיד מנורמל", async function () {
    const result = await auth.loginWorker(activeAdminId, "Str0ngPass!");
    assert.ok(result, "login should succeed");
    assert.strictEqual(typeof result.token, "string");
    assert.strictEqual(result.user.role, auth.ROLES.ADMIN);
    assert.strictEqual(result.mustChangePassword, false);
  });

  await checkAsync("loginWorker: סיסמה שגויה -> null (לא token)", async function () {
    const result = await auth.loginWorker(activeAdminId, "wrong-password");
    assert.strictEqual(result, null);
  });

  await checkAsync("loginWorker: עובד לא קיים -> null", async function () {
    const result = await auth.loginWorker(999999, "anything");
    assert.strictEqual(result, null);
  });

  await checkAsync("loginWorker: עובד מושבת (status != 'פעיל') -> null גם עם סיסמה נכונה", async function () {
    const result = await auth.loginWorker(inactiveAdminId, "Str0ngPass!");
    assert.strictEqual(result, null);
  });

  await checkAsync("loginWorker: עובד בלי passwordHash בכלל -> null, לא זורק שגיאה", async function () {
    const result = await auth.loginWorker(noPasswordWorkerId, "anything");
    assert.strictEqual(result, null);
  });

  await checkAsync("loginWorker: התחברות כשמור must_change_password=1 -> mustChangePassword:true בתשובה", async function () {
    const id = db.createWorkerInDb("עובד חדש", "מזכיר", "פעיל", bcrypt.hashSync("Temp1234!", 10));
    const result = await auth.loginWorker(id, "Temp1234!");
    assert.strictEqual(result.mustChangePassword, true);
  });

  // ── normalizeRole ────────────────────────────────────────────────────────

  check("normalizeRole: תפקידים בעברית ובאנגלית ממופים נכון", function () {
    assert.strictEqual(auth.normalizeRole("מנהל"), auth.ROLES.ADMIN);
    assert.strictEqual(auth.normalizeRole("מזכיר"), auth.ROLES.SECRETARY);
    assert.strictEqual(auth.normalizeRole("ADMIN"), auth.ROLES.ADMIN);
    assert.strictEqual(auth.normalizeRole("secretary"), auth.ROLES.SECRETARY);
    assert.strictEqual(auth.normalizeRole("ivr"), auth.ROLES.IVR_SYSTEM);
    assert.strictEqual(auth.normalizeRole("משהו לא מוכר"), "");
    assert.strictEqual(auth.normalizeRole(""), "");
  });

  // ── requireAuth ──────────────────────────────────────────────────────────

  check("requireAuth: בקשה בלי כותרת Authorization -> 401, next() לא נקרא", function () {
    const req = { headers: {}, path: "/api/whatever" };
    const res = makeMockRes();
    let nextCalled = false;
    auth.requireAuth(req, res, function () { nextCalled = true; });
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(nextCalled, false);
  });

  check("requireAuth: token לא תקין -> 401", function () {
    const req = { headers: { authorization: "Bearer garbage-token" }, path: "/api/whatever" };
    const res = makeMockRes();
    let nextCalled = false;
    auth.requireAuth(req, res, function () { nextCalled = true; });
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(nextCalled, false);
  });

  await checkAsync("requireAuth: token תקין + must_change_password=0 -> next() נקרא, req.user מאוכלס", async function () {
    const login = await auth.loginWorker(activeAdminId, "Str0ngPass!");
    const req = { headers: { authorization: "Bearer " + login.token }, path: "/api/workers" };
    const res = makeMockRes();
    let nextCalled = false;
    auth.requireAuth(req, res, function () { nextCalled = true; });
    assert.strictEqual(nextCalled, true);
    assert.strictEqual(req.userRole, auth.ROLES.ADMIN);
    assert.strictEqual(req.user.id, activeAdminId);
  });

  await checkAsync("requireAuth: must_change_password=1 חוסם נתיב רגיל עם 403, גם עם token תקין", async function () {
    const id = db.createWorkerInDb("חייב להחליף סיסמה", "מזכיר", "פעיל", bcrypt.hashSync("Temp1234!", 10));
    const login = await auth.loginWorker(id, "Temp1234!");
    const req = { headers: { authorization: "Bearer " + login.token }, path: "/api/donors" };
    const res = makeMockRes();
    let nextCalled = false;
    auth.requireAuth(req, res, function () { nextCalled = true; });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.error, "must_change_password");
    assert.strictEqual(nextCalled, false);
  });

  await checkAsync("requireAuth: must_change_password=1 עדיין מאפשר את נתיב שינוי הסיסמה עצמו", async function () {
    const id = db.createWorkerInDb("חייב להחליף סיסמה 2", "מזכיר", "פעיל", bcrypt.hashSync("Temp1234!", 10));
    const login = await auth.loginWorker(id, "Temp1234!");
    const req = { headers: { authorization: "Bearer " + login.token }, path: "/api/workers/me/password" };
    const res = makeMockRes();
    let nextCalled = false;
    auth.requireAuth(req, res, function () { nextCalled = true; });
    assert.strictEqual(nextCalled, true);
  });

  // ── requireRole ──────────────────────────────────────────────────────────

  await checkAsync("requireRole: תפקיד שאינו ברשימת המורשים -> 403 Forbidden", async function () {
    const secretaryId = db.createWorkerInDb("מזכיר לבדיקת הרשאות", "מזכיר", "פעיל", bcrypt.hashSync("Str0ngPass!", 10));
    db.clearMustChangePassword(secretaryId);
    const login = await auth.loginWorker(secretaryId, "Str0ngPass!");

    const req = { headers: { authorization: "Bearer " + login.token }, path: "/api/workers" };
    const res = makeMockRes();
    let nextCalled = false;
    const middlewares = auth.requireRole([auth.ROLES.ADMIN]); // secretary is NOT admin
    // requireRole returns [requireAuth, roleCheck] — run both in sequence like Express would.
    middlewares[0](req, res, function () {
      middlewares[1](req, res, function () { nextCalled = true; });
    });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(nextCalled, false);
  });

  await checkAsync("requireRole: תפקיד ברשימת המורשים -> next() נקרא, אין תשובת שגיאה", async function () {
    const adminLogin = await auth.loginWorker(activeAdminId, "Str0ngPass!");
    const req = { headers: { authorization: "Bearer " + adminLogin.token }, path: "/api/workers" };
    const res = makeMockRes();
    let nextCalled = false;
    const middlewares = auth.requireRole([auth.ROLES.ADMIN, auth.ROLES.SECRETARY]);
    middlewares[0](req, res, function () {
      middlewares[1](req, res, function () { nextCalled = true; });
    });
    assert.strictEqual(nextCalled, true);
    assert.strictEqual(res.statusCode, null);
  });

  // ── סיכום ────────────────────────────────────────────────────────────────
  const failed = results.filter(function (r) { return !r.ok; });
  results.forEach(function (r) {
    console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : " — " + r.error));
  });
  console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");
  process.exitCode = failed.length ? 1 : 0;
}

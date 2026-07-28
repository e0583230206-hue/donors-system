// session-persistence.test.js — covers the removal of the old 8-hour forced
// logout / "פג תוקף החיבור" message, and the replacement design: a login
// stays valid until explicit logout, admin force-logout, or the worker being
// deleted/disabled — never from elapsed time or a closed browser alone.
//
// Real HTTP-level test against server.js (same pattern as
// server.routes.test.js): require("./server") returns the Express app
// without starting app.listen()/the backup job (require.main !== module),
// so this mounts it on its own ephemeral local port.
//
// Uses a TEMPORARY sqlite file (own os.tmpdir() path) — never opens the real
// data.sqlite. SESSION_ONLINE_THRESHOLD_MS is set to a small value here (via
// env, read once at db.js module-load time) purely so the online/offline
// display flag can be exercised in milliseconds instead of real minutes —
// this has no effect on login validity, only on that one display field.
//
// הרצה: node session-persistence.test.js

const assert = require("assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const jwt = require("jsonwebtoken");
const { DatabaseSync } = require("node:sqlite");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-persistence-test-"));
process.env.DB_PATH = path.join(tmpRoot, "test.sqlite");
process.env.SESSION_ONLINE_THRESHOLD_MS = "800"; // must be set before db.js is required
delete process.env.NODE_ENV;

const app = require("./server");
const db = require("./db");

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name: name, ok: true });
  } catch (err) {
    results.push({ name: name, ok: false, error: err.stack || err.message });
  }
}

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

// Directly backdates a session's timestamps on the temp sqlite file to
// simulate ">8 hours since last activity" / "a day has passed" without
// actually waiting — a second short-lived connection to the same (test-only,
// tmpRoot-scoped) file, closed immediately after the single UPDATE.
function backdateSession(sessionId, isoTimestamp) {
  const raw = new DatabaseSync(db.DB_PATH);
  raw.prepare("UPDATE worker_sessions SET lastHeartbeat = ?, loginAt = ? WHERE sessionId = ?")
    .run(isoTimestamp, isoTimestamp, sessionId);
  raw.close();
}

let server, baseUrl;

async function jsonFetch(method, urlPath, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(baseUrl + urlPath, {
    method: method,
    headers: headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, body: data };
}

async function loginAndActivate(workerId, tempPassword, newPassword) {
  // Fresh workers are seeded with must_change_password=1 — clear it first so
  // the rest of each scenario isn't blocked by an unrelated 403, same as
  // server.routes.test.js.
  const first = await jsonFetch("POST", "/api/login", { workerId: workerId, password: tempPassword });
  await jsonFetch("PUT", "/api/workers/me/password", { newPassword: newPassword }, first.body.token);
  const relogin = await jsonFetch("POST", "/api/login", { workerId: workerId, password: newPassword });
  return relogin.body; // { token, sessionId, user, mustChangePassword }
}

async function main() {
  server = http.createServer(app);
  await new Promise(function (resolve) { server.listen(0, "127.0.0.1", resolve); });
  baseUrl = "http://127.0.0.1:" + server.address().port;

  await check("[בטיחות] הבדיקה פועלת מול DB זמני, לא מול data.sqlite האמיתי", async function () {
    assert.ok(db.DB_PATH.indexOf(tmpRoot) === 0, "DB_PATH חייב להיות תחת תיקיית ה-tmp, לא הנתיב האמיתי");
  });

  // ── Bootstrap: seeded admin (id 1) + a fresh secretary ──────────────────────

  const admin = await loginAndActivate(1, "1234", "AdminStr0ng!");
  const adminToken = admin.token;

  let secretaryId;
  await check("POST /api/workers (מנהל) יוצר מזכיר חדש לבדיקות ה-session", async function () {
    const res = await jsonFetch("POST", "/api/workers", { name: "מזכיר לבדיקת session", role: "מזכיר", password: "Temp1234!" }, adminToken);
    assert.strictEqual(res.status, 201);
    secretaryId = res.body.id;
  });
  const secretary = await loginAndActivate(secretaryId, "Temp1234!", "SecStr0ng!");
  const secretaryToken = secretary.token;
  const secretarySessionId = secretary.sessionId;

  // ── 1) אין תוקף קצוב (8 שעות) על ה-JWT ───────────────────────────────────────

  await check("ל-JWT יש תוקף ארוך ומבוקר (JWT_TTL_DAYS, ברירת מחדל 30 יום) — לא 8 שעות", function () {
    const decoded = jwt.decode(secretaryToken);
    assert.ok(decoded.exp && decoded.iat, "token must carry exp/iat");
    const ttlHours = (decoded.exp - decoded.iat) / 3600;
    assert.ok(ttlHours > 24 * 20, "TTL must be measured in weeks, not hours: got " + ttlHours + "h");
  });

  // ── 2) התחברות, סגירת דפדפן, פתיחה מחדש = פשוט להשתמש שוב באותו טוקן ──────────

  await check("טוקן שנשמר (מדמה localStorage ששרד סגירת דפדפן) ממשיך לעבוד בבקשה חדשה", async function () {
    const res = await jsonFetch("GET", "/api/workers", undefined, secretaryToken);
    assert.strictEqual(res.status, 200);
  });

  // ── 3) הדמיית מעבר של יותר משמונה שעות + רענון עמוד ──────────────────────────

  await check("session שלא היה בו heartbeat מעל 8 שעות: הטוקן עדיין תקף, ה-session עדיין 'active' (לא מתנתק אוטומטית)", async function () {
    const fortyHoursAgo = new Date(Date.now() - 40 * 3600 * 1000).toISOString();
    backdateSession(secretarySessionId, fortyHoursAgo);

    // "page refresh after a long time" — same token, new request
    const res = await jsonFetch("GET", "/api/workers", undefined, secretaryToken);
    assert.strictEqual(res.status, 200, "a long-idle session must not be force-logged-out by elapsed time alone");

    const sessions = await jsonFetch("GET", "/api/admin/sessions", undefined, adminToken);
    const row = sessions.body.active.find(function (s) { return s.sessionId === secretarySessionId; });
    assert.ok(row, "the session must still be listed as logged in (active), not moved to history as timed-out");
    assert.strictEqual(row.status, "active");
  });

  // ── 4) heartbeat + רשימת משתמשים פעילים: online לפי heartbeat אחרון בלבד ──────

  await check("heartbeat: online:true מיד אחרי heartbeat, online:false אחרי שהוא נהיה ישן — בלי לבטל את ההתחברות", async function () {
    const hb = await jsonFetch("POST", "/api/sessions/heartbeat", { sessionId: secretarySessionId }, secretaryToken);
    assert.strictEqual(hb.status, 200);
    assert.strictEqual(hb.body.ok, true);
    assert.ok(hb.body.token, "heartbeat must silently renew the token");

    const soonAfter = await jsonFetch("GET", "/api/admin/sessions", undefined, adminToken);
    const rowOnline = soonAfter.body.active.find(function (s) { return s.sessionId === secretarySessionId; });
    assert.strictEqual(!!rowOnline.online, true, "must show online right after a heartbeat");

    await sleep(1000); // > SESSION_ONLINE_THRESHOLD_MS (800ms, set above only for this test file)

    const later = await jsonFetch("GET", "/api/admin/sessions", undefined, adminToken);
    const rowOffline = later.body.active.find(function (s) { return s.sessionId === secretarySessionId; });
    assert.ok(rowOffline, "must still be logged in (present in the active list) once idle");
    assert.strictEqual(rowOffline.status, "active", "login itself must not be cancelled just because heartbeat went stale");
    assert.strictEqual(!!rowOffline.online, false, "must show offline once the heartbeat is stale");
  });

  // ── 5) חידוש שקט: הטוקן שהתקבל מ-heartbeat ממשיך לעבוד ותפקידים נשמרים ────────

  let renewedSecretaryToken;
  await check("הטוקן המחודש מ-heartbeat תקף ושומר את התפקיד (מזכיר) — לא הופך למנהל ולא מאבד הרשאות", async function () {
    const hb = await jsonFetch("POST", "/api/sessions/heartbeat", { sessionId: secretarySessionId }, secretaryToken);
    renewedSecretaryToken = hb.body.token;

    const asSecretary = await jsonFetch("GET", "/api/workers", undefined, renewedSecretaryToken);
    assert.strictEqual(asSecretary.status, 200, "secretary permissions must still work after renewal");

    const adminOnly = await jsonFetch("POST", "/api/workers", { name: "אמור להיכשל", role: "מזכיר", password: "x1234567" }, renewedSecretaryToken);
    assert.strictEqual(adminOnly.status, 403, "renewed token must not gain admin rights");
  });

  await check("חידוש שקט עבור מנהל: טוקן מחודש עדיין מאפשר פעולות admin-only", async function () {
    // re-activate the admin's own session (id 1 logged in earlier) via heartbeat
    const hb = await jsonFetch("POST", "/api/sessions/heartbeat", { sessionId: admin.sessionId }, adminToken);
    assert.strictEqual(hb.status, 200);
    const renewedAdminToken = hb.body.token;
    const res = await jsonFetch("GET", "/api/admin/sessions", undefined, renewedAdminToken);
    assert.strictEqual(res.status, 200, "renewed admin token must still pass requireRole([ADMIN])");
  });

  // ── 6) יציאה ידנית ────────────────────────────────────────────────────────────

  await check("POST /api/logout: ה-session עובר להיסטוריה עם status='logout' ונעלם מהרשימה הפעילה", async function () {
    const res = await jsonFetch("POST", "/api/logout", { sessionId: secretarySessionId }, renewedSecretaryToken);
    assert.strictEqual(res.status, 200);

    const sessions = await jsonFetch("GET", "/api/admin/sessions", undefined, adminToken);
    const activeRow = sessions.body.active.find(function (s) { return s.sessionId === secretarySessionId; });
    assert.strictEqual(activeRow, undefined, "must no longer appear in the active list after logout");

    const historyRow = sessions.body.history.find(function (s) { return s.sessionId === secretarySessionId; });
    assert.ok(historyRow, "must appear in session history");
    assert.strictEqual(historyRow.status, "logout");
  });

  // ── 7) ניתוק כפוי בידי מנהל ────────────────────────────────────────────────────

  let forcedSecretary, forcedToken, forcedSessionId;
  await check("ניתוק כפוי: לאחר force-logout, ה-heartbeat הבא של המשתמש מחזיר forceLogout:true", async function () {
    const created = await jsonFetch("POST", "/api/workers", { name: "מזכיר לניתוק כפוי", role: "מזכיר", password: "Temp1234!" }, adminToken);
    forcedSecretary = await loginAndActivate(created.body.id, "Temp1234!", "SecStr0ng2!");
    forcedToken = forcedSecretary.token;
    forcedSessionId = forcedSecretary.sessionId;

    // sanity: session must be listed as active and connected long-term (no 8h issue)
    const beforeDisconnect = await jsonFetch("GET", "/api/workers", undefined, forcedToken);
    assert.strictEqual(beforeDisconnect.status, 200);

    const disconnect = await jsonFetch("POST", "/api/admin/sessions/" + forcedSessionId + "/force-logout", undefined, adminToken);
    assert.strictEqual(disconnect.status, 200);

    const hb = await jsonFetch("POST", "/api/sessions/heartbeat", { sessionId: forcedSessionId }, forcedToken);
    assert.strictEqual(hb.status, 200);
    assert.strictEqual(hb.body.forceLogout, true, "the disconnected user must be told to log out on their next heartbeat");

    const sessions = await jsonFetch("GET", "/api/admin/sessions", undefined, adminToken);
    const historyRow = sessions.body.history.find(function (s) { return s.sessionId === forcedSessionId; });
    assert.strictEqual(historyRow.status, "forced_logout");
  });

  // ── 8) משתמש שנמחק ─────────────────────────────────────────────────────────────

  await check("עובד שנמחק לאחר שהתחבר: הטוקן הישן שלו נדחה מיד (401), גם בלי לחכות לתפוגה", async function () {
    const created = await jsonFetch("POST", "/api/workers", { name: "עובד למחיקה", role: "מזכיר", password: "Temp1234!" }, adminToken);
    const doomed = await loginAndActivate(created.body.id, "Temp1234!", "DoomedStr0ng!");

    const before = await jsonFetch("GET", "/api/workers", undefined, doomed.token);
    assert.strictEqual(before.status, 200, "sanity: token works before deletion");

    const del = await jsonFetch("DELETE", "/api/workers/" + created.body.id, undefined, adminToken);
    assert.strictEqual(del.status, 200);

    const after = await jsonFetch("GET", "/api/workers", undefined, doomed.token);
    assert.strictEqual(after.status, 401, "a deleted worker's still-cryptographically-valid token must be rejected");

    const hb = await jsonFetch("POST", "/api/sessions/heartbeat", { sessionId: doomed.sessionId }, doomed.token);
    assert.strictEqual(hb.status, 401, "heartbeat must also reject a deleted worker, not just other routes");
  });

  // ── 9) משתמש שנחסם (status != 'פעיל') ────────────────────────────────────────

  await check("עובד שנחסם (status שונה מ'פעיל') לאחר שהתחבר: הגישה נחסמת מיד, ה-session לא מבוטל אבל הגישה נדחית", async function () {
    const created = await jsonFetch("POST", "/api/workers", { name: "עובד לחסימה", role: "מזכיר", password: "Temp1234!" }, adminToken);
    const blocked = await loginAndActivate(created.body.id, "Temp1234!", "BlockedStr0ng!");

    const before = await jsonFetch("GET", "/api/workers", undefined, blocked.token);
    assert.strictEqual(before.status, 200);

    db.setWorkerStatus(created.body.id, "לא פעיל");

    const after = await jsonFetch("GET", "/api/workers", undefined, blocked.token);
    assert.strictEqual(after.status, 401, "a blocked worker's token must stop working on the very next request");
  });

  // ── 10) גישה ללא token או עם token לא תקין ───────────────────────────────────

  await check("בקשה בלי Authorization header -> 401", async function () {
    const res = await fetch(baseUrl + "/api/workers");
    assert.strictEqual(res.status, 401);
  });

  await check("בקשה עם Bearer token מזויף/לא תקין -> 401", async function () {
    const res = await jsonFetch("GET", "/api/workers", undefined, "not-a-real-jwt-at-all");
    assert.strictEqual(res.status, 401);
  });

  // ── סיכום ────────────────────────────────────────────────────────────────────
  const failed = results.filter(function (r) { return !r.ok; });
  results.forEach(function (r) {
    console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : " — " + r.error));
  });
  console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");

  await new Promise(function (resolve) { server.close(resolve); });
  process.exitCode = failed.length ? 1 : 0;
}

main();

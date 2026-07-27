// server.routes.test.js — REAL HTTP-level test of server.js itself: login,
// must_change_password enforcement, admin/secretary role gating, the
// /api/data/:key save path (validation + optimistic concurrency), and the
// new server_audit_log mirror (data-audit-mirror.service.js) wired into that
// same route. server.js previously had zero tests of any kind (see
// production audit) — this is the first.
//
// Made possible by the require.main === module guard added to server.js:
// requiring it here returns the Express app WITHOUT starting app.listen() on
// the real PORT or running the real backup job (both stay skipped unless
// server.js is run directly as `node server.js`, which is all PM2 ever does
// — see pm2.ecosystem.config.js: script: "server.js"). This test mounts that
// exact app on its own ephemeral local port instead, exactly like the
// existing ivr-audio-paymsg.routes.test.js pattern.
//
// Uses a TEMPORARY sqlite file (own os.tmpdir() path, set via DB_PATH before
// requiring server.js/db.js) — never opens the real data.sqlite. NODE_ENV is
// deliberately left non-production so JWT_SECRET/IVR_KEY fall back to their
// insecure-dev defaults instead of exiting the process.
//
// הרצה: node server.routes.test.js

const assert = require("assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "server-routes-test-"));
process.env.DB_PATH = path.join(tmpRoot, "test.sqlite");
delete process.env.NODE_ENV;

const app = require("./server"); // require.main !== module here -> no app.listen(), no backup job
const db = require("./db");      // same cached module instance server.js itself uses

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name: name, ok: true });
  } catch (err) {
    results.push({ name: name, ok: false, error: err.stack || err.message });
  }
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
  return { status: res.status, headers: res.headers, body: data };
}

async function main() {
  server = http.createServer(app);
  await new Promise(function (resolve) { server.listen(0, "127.0.0.1", resolve); });
  baseUrl = "http://127.0.0.1:" + server.address().port;

  await check("[בטיחות] הבדיקה פועלת מול DB זמני, לא מול data.sqlite האמיתי", async function () {
    assert.ok(db.DB_PATH.indexOf(tmpRoot) === 0, "DB_PATH חייב להיות תחת תיקיית ה-tmp, לא הנתיב האמיתי");
  });

  await check("GET /health -> 200 ok:true", async function () {
    const res = await jsonFetch("GET", "/health");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
  });

  await check("POST /api/login עם workerId חסר -> 400", async function () {
    const res = await jsonFetch("POST", "/api/login", { password: "1234" });
    assert.strictEqual(res.status, 400);
  });

  await check("POST /api/login עם סיסמה שגויה -> 401", async function () {
    const res = await jsonFetch("POST", "/api/login", { workerId: 1, password: "wrong" });
    assert.strictEqual(res.status, 401);
  });

  await check("GET /api/workers בלי Authorization -> 401", async function () {
    const res = await jsonFetch("GET", "/api/workers");
    assert.strictEqual(res.status, 401);
  });

  let adminToken;
  await check("POST /api/login עם ברירת המחדל (1/1234) -> 200, mustChangePassword:true", async function () {
    const res = await jsonFetch("POST", "/api/login", { workerId: 1, password: "1234" });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.mustChangePassword, true);
    assert.strictEqual(res.body.user.role, "ADMIN");
    adminToken = res.body.token;
  });

  await check("GET /api/workers עם must_change_password=1 -> 403 (חסום עד שינוי סיסמה)", async function () {
    const res = await jsonFetch("GET", "/api/workers", undefined, adminToken);
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.error, "must_change_password");
  });

  await check("PUT /api/workers/me/password (נתיב פטור) מצליח גם לפני שינוי סיסמה חובה", async function () {
    const res = await jsonFetch("PUT", "/api/workers/me/password", { newPassword: "NewStr0ngPass!" }, adminToken);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.updated, true);
  });

  await check("אחרי שינוי הסיסמה: GET /api/workers עם אותו טוקן ישן כבר לא חסום על must_change_password", async function () {
    const res = await jsonFetch("GET", "/api/workers", undefined, adminToken);
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body));
  });

  let secretaryId, secretaryToken;
  await check("POST /api/workers (מנהל) יוצר עובד מזכיר חדש", async function () {
    const res = await jsonFetch("POST", "/api/workers", { name: "מזכיר בדיקה", role: "מזכיר", password: "SecretPass1!" }, adminToken);
    assert.strictEqual(res.status, 201);
    secretaryId = res.body.id;
    assert.ok(secretaryId);
  });

  await check("POST /api/workers (מזכיר, לא מנהל) -> 403", async function () {
    const loginRes = await jsonFetch("POST", "/api/login", { workerId: secretaryId, password: "SecretPass1!" });
    // secretary also starts with must_change_password=1 — change it first so later
    // checks in this test aren't blocked by an unrelated 403.
    const tmpToken = loginRes.body.token;
    await jsonFetch("PUT", "/api/workers/me/password", { newPassword: "SecretPass2!" }, tmpToken);
    const relogin = await jsonFetch("POST", "/api/login", { workerId: secretaryId, password: "SecretPass2!" });
    secretaryToken = relogin.body.token;

    const res = await jsonFetch("POST", "/api/workers", { name: "אמור להיכשל", role: "מזכיר", password: "x1234567" }, secretaryToken);
    assert.strictEqual(res.status, 403);
  });

  await check("GET /api/workers (מזכיר) -> 200 — מזכיר ומנהל שניהם מורשים לנתיב הזה", async function () {
    const res = await jsonFetch("GET", "/api/workers", undefined, secretaryToken);
    assert.strictEqual(res.status, 200);
  });

  // ── /api/data/:key ────────────────────────────────────────────────────────

  await check("POST /api/data/donors עם סכום תרומה לא תקין -> 400 (validateDonorsPayload)", async function () {
    const res = await jsonFetch("POST", "/api/data/donors", [
      { id: 1, fullName: "תורם לדוגמה", phone: "0501234567", donations: [{ amount: -50 }] },
    ], adminToken);
    assert.strictEqual(res.status, 400);
  });

  let firstUpdatedAt;
  await check("POST /api/data/donors עם רשומה תקינה -> 200 saved:true", async function () {
    const res = await jsonFetch("POST", "/api/data/donors", [
      { id: 1, fullName: "תורם לדוגמה", phone: "0501234567", donations: [{ amount: 100 }] },
    ], adminToken);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.saved, true);
  });

  await check("GET /api/data/donors מחזיר בדיוק את מה שנשמר, וכולל X-Data-Updated-At", async function () {
    const res = await jsonFetch("GET", "/api/data/donors", undefined, adminToken);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body[0].fullName, "תורם לדוגמה");
    firstUpdatedAt = res.headers.get("x-data-updated-at");
    assert.ok(firstUpdatedAt);
  });

  await check("POST /api/data/donors עם X-Expected-Updated-At לא-עדכני -> 409 (concurrency)", async function () {
    // Save once more so the stored updatedAt moves past what we captured above.
    // The small delay guarantees the new ISO timestamp actually differs from
    // firstUpdatedAt down to the millisecond — without it, two saves issued
    // back-to-back could coincidentally land in the same millisecond and
    // make this check flaky.
    await new Promise(function (resolve) { setTimeout(resolve, 5); });
    await jsonFetch("POST", "/api/data/donors", [
      { id: 1, fullName: "תורם עודכן", phone: "0501234567", donations: [] },
    ], adminToken);

    const res = await fetch(baseUrl + "/api/data/donors", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + adminToken,
        "X-Expected-Updated-At": firstUpdatedAt, // stale on purpose
      },
      body: JSON.stringify([{ id: 1, fullName: "תורם עם קונפליקט", phone: "0501234567", donations: [] }]),
    });
    assert.strictEqual(res.status, 409);
  });

  // ── מיזוג audit log (data-audit-mirror.service.js) ──────────────────────────

  await check("POST /api/data/logs עם רשומת AuditLog חדשה -> נוצרת שורה תואמת ב-server_audit_log, עם workerId מה-JWT ולא מהרשומה", async function () {
    const before = db.getAuditLogs(1000).length;

    await jsonFetch("POST", "/api/data/logs", [
      {
        id: Date.now(),
        action: "create",
        entityType: "donor",
        entityId: 1,
        entityName: "תורם לדוגמה",
        details: "נוסף תורם חדש",
        user: { id: 999999, name: "זהות מזויפת מהלקוח" }, // must be ignored — real identity comes from the JWT
      },
    ], adminToken);

    const logs = db.getAuditLogs(1000);
    assert.strictEqual(logs.length, before + 1, "expected exactly one new server_audit_log row");
    const mirrored = logs[0]; // getAuditLogs orders by id DESC
    assert.strictEqual(mirrored.action, "create");
    assert.strictEqual(mirrored.entityType, "donor");
    assert.strictEqual(mirrored.entityName, "תורם לדוגמה");
    assert.strictEqual(mirrored.workerName, "מנהל מערכת", "workerName must come from the authenticated admin, not the client payload");
    assert.notStrictEqual(mirrored.workerId, 999999);
  });

  await check("POST /api/data/logs פעם שנייה עם אותה רשומה (id זהה) -> לא ממוזג שוב", async function () {
    const sharedEntry = {
      id: 777777,
      action: "delete",
      entityType: "task",
      entityId: 5,
      entityName: "משימה",
      details: "נמחקה",
    };
    const currentLogs = await jsonFetch("GET", "/api/data/logs", undefined, adminToken);
    const withEntry = currentLogs.body.concat([sharedEntry]);

    await jsonFetch("POST", "/api/data/logs", withEntry, adminToken);
    const before = db.getAuditLogs(1000).length;

    await jsonFetch("POST", "/api/data/logs", withEntry, adminToken); // re-save identical array — no new id
    const after = db.getAuditLogs(1000).length;
    assert.strictEqual(after, before, "re-saving the same logs array must not mirror the same entry twice");
  });

  // ── סיכום ────────────────────────────────────────────────────────────────
  const failed = results.filter(function (r) { return !r.ok; });
  results.forEach(function (r) {
    console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : " — " + r.error));
  });
  console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");

  await new Promise(function (resolve) { server.close(resolve); });
  // process.exit() immediately after an http.Server#close() callback can race
  // libuv's own handle-teardown on Windows (UV_HANDLE_CLOSING assertion) —
  // setting exitCode and letting the event loop drain naturally avoids it
  // (same pattern as ivr-audio-paymsg.routes.test.js).
  process.exitCode = failed.length ? 1 : 0;
}

main();

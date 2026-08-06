// softphone-calls.routes.test.js — REAL HTTP-level tests for the softphone
// call-history endpoints (POST/GET /api/softphone/calls[/event], DELETE
// /api/softphone/calls/:id). Covers: event dedup by sipCallId, duration
// calc end-to-end through the real route, caller-id allowlist enforcement,
// donor/contact auto-linking, status-group filters + search + pagination,
// role permissions (ADMIN vs SECRETARY), and delete audit logging.
//
// Same require.main !== module + temp-DB-file pattern as server.routes.test.js.
// No real SIP/network call is ever placed — this only exercises the HTTP
// logging endpoint the browser softphone posts to.
//
// הרצה: node softphone-calls.routes.test.js

const assert = require("assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "softphone-calls-routes-test-"));
process.env.DB_PATH = path.join(tmpRoot, "test.sqlite");
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

let server, baseUrl;

async function apiRequest(method, urlPath, body, token) {
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

async function main() {
  server = http.createServer(app);
  await new Promise(function (resolve) { server.listen(0, "127.0.0.1", resolve); });
  baseUrl = "http://127.0.0.1:" + server.address().port;

  await check("[בטיחות] הבדיקה פועלת מול DB זמני, לא מול data.sqlite האמיתי", async function () {
    assert.ok(db.DB_PATH.indexOf(tmpRoot) === 0, "DB_PATH חייב להיות תחת תיקיית ה-tmp, לא הנתיב האמיתי");
  });

  let adminToken, secretaryToken;
  await check("[הכנה] התחברות כמנהל + שינוי סיסמה חובה", async function () {
    const login = await apiRequest("POST", "/api/login", { workerId: 1, password: "1234" });
    assert.strictEqual(login.status, 200);
    adminToken = login.body.token;
    const pw = await apiRequest("PUT", "/api/workers/me/password", { newPassword: "NewStr0ngPass!" }, adminToken);
    assert.strictEqual(pw.status, 200);
  });

  await check("[הכנה] יצירת עובד מזכיר לבדיקות הרשאה", async function () {
    const created = await apiRequest("POST", "/api/workers", { name: "מזכירה בדיקה", role: "מזכיר", password: "SecPass1!" }, adminToken);
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const secId = created.body.id;
    const login = await apiRequest("POST", "/api/login", { workerId: secId, password: "SecPass1!" });
    assert.strictEqual(login.status, 200);
    secretaryToken = login.body.token;
    const pw = await apiRequest("PUT", "/api/workers/me/password", { newPassword: "NewSecPass1!" }, secretaryToken);
    assert.strictEqual(pw.status, 200, JSON.stringify(pw.body));
  });

  // ── Fixtures: donor + custom contact for auto-linking tests ─────────────────
  db.setAppState("donors", [{ id: 501, phone: "0501111111", fullName: "תורם לבדיקה" }]);
  let customContactId;
  await check("[הכנה] יצירת איש קשר מותאם אישית", async function () {
    const c = db.createSoftphoneContact({ name: "איש קשר בדיקה", primaryPhone: "0502222222" }, { id: 1, name: "מנהל" });
    customContactId = c.id;
  });

  // ── Event dedup + duration calc ──────────────────────────────────────────────

  await check("POST /api/softphone/calls/event: יצירת שיחה יוצאת (in_progress)", async function () {
    const r = await apiRequest("POST", "/api/softphone/calls/event", {
      sipCallId: "sip-abc-1", direction: "outgoing", remotePhone: "0509998888",
      startedAt: "2026-01-01T10:00:00.000Z", status: "in_progress",
    }, secretaryToken);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.call.status, "in_progress");
  });

  await check("POST /api/softphone/calls/event: אירועי progress+ended לאותו sipCallId -> שורה אחת בלבד (ללא כפילות)", async function () {
    await apiRequest("POST", "/api/softphone/calls/event", {
      sipCallId: "sip-abc-1", direction: "outgoing", remotePhone: "0509998888",
      startedAt: "2026-01-01T10:00:00.000Z", ringingAt: "2026-01-01T10:00:02.000Z", status: "in_progress",
    }, secretaryToken);
    const final = await apiRequest("POST", "/api/softphone/calls/event", {
      sipCallId: "sip-abc-1", direction: "outgoing", remotePhone: "0509998888",
      startedAt: "2026-01-01T10:00:00.000Z", answeredAt: "2026-01-01T10:00:05.000Z",
      endedAt: "2026-01-01T10:01:05.000Z", status: "outgoing_answered",
    }, secretaryToken);
    assert.strictEqual(final.status, 200, JSON.stringify(final.body));
    assert.strictEqual(final.body.call.status, "outgoing_answered");
    assert.strictEqual(final.body.call.ringDurationSec, 3);
    assert.strictEqual(final.body.call.talkDurationSec, 60);

    const list = await apiRequest("GET", "/api/softphone/calls?search=0509998888", undefined, secretaryToken);
    assert.strictEqual(list.body.rows.filter(function (r) { return r.sipCallId === "sip-abc-1"; }).length, 1,
      "3 אירועים לאותו sipCallId חייבים להצטמצם לשורה אחת");
  });

  // ── Caller-ID allowlist ──────────────────────────────────────────────────────

  await check("POST /api/softphone/calls/event: מזהה מתקשר לא מאושר -> 400", async function () {
    const r = await apiRequest("POST", "/api/softphone/calls/event", {
      sipCallId: "sip-bad-callerid", direction: "outgoing", remotePhone: "0501234567",
      selectedCallerId: "0000000000", status: "in_progress",
    }, secretaryToken);
    assert.strictEqual(r.status, 400);
  });

  await check("POST /api/softphone/calls/event: מזהה מתקשר מאושר (025378787) -> נשמר", async function () {
    const r = await apiRequest("POST", "/api/softphone/calls/event", {
      sipCallId: "sip-good-callerid", direction: "outgoing", remotePhone: "0501234567",
      selectedCallerId: "025378787", status: "in_progress",
    }, secretaryToken);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.call.selectedCallerId, "025378787");
  });

  await check("POST /api/softphone/calls/event: סטטוס לא בתוך הרשימה המותרת -> 400", async function () {
    const r = await apiRequest("POST", "/api/softphone/calls/event", {
      sipCallId: "sip-bad-status", direction: "outgoing", remotePhone: "0501234567",
      status: "made_up_status",
    }, secretaryToken);
    assert.strictEqual(r.status, 400);
  });

  // ── Donor / contact auto-linking ─────────────────────────────────────────────

  await check("POST /api/softphone/calls/event: מספר תואם תורם קיים -> donorId/donorName משויכים אוטומטית", async function () {
    const r = await apiRequest("POST", "/api/softphone/calls/event", {
      sipCallId: "sip-donor-match", direction: "incoming", remotePhone: "0501111111", status: "incoming_answered",
      startedAt: "2026-01-01T11:00:00.000Z", answeredAt: "2026-01-01T11:00:01.000Z", endedAt: "2026-01-01T11:00:30.000Z",
    }, secretaryToken);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.call.donorId, 501);
    assert.strictEqual(r.body.call.donorName, "תורם לבדיקה");
    assert.strictEqual(r.body.call.contactId, null);
  });

  await check("POST /api/softphone/calls/event: מספר תואם איש קשר מותאם אישית -> contactId/contactName משויכים אוטומטית", async function () {
    const r = await apiRequest("POST", "/api/softphone/calls/event", {
      sipCallId: "sip-contact-match", direction: "incoming", remotePhone: "0502222222", status: "incoming_missed",
      startedAt: "2026-01-01T11:05:00.000Z", endedAt: "2026-01-01T11:05:20.000Z",
    }, secretaryToken);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.call.contactId, customContactId);
    assert.strictEqual(r.body.call.contactName, "איש קשר בדיקה");
    assert.strictEqual(r.body.call.donorId, null);
  });

  // ── Filters / search / pagination ────────────────────────────────────────────

  await check("GET /api/softphone/calls: פילטר statusGroup=missed מחזיר רק incoming_missed", async function () {
    const r = await apiRequest("GET", "/api/softphone/calls?statusGroup=missed&pageSize=100", undefined, secretaryToken);
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.rows.length >= 1);
    r.body.rows.forEach(function (row) { assert.strictEqual(row.status, "incoming_missed"); });
  });

  await check("GET /api/softphone/calls: פילטר statusGroup=outgoing מחזיר רק direction=outgoing", async function () {
    const r = await apiRequest("GET", "/api/softphone/calls?statusGroup=outgoing&pageSize=100", undefined, secretaryToken);
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.rows.length >= 1);
    r.body.rows.forEach(function (row) { assert.strictEqual(row.direction, "outgoing"); });
  });

  await check("GET /api/softphone/calls: פילטר statusGroup=failed כולל rejected/failed/unanswered/cancelled בלבד", async function () {
    const r = await apiRequest("GET", "/api/softphone/calls?statusGroup=failed&pageSize=100", undefined, secretaryToken);
    const allowed = ["incoming_rejected", "outgoing_rejected", "outgoing_failed", "outgoing_unanswered", "cancelled"];
    r.body.rows.forEach(function (row) { assert.ok(allowed.indexOf(row.status) !== -1, row.status + " should not appear in the failed tab"); });
  });

  await check("GET /api/softphone/calls: חיפוש לפי שם תורם מוצא את השיחה המקושרת", async function () {
    const r = await apiRequest("GET", "/api/softphone/calls?search=" + encodeURIComponent("תורם לבדיקה"), undefined, secretaryToken);
    assert.ok(r.body.rows.some(function (row) { return row.sipCallId === "sip-donor-match"; }));
  });

  await check("GET /api/softphone/calls: תוצאות ממוינות מהחדש לישן (startedAt DESC)", async function () {
    const r = await apiRequest("GET", "/api/softphone/calls?pageSize=100", undefined, secretaryToken);
    const times = r.body.rows.map(function (row) { return new Date(row.startedAt).getTime(); });
    for (let i = 1; i < times.length; i++) assert.ok(times[i - 1] >= times[i], "not sorted newest-first");
  });

  await check("GET /api/softphone/calls: pageSize=1 מחזיר עמוד יחיד + total נכון", async function () {
    const r = await apiRequest("GET", "/api/softphone/calls?pageSize=1&page=1", undefined, secretaryToken);
    assert.strictEqual(r.body.rows.length, 1);
    assert.ok(r.body.total >= 4);
  });

  // ── Permissions ───────────────────────────────────────────────────────────────

  await check("GET /api/softphone/calls ללא טוקן -> 401", async function () {
    const r = await apiRequest("GET", "/api/softphone/calls", undefined, undefined);
    assert.strictEqual(r.status, 401);
  });

  await check("DELETE /api/softphone/calls/:id עם טוקן מזכיר (לא מנהל) -> 403", async function () {
    const list = await apiRequest("GET", "/api/softphone/calls?search=sip-abc-1&pageSize=5", undefined, secretaryToken);
    const row = (await apiRequest("GET", "/api/softphone/calls?pageSize=100", undefined, secretaryToken)).body.rows
      .find(function (r) { return r.sipCallId === "sip-abc-1"; });
    assert.ok(row);
    const del = await apiRequest("DELETE", "/api/softphone/calls/" + row.id, undefined, secretaryToken);
    assert.strictEqual(del.status, 403);
  });

  await check("DELETE /api/softphone/calls/:id עם טוקן מנהל -> 200 + רשומת audit log", async function () {
    const row = (await apiRequest("GET", "/api/softphone/calls?pageSize=100", undefined, adminToken)).body.rows
      .find(function (r) { return r.sipCallId === "sip-abc-1"; });
    assert.ok(row);
    const before = db.getAuditLogs(1000).filter(function (l) { return l.action === "softphone_call_deleted"; }).length;
    const del = await apiRequest("DELETE", "/api/softphone/calls/" + row.id, undefined, adminToken);
    assert.strictEqual(del.status, 200, JSON.stringify(del.body));
    const after = db.getAuditLogs(1000).filter(function (l) { return l.action === "softphone_call_deleted"; }).length;
    assert.strictEqual(after, before + 1, "מחיקה חייבת להוסיף רשומת audit log");

    const gone = await apiRequest("GET", "/api/softphone/calls?pageSize=100", undefined, adminToken);
    assert.ok(!gone.body.rows.some(function (r) { return r.id === row.id; }));
  });

  await check("DELETE /api/softphone/calls/:id על רשומה לא קיימת -> 404", async function () {
    const del = await apiRequest("DELETE", "/api/softphone/calls/999999", undefined, adminToken);
    assert.strictEqual(del.status, 404);
  });

  // ── סיכום ─────────────────────────────────────────────────────────────────────
  const failed = results.filter(function (r) { return !r.ok; });
  results.forEach(function (r) {
    console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : " — " + r.error));
  });
  console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");
  server.close();
  process.exit(failed.length ? 1 : 0);
}

main();

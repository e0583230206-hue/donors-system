// ivr-pregreeting.routes.test.js — REAL HTTP-level test of the 5 admin
// routes for the temporary "pre-greeting" IVR message
// (GET/POST upload/DELETE/PUT enabled/PUT schedule under
// /api/admin/ivr-audio/pregreeting), against the REAL server.js app —
// same pattern as server.routes.test.js.
//
// Scope note (matches the existing, established precedent in this repo —
// see ivr-audio-paymsg.routes.test.js's own header and
// ivr-audio-paymsg-lifecycle.service.test.js's ffmpeg note): ffmpeg/ffprobe
// are NOT installed in this environment, so a real multipart upload of a
// genuinely playable audio file can't be exercised end-to-end here. What IS
// covered over real HTTP: routing/auth/role checks, request validation,
// locking, the enabled/schedule/delete state machine (seeded directly via
// db.setIvrAudioRecordingSlots to stand in for "a file was already
// uploaded and approved" without needing ffmpeg), graceful rejection of an
// invalid audio upload (multer fileFilter + convertUploadedFile's own
// probe-failure path — both exercised for real, no ffmpeg required), and
// audit logging. The upload->convert->auto-approve happy path itself is
// covered at the unit level (paymsgLifecycle, already tested elsewhere) —
// this file proves ivr-pregreeting's own routing reaches those exact same,
// already-trusted functions correctly.
//
// Uses a TEMPORARY sqlite file — never opens the real data.sqlite.
//
// הרצה: node ivr-pregreeting.routes.test.js

const assert = require("assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pregreeting-routes-test-"));
process.env.DB_PATH = path.join(tmpRoot, "test.sqlite");
delete process.env.NODE_ENV;

const app = require("./server");
const db = require("./db");
const paymsgLock = require("./ivr-audio-paymsg-lock.service");

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

  await check("GET pregreeting בלי Authorization -> 401", async function () {
    const res = await jsonFetch("GET", "/api/admin/ivr-audio/pregreeting");
    assert.strictEqual(res.status, 401);
  });

  let adminToken;
  await check("התחברות מנהל + שינוי סיסמה חובה", async function () {
    const login = await jsonFetch("POST", "/api/login", { workerId: 1, password: "1234" });
    adminToken = login.body.token;
    await jsonFetch("PUT", "/api/workers/me/password", { newPassword: "AdminStr0ng!" }, adminToken);
    const relogin = await jsonFetch("POST", "/api/login", { workerId: 1, password: "AdminStr0ng!" });
    adminToken = relogin.body.token;
    assert.ok(adminToken);
  });

  let secretaryToken;
  await check("יצירת מזכיר לבדיקות הרשאה", async function () {
    const created = await jsonFetch("POST", "/api/workers", { name: "מזכיר pregreeting", role: "מזכיר", password: "Temp1234!" }, adminToken);
    const login1 = await jsonFetch("POST", "/api/login", { workerId: created.body.id, password: "Temp1234!" });
    await jsonFetch("PUT", "/api/workers/me/password", { newPassword: "SecStr0ng!" }, login1.body.token);
    const login2 = await jsonFetch("POST", "/api/login", { workerId: created.body.id, password: "SecStr0ng!" });
    secretaryToken = login2.body.token;
    assert.ok(secretaryToken);
  });

  // ── הרשאות: כל 5 הנתיבים דורשים ADMIN, לא מספיק מזכיר ────────────────────────

  await check("GET pregreeting כמזכיר -> 403", async function () {
    const res = await jsonFetch("GET", "/api/admin/ivr-audio/pregreeting", undefined, secretaryToken);
    assert.strictEqual(res.status, 403);
  });

  await check("PUT enabled כמזכיר -> 403", async function () {
    const res = await jsonFetch("PUT", "/api/admin/ivr-audio/pregreeting/enabled", { enabled: true }, secretaryToken);
    assert.strictEqual(res.status, 403);
  });

  await check("PUT schedule כמזכיר -> 403", async function () {
    const res = await jsonFetch("PUT", "/api/admin/ivr-audio/pregreeting/schedule", { startAt: "2026-01-01T00:00" }, secretaryToken);
    assert.strictEqual(res.status, 403);
  });

  await check("DELETE pregreeting כמזכיר -> 403", async function () {
    const res = await jsonFetch("DELETE", "/api/admin/ivr-audio/pregreeting", undefined, secretaryToken);
    assert.strictEqual(res.status, 403);
  });

  // ── מצב התחלתי: אין קובץ ─────────────────────────────────────────────────────

  await check("GET pregreeting (התחלה): אין קובץ, לא פעילה, לא מופעלת", async function () {
    const res = await jsonFetch("GET", "/api/admin/ivr-audio/pregreeting", undefined, adminToken);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.audioId, "PREGREETING-001");
    assert.strictEqual(res.body.hasFile, false);
    assert.strictEqual(res.body.enabled, false);
    assert.strictEqual(res.body.active, false);
    assert.strictEqual(res.body.fileUrl, null);
    assert.match(res.body.now, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "השדה now חייב להיות בפורמט Asia/Jerusalem תקין");
  });

  await check("PUT enabled=true בלי קובץ -> 400, לא מופעל", async function () {
    const res = await jsonFetch("PUT", "/api/admin/ivr-audio/pregreeting/enabled", { enabled: true }, adminToken);
    assert.strictEqual(res.status, 400);
    const status = await jsonFetch("GET", "/api/admin/ivr-audio/pregreeting", undefined, adminToken);
    assert.strictEqual(status.body.enabled, false);
  });

  // ── בדיקות אימות לוח זמנים ────────────────────────────────────────────────────

  await check("PUT schedule עם פורמט לא תקין -> 400", async function () {
    const res = await jsonFetch("PUT", "/api/admin/ivr-audio/pregreeting/schedule", { startAt: "לא-תאריך" }, adminToken);
    assert.strictEqual(res.status, 400);
  });

  await check("PUT schedule עם startAt >= endAt -> 400", async function () {
    const res = await jsonFetch("PUT", "/api/admin/ivr-audio/pregreeting/schedule", {
      startAt: "2026-06-01T00:00", endAt: "2026-05-01T00:00",
    }, adminToken);
    assert.strictEqual(res.status, 400);
  });

  // ── קובץ לא תקין: multer fileFilter דוחה סוג קובץ אסור לפני שמגיע להמרה ────────

  await check("POST upload עם קובץ טקסט (לא audio) -> 400, לא קורס", async function () {
    const boundary = "----pregreetingTestBoundary1";
    const body =
      "--" + boundary + "\r\n" +
      'Content-Disposition: form-data; name="audio"; filename="not-audio.txt"\r\n' +
      "Content-Type: text/plain\r\n\r\n" +
      "this is definitely not an audio file\r\n" +
      "--" + boundary + "--\r\n";
    const res = await fetch(baseUrl + "/api/admin/ivr-audio/pregreeting/upload", {
      method: "POST",
      headers: { Authorization: "Bearer " + adminToken, "Content-Type": "multipart/form-data; boundary=" + boundary },
      body: body,
    });
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.ok(data.error);
  });

  await check("POST upload עם bytes מזויפים בסיומת .mp3 -> 422 מסודר (לא 500), הודעה זמנית ריקה כרגיל", async function () {
    // Passes multer's extension/mimetype fileFilter (looks like an mp3 by
    // name), but isn't real audio — convertUploadedFile's ffprobe call fails
    // to parse it and returns a clean {ok:false} rather than crashing (see
    // header note: real conversion happy-path needs ffmpeg, not available
    // here — this proves the FAILURE path instead, which doesn't).
    const boundary = "----pregreetingTestBoundary2";
    const body =
      "--" + boundary + "\r\n" +
      'Content-Disposition: form-data; name="audio"; filename="fake.mp3"\r\n' +
      "Content-Type: audio/mpeg\r\n\r\n" +
      "not real mp3 bytes at all, just garbage\r\n" +
      "--" + boundary + "--\r\n";
    const res = await fetch(baseUrl + "/api/admin/ivr-audio/pregreeting/upload", {
      method: "POST",
      headers: { Authorization: "Bearer " + adminToken, "Content-Type": "multipart/form-data; boundary=" + boundary },
      body: body,
    });
    assert.strictEqual(res.status, 422);
    const data = await res.json();
    assert.ok(data.error);

    const status = await jsonFetch("GET", "/api/admin/ivr-audio/pregreeting", undefined, adminToken);
    assert.strictEqual(status.body.hasFile, false, "העלאה כושלת לא הותירה קובץ מזויף פעיל");
  });

  await check("לאחר 2 ניסיונות העלאה כושלים: אין רשומות audit log של pregreeting_upload (רק הצלחה מתועדת)", async function () {
    const logs = db.getAuditLogs(1000).filter(function (r) { return r.action === "ivr_pregreeting_upload"; });
    assert.strictEqual(logs.length, 0);
  });

  // ── מדמים העלאה שהצליחה (ללא ffmpeg אמיתי) ע"י כתיבה ישירה ל-DB, ואז בודקים
  //    את מחזור החיים המלא (הפעלה/כיבוי/לוח זמנים/מחיקה) מעל HTTP אמיתי ─────────

  await check("(seed) קובץ מאושר לדימוי העלאה מוצלחת", async function () {
    db.setIvrAudioRecordingSlots(db.PREGREETING_AUDIO_ID, {
      audioFile1: "pregreeting-seed-abc123.wav", audioFile2: "", audioFile3: "", status: "אושר",
    });
    const status = await jsonFetch("GET", "/api/admin/ivr-audio/pregreeting", undefined, adminToken);
    assert.strictEqual(status.body.hasFile, true);
    assert.strictEqual(status.body.fileUrl, "/uploads/ivr-audio/pregreeting-seed-abc123.wav");
    assert.strictEqual(status.body.enabled, false, "העלאה לבדה לא מפעילה אוטומטית");
    assert.strictEqual(status.body.active, false);
  });

  await check("PUT enabled=true (יש קובץ) -> 200, פעילה מיד (אין לוח זמנים)", async function () {
    const res = await jsonFetch("PUT", "/api/admin/ivr-audio/pregreeting/enabled", { enabled: true }, adminToken);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.active, true);
    const status = await jsonFetch("GET", "/api/admin/ivr-audio/pregreeting", undefined, adminToken);
    assert.strictEqual(status.body.enabled, true);
    assert.strictEqual(status.body.active, true);
  });

  await check("PUT schedule עם startAt עתידי -> נשמר, אבל active=false (טרם הגיע המועד)", async function () {
    const res = await jsonFetch("PUT", "/api/admin/ivr-audio/pregreeting/schedule", { startAt: "2099-01-01T00:00" }, adminToken);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.active, false);
    const status = await jsonFetch("GET", "/api/admin/ivr-audio/pregreeting", undefined, adminToken);
    assert.strictEqual(status.body.startAt, "2099-01-01T00:00");
    assert.strictEqual(status.body.active, false);
  });

  await check("PUT schedule עם טווח שכולל את עכשיו -> active=true שוב", async function () {
    const res = await jsonFetch("PUT", "/api/admin/ivr-audio/pregreeting/schedule", {
      startAt: "2020-01-01T00:00", endAt: "2099-01-01T00:00",
    }, adminToken);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.active, true);
  });

  await check("PUT schedule עם endAt שכבר עבר -> active=false אוטומטית, בלי לגעת ב-enabled", async function () {
    const res = await jsonFetch("PUT", "/api/admin/ivr-audio/pregreeting/schedule", {
      startAt: "2020-01-01T00:00", endAt: "2020-06-01T00:00",
    }, adminToken);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.active, false);
    const status = await jsonFetch("GET", "/api/admin/ivr-audio/pregreeting", undefined, adminToken);
    assert.strictEqual(status.body.enabled, true, "enabled עצמו לא נגע — רק active הושפע מהלוח זמנים");
  });

  await check("PUT schedule ריק (ניקוי טווח) -> חוזרת להפעלה ידנית -> active=true שוב (enabled עדיין true)", async function () {
    const res = await jsonFetch("PUT", "/api/admin/ivr-audio/pregreeting/schedule", { startAt: "", endAt: "" }, adminToken);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.active, true);
    const status = await jsonFetch("GET", "/api/admin/ivr-audio/pregreeting", undefined, adminToken);
    assert.strictEqual(status.body.startAt, null);
    assert.strictEqual(status.body.endAt, null);
  });

  await check("PUT enabled=false -> כיבוי ידני, active=false", async function () {
    const res = await jsonFetch("PUT", "/api/admin/ivr-audio/pregreeting/enabled", { enabled: false }, adminToken);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.active, false);
    const status = await jsonFetch("GET", "/api/admin/ivr-audio/pregreeting", undefined, adminToken);
    assert.strictEqual(status.body.enabled, false);
    assert.strictEqual(status.body.hasFile, true, "כיבוי לא מוחק את הקובץ");
  });

  // ── נעילה: מונעת פעולה כפולה ────────────────────────────────────────────────

  await check("נעילה פעילה על PREGREETING-001 -> DELETE מחזיר 409 (מונע לחיצה כפולה)", async function () {
    assert.strictEqual(paymsgLock.tryLock(db.PREGREETING_AUDIO_ID), true);
    try {
      const res = await jsonFetch("DELETE", "/api/admin/ivr-audio/pregreeting", undefined, adminToken);
      assert.strictEqual(res.status, 409);
    } finally {
      paymsgLock.unlock(db.PREGREETING_AUDIO_ID);
    }
  });

  // ── מחיקה: מנקה הכול, לא פוגעת בפתיח הקבוע (OPEN-001) ──────────────────────────

  await check("DELETE pregreeting -> מאפס לגמרי, ו-OPEN-001 (הפתיח הקבוע) לא נפגע כלל", async function () {
    const openBefore = db.getIvrAudioRecordingById("OPEN-001");

    const res = await jsonFetch("DELETE", "/api/admin/ivr-audio/pregreeting", undefined, adminToken);
    assert.strictEqual(res.status, 200);

    const status = await jsonFetch("GET", "/api/admin/ivr-audio/pregreeting", undefined, adminToken);
    assert.strictEqual(status.body.hasFile, false);
    assert.strictEqual(status.body.enabled, false);
    assert.strictEqual(status.body.startAt, null);
    assert.strictEqual(status.body.endAt, null);
    assert.strictEqual(status.body.active, false);

    const openAfter = db.getIvrAudioRecordingById("OPEN-001");
    assert.deepStrictEqual(openAfter, openBefore, "מחיקת ההודעה הזמנית לא רשאית לגעת בשום שדה של OPEN-001");
  });

  await check("PUT enabled=true אחרי מחיקה (אין קובץ) -> 400 שוב, לא נשאר 'תקוע' פעיל", async function () {
    const res = await jsonFetch("PUT", "/api/admin/ivr-audio/pregreeting/enabled", { enabled: true }, adminToken);
    assert.strictEqual(res.status, 400);
  });

  // ── Audit Log: תקין, כולל משתמש+זמן, בלי מידע רגיש מיותר ───────────────────────

  await check("Audit Log: כל פעולות ה-pregreeting מתועדות עם workerName נכון, בלי fileLink/נתיב קובץ גולמי", async function () {
    const logs = db.getAuditLogs(1000).filter(function (r) { return String(r.action).indexOf("ivr_pregreeting_") === 0; });
    var actions = logs.map(function (r) { return r.action; });
    assert.ok(actions.includes("ivr_pregreeting_enable"));
    assert.ok(actions.includes("ivr_pregreeting_schedule"));
    assert.ok(actions.includes("ivr_pregreeting_delete"));

    logs.forEach(function (r) {
      assert.strictEqual(r.workerName, "מנהל מערכת", "כל שורה חייבת לשקף את המשתמש המחובר האמיתי (מה-JWT)");
      assert.ok(r.createdAt, "כל שורה חייבת זמן");
      var serialized = JSON.stringify(r);
      assert.ok(!serialized.includes("/uploads/ivr-audio/"), "אסור שיישמר נתיב שרת גולמי בלוג");
      assert.ok(!serialized.includes("pregreeting-seed-abc123"), "אסור ששם הקובץ הפנימי ייכנס ללוג");
    });
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

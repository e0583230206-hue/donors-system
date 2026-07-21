// ivr-audio-paymsg.routes.test.js — REAL HTTP-level test of the extracted
// route module (ivr-audio-paymsg.routes.js), proving server.js is wired
// correctly — not just that the underlying lifecycle service works (that's
// already covered by ivr-audio-paymsg-lifecycle.service.test.js).
//
// Mounts createIvrAudioSlotRoutes() — the EXACT SAME factory server.js
// calls in production — on a throwaway Express app listening on an
// ephemeral local port, and issues real HTTP requests via Node's built-in
// fetch (no supertest/new dependency). The DB layer and paymsgLifecycle are
// FAKED here on purpose (route-level tests should prove ROUTING/WIRING —
// method/path/status codes/locking/response shape — not re-prove business
// logic already covered elsewhere); the REAL paymsgLock module IS used
// (it's pure/dependency-free — no reason to fake it, and using the real one
// proves the routes share the actual production lock, not a stand-in).
//
// Scope note: only PUT /:id, DELETE /:id/audio/:slot, and
// POST /:id/restore-previous are exercised here — POST /:id/audio/:slot
// (file upload) needs real multipart/form-data + a real temp upload dir to
// test meaningfully over HTTP and is out of scope for this round; its
// wiring follows the exact same isPaymsg/lock/deps pattern already proven
// here and at the lifecycle level.
//
// הרצה: node ivr-audio-paymsg.routes.test.js

const assert = require("assert");
const http = require("http");
const path = require("path");
const express = require("express");
const { createIvrAudioSlotRoutes } = require("./ivr-audio-paymsg.routes");
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

const VALID_STATUSES = ["חסר", "תורגם", "הוקלט", "נבדק", "אושר"];

function makeDeps(rows, opts) {
  opts = opts || {};
  const approvePendingCalls = [];
  const rejectPendingCalls = [];
  const restorePreviousCalls = [];
  const auditLogs = [];
  const fsUnlinkCalls = [];
  const updateIvrAudioRecordingCalls = [];

  const fakeLifecycle = {
    approvePending: function (id) {
      approvePendingCalls.push(id);
      const row = rows[id];
      if (!row || !row.audioFile3) return { ok: false, status: 400, error: "אין גרסה ממתינה לאישור" };
      const oldFile1 = row.audioFile1;
      row.audioFile2 = oldFile1;
      row.audioFile1 = row.audioFile3;
      row.audioFile3 = "";
      row.status = "אושר";
      return { ok: true, recording: Object.assign({ audioId: id }, row) };
    },
    rejectPending: function (id) {
      rejectPendingCalls.push(id);
      const row = rows[id];
      if (!row || !row.audioFile3) return { ok: false, status: 400, error: "אין גרסה ממתינה למחיקה" };
      row.audioFile3 = "";
      return { ok: true, recording: Object.assign({ audioId: id }, row) };
    },
    restorePrevious: function (id) {
      restorePreviousCalls.push(id);
      const row = rows[id];
      if (!row || !row.audioFile2) return { ok: false, status: 400, error: "אין גרסה קודמת" };
      const oldFile1 = row.audioFile1;
      row.audioFile1 = row.audioFile2;
      row.audioFile2 = oldFile1;
      return { ok: true, recording: Object.assign({ audioId: id }, row) };
    },
    convertUploadedFile: function () { return { ok: true }; },
    commitStagedUpload: function (id, filename) {
      rows[id].audioFile3 = filename;
      return { ok: true, recording: Object.assign({ audioId: id }, rows[id]) };
    },
  };

  const deps = {
    getIvrAudioRecordingById: function (id) { return rows[id] ? Object.assign({ audioId: id }, rows[id]) : null; },
    updateIvrAudioRecording: function (id, fields) {
      updateIvrAudioRecordingCalls.push({ id: id, fields: fields });
      if (!rows[id]) return null;
      Object.assign(rows[id], fields);
      return Object.assign({ audioId: id }, rows[id]);
    },
    setIvrAudioRecordingFileSlot: function (id, slot, filename, status) {
      rows[id]["audioFile" + slot] = filename;
      rows[id].status = status;
      return Object.assign({ audioId: id }, rows[id]);
    },
    clearIvrAudioRecordingFileSlot: function (id, slot) {
      rows[id]["audioFile" + slot] = "";
      return Object.assign({ audioId: id }, rows[id]);
    },
    bumpStatusOnUpload: function (s) { return s; },
    isValidStatus: function (s) { return VALID_STATUSES.indexOf(s) !== -1; },
    isValidSlot: function (s) { return [1, 2, 3].indexOf(Number(s)) !== -1; },
    insertAuditLog: function (entry) { auditLogs.push(entry); },
    paymsgLock: paymsgLock, // REAL — pure, dependency-free, shared with production
    paymsgLifecycle: opts.lifecycleOverrides ? Object.assign(fakeLifecycle, opts.lifecycleOverrides) : fakeLifecycle,
    ivrAudioUpload: function (req, res, cb) { cb(new Error("upload not exercised by this route test")); },
    IVR_AUDIO_FILE_FIELD: { 1: "audioFile1", 2: "audioFile2", 3: "audioFile3" },
    uploadsDir: "/fake-uploads-dir",
    fs: {
      existsSync: function () { return !!(opts.fileExistsOnDisk); },
      unlinkSync: function (p) { fsUnlinkCalls.push(p); },
    },
    path: path,
  };

  return {
    deps: deps,
    approvePendingCalls: approvePendingCalls,
    rejectPendingCalls: rejectPendingCalls,
    restorePreviousCalls: restorePreviousCalls,
    auditLogs: auditLogs,
    fsUnlinkCalls: fsUnlinkCalls,
    updateIvrAudioRecordingCalls: updateIvrAudioRecordingCalls,
  };
}

function makeRow(fields) {
  return Object.assign({ category: "open", audioFile1: "", audioFile2: "", audioFile3: "", status: "חסר" }, fields);
}

// Starts a real HTTP server with the routes mounted, runs `fn(baseUrl, harness)`,
// always tears the server down afterward. paymsgLock is reset before every
// call so tests never leak locks into each other.
async function withServer(rows, opts, fn) {
  paymsgLock._reset();
  const harness = makeDeps(rows, opts || {});
  const app = express();
  app.use(express.json());
  app.use(function (req, res, next) {
    req.user = { id: 1, name: "בודק" };
    next();
  });
  app.use("/api/admin/ivr-audio", createIvrAudioSlotRoutes(harness.deps));
  app.use(function (err, req, res, next) { // eslint-disable-line no-unused-vars
    res.status(500).json({ error: err.message });
  });

  const server = http.createServer(app);
  await new Promise(function (resolve) { server.listen(0, "127.0.0.1", resolve); });
  const baseUrl = "http://127.0.0.1:" + server.address().port;
  try {
    await fn(baseUrl, harness);
  } finally {
    await new Promise(function (resolve) { server.close(resolve); });
    paymsgLock._reset();
  }
}

async function main() {
  // ── PUT /:id — approve-branch (ממצא 1) ──────────────────────────────────
  await check("[PUT — הממצא הראשי] status=\"אושר\" כבר קיים + audioFile3 קיים -> קידום אמיתי דרך HTTP: audioFile3 מתרוקן, הממתין הופך פעיל, הפעיל הישן הופך קודם", async function () {
    const rows = { "PAYMSG-3000": makeRow({ category: "paymsg", audioFile1: "old-active.wav", audioFile3: "new-pending.wav", status: "אושר" }) };
    await withServer(rows, {}, async function (baseUrl) {
      const res = await fetch(baseUrl + "/api/admin/ivr-audio/PAYMSG-3000", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "אושר" }),
      });
      const data = await res.json();
      assert.strictEqual(res.status, 200);
      assert.strictEqual(data.ok, true);
      assert.ok(data.recording, "התשובה חייבת לכלול שורה מעודכנת, לא רק {ok:true}");
      assert.strictEqual(data.recording.audioFile3, "");
      assert.strictEqual(data.recording.audioFile1, "new-pending.wav");
      assert.strictEqual(data.recording.audioFile2, "old-active.wav");
      assert.strictEqual(data.recording.status, "אושר");
    });
  });

  await check("[PUT] אין audioFile3 -> נתיב הנפילה הגנרי (updateIvrAudioRecording), לא קידום — approvePending לא נקרא בכלל", async function () {
    const rows = { "PAYMSG-3001": makeRow({ category: "paymsg", audioFile1: "active.wav", status: "הוקלט" }) };
    await withServer(rows, {}, async function (baseUrl, harness) {
      const res = await fetch(baseUrl + "/api/admin/ivr-audio/PAYMSG-3001", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "אושר" }),
      });
      const data = await res.json();
      assert.strictEqual(res.status, 200);
      assert.strictEqual(data.recording.status, "אושר");
      assert.strictEqual(data.recording.audioFile1, "active.wav", "לא זז — לא הייתה גרסה ממתינה לקדם");
      assert.strictEqual(harness.approvePendingCalls.length, 0, "approvePending לא אמור להיקרא כשאין audioFile3");
    });
  });

  await check("[PUT] תשובת הצלחה תמיד כוללת recording עם audioFile1/2/3 — לא {ok:true} בלבד", async function () {
    const rows = { "OPEN-001": makeRow({ category: "open", sourceTextHe: "טקסט" }) };
    await withServer(rows, {}, async function (baseUrl) {
      const res = await fetch(baseUrl + "/api/admin/ivr-audio/OPEN-001", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: "הערה" }),
      });
      const data = await res.json();
      assert.strictEqual(res.status, 200);
      assert.ok("audioFile1" in data.recording && "audioFile2" in data.recording && "audioFile3" in data.recording);
    });
  });

  // ── PUT — ממצא 1 (סבב תיקון נוסף): allowlist מפורש, לא עקיפה דרך PUT ─────
  async function putJson(baseUrl, id, body) {
    const res = await fetch(baseUrl + "/api/admin/ivr-audio/" + encodeURIComponent(id), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return { status: res.status, data: data };
  }

  await check("[PUT — allowlist 1] paymsg ללא pending + PUT עם audioFile1 -> מתעלם, audioFile1 לא זז", async function () {
    const rows = { "PAYMSG-3010": makeRow({ category: "paymsg", audioFile1: "real-active.wav", status: "אושר" }) };
    await withServer(rows, {}, async function (baseUrl) {
      const r = await putJson(baseUrl, "PAYMSG-3010", { audioFile1: "SNEAKY-INJECTED.wav" });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.data.recording.audioFile1, "real-active.wav", "audioFile1 מהגוף מתעלם לגמרי, לא נכנס ל-DB");
    });
  });

  await check("[PUT — allowlist 2] paymsg עם pending + PUT שאינו \"אושר\" -> אף סלוט לא זז", async function () {
    const rows = { "PAYMSG-3011": makeRow({ category: "paymsg", audioFile1: "active.wav", audioFile3: "pending.wav", status: "אושר" }) };
    await withServer(rows, {}, async function (baseUrl, harness) {
      const r = await putJson(baseUrl, "PAYMSG-3011", { status: "נבדק" });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.data.recording.status, "נבדק", "שינוי סטטוס רגיל (לא אישור) עדיין עובד");
      assert.strictEqual(r.data.recording.audioFile1, "active.wav");
      assert.strictEqual(r.data.recording.audioFile3, "pending.wav", "הממתין לא נגע — לא הייתה זו בקשת אישור");
      assert.strictEqual(harness.approvePendingCalls.length, 0);
    });
  });

  await check("[PUT — allowlist 3] paymsg + PUT עם audioFile2/audioFile3 -> אינו יכול לשנות אותם", async function () {
    const rows = { "PAYMSG-3012": makeRow({ category: "paymsg", audioFile1: "active.wav", audioFile2: "previous.wav", audioFile3: "pending.wav", status: "אושר" }) };
    await withServer(rows, {}, async function (baseUrl) {
      const r = await putJson(baseUrl, "PAYMSG-3012", { audioFile2: "HACK2.wav", audioFile3: "HACK3.wav", notes: "עדכון לגיטימי" });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.data.recording.audioFile2, "previous.wav", "audioFile2 מהגוף מתעלם");
      assert.strictEqual(r.data.recording.audioFile3, "pending.wav", "audioFile3 מהגוף מתעלם (זו לא בקשת אישור — status לא נשלח)");
      assert.strictEqual(r.data.recording.notes, "עדכון לגיטימי", "שדה מותר (notes) כן עודכן");
    });
  });

  await check("[PUT — allowlist 4] ניסיון לשנות category נדחה/מתעלם עבור שורת paymsg", async function () {
    const rows = { "PAYMSG-3013": makeRow({ category: "paymsg", audioFile1: "active.wav", status: "אושר" }) };
    await withServer(rows, {}, async function (baseUrl) {
      const r = await putJson(baseUrl, "PAYMSG-3013", { category: "open" });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.data.recording.category, "paymsg", "category נשאר paymsg — לא ניתן לברוח מהמנגנון דרך PUT");
    });
  });

  await check("[PUT — allowlist 4b] ניסיון לשנות audioId בגוף הבקשה — מתעלם (audioId נלקח מה-URL, לא מהגוף)", async function () {
    const rows = { "PAYMSG-3014": makeRow({ category: "paymsg", audioFile1: "active.wav", status: "אושר" }) };
    await withServer(rows, {}, async function (baseUrl) {
      const r = await putJson(baseUrl, "PAYMSG-3014", { audioId: "PAYMSG-9999", notes: "x" });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.data.recording.audioId, "PAYMSG-3014", "audioId בגוף לא משנה איזו שורה עודכנה");
      assert.strictEqual(rows["PAYMSG-9999"], undefined, "לא נוצרה/שונתה שורה אחרת");
    });
  });

  await check("[PUT — allowlist 5] שורה שאינה paymsg ממשיכה להתעדכן בחוזה הקיים — audioFile1/category כן ניתנים לעריכה כמו קודם (ללא רגרסיה)", async function () {
    const rows = { "OPEN-003": makeRow({ category: "open", audioFile1: "x.wav" }) };
    await withServer(rows, {}, async function (baseUrl) {
      const r = await putJson(baseUrl, "OPEN-003", { category: "menu", sourceTextHe: "טקסט חדש" });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.data.recording.category, "menu", "לשורה רגילה עדיין מותר לשנות category — זו לא הגבלה חדשה עליה");
      assert.strictEqual(r.data.recording.sourceTextHe, "טקסט חדש");
    });
  });

  await check("[PUT — allowlist 6] בקשת אישור היא lifecycle-only: כישלון approvePending לא משאיר עדכון חלקי של שדות אחרים באותה בקשה", async function () {
    const rows = { "PAYMSG-3015": makeRow({ category: "paymsg", audioFile1: "active.wav", audioFile3: "corrupt-pending.wav", status: "אושר", notes: "ישן" }) };
    await withServer(rows, {
      lifecycleOverrides: {
        approvePending: function (id) {
          // מדמה כישלון אימות פורמט (isFormatReady=false) — לא נוגע בכלום.
          return { ok: false, status: 422, error: "הגרסה הממתינה אינה תקינה (מדומה)" };
        },
      },
    }, async function (baseUrl, harness) {
      const r = await putJson(baseUrl, "PAYMSG-3015", { status: "אושר", notes: "חדש — לא אמור להישמר" });
      assert.strictEqual(r.status, 422);
      assert.strictEqual(rows["PAYMSG-3015"].notes, "ישן", "notes לא עודכן — approvePending נכשל");
      assert.strictEqual(rows["PAYMSG-3015"].audioFile3, "corrupt-pending.wav", "audioFile3 גם לא נגע — approvePending עצמו כשל בלי לשנות DB");
      assert.strictEqual(harness.updateIvrAudioRecordingCalls.length, 0, "updateIvrAudioRecording לא נקרא בכלל — לא רק ש'לא הצליח', הוא מעולם לא הופעל");
    });
  });

  await check("[PUT — הממצא השלישי] בקשת אישור מוצלחת + notes באותה בקשה -> הקידום מצליח, notes לא משתנה, updateIvrAudioRecording לא נקרא בכלל, התשובה מחזירה את השורה המאושרת בפועל", async function () {
    const rows = { "PAYMSG-3016": makeRow({ category: "paymsg", audioFile1: "old-active.wav", audioFile3: "new-pending.wav", status: "אושר", notes: "ישן — לא אמור להשתנות" }) };
    await withServer(rows, {}, async function (baseUrl, harness) {
      const r = await putJson(baseUrl, "PAYMSG-3016", { status: "אושר", notes: "מנסים להחליק עדכון נוסף" });
      assert.strictEqual(r.status, 200, "האישור עצמו מצליח");
      assert.strictEqual(r.data.recording.audioFile3, "", "הקידום בוצע בפועל");
      assert.strictEqual(r.data.recording.audioFile1, "new-pending.wav");
      assert.strictEqual(r.data.recording.audioFile2, "old-active.wav");
      assert.strictEqual(r.data.recording.notes, "ישן — לא אמור להשתנות", "notes לא השתנה — בקשת אישור היא lifecycle-only, לא כולל עדכון שדות");
      assert.strictEqual(rows["PAYMSG-3016"].notes, "ישן — לא אמור להשתנות", "גם ב-DB עצמו — לא רק בתשובה");
      assert.strictEqual(harness.updateIvrAudioRecordingCalls.length, 0, "updateIvrAudioRecording לא נקרא בכלל אחרי approvePending — אין 'שלב שני' שיכול להיכשל בנפרד");
      assert.strictEqual(harness.approvePendingCalls.length, 1);
    });
  });

  // ── DELETE /:id/audio/:slot — ממצא 2 ────────────────────────────────────
  await check("[DELETE] שורת paymsg, slot=3 -> נכנס ל-rejectPending, audioFile3 מתרוקן דרך HTTP אמיתי", async function () {
    const rows = { "PAYMSG-3002": makeRow({ category: "paymsg", audioFile1: "active.wav", audioFile3: "pending.wav", status: "אושר" }) };
    await withServer(rows, {}, async function (baseUrl, harness) {
      const res = await fetch(baseUrl + "/api/admin/ivr-audio/PAYMSG-3002/audio/3", { method: "DELETE" });
      const data = await res.json();
      assert.strictEqual(res.status, 200);
      assert.strictEqual(data.recording.audioFile3, "");
      assert.strictEqual(harness.rejectPendingCalls.length, 1);
      assert.deepStrictEqual(harness.rejectPendingCalls, ["PAYMSG-3002"]);
    });
  });

  await check("[DELETE — category מה-DB, לא מהלקוח] שורה שאינה paymsg ממשיכה בנתיב הגנרי הקיים — rejectPending לא נקרא בכלל", async function () {
    const rows = { "OPEN-002": makeRow({ category: "open", audioFile1: "existing.wav" }) };
    await withServer(rows, { fileExistsOnDisk: true }, async function (baseUrl, harness) {
      const res = await fetch(baseUrl + "/api/admin/ivr-audio/OPEN-002/audio/1", { method: "DELETE" });
      const data = await res.json();
      assert.strictEqual(res.status, 200);
      assert.strictEqual(data.recording.audioFile1, "", "נמחק דרך הנתיב הגנרי (clearIvrAudioRecordingFileSlot)");
      assert.strictEqual(harness.rejectPendingCalls.length, 0, "rejectPending לא רלוונטי לשורה שאינה paymsg");
      assert.strictEqual(harness.fsUnlinkCalls.length, 1, "הנתיב הגנרי מוחק את הקובץ ישירות מהדיסק (בניגוד ל-rejectPending)");
    });
  });

  await check("[DELETE — נעילה משותפת] בקשה שנייה לאותו audioId בזמן שכבר נעול (סימולציה של פעולה מקבילה) מקבלת 409, לא נוגעת בכלום", async function () {
    const rows = { "PAYMSG-3003": makeRow({ category: "paymsg", audioFile3: "pending.wav", status: "חסר" }) };
    await withServer(rows, {}, async function (baseUrl, harness) {
      assert.strictEqual(paymsgLock.tryLock("PAYMSG-3003"), true, "מדמים פעולה אחרת שכבר תפסה את הנעילה");
      const res = await fetch(baseUrl + "/api/admin/ivr-audio/PAYMSG-3003/audio/3", { method: "DELETE" });
      const data = await res.json();
      assert.strictEqual(res.status, 409);
      assert.ok(data.error);
      assert.strictEqual(harness.rejectPendingCalls.length, 0, "לא הגיע בכלל ל-rejectPending בזמן שנעול");
      assert.strictEqual(rows["PAYMSG-3003"].audioFile3, "pending.wav", "שום דבר לא השתנה");
      paymsgLock.unlock("PAYMSG-3003");
    });
  });

  await check("[DELETE — unlock תמיד ב-finally] אחרי בקשה שנכשלה (rejectPending מחזיר ok:false), הנעילה עדיין משוחררת — בקשה הבאה לא נתקעת", async function () {
    const rows = { "PAYMSG-3004": makeRow({ category: "paymsg", status: "חסר" }) }; // אין audioFile3 -> rejectPending יכשל
    await withServer(rows, {}, async function (baseUrl) {
      const res1 = await fetch(baseUrl + "/api/admin/ivr-audio/PAYMSG-3004/audio/3", { method: "DELETE" });
      assert.strictEqual(res1.status, 400, "rejectPending נכשל כי אין audioFile3");
      const res2 = await fetch(baseUrl + "/api/admin/ivr-audio/PAYMSG-3004/audio/3", { method: "DELETE" });
      assert.strictEqual(res2.status, 400, "לא 409 — מוכיח שהנעילה שוחררה אחרי הכישלון הראשון");
    });
  });

  await check("[DELETE — עקיפת סלוט] שורת paymsg, ניסיון מחיקה בסלוט 1 (הפעיל) -> נדחה 400, rejectPending לא נקרא, שום דבר לא השתנה", async function () {
    const rows = { "PAYMSG-3005": makeRow({ category: "paymsg", audioFile1: "active.wav", status: "אושר" }) };
    await withServer(rows, {}, async function (baseUrl, harness) {
      const res = await fetch(baseUrl + "/api/admin/ivr-audio/PAYMSG-3005/audio/1", { method: "DELETE" });
      const data = await res.json();
      assert.strictEqual(res.status, 400);
      assert.ok(data.error);
      assert.strictEqual(harness.rejectPendingCalls.length, 0);
      assert.strictEqual(rows["PAYMSG-3005"].audioFile1, "active.wav", "הפעיל לא נגע");
    });
  });

  // ── POST /:id/restore-previous ───────────────────────────────────────────
  await check("[restore-previous] HTTP אמיתי — swap מוצלח, audioFile3/status לא זזים", async function () {
    const rows = { "PAYMSG-3006": makeRow({ category: "paymsg", audioFile1: "active.wav", audioFile2: "previous.wav", audioFile3: "pending.wav", status: "אושר" }) };
    await withServer(rows, {}, async function (baseUrl, harness) {
      const res = await fetch(baseUrl + "/api/admin/ivr-audio/PAYMSG-3006/restore-previous", { method: "POST" });
      const data = await res.json();
      assert.strictEqual(res.status, 200);
      assert.strictEqual(data.recording.audioFile1, "previous.wav");
      assert.strictEqual(data.recording.audioFile2, "active.wav");
      assert.strictEqual(data.recording.audioFile3, "pending.wav");
      assert.strictEqual(harness.restorePreviousCalls.length, 1);
    });
  });

  await check("[restore-previous — נעילה] בקשה בזמן שנעול חיצונית -> 409", async function () {
    const rows = { "PAYMSG-3007": makeRow({ category: "paymsg", audioFile1: "a.wav", audioFile2: "b.wav" }) };
    await withServer(rows, {}, async function (baseUrl) {
      paymsgLock.tryLock("PAYMSG-3007");
      const res = await fetch(baseUrl + "/api/admin/ivr-audio/PAYMSG-3007/restore-previous", { method: "POST" });
      assert.strictEqual(res.status, 409);
      paymsgLock.unlock("PAYMSG-3007");
    });
  });

  // ── סיכום ──────────────────────────────────────────────────────────────
  const failed = results.filter(function (r) { return !r.ok; });
  results.forEach(function (r) {
    console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : " — " + r.error));
  });
  console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");
  // process.exit() immediately after an http.Server#close() callback can
  // race libuv's own handle-teardown on Windows (UV_HANDLE_CLOSING
  // assertion) — setting exitCode and letting the event loop drain
  // naturally avoids it.
  process.exitCode = failed.length ? 1 : 0;
}

main();

// ivr-voice-messages.routes.test.js — REAL HTTP-level tests for the new
// screen's server endpoints: GET/PATCH /api/ivr/voice-messages and the
// Technoline audio-proxy GET /api/ivr/voice-messages/:id/audio. Covers auth
// gating, status validation (reusing the existing "ממתין"/"טופל" values —
// no new status system), and the audio proxy's handling of Technoline's
// documented "HTTP 200 with a plain-text body" failure mode (see
// ivrExtensionsApiDocs.html §fileDownload) without ever leaking
// TECHNOLINE_API_KEY or the Technoline URL to the client.
//
// Same require.main !== module + temp-DB-file pattern as server.routes.test.js
// — never opens the real data.sqlite, never starts app.listen() on the real
// PORT.
//
// הרצה: node ivr-voice-messages.routes.test.js

const assert = require("assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ivr-voice-messages-routes-test-"));
process.env.DB_PATH = path.join(tmpRoot, "test.sqlite");
delete process.env.NODE_ENV;
process.env.TECHNOLINE_API_KEY = "test-api-key";

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
  const contentType = res.headers.get("content-type") || "";
  let data = null;
  if (contentType.indexOf("application/json") !== -1) {
    try { data = await res.json(); } catch (_) {}
  }
  return { status: res.status, headers: res.headers, body: data, res: res };
}

// Swaps global.fetch for the duration of `fn`, restoring it afterward even
// if fn throws — used only to simulate Technoline's response for the audio
// proxy. Requests to our OWN test server (apiRequest above also uses
// global.fetch) are passed straight through to the real fetch — only the
// ipsales.co.il (Technoline) URL is intercepted.
async function withMockedFetch(technolineMockFn, fn) {
  const original = global.fetch;
  global.fetch = function (url, opts) {
    if (String(url).indexOf("ipsales.co.il") !== -1) return technolineMockFn(url, opts);
    return original(url, opts);
  };
  try {
    await fn();
  } finally {
    global.fetch = original;
  }
}

async function main() {
  server = http.createServer(app);
  await new Promise(function (resolve) { server.listen(0, "127.0.0.1", resolve); });
  baseUrl = "http://127.0.0.1:" + server.address().port;

  await check("[בטיחות] הבדיקה פועלת מול DB זמני, לא מול data.sqlite האמיתי", async function () {
    assert.ok(db.DB_PATH.indexOf(tmpRoot) === 0, "DB_PATH חייב להיות תחת תיקיית ה-tmp, לא הנתיב האמיתי");
  });

  // ── Auth setup (same dance as server.routes.test.js) ────────────────────────
  let adminToken;
  await check("[הכנה] התחברות כמנהל ברירת מחדל", async function () {
    const res = await apiRequest("POST", "/api/login", { workerId: 1, password: "1234" });
    assert.strictEqual(res.status, 200);
    adminToken = res.body.token;
  });

  await check("[הכנה] שינוי סיסמה חובה (כדי לפתוח גישה לשאר הנתיבים)", async function () {
    const res = await apiRequest("PUT", "/api/workers/me/password", { newPassword: "NewStr0ngPass!" }, adminToken);
    assert.strictEqual(res.status, 200);
  });

  // ── Fixtures: תורם ידוע + שתי הודעות (אחת עם תורם, אחת בלי) ──────────────────
  db.setAppState("donors", [{ id: 701, phone: "0501234567", fullName: "שרה לוי" }]);

  let knownMsgId, unknownMsgId, techAudioMsgId;
  await check("[הכנה] יצירת הודעה קולית מתורם מוכר + הודעה ממספר לא מוכר + הודעה עם technolineAudio", async function () {
    const known = db.saveIvrVoiceMessageOnce({
      pbxCallId: "ROUTE-TEST-KNOWN-1", phone: "0501234567", donorAppId: 701, donorName: "שרה לוי",
      fileName: "vm_ROUTE-TEST-KNOWN-1", extension: "9263",
    });
    const unknown = db.saveIvrVoiceMessageOnce({
      pbxCallId: "ROUTE-TEST-UNKNOWN-1", phone: "0509990000",
      fileName: "vm_ROUTE-TEST-UNKNOWN-1", extension: "9263",
    });
    // מדמה שורה שנשמרה עם השם שטכנוליין החזירה בפועל (FILE_voiceMessage) —
    // לא בהכרח זהה ל-fileName שביקשנו.
    const withTechAudio = db.saveIvrVoiceMessageOnce({
      pbxCallId: "ROUTE-TEST-TECHAUDIO-1", phone: "0501234567", donorAppId: 701, donorName: "שרה לוי",
      fileName: "vm_ROUTE-TEST-TECHAUDIO-1", technolineAudio: "vm_ROUTE-TEST-TECHAUDIO-1_xyz789", extension: "9263",
    });
    knownMsgId = known.id;
    unknownMsgId = unknown.id;
    techAudioMsgId = withTechAudio.id;
    assert.ok(knownMsgId && unknownMsgId && techAudioMsgId);
  });

  // ── GET list ──────────────────────────────────────────────────────────────

  await check("GET /api/ivr/voice-messages בלי Authorization -> 401", async function () {
    const res = await apiRequest("GET", "/api/ivr/voice-messages");
    assert.strictEqual(res.status, 401);
  });

  await check("GET /api/ivr/voice-messages עם טוקן תקין -> 200, כולל שתי ההודעות", async function () {
    const res = await apiRequest("GET", "/api/ivr/voice-messages", undefined, adminToken);
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body));
    const known = res.body.find(function (m) { return m.id === knownMsgId; });
    const unknown = res.body.find(function (m) { return m.id === unknownMsgId; });
    assert.ok(known, "ההודעה מהתורם המוכר חייבת להופיע ברשימה");
    assert.strictEqual(known.donorAppId, 701, "צריך לקשר לכרטיס התורם דרך donorAppId");
    assert.strictEqual(known.donorName, "שרה לוי");
    assert.ok(unknown, "ההודעה מהמספר הלא-מוכר חייבת להופיע ברשימה גם היא");
    assert.strictEqual(unknown.donorAppId, null, "מספר לא מזוהה מוצג כטלפון בלבד, בלי תורם מקושר");
    assert.strictEqual(unknown.phone, "0509990000");
  });

  // ── PATCH status ──────────────────────────────────────────────────────────

  await check("PATCH /api/ivr/voice-messages/:id בלי Authorization -> 401", async function () {
    const res = await apiRequest("PATCH", "/api/ivr/voice-messages/" + knownMsgId, { status: "טופל" });
    assert.strictEqual(res.status, 401);
  });

  await check("PATCH עם סטטוס לא קיים במערכת -> 400 (לא נוצרת מערכת סטטוסים כפולה)", async function () {
    const res = await apiRequest("PATCH", "/api/ivr/voice-messages/" + knownMsgId, { status: "בהמתנה_מומצא" }, adminToken);
    assert.strictEqual(res.status, 400);
  });

  await check("PATCH עם סטטוס תקין ('טופל') -> 200, ומשתקף מיד ב-GET הבא", async function () {
    const patchRes = await apiRequest("PATCH", "/api/ivr/voice-messages/" + knownMsgId, { status: "טופל" }, adminToken);
    assert.strictEqual(patchRes.status, 200);
    assert.strictEqual(patchRes.body.ok, true);

    const listRes = await apiRequest("GET", "/api/ivr/voice-messages", undefined, adminToken);
    const updated = listRes.body.find(function (m) { return m.id === knownMsgId; });
    assert.strictEqual(updated.status, "טופל");
  });

  await check("PATCH על id שלא קיים -> 404", async function () {
    const res = await apiRequest("PATCH", "/api/ivr/voice-messages/9999999", { status: "טופל" }, adminToken);
    assert.strictEqual(res.status, 404);
  });

  // ── Audio proxy ───────────────────────────────────────────────────────────

  await check("GET /api/ivr/voice-messages/:id/audio בלי Authorization -> 401", async function () {
    const res = await apiRequest("GET", "/api/ivr/voice-messages/" + knownMsgId + "/audio");
    assert.strictEqual(res.status, 401);
  });

  await check("GET .../audio על id שלא קיים -> 404 עם הודעה ברורה, לא קורס", async function () {
    const res = await apiRequest("GET", "/api/ivr/voice-messages/9999999/audio", undefined, adminToken);
    assert.strictEqual(res.status, 404);
    assert.ok(res.body && res.body.error);
  });

  await check("GET .../audio כשטכנוליין מחזיר קובץ אודיו תקין -> 200, Content-Type audio/mpeg, בייטים זהים", async function () {
    const fakeAudioBytes = Buffer.from([0x49, 0x44, 0x33, 0x01, 0x02, 0x03]); // fake MP3-ish bytes
    await withMockedFetch(
      async function (url) {
        assert.ok(String(url).indexOf("action=fileDownload") !== -1);
        assert.ok(String(url).indexOf("apiKey=test-api-key") !== -1);
        assert.ok(String(url).indexOf("fileName=vm_ROUTE-TEST-KNOWN-1") !== -1);
        return new Response(fakeAudioBytes, { status: 200, headers: { "content-type": "audio/mp3" } });
      },
      async function () {
        const res = await apiRequest("GET", "/api/ivr/voice-messages/" + knownMsgId + "/audio", undefined, adminToken);
        assert.strictEqual(res.status, 200);
        assert.ok((res.headers.get("content-type") || "").indexOf("audio") !== -1);
        const buf = Buffer.from(await res.res.arrayBuffer());
        assert.ok(buf.equals(fakeAudioBytes), "הבייטים שחוזרים ללקוח חייבים להיות זהים למה שטכנוליין החזירה");
      }
    );
  });

  await check("GET .../audio כשיש technolineAudio שמור -> משתמש ב-audio=<technolineAudio>, לא ב-fileName (הדרך המדויקת יותר לפי התיעוד)", async function () {
    const fakeAudioBytes = Buffer.from([0x49, 0x44, 0x33]);
    await withMockedFetch(
      async function (url) {
        assert.ok(String(url).indexOf("audio=vm_ROUTE-TEST-TECHAUDIO-1_xyz789") !== -1,
                   "צריך לחפש לפי technolineAudio, לא לפי fileName שביקשנו");
        assert.ok(String(url).indexOf("fileName=") === -1, "כשיש technolineAudio, אסור לשלוח גם fileName");
        return new Response(fakeAudioBytes, { status: 200, headers: { "content-type": "audio/mp3" } });
      },
      async function () {
        const res = await apiRequest("GET", "/api/ivr/voice-messages/" + techAudioMsgId + "/audio", undefined, adminToken);
        assert.strictEqual(res.status, 200);
      }
    );
  });

  await check("GET .../audio כשטכנוליין מחזירה 200 עם טקסט רגיל (קובץ לא קיים/פג תוקף) -> 404 ברור, לא קורס ולא מוגש כאודיו", async function () {
    await withMockedFetch(
      async function () {
        return new Response("file not found", { status: 200, headers: { "content-type": "text/plain" } });
      },
      async function () {
        const res = await apiRequest("GET", "/api/ivr/voice-messages/" + unknownMsgId + "/audio", undefined, adminToken);
        assert.strictEqual(res.status, 404);
        assert.ok(res.body && res.body.error, "חייבת לחזור הודעת שגיאה ברורה, לא גוף טקסט גולמי מטכנוליין");
      }
    );
  });

  await check("GET .../audio כשטכנוליין מחזירה שגיאת JSON תחת Content-Type: text/html (הצורה האמיתית שאומתה בבדיקת ייצור) -> 404 ברור, לא קורס", async function () {
    // אומת ישירות מול app.ipsales.co.il (ivrFilesApi.php) עם apiKey לא תקין:
    // {"status":"ERROR","note":"Unrecognized system"} מוגש עם
    // Content-Type: text/html; charset=UTF-8 — בדיוק כמו שבדיקת הייצור הראתה.
    await withMockedFetch(
      async function () {
        return new Response('{"status":"ERROR","note":"קובץ לא נמצא"}', {
          status: 200, headers: { "content-type": "text/html; charset=UTF-8" },
        });
      },
      async function () {
        const res = await apiRequest("GET", "/api/ivr/voice-messages/" + knownMsgId + "/audio", undefined, adminToken);
        assert.strictEqual(res.status, 404);
        assert.ok(res.body && res.body.error);
      }
    );
  });

  await check("GET .../audio כשטכנוליין לא זמינה (שגיאת רשת) -> 502 ברור, לא 500 גנרי ולא קורס", async function () {
    await withMockedFetch(
      async function () { throw new Error("network unreachable"); },
      async function () {
        const res = await apiRequest("GET", "/api/ivr/voice-messages/" + knownMsgId + "/audio", undefined, adminToken);
        assert.strictEqual(res.status, 502);
        assert.ok(res.body && res.body.error);
      }
    );
  });

  await check("GET .../audio כש-TECHNOLINE_API_KEY לא מוגדר -> 503 עם הודעה ברורה, לא זורק apiKey ריק לטכנוליין", async function () {
    const original = process.env.TECHNOLINE_API_KEY;
    delete process.env.TECHNOLINE_API_KEY;
    try {
      const res = await apiRequest("GET", "/api/ivr/voice-messages/" + knownMsgId + "/audio", undefined, adminToken);
      assert.strictEqual(res.status, 503);
    } finally {
      process.env.TECHNOLINE_API_KEY = original;
    }
  });

  // ── PII redaction in /ivr logs (production found phone numbers printed in
  // full — sanitizeIvrQueryForLog used to skip redaction whenever NODE_ENV
  // wasn't exactly "production" or IVR_DEBUG was set, which is exactly the
  // situation a live debugging session runs under) ────────────────────────────

  const ivrKey = process.env.IVR_KEY; // populated by dotenv when ./server was required above
  const testPhone = "0507654321";

  await check("GET /ivr עם voiceMessage: מספר הטלפון לעולם לא מודפס גלוי בלוג השרת, גם כשההודעה בכל זאת נשמרת כראוי", async function () {
    if (!ivrKey) return; // no IVR_KEY configured in this environment — nothing to verify against

    const originalLog = console.log;
    const captured = [];
    console.log = function (...args) { captured.push(args.map(String).join(" ")); };
    try {
      const res = await fetch(
        baseUrl + "/ivr?ivrKey=" + encodeURIComponent(ivrKey) +
        "&PBXphone=" + testPhone + "&PBXcallId=CALL-PII-LOG-1&PBXextensionId=9263&voiceMessage=1",
        { method: "GET" }
      );
      assert.strictEqual(res.status, 200);
    } finally {
      console.log = originalLog;
    }

    const joined = captured.join("\n");
    assert.ok(joined.indexOf(testPhone) === -1, "מספר הטלפון הגולמי הופיע בלוג השרת — הוא היה חייב להיות מצונזר");

    // מוודא שהמספר בכל זאת עובד בפועל (לא נבלע/נשבר) — נשמר ב-DB כרגיל.
    const row = db.listIvrVoiceMessages({ limit: 1000 }).find(function (r) { return r.pbxCallId === "CALL-PII-LOG-1"; });
    assert.ok(row, "ההודעה עדיין חייבת להישמר כרגיל — הצנזור הוא רק בלוג, לא בפונקציונליות");
    assert.strictEqual(row.phone, testPhone);
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

// ivr-phone-log-redaction.test.js — dedicated, broader coverage for the
// central IVR log-redaction fix (ivr.service.js mask()/callIdLogSafe()).
//
// ivr-voice-messages.routes.test.js already proves this for the
// voice_message step specifically. This file proves the SAME guarantee
// holds across every other step that goes through the same shared mask()
// helper (identification, payment, the missing-PBXcallId fallback path) —
// since the fix is centralized in one function, this is what proves the
// fix is actually central and not just patched for the one step a test
// happened to already cover.
//
// Also proves the fix is UNCONDITIONAL: unlike before, these assertions
// hold with NODE_ENV unset AND with IVR_DEBUG=true — the exact two
// conditions that used to disable masking entirely.
//
// הרצה: node ivr-phone-log-redaction.test.js

const assert = require("assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ivr-phone-log-redaction-test-"));
process.env.DB_PATH = path.join(tmpRoot, "test.sqlite");
delete process.env.NODE_ENV;
process.env.IVR_DEBUG = "true"; // the exact escape hatch that used to disable masking — must have NO effect now

const app = require("./server");
const db = require("./db");

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, error: err.stack || err.message });
  }
}

let server, baseUrl;

async function apiRequest(method, urlPath, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(baseUrl + urlPath, {
    method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, body: data };
}

// Captures every console.log/warn/error call made during fn(), across all
// three streams (the leak in the original bug was via console.log, but
// mask() is also used from console.warn/error call sites — e.g. the
// missing-PBXcallId fallback warning).
async function captureAllConsole(fn) {
  const originalLog = console.log, originalWarn = console.warn, originalError = console.error;
  const captured = [];
  const record = (...args) => captured.push(args.map(String).join(" "));
  console.log = record; console.warn = record; console.error = record;
  try {
    await fn();
  } finally {
    console.log = originalLog; console.warn = originalWarn; console.error = originalError;
  }
  return captured;
}

async function ivrGet(qs) {
  return fetch(baseUrl + "/ivr?" + qs, { method: "GET" });
}

async function main() {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = "http://127.0.0.1:" + server.address().port;

  await check("[בטיחות] הבדיקה פועלת מול DB זמני, לא מול data.sqlite האמיתי", async () => {
    assert.ok(db.DB_PATH.indexOf(tmpRoot) === 0);
  });

  const ivrKey = process.env.IVR_KEY;
  if (!ivrKey) {
    console.log("(skip: IVR_KEY not configured in this environment — nothing to verify against)");
  } else {
    const phone1 = "0509990001";
    await check("שלב identification: מספר הטלפון לא מודפס גלוי בשום שורת לוג", async () => {
      const lines = await captureAllConsole(async () => {
        const res = await ivrGet("ivrKey=" + encodeURIComponent(ivrKey) +
          "&PBXphone=" + phone1 + "&PBXcallId=CALL-REDACT-IDENT-1");
        assert.strictEqual(res.status, 200);
      });
      const joined = lines.join("\n");
      assert.ok(joined.indexOf(phone1) === -1, "מספר הטלפון דלף בשלב identification:\n" + joined);
      assert.ok(joined.indexOf("CALL-REDACT-IDENT-1") !== -1, "callId אמיתי היה אמור להישאר גלוי בלוג (לא PII)");
    });

    const phone2 = "0509990002";
    await check("שלב payment: מספר הטלפון לא מודפס גלוי בשום שורת לוג, גם כשהתשלום נכשל/נדחה", async () => {
      const lines = await captureAllConsole(async () => {
        const res = await ivrGet("ivrKey=" + encodeURIComponent(ivrKey) +
          "&PBXphone=" + phone2 + "&PBXcallId=CALL-REDACT-PAY-1" +
          "&identChoice=1&mainChoice=1&payChoice=1" +
          "&payment=OK&amount=250&CONFIRM_payment=9999");
        // Any status is fine here (donor likely unresolved in a fresh temp
        // DB) — the point is what got logged along the way, not the result.
        assert.ok(res.status === 200 || res.status === 400 || res.status === 500);
      });
      const joined = lines.join("\n");
      assert.ok(joined.indexOf(phone2) === -1, "מספר הטלפון דלף בשלב payment:\n" + joined);
    });

    await check("callId חסר (fallback) -> אזהרת ה-fallback לא חושפת את הטלפון הגולמי, אבל עדיין מזהה שמדובר ב-fallback", async () => {
      const phone3 = "0509990003";
      const lines = await captureAllConsole(async () => {
        // Deliberately omit PBXcallId to trigger the "phone-<phone>" fallback.
        const res = await ivrGet("ivrKey=" + encodeURIComponent(ivrKey) + "&PBXphone=" + phone3);
        assert.strictEqual(res.status, 200);
      });
      const joined = lines.join("\n");
      assert.ok(joined.indexOf(phone3) === -1, "הטלפון הגולמי דלף דרך ה-callId הנופל ל-fallback:\n" + joined);
      assert.ok(joined.indexOf("phone-[REDACTED]") !== -1, "אזהרת ה-fallback הייתה אמורה להראות placeholder מזוהה, לא להיעלם לגמרי");
    });

    await check("IVR_DEBUG=true (המנגנון הישן שביטל צנזור לגמרי) -> עדיין אין דליפה", async () => {
      assert.strictEqual(process.env.IVR_DEBUG, "true", "בדיקה זו חייבת לרוץ עם IVR_DEBUG=true כדי להוכיח שהתיקון בלתי-תלוי בדגל הזה");
      const phone4 = "0509990004";
      const lines = await captureAllConsole(async () => {
        const res = await ivrGet("ivrKey=" + encodeURIComponent(ivrKey) +
          "&PBXphone=" + phone4 + "&PBXcallId=CALL-REDACT-DEBUG-1&voiceMessage=1");
        assert.strictEqual(res.status, 200);
      });
      const joined = lines.join("\n");
      assert.ok(joined.indexOf(phone4) === -1, "IVR_DEBUG=true עדיין גורם לדליפה — התיקון לא באמת בלתי-תלוי בסביבה:\n" + joined);
    });
  }

  // ── סיכום ────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  results.forEach((r) => {
    console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : "\n    " + r.error));
  });
  console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");

  await new Promise((resolve) => server.close(resolve));
  process.exitCode = failed.length ? 1 : 0;
}

main();

// ivr-pregreeting.service.test.js — pure unit tests for the temporary
// "pre-greeting" IVR message: schedule/enabled gating (isPregreetingActiveNow),
// Asia/Jerusalem "now" formatting, schedule value validation, and the
// dependency-injected resolver core (createPregreetingResolver) — all with
// FAKE deps, exactly like ivr-audio-resolver.service.test.js. No DB, no fs,
// no network. requiring this module must never touch anything real.
//
// הרצה: node ivr-pregreeting.service.test.js

const assert = require("assert");
const pregreeting = require("./ivr-pregreeting.service");

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name: name, ok: true });
  } catch (err) {
    results.push({ name: name, ok: false, error: err.stack || err.message });
  }
}

// ── isPregreetingActiveNow ────────────────────────────────────────────────

check("אין שורה בכלל -> לא פעילה", function () {
  assert.strictEqual(pregreeting.isPregreetingActiveNow(null), false);
});

check("enabled=0 -> לא פעילה גם עם קובץ מאושר", function () {
  const row = { enabled: 0, audioFile1: "a.wav", status: "אושר" };
  assert.strictEqual(pregreeting.isPregreetingActiveNow(row), false);
});

check("enabled=1 אבל אין audioFile1 -> לא פעילה", function () {
  const row = { enabled: 1, audioFile1: "", status: "אושר" };
  assert.strictEqual(pregreeting.isPregreetingActiveNow(row), false);
});

check("enabled=1 + קובץ, אבל status != 'אושר' -> לא פעילה", function () {
  const row = { enabled: 1, audioFile1: "a.wav", status: "הוקלט" };
  assert.strictEqual(pregreeting.isPregreetingActiveNow(row), false);
});

check("enabled=1 + קובץ מאושר, בלי שום טווח זמן -> פעילה (הפעלה/כיבוי ידניים)", function () {
  const row = { enabled: 1, audioFile1: "a.wav", status: "אושר" };
  assert.strictEqual(pregreeting.isPregreetingActiveNow(row, "2026-07-28T10:00"), true);
});

check("טרם הגיע מועד ההתחלה -> לא פעילה", function () {
  const row = { enabled: 1, audioFile1: "a.wav", status: "אושר", startAt: "2026-08-01T00:00" };
  assert.strictEqual(pregreeting.isPregreetingActiveNow(row, "2026-07-28T10:00"), false);
});

check("בתוך הטווח (יש רק startAt, כבר עבר) -> פעילה", function () {
  const row = { enabled: 1, audioFile1: "a.wav", status: "אושר", startAt: "2026-01-01T00:00" };
  assert.strictEqual(pregreeting.isPregreetingActiveNow(row, "2026-07-28T10:00"), true);
});

check("מועד הסיום עבר -> לא פעילה (מפסיקה אוטומטית)", function () {
  const row = { enabled: 1, audioFile1: "a.wav", status: "אושר", endAt: "2026-01-01T00:00" };
  assert.strictEqual(pregreeting.isPregreetingActiveNow(row, "2026-07-28T10:00"), false);
});

check("בתוך טווח מלא (start<=now<=end) -> פעילה", function () {
  const row = { enabled: 1, audioFile1: "a.wav", status: "אושר", startAt: "2026-07-01T00:00", endAt: "2026-08-01T00:00" };
  assert.strictEqual(pregreeting.isPregreetingActiveNow(row, "2026-07-28T10:00"), true);
});

check("בדיוק על גבול ההתחלה (now === startAt) -> פעילה (כולל)", function () {
  const row = { enabled: 1, audioFile1: "a.wav", status: "אושר", startAt: "2026-07-28T10:00" };
  assert.strictEqual(pregreeting.isPregreetingActiveNow(row, "2026-07-28T10:00"), true);
});

check("בדיוק על גבול הסיום (now === endAt) -> פעילה (כולל)", function () {
  const row = { enabled: 1, audioFile1: "a.wav", status: "אושר", endAt: "2026-07-28T10:00" };
  assert.strictEqual(pregreeting.isPregreetingActiveNow(row, "2026-07-28T10:00"), true);
});

// ── isValidScheduleValue ─────────────────────────────────────────────────

check("isValidScheduleValue: ריק/null/undefined -> תקין (ללא הגבלה)", function () {
  assert.strictEqual(pregreeting.isValidScheduleValue(""), true);
  assert.strictEqual(pregreeting.isValidScheduleValue(null), true);
  assert.strictEqual(pregreeting.isValidScheduleValue(undefined), true);
});

check("isValidScheduleValue: פורמט תקין YYYY-MM-DDTHH:mm -> תקין", function () {
  assert.strictEqual(pregreeting.isValidScheduleValue("2026-07-28T10:00"), true);
});

check("isValidScheduleValue: טקסט חופשי / פורמט שגוי -> לא תקין", function () {
  assert.strictEqual(pregreeting.isValidScheduleValue("not-a-date"), false);
  assert.strictEqual(pregreeting.isValidScheduleValue("2026-07-28"), false);
  assert.strictEqual(pregreeting.isValidScheduleValue("2026/07/28 10:00"), false);
});

check("isValidScheduleValue: תאריך לא אמיתי (חודש 13) -> לא תקין", function () {
  assert.strictEqual(pregreeting.isValidScheduleValue("2026-13-01T10:00"), false);
});

// ── nowInJerusalem ───────────────────────────────────────────────────────

check("nowInJerusalem: פורמט תקין YYYY-MM-DDTHH:mm", function () {
  const s = pregreeting.nowInJerusalem(new Date("2026-07-28T10:00:00.000Z"));
  assert.match(s, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
});

check("nowInJerusalem: UTC 22:00 ביולי (קיץ, UTC+3) -> 01:00 למחרת", function () {
  const s = pregreeting.nowInJerusalem(new Date("2026-07-27T22:00:00.000Z"));
  assert.strictEqual(s, "2026-07-28T01:00");
});

// ── createPregreetingResolver (DI, בלי DB/דיסק/רשת אמיתיים) ─────────────────

// isPathContained/fileExists deliberately don't depend on the platform's
// real path.resolve() output (Windows vs POSIX) — they key purely off the
// filename via a synthetic "FAKE:<filename>" marker, so these tests behave
// identically on any OS. uploadDir itself is irrelevant to the fake, exactly
// like the real isPathContained's uploadDir is opaque to its caller.
function makeDeps(overrides) {
  const files = (overrides && overrides.files) || {};
  return Object.assign({
    getRow: function () {
      return { enabled: 1, audioFile1: "pregreet-abc.wav", status: "אושר", startAt: null, endAt: null };
    },
    fileExists: function (p) { return !!files[p]; },
    isPathContained: function (uploadDir, filename) {
      if (!filename) return { ok: false, resolvedPath: null };
      return { ok: true, resolvedPath: "FAKE:" + filename };
    },
    computeDerivedFilename: function (filename) { return filename.replace(/\.[^.]+$/, "") + "-pcm8k.wav"; },
    uploadDir: "/uploads/ivr-audio",
    baseUrl: "https://example.test/uploads/ivr-audio",
    now: "2026-07-28T10:00",
    log: function () {},
  }, overrides || {});
}

check("resolver: לא פעילה (enabled=0) -> [] (מדלגים, בלי טקסט חלופי)", function () {
  const resolver = pregreeting.createPregreetingResolver(makeDeps({
    getRow: function () { return { enabled: 0, audioFile1: "x.wav", status: "אושר" }; },
  }));
  assert.deepStrictEqual(resolver.buildPregreetingFiles(), []);
});

check("resolver: פעילה + יש נגזרת PCM8k תקינה על הדיסק -> קובץ הנגזרת (מועדף)", function () {
  const deps = makeDeps({ files: { "FAKE:pregreet-abc-pcm8k.wav": true } });
  const resolver = pregreeting.createPregreetingResolver(deps);
  const result = resolver.buildPregreetingFiles();
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].fileName, "pregreet-abc-pcm8k");
  assert.strictEqual(result[0].fileLink, "https://example.test/uploads/ivr-audio/pregreet-abc-pcm8k.wav");
});

check("resolver: אין נגזרת, אבל המקור עצמו .wav וקיים -> המקור מתקבל כמו שהוא", function () {
  const deps = makeDeps({ files: { "FAKE:pregreet-abc.wav": true } });
  const resolver = pregreeting.createPregreetingResolver(deps);
  const result = resolver.buildPregreetingFiles();
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].fileName, "pregreet-abc");
});

check("resolver: אין נגזרת, המקור לא .wav (למשל .mp3 שמעולם לא הומר) -> [] בלי fallback", function () {
  const deps = makeDeps({
    getRow: function () { return { enabled: 1, audioFile1: "pregreet-abc.mp3", status: "אושר" }; },
    files: {}, // no derived file exists either
  });
  const resolver = pregreeting.createPregreetingResolver(deps);
  assert.deepStrictEqual(resolver.buildPregreetingFiles(), []);
});

check("resolver: הקובץ לא קיים בכלל על הדיסק (רשומה יתומה) -> [] בבטחה, לא זורק", function () {
  const deps = makeDeps({ files: {} });
  const resolver = pregreeting.createPregreetingResolver(deps);
  assert.deepStrictEqual(resolver.buildPregreetingFiles(), []);
});

check("resolver: isPathContained נכשל (path traversal חשוד) -> [] בבטחה", function () {
  const deps = makeDeps({
    isPathContained: function () { return { ok: false, resolvedPath: null }; },
    files: { "/uploads/ivr-audio/pregreet-abc.wav": true },
  });
  const resolver = pregreeting.createPregreetingResolver(deps);
  assert.deepStrictEqual(resolver.buildPregreetingFiles(), []);
});

check("resolver: deps.getRow() זורק חריגה -> [] בבטחה, לא קורס את השיחה", function () {
  const deps = makeDeps({ getRow: function () { throw new Error("db boom"); } });
  const resolver = pregreeting.createPregreetingResolver(deps);
  assert.deepStrictEqual(resolver.buildPregreetingFiles(), []);
});

check("resolver: מחוץ לטווח הזמן (הסתיים) -> [] גם אם הקובץ תקין ומאושר", function () {
  const deps = makeDeps({
    getRow: function () {
      return { enabled: 1, audioFile1: "pregreet-abc.wav", status: "אושר", endAt: "2020-01-01T00:00" };
    },
    files: { "/uploads/ivr-audio/pregreet-abc.wav": true },
  });
  const resolver = pregreeting.createPregreetingResolver(deps);
  assert.deepStrictEqual(resolver.buildPregreetingFiles(), []);
});

// ── סיכום ────────────────────────────────────────────────────────────────
const failed = results.filter(function (r) { return !r.ok; });
results.forEach(function (r) {
  console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : " — " + r.error));
});
console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");
process.exitCode = failed.length ? 1 : 0;

// ivr-voice-messages.service.test.js — covers the actual voicemail-save path
// used by real IVR calls: handleIvrQuery() (ivr.service.js) reaching
// step==="voice_message" -> saveVoiceMessageOnce() -> db.saveIvrVoiceMessageOnce().
// Also covers the raw db.js functions directly (dedup, status update).
//
// Uses a TEMPORARY sqlite file (own os.tmpdir() path, set via DB_PATH before
// requiring db.js) — same pattern as payment.service.test.js. Never opens
// the real data.sqlite.
//
// הרצה: node ivr-voice-messages.service.test.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ivr-voice-messages-test-"));
process.env.DB_PATH = path.join(tmpRoot, "test.sqlite");
delete process.env.NODE_ENV;

const db = require("./db");
const { handleIvrQuery } = require("./ivr.service");

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name: name, ok: true });
  } catch (err) {
    results.push({ name: name, ok: false, error: err.stack || err.message });
  }
}

check("[בטיחות] הבדיקה פועלת מול DB זמני, לא מול data.sqlite האמיתי", function () {
  assert.ok(db.DB_PATH.indexOf(tmpRoot) === 0, "DB_PATH חייב להיות תחת תיקיית ה-tmp, לא הנתיב האמיתי");
});

// ── Fixture: תורם ידוע ב-app_state (כמו donors.json בפועל) ───────────────────
db.setAppState("donors", [
  { id: 501, phone: "0501112222", fullName: "יעקב כהן (תורם ידוע)" },
]);

// ── db.saveIvrVoiceMessageOnce / listIvrVoiceMessages / updateIvrVoiceMessageStatus ──

check("saveIvrVoiceMessageOnce: קריאה ראשונה יוצרת רשומה עם סטטוס ברירת מחדל 'ממתין'", function () {
  var result = db.saveIvrVoiceMessageOnce({
    pbxCallId: "VM-DEDUP-001", phone: "0501111111", fileName: "vm_VM-DEDUP-001",
  });
  assert.strictEqual(result.duplicate, false);
  var row = db.getIvrVoiceMessageById(result.id);
  assert.strictEqual(row.status, "ממתין");
  assert.strictEqual(row.phone, "0501111111");
});

check("saveIvrVoiceMessageOnce: אותו pbxCallId פעמיים => duplicate:true, בלי רשומה כפולה (מניעת כפילות מטכנוליין)", function () {
  var callId = "VM-DEDUP-002";
  var first  = db.saveIvrVoiceMessageOnce({ pbxCallId: callId, phone: "0502222222", fileName: "vm_a" });
  var second = db.saveIvrVoiceMessageOnce({ pbxCallId: callId, phone: "0502222222", fileName: "vm_a" });
  assert.strictEqual(first.duplicate, false);
  assert.strictEqual(second.duplicate, true);
  assert.strictEqual(first.id, second.id);

  var all = db.listIvrVoiceMessages({ limit: 1000 });
  var matching = all.filter(function (r) { return r.pbxCallId === callId; });
  assert.strictEqual(matching.length, 1, "אסור שתיווצר רשומה כפולה עבור אותו callId");
});

check("saveIvrVoiceMessageOnce: שני callId שונים מאותו טלפון => שתי רשומות נפרדות", function () {
  var a = db.saveIvrVoiceMessageOnce({ pbxCallId: "VM-SAMEPHONE-A", phone: "0503333333", fileName: "vm_1" });
  var b = db.saveIvrVoiceMessageOnce({ pbxCallId: "VM-SAMEPHONE-B", phone: "0503333333", fileName: "vm_2" });
  assert.strictEqual(a.duplicate, false);
  assert.strictEqual(b.duplicate, false);
  assert.notStrictEqual(a.id, b.id);
});

check("updateIvrVoiceMessageStatus: מעדכן ל-'טופל' ומחזיר true", function () {
  var r = db.saveIvrVoiceMessageOnce({ pbxCallId: "VM-STATUS-001", phone: "0504444444", fileName: "vm_s" });
  var updated = db.updateIvrVoiceMessageStatus(r.id, "טופל");
  assert.strictEqual(updated, true);
  assert.strictEqual(db.getIvrVoiceMessageById(r.id).status, "טופל");
});

check("updateIvrVoiceMessageStatus: סטטוס לא קיים במערכת נדחה (לא נוצרת מערכת סטטוסים כפולה)", function () {
  var r = db.saveIvrVoiceMessageOnce({ pbxCallId: "VM-STATUS-002", phone: "0505555555", fileName: "vm_x" });
  assert.throws(function () { db.updateIvrVoiceMessageStatus(r.id, "בהמתנה_מומצא"); });
});

check("updateIvrVoiceMessageStatus: id שלא קיים מחזיר false, לא זורק", function () {
  assert.strictEqual(db.updateIvrVoiceMessageStatus(999999, "טופל"), false);
});

check("createdAt נשמר כ-ISO תקין שמתפרש נכון תחת Asia/Jerusalem", function () {
  var r = db.saveIvrVoiceMessageOnce({ pbxCallId: "VM-TZ-001", phone: "0506666666", fileName: "vm_tz" });
  var row = db.getIvrVoiceMessageById(r.id);
  assert.ok(!isNaN(new Date(row.createdAt).getTime()), "createdAt חייב להיות תאריך ISO תקין");
  // מוודא שההמרה ל-Asia/Jerusalem לא זורקת ומניבה מחרוזת תקינה (זהה לתבנית
  // שה-frontend (phone.js) משתמש בה בפועל).
  var formatted = new Date(row.createdAt).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem", hour12: false });
  assert.ok(typeof formatted === "string" && formatted.length > 0);
});

// ── handleIvrQuery(): המסלול האמיתי מ-/ivr ועד לשמירה ב-DB ───────────────────

function accumulatedVoiceMessageQuery(overrides) {
  return Object.assign({
    PBXcallId: "CALL-VM-INT-1",
    PBXphone:  "0501112222",
    mainChoice: "3",
    identChoice: "1", // מזוהה כתורם עצמו (self) — הגיע דרך התפריט הראשי
    voiceMessage: "1",
    FILEID_voiceMessage: "999",
    PATH_voiceMessage: "/rec/vm_CALL-VM-INT-1.wav",
    DURATION_voiceMessage: "12",
    SIZE_voiceMessage: "0.3",
  }, overrides || {});
}

check("handleIvrQuery: הודעה מתורם מוכר (ANI תואם) => נשמרת עם donorAppId מקושר", function () {
  var q = accumulatedVoiceMessageQuery();
  var result = handleIvrQuery(q);
  assert.ok(result.response, "עדיין חייב להחזיר תשובת IVR תקינה לשיחה");

  var rows = db.listIvrVoiceMessages({ limit: 1000 }).filter(function (r) { return r.pbxCallId === "CALL-VM-INT-1"; });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].donorAppId, 501);
  assert.strictEqual(rows[0].donorName, "יעקב כהן (תורם ידוע)");
  assert.strictEqual(rows[0].phone, "0501112222");
  assert.strictEqual(rows[0].status, "ממתין");
});

check("handleIvrQuery: הודעה ממספר לא מוכר (ANI לא תואם אף תורם) => נשמרת בלי donorAppId, בלי יצירת תורם חדש", function () {
  var q = accumulatedVoiceMessageQuery({
    PBXcallId: "CALL-VM-UNKNOWN-1",
    PBXphone:  "0509998888", // לא קיים ברשימת התורמים
  });
  handleIvrQuery(q);

  var rows = db.listIvrVoiceMessages({ limit: 1000 }).filter(function (r) { return r.pbxCallId === "CALL-VM-UNKNOWN-1"; });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].donorAppId, null);
  assert.strictEqual(rows[0].phone, "0509998888");

  // לא נוצר תורם חדש עבור המספר הזה.
  var donorsAfter = db.getAppState("donors");
  var created = donorsAfter.find(function (d) { return String(d.phone) === "0509998888"; });
  assert.strictEqual(created, undefined, "אסור שהמערכת תיצור תורם חדש עבור מתקשר לא מזוהה");
});

check("handleIvrQuery: מתקשר שהגיע ל-max_attempts (לא הזדהה בכלל) => voicemail נשמר, donorAppId=null", function () {
  var q = {
    PBXcallId: "CALL-VM-MAXATT-1",
    PBXphone:  "0507770000",
    selfIdentInput: ["x", "y", "z"], // 3 ניסיונות כושלים -> max_attempts
    voiceMessage: "1",
  };
  var result = handleIvrQuery(q);
  assert.ok(result.response);

  var rows = db.listIvrVoiceMessages({ limit: 1000 }).filter(function (r) { return r.pbxCallId === "CALL-VM-MAXATT-1"; });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].donorAppId, null);
  assert.strictEqual(rows[0].phone, "0507770000");
});

check("handleIvrQuery: טכנוליין שולחת את אותה הודעה (אותו PBXcallId) פעמיים => רשומה אחת בלבד", function () {
  var q = accumulatedVoiceMessageQuery({ PBXcallId: "CALL-VM-RETRY-1" });
  handleIvrQuery(q);
  handleIvrQuery(Object.assign({}, q)); // בקשה שנייה חוזרת עם אותם פרמטרים מצטברים

  var rows = db.listIvrVoiceMessages({ limit: 1000 }).filter(function (r) { return r.pbxCallId === "CALL-VM-RETRY-1"; });
  assert.strictEqual(rows.length, 1, "אותו callId פעמיים חייב ליצור רשומה אחת בדיוק");
});

check("handleIvrQuery: שתי הודעות שונות מאותו מספר (callId שונה לכל אחת) => שתי רשומות נפרדות", function () {
  var phone = "0503334444";
  handleIvrQuery(accumulatedVoiceMessageQuery({ PBXcallId: "CALL-VM-TWICE-A", PBXphone: phone, identChoice: undefined }));
  handleIvrQuery(accumulatedVoiceMessageQuery({ PBXcallId: "CALL-VM-TWICE-B", PBXphone: phone, identChoice: undefined }));

  var rows = db.listIvrVoiceMessages({ limit: 1000 }).filter(function (r) { return r.phone === phone; });
  assert.strictEqual(rows.length, 2, "שתי שיחות נפרדות מאותו מספר חייבות ליצור שתי הודעות נפרדות");
  assert.notStrictEqual(rows[0].pbxCallId, rows[1].pbxCallId);
});

check("handleIvrQuery: PBXcallId חסר => נופל בחזרה ל-callId מבוסס-טלפון (כמו שאר הזרימה), עדיין נשמר ולא קורס", function () {
  var q = accumulatedVoiceMessageQuery({ PBXcallId: undefined, PBXphone: "0501112222", identChoice: undefined });
  var result;
  assert.doesNotThrow(function () { result = handleIvrQuery(q); });
  assert.ok(result.response, "התשובה למתקשר לא קורסת גם כש-PBXcallId חסר");

  var rows = db.listIvrVoiceMessages({ limit: 1000 }).filter(function (r) { return r.pbxCallId === "phone-0501112222"; });
  assert.strictEqual(rows.length, 1, "callId הנופל-בחזרה (phone-<מספר>) — אותו מנגנון כמו שאר ivr.service.js — עדיין נשמר");
});

// ═══ סיכום ═══════════════════════════════════════════════════════════════════
const failed = results.filter(function (r) { return !r.ok; });
results.forEach(function (r) {
  console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : " — " + r.error));
});
console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");
process.exit(failed.length ? 1 : 0);

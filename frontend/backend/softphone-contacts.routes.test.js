// softphone-contacts.routes.test.js — REAL HTTP-level tests for the
// softphone contacts endpoints (GET/POST/PUT/DELETE /api/softphone/contacts).
// Covers: donor contacts are read live from app_state.donors (never
// duplicated into a table), custom-contact CRUD, duplicate-phone prevention
// (primary vs additional, across contacts), phone normalization (leading
// zero preserved), search by name/phone, donor-vs-custom tagging, role
// permissions, and audit logging on create/update/delete.
//
// Same require.main !== module + temp-DB-file pattern as server.routes.test.js.
//
// הרצה: node softphone-contacts.routes.test.js

const assert = require("assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "softphone-contacts-routes-test-"));
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
    const created = await apiRequest("POST", "/api/workers", { name: "מזכירה בדיקה 2", role: "מזכיר", password: "SecPass1!" }, adminToken);
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const login = await apiRequest("POST", "/api/login", { workerId: created.body.id, password: "SecPass1!" });
    secretaryToken = login.body.token;
    const pw = await apiRequest("PUT", "/api/workers/me/password", { newPassword: "NewSecPass1!" }, secretaryToken);
    assert.strictEqual(pw.status, 200);
  });

  // Two donors with several phone fields each — exercises "all valid phone
  // fields" + the merge-not-duplicate requirement.
  db.setAppState("donors", [
    { id: 701, phone: "0501112222", phone2: "0301234567", fullName: "תורם ראשון" },
    { id: 702, phone: "0503334444", ivrApprovedPhones: ["0509998888"], fullName: "תורם שני" },
  ]);

  // ── Donors merged live, never duplicated ─────────────────────────────────────

  await check("GET /api/softphone/contacts: תורמים מוצגים אוטומטית עם type=donor, כולל כל שדות הטלפון", async function () {
    const r = await apiRequest("GET", "/api/softphone/contacts", undefined, secretaryToken);
    assert.strictEqual(r.status, 200);
    const donor1 = r.body.contacts.find(function (c) { return c.type === "donor" && c.id === 701; });
    assert.ok(donor1, "תורם 701 חייב להופיע ברשימת אנשי הקשר");
    assert.deepStrictEqual(donor1.phones.sort(), ["0301234567", "0501112222"].sort());
    const donor2 = r.body.contacts.find(function (c) { return c.type === "donor" && c.id === 702; });
    assert.deepStrictEqual(donor2.phones.sort(), ["0503334444", "0509998888"].sort());
  });

  await check("שינוי donors ב-app_state ישירות מתעדכן ברשימת אנשי הקשר (אין העתקה לטבלה נפרדת)", async function () {
    db.setAppState("donors", [
      { id: 701, phone: "0501112222", phone2: "0301234567", fullName: "תורם ראשון - שם עודכן" },
      { id: 702, phone: "0503334444", ivrApprovedPhones: ["0509998888"], fullName: "תורם שני" },
    ]);
    const r = await apiRequest("GET", "/api/softphone/contacts", undefined, secretaryToken);
    const donor1 = r.body.contacts.find(function (c) { return c.type === "donor" && c.id === 701; });
    assert.strictEqual(donor1.name, "תורם ראשון - שם עודכן",
      "רשימת אנשי הקשר חייבת לשקף שינוי מיידי ב-app_state.donors — הוכחה שאין העתקה לטבלה נפרדת");
  });

  // ── Donor search across idNumber / city / address / phone-format variants ───

  db.setAppState("donors", [
    { id: 701, phone: "0501112222", phone2: "0301234567", fullName: "תורם ראשון - שם עודכן" },
    { id: 702, phone: "0503334444", ivrApprovedPhones: ["0509998888"], fullName: "תורם שני" },
    { id: 703, phone: "0253456789", fullName: "תורם שלישי", idNumber: "123456789", city: "ירושלים", address: "רחוב הרצל 5" },
  ]);

  await check("GET /api/softphone/contacts?search=: חיפוש לפי מספר זהות (ת.ז.) מוצא את התורם", async function () {
    const r = await apiRequest("GET", "/api/softphone/contacts?search=123456789", undefined, secretaryToken);
    assert.ok(r.body.contacts.some(function (c) { return c.type === "donor" && c.id === 703; }), "חיפוש לפי ת.ז. חייב למצוא את התורם");
  });

  await check("GET /api/softphone/contacts?search=: חיפוש לפי עיר מוצא את התורם", async function () {
    const r = await apiRequest("GET", "/api/softphone/contacts?search=" + encodeURIComponent("ירושלים"), undefined, secretaryToken);
    assert.ok(r.body.contacts.some(function (c) { return c.type === "donor" && c.id === 703; }), "חיפוש לפי עיר חייב למצוא את התורם");
  });

  await check("GET /api/softphone/contacts?search=: חיפוש לפי כתובת מוצא את התורם", async function () {
    const r = await apiRequest("GET", "/api/softphone/contacts?search=" + encodeURIComponent("הרצל"), undefined, secretaryToken);
    assert.ok(r.body.contacts.some(function (c) { return c.type === "donor" && c.id === 703; }), "חיפוש לפי כתובת חייב למצוא את התורם");
  });

  await check("GET /api/softphone/contacts?search=: 0253456789 / 02-53-45-67-89 / +972-2-53456789 מוצאים את אותו תורם", async function () {
    const variants = ["0253456789", "02-53-45-67-89", "+972-2-53456789"];
    for (const v of variants) {
      const r = await apiRequest("GET", "/api/softphone/contacts?search=" + encodeURIComponent(v), undefined, secretaryToken);
      assert.ok(
        r.body.contacts.some(function (c) { return c.type === "donor" && c.id === 703; }),
        "החיפוש \"" + v + "\" חייב למצוא את התורם עם 0253456789 (המספר חייב להישאר עם ה-0 המוביל אחרי נורמליזציה)"
      );
    }
  });

  // ── Custom contact CRUD + phone normalization ────────────────────────────────

  let contactId;
  await check("POST /api/softphone/contacts: יצירת איש קשר מותאם אישית + נורמליזציה של מספר טלפון (שומרת על ה-0 המוביל)", async function () {
    const r = await apiRequest("POST", "/api/softphone/contacts", {
      name: "יוסי כהן", primaryPhone: "050-111-2233", additionalPhones: ["03 555 6677", "+972521112233"], notes: "לקוח VIP",
    }, secretaryToken);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    contactId = r.body.contact.id;
    assert.strictEqual(r.body.contact.primaryPhone, "0501112233", "המספר חייב להתנרמל תוך שמירה על ה-0 המוביל");
    assert.deepStrictEqual(r.body.contact.additionalPhones, ["035556677", "0521112233"]);
  });

  await check("GET /api/softphone/contacts: איש הקשר החדש מופיע עם type=custom", async function () {
    const r = await apiRequest("GET", "/api/softphone/contacts", undefined, secretaryToken);
    const c = r.body.contacts.find(function (x) { return x.type === "custom" && x.id === contactId; });
    assert.ok(c);
    assert.strictEqual(c.name, "יוסי כהן");
  });

  await check("GET /api/softphone/contacts?search=: חיפוש לפי שם מוצא תורם וגם איש קשר מותאם", async function () {
    const byName = await apiRequest("GET", "/api/softphone/contacts?search=" + encodeURIComponent("יוסי"), undefined, secretaryToken);
    assert.ok(byName.body.contacts.some(function (c) { return c.id === contactId; }));
    const byDonorName = await apiRequest("GET", "/api/softphone/contacts?search=" + encodeURIComponent("תורם שני"), undefined, secretaryToken);
    assert.ok(byDonorName.body.contacts.some(function (c) { return c.type === "donor" && c.id === 702; }));
  });

  await check("GET /api/softphone/contacts?search=: חיפוש לפי מספר טלפון (כולל טלפון משני) מוצא את התורם/איש הקשר", async function () {
    const r = await apiRequest("GET", "/api/softphone/contacts?search=0355566", undefined, secretaryToken);
    assert.ok(r.body.contacts.some(function (c) { return c.id === contactId; }), "חיפוש לפי טלפון נוסף חייב למצוא את איש הקשר");
  });

  // ── Duplicate prevention ──────────────────────────────────────────────────────

  await check("POST /api/softphone/contacts: טלפון ראשי כפול (זהה לאיש קשר קיים) -> 409", async function () {
    const r = await apiRequest("POST", "/api/softphone/contacts", { name: "מישהו אחר", primaryPhone: "0501112233" }, secretaryToken);
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
  });

  await check("POST /api/softphone/contacts: טלפון נוסף כפול (מופיע כ-additionalPhone של איש קשר אחר) -> 409", async function () {
    const r = await apiRequest("POST", "/api/softphone/contacts", { name: "מישהו נוסף", primaryPhone: "0509990000", additionalPhones: ["035556677"] }, secretaryToken);
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
  });

  await check("POST /api/softphone/contacts: טלפון חדש לגמרי -> מצליח (אין false positive על מניעת כפילות)", async function () {
    const r = await apiRequest("POST", "/api/softphone/contacts", { name: "איש קשר תקין", primaryPhone: "0587654321" }, secretaryToken);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  });

  await check("GET /api/softphone/contacts?search=: +972-58-7654321 מוצא איש קשר מותאם אישית שנשמר עם 0 מוביל", async function () {
    const r = await apiRequest("GET", "/api/softphone/contacts?search=" + encodeURIComponent("+972-58-7654321"), undefined, secretaryToken);
    assert.ok(r.body.contacts.some(function (c) { return c.type === "custom" && c.name === "איש קשר תקין"; }),
      "חיפוש בפורמט בינלאומי חייב למצוא את אותו איש קשר כמו החיפוש המנורמל");
  });

  // ── Input handling: special characters never break storage or leak into SQL —
  //    the round trip must come back byte-for-byte identical. The frontend
  //    only ever renders these values via jQuery .text() (never .html()),
  //    which is what actually prevents script execution in the browser; this
  //    test proves the backend doesn't mangle/reject the input, not that a
  //    browser is safe (that's a code-review property of the .text() calls
  //    in softphone.html, not something an HTTP test can observe). ──────────

  await check("POST /api/softphone/contacts: תווים מיוחדים בשם/הערות נשמרים ומוחזרים ללא שינוי (ללא הזרקת SQL, ללא קריסה)", async function () {
    const trickyName = "<script>alert(1)</script> O'Brien \"quoted\" -- ;DROP TABLE softphone_contacts;";
    const r = await apiRequest("POST", "/api/softphone/contacts", { name: trickyName, primaryPhone: "0511112222", notes: trickyName }, secretaryToken);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.contact.name, trickyName);
    assert.strictEqual(r.body.contact.notes, trickyName);
    // Table must still exist and be queryable — proves no SQL injection occurred.
    const list = await apiRequest("GET", "/api/softphone/contacts", undefined, secretaryToken);
    assert.strictEqual(list.status, 200);
    assert.ok(list.body.contacts.some(function (c) { return c.name === trickyName; }));
  });

  // ── Update ────────────────────────────────────────────────────────────────────

  await check("PUT /api/softphone/contacts/:id: עדכון שם והערות מצליח", async function () {
    const r = await apiRequest("PUT", "/api/softphone/contacts/" + contactId, { name: "יוסי כהן-לוי", notes: "עודכן" }, secretaryToken);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.contact.name, "יוסי כהן-לוי");
  });

  await check("PUT /api/softphone/contacts/:id: עדכון לטלפון שכבר שייך לאיש קשר אחר -> 409", async function () {
    const r = await apiRequest("PUT", "/api/softphone/contacts/" + contactId, { primaryPhone: "0587654321" }, secretaryToken);
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
  });

  // ── Audit logging ─────────────────────────────────────────────────────────────

  await check("יצירה/עדכון/מחיקה של איש קשר נרשמים ב-audit log", async function () {
    const created = db.getAuditLogs(1000).filter(function (l) { return l.action === "softphone_contact_created"; }).length;
    const updated = db.getAuditLogs(1000).filter(function (l) { return l.action === "softphone_contact_updated"; }).length;
    assert.ok(created >= 2, "לפחות 2 יצירות אמורות היו להירשם");
    assert.ok(updated >= 1, "לפחות עדכון אחד אמור היה להירשם");
  });

  await check("DELETE /api/softphone/contacts/:id מצליח ורושם audit log", async function () {
    const before = db.getAuditLogs(1000).filter(function (l) { return l.action === "softphone_contact_deleted"; }).length;
    const r = await apiRequest("DELETE", "/api/softphone/contacts/" + contactId, undefined, secretaryToken);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const after = db.getAuditLogs(1000).filter(function (l) { return l.action === "softphone_contact_deleted"; }).length;
    assert.strictEqual(after, before + 1);
    const list = await apiRequest("GET", "/api/softphone/contacts", undefined, secretaryToken);
    assert.ok(!list.body.contacts.some(function (c) { return c.id === contactId && c.type === "custom"; }));
  });

  // ── Permissions ───────────────────────────────────────────────────────────────

  await check("GET /api/softphone/contacts ללא טוקן -> 401", async function () {
    const r = await apiRequest("GET", "/api/softphone/contacts", undefined, undefined);
    assert.strictEqual(r.status, 401);
  });

  await check("POST /api/softphone/contacts: שדה שם חסר -> 400", async function () {
    const r = await apiRequest("POST", "/api/softphone/contacts", { primaryPhone: "0501234999" }, secretaryToken);
    assert.strictEqual(r.status, 400);
  });

  await check("POST /api/softphone/contacts: טלפון ראשי חסר -> 400", async function () {
    const r = await apiRequest("POST", "/api/softphone/contacts", { name: "בלי טלפון" }, secretaryToken);
    assert.strictEqual(r.status, 400);
  });

  // ── Static assets: embed mode + redesigned softphone page actually shipped ──
  // Cheap, real smoke checks that don't need a browser — confirms the served
  // HTML contains the expected markers, catching a broken/missing deploy of
  // either file without needing DOM/browser tooling this project doesn't have.

  await check("GET /donor.html?embed=1 -> מכיל את קוד ה-bootstrap של מצב embed", async function () {
    const res = await fetch(baseUrl + "/donor.html?id=703&embed=1");
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.indexOf("embed-mode") !== -1, "עמוד התורם חייב לכלול את מנגנון embed-mode");
    assert.ok(html.indexOf("donor-embed-close") !== -1, "עמוד התורם חייב לכלול את גשר ה-postMessage לסגירת המגירה");
  });

  await check("GET /softphone.html -> מכיל את מגירת פרטי התורם, הצ׳יפ הנבחר, ומזהה המתקשר הקיים ללא שינוי", async function () {
    const res = await fetch(baseUrl + "/softphone.html");
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    ["donorDrawerBg", "donorDrawerFrame", "selChip", "callerIdOpts", "calleridnote", "callCtrls2"].forEach(function (marker) {
      assert.ok(html.indexOf(marker) !== -1, "חסר מזהה צפוי בעמוד הסופטפון: " + marker);
    });
    // The exact caution note text must survive untouched — explicit requirement.
    assert.ok(html.indexOf("טכנוליין טרם אישרה מנגנון החלפת מזהה מתקשר") !== -1,
      "הודעת האזהרה של בורר מזהה המתקשר חייבת להישאר בדיוק כפי שהיא");
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

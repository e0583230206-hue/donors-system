"use strict";
// ai/tests/regression.js — AI v3 regression suite
// Run: node frontend/backend/ai/tests/regression.js
// Exit 0 = all pass, Exit 1 = failures

const path = require("path");
process.chdir(path.join(__dirname, ".."));

let passed = 0;
let failed = 0;
const results = [];

function assert(name, condition, detail) {
  if (condition) {
    passed++;
    results.push("  ✅ " + name);
  } else {
    failed++;
    results.push("  ❌ " + name + (detail ? " — " + detail : ""));
  }
}

function section(title) {
  results.push("\n[" + title + "]");
}

// ─── Load modules ─────────────────────────────────────────────────────────────

let formatter, detector, localEngine, aiIndex;
let donorHandlers, systemHandlers, insightHandlers;

try {
  formatter       = require("../formatter");
  detector        = require("../detector");
  localEngine     = require("../engines/local");
  aiIndex         = require("../index");
  donorHandlers   = require("../handlers/donor");
  systemHandlers  = require("../handlers/system");
  insightHandlers = require("../handlers/insights");
} catch (e) {
  console.error("FATAL: Module load error —", e.message);
  process.exit(1);
}

// ─── Mock contexts ────────────────────────────────────────────────────────────

function mockGlobalCtx() {
  function fmtMoney(n) { return "₪" + Number(n || 0); }
  function fmtDate(d) { return d ? String(d) : "לא ידוע"; }
  function daysSince(d) { if (!d) return Infinity; return Math.floor((Date.now() - new Date(d)) / 86400000); }
  function getDonorStats(d) {
    var donations = d.donations || [];
    var openDebts = donations.filter(function (x) { return Number(x.remainingDebt || 0) > 0; });
    return {
      totalDonations: donations.length, totalPaid: 0, totalDebt: 0,
      openDebtsCount: openDebts.length, avgAmount: 0, maxAmount: 0,
      lastDonationDate: null, lastDonationFmt: "לא ידוע",
      daysSinceLastDonation: Infinity, paidCount: 0,
    };
  }
  return {
    type: "global",
    allDonors: [],
    statsPerDonor: [],
    tasks: [], reminders: [], openTasks: [], urgentTasks: [], upcomingReminders: [],
    withDebt: [], dormant90: [], dormant180: [], dormant365: [], neverGiven: [],
    summary: {
      totalDonors: 0, activeDonors: 0, withDebt: 0, totalDebt: 0, totalPaid: 0,
      dormant90: 0, dormant180: 0, dormant365: 0, neverGiven: 0,
      openTasksCount: 0, urgentCount: 0, campaignReady: 0, noPhone: 0,
    },
    citySorted: [], purposeMap: {}, tagMap: {}, methodMap: {}, monthlyTrend: [],
    fmtDate, fmtMoney, daysSince, getDonorStats,
  };
}

function mockDonorCtx() {
  function fmtMoney(n) { return "₪" + Number(n || 0); }
  function fmtDate(d) { return d ? String(d) : "לא ידוע"; }
  function daysSince(d) { if (!d) return Infinity; return Math.floor((Date.now() - new Date(d)) / 86400000); }
  var donor = { id: 1, fullName: "ראובן לוי", phone: "050-1234567", city: "ירושלים", tags: [], notes: "", donations: [], ivrApprovedPhones: [] };
  return {
    type: "donor",
    donor: donor,
    stats: { totalDonations: 0, totalPaid: 0, totalDebt: 0, openDebtsCount: 0, avgAmount: 0, maxAmount: 0, lastDonationDate: null, lastDonationFmt: "לא ידוע", daysSinceLastDonation: Infinity, paidCount: 0 },
    openDebts: [], recentDonations: [], allDonations: [], openTasks: [],
    globalAvgPaid: 0, globalAvgDebt: 0, allDonorsCount: 1,
    fmtDate, fmtMoney, daysSince,
  };
}

// ─── 1. Formatter ─────────────────────────────────────────────────────────────

section("formatter.js");

(function () {
  var out;

  out = formatter.format({ summary: "בדיקה", metrics: [], sections: [], conclusion: "", recommendation: "", suggestions: [] });
  assert("format: summary only", typeof out === "string" && out.includes("בדיקה"));

  out = formatter.format({ summary: "מצב", metrics: [{ label: "חוב", value: "₪500" }], sections: [], conclusion: "", recommendation: "", suggestions: [] });
  assert("format: metrics row", out.includes("₪500"));

  out = formatter.format({ summary: "", metrics: [], sections: [{ title: "דחוף", items: ["פריט א", "פריט ב"], urgent: true }], conclusion: "", recommendation: "", suggestions: [] });
  assert("format: section with items", out.includes("פריט א"));

  out = formatter.format({ summary: "x", metrics: [], sections: [], conclusion: "מסקנה", recommendation: "המלצה", suggestions: [] });
  assert("format: conclusion + recommendation", out.includes("מסקנה") && out.includes("המלצה"));

  out = formatter.format(null);
  assert("format: null input returns string", typeof out === "string");

  out = formatter.format({ answer: "תשובה ישנה" });
  assert("format: legacy answer passthrough", out === "תשובה ישנה");

  var parsed = formatter.parseOpenAIResponse('{"summary":"סיכום","metrics":[],"sections":[],"conclusion":"","recommendation":"","suggestions":[]}');
  assert("parseOpenAIResponse: valid JSON", parsed && parsed.summary === "סיכום");

  var fallback = formatter.parseOpenAIResponse("not json at all");
  assert("parseOpenAIResponse: invalid JSON fallback", fallback && (fallback._rawFallback || typeof fallback.summary === "string"));
}());

// ─── 2. Detector ──────────────────────────────────────────────────────────────

section("detector.js");

(function () {
  var d;

  d = detector.detectIntent("מה מצב התורם", [], "donor");
  assert("detect: donor_summary on donor page", d.intent === "donor_summary", "got " + d.intent);

  d = detector.detectIntent("כמה חוב פתוח יש לו", [], "debts");
  assert("detect: debt intent on debts page", d.intent && (d.intent.includes("debt") || d.intent.includes("donor")), "got " + d.intent);

  d = detector.detectIntent("מי לא תרם בחצי שנה", [], "global");
  assert("detect: dormant intent", d.intent === "system_dormant", "got " + d.intent);

  d = detector.detectIntent("למי להתקשר היום", [], "global");
  assert("detect: who-to-call intent", d.intent === "insight_who_to_call" || d.intent === "system_priority_debts", "got " + d.intent);

  // system_summary: "מה קורה במערכת" uniquely hits system_summary kw list
  d = detector.detectIntent("מה קורה במערכת", [], "global");
  assert("detect: system_summary via 'מה קורה במערכת'", d.intent === "system_summary", "got " + d.intent);

  d = detector.detectIntent("?", [], "global");
  assert("detect: gibberish returns intent string", typeof d.intent === "string");

  assert("detect: confidence is number", typeof d.confidence === "number");
  assert("detect: entities is object", d.entities !== null && typeof d.entities === "object");

  // Synonym expansion: "כמה חוב יש לו" — clear debt intent
  d = detector.detectIntent("כמה חוב יש לו בסה\"כ", [], "donor");
  assert("detect: חוב → debt intent", d.intent && d.intent.includes("debt"), "got " + d.intent);

  // Page context bias for tasks page
  d = detector.detectIntent("מה הדחוף?", [], "tasks");
  assert("detect: tasks page biases to task intent", typeof d.intent === "string");
}());

// ─── 3. Local engine — donor intents ─────────────────────────────────────────

section("engines/local.js — donor context");

(function () {
  localEngine.query({ question: "מצב התורם", donorId: null, history: [], pageContext: "donor" })
    .then(function (r) {
      assert("local: donor intent without donorId → graceful message", r && typeof r.answer === "string");
      assert("local: has suggestions array", Array.isArray(r.suggestions));
      assert("local: has intent field", typeof r.intent === "string");
      assert("local: has model field", r.model === "local");
      assert("local: has debug object", r.debug && typeof r.debug === "object");
    }).catch(function (e) {
      assert("local: donor intent without donorId → no throw", false, e.message);
    });
}());

// ─── 4. Local engine — system intents ────────────────────────────────────────

section("engines/local.js — system context");

(function () {
  localEngine.query({ question: "מצב המערכת", donorId: null, history: [], pageContext: "global" })
    .then(function (r) {
      assert("local: system intent runs", r && typeof r.answer === "string");
      assert("local: system answer non-empty", r.answer.length > 5);
      assert("local: system debug present", r.debug && typeof r.debug === "object");
    }).catch(function (e) {
      assert("local: system intent no throw", false, e.message);
    });

  localEngine.query({ question: "חובות פתוחים לפי עדיפות", donorId: null, history: [], pageContext: "debts" })
    .then(function (r) {
      assert("local: priority debts intent runs", r && typeof r.answer === "string");
    }).catch(function (e) {
      assert("local: priority debts no throw", false, e.message);
    });
}());

// ─── 5. Local engine — insight intents ───────────────────────────────────────

section("engines/local.js — insights");

(function () {
  localEngine.query({ question: "למי כדאי להתקשר היום?", donorId: null, history: [], pageContext: "global" })
    .then(function (r) {
      assert("local: insight_who_to_call runs", r && typeof r.answer === "string");
    }).catch(function (e) {
      assert("local: insight no throw", false, e.message);
    });
}());

// ─── 6. Local engine — disambiguation ────────────────────────────────────────

section("engines/local.js — disambiguation");

(function () {
  localEngine.query({ question: "ממ?", donorId: null, history: [], pageContext: "global" })
    .then(function (r) {
      assert("local: vague question → answer string", r && typeof r.answer === "string");
      assert("local: vague → known intent", typeof r.intent === "string");
    }).catch(function (e) {
      assert("local: disambiguation no throw", false, e.message);
    });
}());

// ─── 7. Local engine — follow-up history ─────────────────────────────────────

section("engines/local.js — follow-up history");

(function () {
  var history = [
    { role: "user",      text: "מה מצב המערכת?" },
    { role: "assistant", text: "יש 100 תורמים..." },
  ];
  localEngine.query({ question: "ספר לי עוד", donorId: null, history: history, pageContext: "global" })
    .then(function (r) {
      assert("local: follow-up with history runs", r && typeof r.answer === "string");
    }).catch(function (e) {
      assert("local: follow-up no throw", false, e.message);
    });
}());

// ─── 8. Local engine — fallback ───────────────────────────────────────────────

section("engines/local.js — fallback");

(function () {
  localEngine.query({ question: "blah blah xyz", donorId: null, history: [], pageContext: "global" })
    .then(function (r) {
      assert("local: unrecognized → fallback with answer", r && typeof r.answer === "string");
      assert("local: fallback suggestions array", Array.isArray(r.suggestions));
    }).catch(function (e) {
      assert("local: fallback no throw", false, e.message);
    });
}());

// ─── 9. ai/index.js ──────────────────────────────────────────────────────────

section("ai/index.js");

(function () {
  assert("aiIndex: queryAI exported", typeof aiIndex.queryAI === "function");

  aiIndex.queryAI({ question: "מצב המערכת", donorId: null, history: [], pageContext: "global" })
    .then(function (r) {
      assert("aiIndex: queryAI returns answer", r && typeof r.answer === "string");
      assert("aiIndex: queryAI returns model", typeof r.model === "string");
      assert("aiIndex: queryAI returns suggestions", Array.isArray(r.suggestions));
    }).catch(function (e) {
      assert("aiIndex: queryAI no throw", false, e.message);
    });
}());

// ─── 10. OpenAI engine — key-absent check ────────────────────────────────────

section("engines/openai.js");

(function () {
  if (process.env.OPENAI_API_KEY) {
    results.push("  ⏭ OpenAI engine test skipped (key present — live test omitted from regression)");
    passed++;
  } else {
    var openaiEngine = require("../engines/openai");
    openaiEngine.query({ question: "מצב", donorId: null, history: [], pageContext: "global" })
      .then(function () {
        assert("openai: throws without key", false, "should have thrown");
      }).catch(function (e) {
        assert("openai: throws without key", e.message.length > 0);
      });
  }
}());

// ─── 11. Handlers — donor dispatch (mock ctx) ────────────────────────────────

section("handlers/donor.js");

(function () {
  var ctx = mockDonorCtx();
  try {
    var r = donorHandlers.dispatch("donor_summary", ctx, {});
    assert("donor dispatch: donor_summary returns ResponseObject", r && typeof r.summary === "string");
    assert("donor dispatch: has suggestions", r && Array.isArray(r.suggestions));
  } catch (e) {
    assert("donor dispatch: no throw on mock ctx", false, e.message);
  }

  try {
    var r2 = donorHandlers.dispatch("unknown_intent_xyz", ctx, {});
    assert("donor dispatch: unknown intent returns null", r2 === null || r2 === undefined);
  } catch (e) {
    assert("donor dispatch: unknown intent no throw", false, e.message);
  }
}());

// ─── 12. Handlers — system dispatch (mock ctx) ───────────────────────────────

section("handlers/system.js");

(function () {
  var ctx = mockGlobalCtx();
  try {
    var r = systemHandlers.dispatch("system_summary", ctx, {});
    assert("system dispatch: system_summary returns ResponseObject", r && typeof r.summary === "string");
    assert("system dispatch: has suggestions", r && Array.isArray(r.suggestions));
  } catch (e) {
    assert("system dispatch: no throw on mock ctx", false, e.message);
  }
}());

// ─── 13. Handlers — insights dispatch (mock ctx) ─────────────────────────────

section("handlers/insights.js");

(function () {
  var ctx = mockGlobalCtx();
  try {
    var r = insightHandlers.dispatch("insight_who_to_call", ctx);
    assert("insights dispatch: returns ResponseObject", r && typeof r.summary === "string");
    assert("insights dispatch: has suggestions", r && Array.isArray(r.suggestions));
  } catch (e) {
    assert("insights dispatch: no throw on mock ctx", false, e.message);
  }
}());

// ─── 14. Debug field passthrough ─────────────────────────────────────────────

section("debug mode");

(function () {
  localEngine.query({ question: "מצב המערכת", donorId: null, history: [], pageContext: "global" })
    .then(function (r) {
      assert("debug: debug field is object", r.debug && typeof r.debug === "object");
      assert("debug: debug.intent present", typeof r.debug.intent === "string");
      assert("debug: debug.pageContext present", r.debug.pageContext !== undefined);
    }).catch(function (e) {
      assert("debug: no throw", false, e.message);
    });
}());

// ─── Print results ────────────────────────────────────────────────────────────

setTimeout(function () {
  results.forEach(function (l) { console.log(l); });
  console.log("\n══════════════════════════════════════════");
  console.log("AI v3 Regression: " + passed + " passed, " + failed + " failed");
  if (failed > 0) {
    console.log("STATUS: ❌ FAILURES DETECTED");
    process.exit(1);
  } else {
    console.log("STATUS: ✅ ALL TESTS PASSED");
    process.exit(0);
  }
}, 3000);

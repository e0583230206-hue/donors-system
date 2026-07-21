// ivr-audio-paymsg-systemmessages.test.js — creditCardModule()'s
// systemMessages construction (ivr.js) + buildPaymsgAudioContext()'s
// independent gating (ivr-audio-context.service.js). No DB/disk/ffmpeg.
//
// הרצה: node ivr-audio-paymsg-systemmessages.test.js

const assert = require("assert");
const { creditCardModule, buildPaymsgSystemMessages, PAYMSG_S_CODE } = require("./ivr");

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name: name, ok: true });
  } catch (err) {
    results.push({ name: name, ok: false, error: err.stack || err.message });
  }
}

function fakePaymsgAudio(resolvedMap) {
  return {
    resolveAudioId: function (audioId) {
      if (Object.prototype.hasOwnProperty.call(resolvedMap, audioId)) {
        return { fileLink: "https://example.test/uploads/ivr-audio/" + resolvedMap[audioId], fileName: resolvedMap[audioId] };
      }
      return { text: "" }; // exactly what the resolver's own fallback returns when unresolved
    },
  };
}

// ── PAYMSG_S_CODE mapping ────────────────────────────────────────────────
check("PAYMSG_S_CODE: בדיוק 24 מפתחות, S3000..S3023, ללא כפילות/חוסר", function () {
  var keys = Object.keys(PAYMSG_S_CODE);
  assert.strictEqual(keys.length, 24);
  var values = keys.map(function (k) { return PAYMSG_S_CODE[k]; });
  for (var n = 3000; n <= 3023; n++) {
    assert.ok(keys.indexOf("PAYMSG-" + n) !== -1, "חסר PAYMSG-" + n);
    assert.ok(values.indexOf("S" + n) !== -1, "חסר S" + n);
  }
  assert.strictEqual(new Set(values).size, 24, "אין S-code כפול");
});

// ── buildPaymsgSystemMessages ────────────────────────────────────────────
check("buildPaymsgSystemMessages: paymsgAudio undefined/null -> מפה ריקה", function () {
  assert.deepStrictEqual(buildPaymsgSystemMessages(undefined), {});
  assert.deepStrictEqual(buildPaymsgSystemMessages(null), {});
});

check("buildPaymsgSystemMessages: רק S-codes שהצליחו (fileLink אמיתי) נכללים, השאר מדולגים לגמרי", function () {
  var audio = fakePaymsgAudio({ "PAYMSG-3003": "PAYMSG-3003-1-abc.wav", "PAYMSG-3004": "PAYMSG-3004-1-def.wav" });
  var map = buildPaymsgSystemMessages(audio);
  assert.strictEqual(Object.keys(map).length, 2);
  assert.deepStrictEqual(map.S3003, [{ fileLink: "https://example.test/uploads/ivr-audio/PAYMSG-3003-1-abc.wav", fileName: "PAYMSG-3003-1-abc.wav" }]);
  assert.deepStrictEqual(map.S3004, [{ fileLink: "https://example.test/uploads/ivr-audio/PAYMSG-3004-1-def.wav", fileName: "PAYMSG-3004-1-def.wav" }]);
  assert.strictEqual(map.S3000, undefined, "S3000 לא אושר -> לא כלול בכלל, לא {text:...}");
});

check("buildPaymsgSystemMessages: אף פעם לא מכניס פריט {text:...} — רק fileLink/fileName", function () {
  var audio = fakePaymsgAudio({}); // כלום לא נפתר
  var map = buildPaymsgSystemMessages(audio);
  assert.deepStrictEqual(map, {});
  Object.keys(PAYMSG_S_CODE).forEach(function (id) {
    assert.strictEqual(map[PAYMSG_S_CODE[id]], undefined);
  });
});

check("buildPaymsgSystemMessages: אף פעם לא מוסיף SF/sum/number/digits לשום פריט", function () {
  var audio = fakePaymsgAudio({ "PAYMSG-3000": "PAYMSG-3000-1-x.wav", "PAYMSG-3009": "PAYMSG-3009-1-y.wav" });
  var map = buildPaymsgSystemMessages(audio);
  Object.keys(map).forEach(function (sCode) {
    map[sCode].forEach(function (item) {
      var keys = Object.keys(item).sort();
      assert.deepStrictEqual(keys, ["fileLink", "fileName"], "פריט " + sCode + " חייב להכיל אך ורק fileLink+fileName");
    });
  });
});

check("buildPaymsgSystemMessages: resolveAudioId שזורק חריגה מטופל בבטחה, לא מפיל את שאר הבנייה", function () {
  var audio = {
    resolveAudioId: function (audioId) {
      if (audioId === "PAYMSG-3005") throw new Error("תקלה מדומה");
      return { fileLink: "https://x/" + audioId + ".wav", fileName: audioId };
    },
  };
  var map = buildPaymsgSystemMessages(audio);
  assert.strictEqual(map.S3005, undefined, "הקוד שזרק חריגה פשוט לא נכלל");
  assert.ok(map.S3000, "שאר הקודים המשיכו להיפתר כרגיל");
});

// ── creditCardModule ──────────────────────────────────────────────────────
check("creditCardModule: ללא paymsgAudio (undefined) — התנהגות זהה לחלוטין להיום, בלי מפתח systemMessages", function () {
  var result = creditCardModule(250);
  assert.strictEqual(result.type, "creditCard");
  assert.strictEqual(result.sum, 250);
  assert.strictEqual(result.sumChangeable, "no");
  assert.strictEqual(result.cvv, "yes");
  assert.strictEqual(result.tz, "yes");
  assert.strictEqual(result.payments, 1);
  assert.strictEqual(result.category, "תרומה");
  assert.strictEqual("systemMessages" in result, false, "בלי paymsgAudio, אין מפתח systemMessages בכלל");
});

check("creditCardModule: paymsgAudio מוזרם אך כלום לא נפתר (off/אין הקלטות מאושרות) — עדיין בלי מפתח systemMessages", function () {
  var result = creditCardModule(100, fakePaymsgAudio({}));
  assert.strictEqual("systemMessages" in result, false, "מפה ריקה לא מצורפת בכלל");
});

check("creditCardModule: עם S3003+S3004 מאושרים בלבד — systemMessages מכיל בדיוק את שניהם, שום שדה קיים אחר לא השתנה", function () {
  var audio = fakePaymsgAudio({ "PAYMSG-3003": "PAYMSG-3003-1-a.wav", "PAYMSG-3004": "PAYMSG-3004-1-b.wav" });
  var result = creditCardModule(583, audio);
  assert.strictEqual(Object.keys(result.systemMessages).length, 2);
  assert.ok(result.systemMessages.S3003);
  assert.ok(result.systemMessages.S3004);
  assert.strictEqual(result.systemMessages.S3000, undefined);
  assert.strictEqual(result.sum, 583, "sum/שאר השדות המקוריים לא נגעו");
  assert.strictEqual(result.type, "creditCard");
  assert.strictEqual(result.terminal, process.env.CREDIT_CARD_TERMINAL || "");
});

// ── buildPaymsgAudioContext — עצמאות מ-IVR_AUDIO_MODE + trial ────────────
check("buildPaymsgAudioContext: IVR_AUDIO_PAYMSG_MODE לא מוגדר (חסר) -> off, resolveAudioId מחזיר תמיד {text}", function () {
  delete process.env.IVR_AUDIO_PAYMSG_MODE;
  delete process.env.IVR_AUDIO_PAYMSG_TRIAL_CALLER_PHONE;
  const { buildPaymsgAudioContext } = require("./ivr-audio-context.service");
  var ctx = buildPaymsgAudioContext("0501234567");
  var result = ctx.resolveAudioId("PAYMSG-3000", "");
  assert.deepStrictEqual(result, { text: "" });
});

check("buildPaymsgAudioContext: trial בלי IVR_AUDIO_PAYMSG_TRIAL_CALLER_PHONE (ריק) -> מתנהג כמו off לכולם", function () {
  process.env.IVR_AUDIO_PAYMSG_MODE = "trial";
  delete process.env.IVR_AUDIO_PAYMSG_TRIAL_CALLER_PHONE;
  delete require.cache[require.resolve("./ivr-audio-context.service")];
  const { buildPaymsgAudioContext } = require("./ivr-audio-context.service");
  var ctx = buildPaymsgAudioContext("0501234567");
  assert.deepStrictEqual(ctx.resolveAudioId("PAYMSG-3000", ""), { text: "" });
  delete process.env.IVR_AUDIO_PAYMSG_MODE;
});

check("buildPaymsgAudioContext: IVR_AUDIO_MODE=on (התפריטים הרגילים) לא משפיע בכלל על paymsgAudio כש-IVR_AUDIO_PAYMSG_MODE נשאר off", function () {
  process.env.IVR_AUDIO_MODE = "on";
  delete process.env.IVR_AUDIO_PAYMSG_MODE;
  delete require.cache[require.resolve("./ivr-audio-context.service")];
  const { buildPaymsgAudioContext, buildAudioContext } = require("./ivr-audio-context.service");
  // audio (הרגיל) כן מופעל...
  var mainAudio = buildAudioContext("0501234567");
  assert.strictEqual(typeof mainAudio.resolveOrText, "function");
  // ...אבל paymsgAudio, עם הדגל הנפרד שנשאר off, עדיין תמיד {text}
  var paymsgCtx = buildPaymsgAudioContext("0501234567");
  assert.deepStrictEqual(paymsgCtx.resolveAudioId("PAYMSG-3000", ""), { text: "" });
  delete process.env.IVR_AUDIO_MODE;
});

// ── סיכום ────────────────────────────────────────────────────────────────
const failed = results.filter(function (r) { return !r.ok; });
results.forEach(function (r) {
  console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : " — " + r.error));
});
console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");
process.exit(failed.length ? 1 : 0);

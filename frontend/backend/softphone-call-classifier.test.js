// softphone-call-classifier.test.js — unit tests for the pure call-status
// classifier shared by the browser softphone and this backend
// (frontend/js/softphone-call-classifier.js). Covers: status classification
// for every one of the 8 required terminal statuses + the transient
// "in_progress" state, and duration math (ring/talk).
//
// הרצה: node softphone-call-classifier.test.js

const assert = require("assert");
const classifier = require("../js/softphone-call-classifier.js");

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name: name, ok: true });
  } catch (err) {
    results.push({ name: name, ok: false, error: err.stack || err.message });
  }
}

var C = classifier.CAUSES;

// ── Status classification ────────────────────────────────────────────────────

check("outgoing + accepted->ended -> outgoing_answered", function () {
  assert.strictEqual(classifier.classifyEnded("outgoing"), "outgoing_answered");
});

check("incoming + accepted->ended -> incoming_answered", function () {
  assert.strictEqual(classifier.classifyEnded("incoming"), "incoming_answered");
});

check("outgoing failed, cause=Canceled, originator=local -> cancelled (hung up before answer)", function () {
  assert.strictEqual(classifier.classifyFailed("outgoing", C.CANCELED, "local"), "cancelled");
});

check("outgoing failed, cause=Busy -> outgoing_rejected", function () {
  assert.strictEqual(classifier.classifyFailed("outgoing", C.BUSY, "remote"), "outgoing_rejected");
});

check("outgoing failed, cause=Rejected -> outgoing_rejected", function () {
  assert.strictEqual(classifier.classifyFailed("outgoing", C.REJECTED, "remote"), "outgoing_rejected");
});

check("outgoing failed, cause=No Answer -> outgoing_unanswered", function () {
  assert.strictEqual(classifier.classifyFailed("outgoing", C.NO_ANSWER, "remote"), "outgoing_unanswered");
});

check("outgoing failed, cause=Request Timeout -> outgoing_unanswered", function () {
  assert.strictEqual(classifier.classifyFailed("outgoing", C.REQUEST_TIMEOUT, "system"), "outgoing_unanswered");
});

check("outgoing failed, cause=WebRTC Error (unrecognized/technical) -> outgoing_failed", function () {
  assert.strictEqual(classifier.classifyFailed("outgoing", C.WEBRTC_ERROR, "system"), "outgoing_failed");
});

check("outgoing failed, cause=Address Incomplete -> outgoing_failed (generic technical bucket)", function () {
  assert.strictEqual(classifier.classifyFailed("outgoing", C.ADDRESS_INCOMPLETE, "remote"), "outgoing_failed");
});

check("incoming failed, cause=Canceled (caller hung up before we answered) -> incoming_missed", function () {
  assert.strictEqual(classifier.classifyFailed("incoming", C.CANCELED, "remote"), "incoming_missed");
});

check("incoming failed, cause=Rejected, originator=local (we clicked reject) -> incoming_rejected", function () {
  assert.strictEqual(classifier.classifyFailed("incoming", C.REJECTED, "local"), "incoming_rejected");
});

check("incoming failed, cause=Busy, originator=local (we clicked reject) -> incoming_rejected", function () {
  assert.strictEqual(classifier.classifyFailed("incoming", C.BUSY, "local"), "incoming_rejected");
});

check("incoming failed, cause=No Answer (timed out unanswered) -> incoming_missed", function () {
  assert.strictEqual(classifier.classifyFailed("incoming", C.NO_ANSWER, "system"), "incoming_missed");
});

check("incoming failed, unexpected technical cause -> incoming_missed (safe default, reads like a normal phone)", function () {
  assert.strictEqual(classifier.classifyFailed("incoming", C.INTERNAL_ERROR, "system"), "incoming_missed");
});

check("STATUSES contains exactly the 8 required terminal statuses + in_progress", function () {
  var required = [
    "incoming_answered", "incoming_missed", "incoming_rejected",
    "outgoing_answered", "outgoing_unanswered", "outgoing_rejected",
    "outgoing_failed", "cancelled",
  ];
  required.forEach(function (s) {
    assert.ok(classifier.STATUSES.indexOf(s) !== -1, "missing required status: " + s);
  });
  assert.strictEqual(classifier.STATUSES.length, 9, "expected exactly 9 statuses (8 terminal + in_progress)");
});

check("isAnsweredStatus true only for the two answered statuses", function () {
  assert.strictEqual(classifier.isAnsweredStatus("outgoing_answered"), true);
  assert.strictEqual(classifier.isAnsweredStatus("incoming_answered"), true);
  assert.strictEqual(classifier.isAnsweredStatus("incoming_missed"), false);
  assert.strictEqual(classifier.isAnsweredStatus("in_progress"), false);
});

check("safeFailureReason never leaks a raw SIP cause/code — Hebrew only, no digits", function () {
  classifier.TERMINAL_STATUSES.forEach(function (status) {
    var reason = classifier.safeFailureReason(status);
    if (reason === null) return; // answered statuses have no failure reason
    assert.ok(!/\d/.test(reason), "reason for " + status + " must not contain a raw status code: " + reason);
  });
});

// ── Duration math ────────────────────────────────────────────────────────────

check("computeDurations: full answered call — ring + talk both computed correctly", function () {
  var d = classifier.computeDurations({
    startedAt:  "2026-01-01T00:00:00.000Z",
    ringingAt:  "2026-01-01T00:00:01.000Z",
    answeredAt: "2026-01-01T00:00:05.000Z",
    endedAt:    "2026-01-01T00:01:05.000Z",
  });
  assert.strictEqual(d.ringDurationSec, 4);
  assert.strictEqual(d.talkDurationSec, 60);
});

check("computeDurations: never answered (missed) — ring duration set, talk duration null", function () {
  var d = classifier.computeDurations({
    startedAt: "2026-01-01T00:00:00.000Z",
    ringingAt: "2026-01-01T00:00:00.000Z",
    endedAt:   "2026-01-01T00:00:20.000Z",
  });
  assert.strictEqual(d.ringDurationSec, 20);
  assert.strictEqual(d.talkDurationSec, null);
});

check("computeDurations: no ringingAt supplied — falls back to startedAt for ring calc", function () {
  var d = classifier.computeDurations({
    startedAt:  "2026-01-01T00:00:00.000Z",
    answeredAt: "2026-01-01T00:00:03.000Z",
    endedAt:    "2026-01-01T00:00:13.000Z",
  });
  assert.strictEqual(d.ringDurationSec, 3);
  assert.strictEqual(d.talkDurationSec, 10);
});

check("computeDurations: missing timestamps -> both null, no crash", function () {
  var d = classifier.computeDurations({});
  assert.strictEqual(d.ringDurationSec, null);
  assert.strictEqual(d.talkDurationSec, null);
});

check("computeDurations: instantly-failed call (no ringingAt, no answeredAt, immediate endedAt) -> both null", function () {
  var d = classifier.computeDurations({
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt:   "2026-01-01T00:00:00.000Z",
  });
  assert.strictEqual(d.ringDurationSec, 0);
  assert.strictEqual(d.talkDurationSec, null);
});

// ── סיכום ─────────────────────────────────────────────────────────────────────
const failed = results.filter(function (r) { return !r.ok; });
results.forEach(function (r) {
  console.log((r.ok ? "✓" : "✗") + " " + r.name + (r.ok ? "" : " — " + r.error));
});
console.log("\n" + (results.length - failed.length) + "/" + results.length + " עברו");
process.exit(failed.length ? 1 : 0);

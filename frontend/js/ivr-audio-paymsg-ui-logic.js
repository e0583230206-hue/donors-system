// ivr-audio-paymsg-ui-logic.js
//
// Small, pure, dual-environment (browser <script> global AND Node
// require()) module holding the decision logic behind the PAYMSG "אשר
// והפעל" button in settings.js. Pulled out on its own specifically so it
// can be unit-tested with plain Node (this project has no frontend test
// framework/DOM environment) — settings.js itself is a non-module browser
// script and can't be require()'d directly.
//
// The bug this exists to prevent: relying on the existing status <select>
// element's "change" event to trigger approval fails silently when the
// currently-selected value is ALREADY "אושר" (e.g. re-approving a
// replacement pending version) — most browsers never fire "change" when a
// <select> is set to the option it already has selected. The functions
// here never look at the row's CURRENT status at all — approval must
// always be an explicit, unconditional action.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.IvrAudioPaymsgUiLogic = factory();
  }
})(typeof window !== "undefined" ? window : this, function () {
  // Whether the explicit "אשר והפעל" button should be shown/enabled for
  // this row — driven ONLY by "is there a pending version", never by the
  // row's current status (a row can legitimately already be "אושר" while
  // still having a newer pending replacement waiting), and never by
  // category — every row in the table uses the same 3-slot lifecycle.
  function shouldShowApproveButton(rec) {
    return !!(rec && rec.audioFile3);
  }

  // The exact request the button must send — always unconditional
  // status:"אושר", regardless of whatever the row's current status
  // already is. No other fields.
  function buildApproveRequest(audioId) {
    return {
      method: "PUT",
      url: "/api/admin/ivr-audio/" + encodeURIComponent(audioId),
      body: { status: "אושר" },
    };
  }

  // What the row is expected to look like right after a successful
  // approve response — used by the UI to sanity-check the server's
  // response actually did what was asked (audioFile3 cleared, the old
  // active file preserved as the new "previous"), not just trust a bare
  // {ok:true}.
  function describeExpectedPostApproveState(recBeforeApprove) {
    return {
      audioFile3ShouldBeEmpty: true,
      newActiveShouldBe: recBeforeApprove ? recBeforeApprove.audioFile3 : undefined,
      newPreviousShouldBe: recBeforeApprove ? recBeforeApprove.audioFile1 : undefined,
    };
  }

  function verifyPostApproveState(recBeforeApprove, recAfterApprove) {
    const expected = describeExpectedPostApproveState(recBeforeApprove);
    if (!recAfterApprove) return { ok: false, reason: "לא התקבלה שורה מעודכנת מהשרת" };
    if (recAfterApprove.audioFile3 !== "") {
      return { ok: false, reason: "audioFile3 לא התרוקן אחרי האישור" };
    }
    if (recAfterApprove.audioFile1 !== expected.newActiveShouldBe) {
      return { ok: false, reason: "הקובץ הפעיל אחרי האישור אינו הגרסה שהייתה ממתינה" };
    }
    if (expected.newPreviousShouldBe && recAfterApprove.audioFile2 !== expected.newPreviousShouldBe) {
      return { ok: false, reason: "הקובץ הפעיל הקודם לא הופיע כגרסה קודמת" };
    }
    return { ok: true };
  }

  // Decides what the UI should do after a PUT approve response. This is
  // the exact decision that used to be wrong: the caller would show
  // "verification failed" AND THEN unconditionally show a success message
  // right after, because the success message wasn't actually gated on
  // verification at all. Never returns showSuccess:true unless at least
  // one of the two verifications actually passed — responseVerification
  // (checked against the PUT response body) or, if that failed,
  // freshVerification (checked against a re-fetched row, proving the
  // promotion really happened even if the response body looked wrong).
  function decideApproveOutcome(responseVerification, freshVerification) {
    if (responseVerification && responseVerification.ok) {
      return { applyLocalUpdate: "response", showSuccess: true };
    }
    if (freshVerification && freshVerification.ok) {
      return { applyLocalUpdate: "refetch", showSuccess: true };
    }
    const reason =
      (freshVerification && freshVerification.reason) ||
      (responseVerification && responseVerification.reason) ||
      "לא ידוע";
    return { applyLocalUpdate: false, showSuccess: false, errorReason: reason };
  }

  return {
    shouldShowApproveButton: shouldShowApproveButton,
    buildApproveRequest: buildApproveRequest,
    describeExpectedPostApproveState: describeExpectedPostApproveState,
    verifyPostApproveState: verifyPostApproveState,
    decideApproveOutcome: decideApproveOutcome,
  };
});

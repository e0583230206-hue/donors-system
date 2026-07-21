// ivr-audio-paymsg-lock.service.js
//
// In-memory, per-audioId mutual-exclusion guard for the PAYMSG upload/
// approve/delete-pending/restore-previous operations (see
// ivr-audio-paymsg-lifecycle.service.js). Prevents two concurrent requests
// against the SAME row from interleaving and mixing up audioFile1/2/3.
//
// IMPORTANT LIMITATION (documented, not silent): this lock lives in the
// memory of a single Node.js process. It only protects against concurrent
// requests handled by that one process. It provides NO protection if the
// app is ever run under PM2 cluster mode (multiple worker processes sharing
// the same SQLite file) — today's deployment runs a single `fork`-mode
// instance, matching every other synchronous DB write already in this
// codebase (none of which use any cross-process locking either). If the
// deployment ever moves to cluster mode, this lock (and the rest of the
// app's SQLite access pattern) would need to be revisited together.
//
// Always release with try/finally — see call sites in server.js.

const locked = new Set();

function tryLock(audioId) {
  const key = String(audioId || "");
  if (!key || locked.has(key)) return false;
  locked.add(key);
  return true;
}

function unlock(audioId) {
  locked.delete(String(audioId || ""));
}

// Test-only escape hatch — never used in production code paths.
function _reset() {
  locked.clear();
}

module.exports = { tryLock, unlock, _reset };

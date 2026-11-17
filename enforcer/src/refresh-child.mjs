// The detached OAuth refresher (see "Why the refresh runs in a detached process" in credentials.mjs).
//
// authHeaders() spawns this in its own process group and does not keep it alive, so the caller may
// be killed or exit at any moment without losing the rotated pair: this process does the POST and
// the write-back under the shared lock, then exits. Exit code: 0 fresh or refreshed, 3 signed out
// (the server refused the refresh token), 2 anything else (transient, lock busy, nothing to do).
import { refreshUnderLock, REFRESH_SKEW_MS, CHILD_TIMEOUT_MS, CHILD_LOCK_WAIT_MS, CHILD_SIGNED_OUT } from './credentials.mjs';

const skewMs = Number(process.env.ENFORCER_REFRESH_SKEW_MS) || REFRESH_SKEW_MS;
let code = 2;
try {
  const { outcome } = await refreshUnderLock({ skewMs, timeoutMs: CHILD_TIMEOUT_MS, lockWaitMs: CHILD_LOCK_WAIT_MS });
  code = outcome === 'fresh' || outcome === 'refreshed' ? 0 : outcome === 'signed_out' ? CHILD_SIGNED_OUT : 2;
} catch {
  code = 2;
}
process.exitCode = code;

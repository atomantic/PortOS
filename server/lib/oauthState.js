/** Issue and consume short-lived, single-use OAuth state with server-owned metadata. */
import { randomBytes } from 'node:crypto';

const PENDING_TTL_MS = 10 * 60 * 1000;

export const INVALID_OAUTH_STATE_MESSAGE = 'Invalid or expired OAuth state. Start authorization again.';

export function createOAuthStateStore() {
  const pendingAuthorizations = new Map();

  function issue(metadata) {
    const now = Date.now();
    for (const [state, pending] of pendingAuthorizations) {
      if (now - pending.createdAt >= PENDING_TTL_MS) pendingAuthorizations.delete(state);
    }
    const state = randomBytes(24).toString('base64url');
    pendingAuthorizations.set(state, { ...metadata, createdAt: now });
    return state;
  }

  function consume(state) {
    const pending = pendingAuthorizations.get(state);
    // Invalidate synchronously so overlapping callbacks cannot share a nonce.
    pendingAuthorizations.delete(state);
    if (!pending || Date.now() - pending.createdAt >= PENDING_TTL_MS) return null;
    return pending;
  }

  return { issue, consume };
}

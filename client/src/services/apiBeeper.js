import { API_BASE, request } from './apiCore.js';

// Beeper Desktop bridge — status card (#30). Read-only connection status
// (token-configured flag, never the token; tri-state reachability; the
// account roster mirrored from beeper_accounts) plus a live "Retry" check.
// Ingestion + connection settings (enabled/intervalMinutes/baseUrl/
// attachmentBudgetGb) go through the generic getSettings/updateSettings pair
// in apiSystem.js, same as iMessage/Signal — this file covers only what
// those don't.
export const getBeeperStatus = (options = {}) => request('/beeper/status', options);
export const checkBeeperConnection = (options = {}) => request('/beeper/status/check', { method: 'POST', ...options });

// The "Sync now" list-header action (#79). Runs one watermark-bounded sweep
// immediately rather than waiting out the configured interval; the server
// reports `skipped: true` instead of an error when a sweep is already in
// flight. The caller re-fetches the list and networks once this resolves —
// this call alone never refreshes anything the surface renders.
export const syncBeeperNow = (options = {}) => request('/beeper/sync', { method: 'POST', ...options });

// ---------------------------------------------------------------------------
// Chat surface (#35) — everything below reads the PortOS MIRROR, not Beeper.
// The sweep (#32) and the socket relay (#33) keep the mirror current, so the
// list stays correct with Beeper Desktop closed and a socket invalidation frame
// costs one local query rather than an upstream fan-out.
// ---------------------------------------------------------------------------

const queryString = (params) => {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    qs.set(key, String(value));
  }
  const encoded = qs.toString();
  return encoded ? `?${encoded}` : '';
};

// `unreadOnly` / `archived` / `lowPriority` are omitted when undefined and sent
// as the literal "true"/"false" otherwise: the server reads an absent filter as
// "do not filter", which is a different query from `false`.
export const getBeeperConversations = ({
  network, unreadOnly, archived, lowPriority, limit, cursor,
} = {}, options = {}) =>
  request(`/beeper/conversations${queryString({ network, unreadOnly, archived, lowPriority, limit, cursor })}`, options);

export const getBeeperConversation = (conversationId, options = {}) =>
  request(`/beeper/conversations/${encodeURIComponent(conversationId)}`, options);

export const getBeeperMessages = (conversationId, { limit, cursor } = {}, options = {}) =>
  request(`/beeper/conversations/${encodeURIComponent(conversationId)}/messages${queryString({ limit, cursor })}`, options);

export const getBeeperNetworks = (options = {}) => request('/beeper/networks', options);

// The two rail controls #9 wired. Both are WRITES to Beeper: they never retry,
// and their thrown error carries `context.retryable === false` so no caller can
// invent one on an API with no idempotency key.
export const setBeeperConversationArchived = (conversationId, archived, options = {}) =>
  request(`/beeper/conversations/${encodeURIComponent(conversationId)}/archive`, {
    method: 'POST',
    body: JSON.stringify({ archived }),
    ...options,
  });

export const setBeeperConversationLowPriority = (conversationId, lowPriority, options = {}) =>
  request(`/beeper/conversations/${encodeURIComponent(conversationId)}/low-priority`, {
    method: 'POST',
    body: JSON.stringify({ lowPriority }),
    ...options,
  });

// The LOCAL "seen in PortOS" watermark (#83) — the opposite shape from the two
// above: it never reaches Beeper. No body: the server stamps `seen_at` from
// its own clock. Called when a thread is opened and, cheaply, again when a
// new message lands in the open thread.
export const markBeeperConversationSeen = (conversationId, options = {}) =>
  request(`/beeper/conversations/${encodeURIComponent(conversationId)}/seen`, {
    method: 'POST',
    ...options,
  });

// Connect flow (#31). PortOS runs OAuth itself (PKCE S256, dynamic client
// registration); `startBeeperOAuth` returns the authorization URL for the
// browser to open, and the redirect lands on the server callback, never here.
// Pasting a token is a first-class alternative — Beeper's own UI can mint a
// no-expiry token and the OAuth surface accepts no lifetime at all. None of
// these ever return a token value: the client only ever sees `tokenConfigured`,
// `tokenExpiresAt` and `tokenSource`.
//
// The browser sends its OWN origin, because the server cannot derive it: under
// the Vite dev proxy (`changeOrigin: true`, no `x-forwarded-*`) the request
// arrives carrying the API's origin on the API port, so the consent redirect
// went to a host the TLS certificate does not cover and the user landed on a
// certificate error. The server validates the value against the hosts this
// install answers on and falls back to the request origin when it does not
// recognize it.
export const startBeeperOAuth = (options = {}) => request('/beeper/oauth/start', {
  method: 'POST',
  body: JSON.stringify({ origin: window.location.origin }),
  ...options,
});
export const saveBeeperToken = (token, options = {}) => request('/beeper/token', { method: 'POST', body: JSON.stringify({ token }), ...options });
export const disconnectBeeper = (options = {}) => request('/beeper/token', { method: 'DELETE', ...options });

// ---------------------------------------------------------------------------
// Attachment byte mirror (#37)
// ---------------------------------------------------------------------------

/**
 * The `src` for one attachment's BYTES. A relative `/api/...` path, never an
 * absolute URL: PortOS is routinely reached over Tailscale from another
 * machine, and a hardcoded origin would point that browser at its own laptop.
 *
 * Requesting this URL is what triggers the mirror. The bytes are fetched from
 * Beeper on a miss and served from disk afterwards, so an `<img loading="lazy">`
 * pointed here IS the "download on first human view" rule — nothing else has to
 * decide when a view happened.
 */
export const beeperAttachmentUrl = (messageId, idx) =>
  `${API_BASE}/beeper/attachments/${encodeURIComponent(messageId)}/${encodeURIComponent(idx)}`;

// The over-cap placeholder's "fetch anyway", and the only path that retries an
// attachment Beeper previously refused. Returns the refreshed row, not bytes.
export const fetchBeeperAttachment = (messageId, idx, options = {}) =>
  request(`/beeper/attachments/${encodeURIComponent(messageId)}/${encodeURIComponent(idx)}/fetch`, {
    method: 'POST',
    ...options,
  });

// The per-attachment keep lock (the `useLockToggle` optimistic-PATCH shape):
// exempt this one from least-recently-viewed eviction.
export const setBeeperAttachmentKeep = (messageId, idx, keep, options = {}) =>
  request(`/beeper/attachments/${encodeURIComponent(messageId)}/${encodeURIComponent(idx)}`, {
    method: 'PATCH',
    body: JSON.stringify({ keep }),
    ...options,
  });

// The census the bulk-backfill consent modal must state before it runs, plus
// the budget/usage picture the settings card renders.
export const getBeeperAttachmentSummary = (options = {}) => request('/beeper/attachments/summary', options);

// The bulk backfill itself — only ever called after the consent modal.
export const backfillBeeperAttachments = (body = {}, options = {}) =>
  request('/beeper/attachments/backfill', { method: 'POST', body: JSON.stringify(body), ...options });

// Purge ONE conversation's mirror (messages, participants, attachment rows and
// the bytes). PortOS-local: Beeper still has the chat. The caller gates this
// behind a typed confirmation naming the conversation and the byte count.
export const purgeBeeperConversation = (conversationId, options = {}) =>
  request(`/beeper/conversations/${encodeURIComponent(conversationId)}`, { method: 'DELETE', ...options });

// Outbound outbox (#36, decided on #8). Two calls for the two-step send, plus
// the breaker reset — every one of them a WRITE, and none of them ever retried:
// Beeper has no idempotency key on send, so a client-side retry is a second
// real message to a real person. The server marks these `retryable: false` in
// the error envelope for the same reason; nothing here re-issues a request.
//
// `confirmFirstContact` is passed explicitly and only when the user has
// answered an inline confirmation. It is a gate, not a hint: the server refuses
// the first outbound message to a conversation without it.
export const listOutboxEntries = (conversationId, options = {}) => request(`/beeper/outbox?conversationId=${encodeURIComponent(conversationId)}`, options);
export const createOutboxEntry = (conversationId, body, options = {}) => request('/beeper/outbox', {
  method: 'POST',
  body: JSON.stringify({ conversationId, body }),
  ...options,
});
export const sendOutboxEntry = (id, { confirmFirstContact = false } = {}, options = {}) => request(`/beeper/outbox/${encodeURIComponent(id)}/send`, {
  method: 'POST',
  body: JSON.stringify({ confirmFirstContact }),
  ...options,
});
export const clearOutboxBreaker = (options = {}) => request('/beeper/outbox/breaker/clear', { method: 'POST', ...options });
// Discard a row the human declined to send — the first-contact confirmation's
// "Cancel" (#53). Only an `approved` row (nothing has POSTed to Beeper for it
// yet) is discardable.
export const discardOutboxEntry = (id, options = {}) => request(`/beeper/outbox/${encodeURIComponent(id)}`, {
  method: 'DELETE',
  ...options,
});

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, createServiceErrorMapper, ServerError } from '../lib/errorHandler.js';
import { resolveOAuthOrigin } from '../lib/beeperOAuthOrigin.js';
import { PORTOS_API_URL, PORTOS_UI_URL } from '../lib/portosUrls.js';
import { serveLocalFile } from '../lib/fileUtils.js';
import { basename, dirname } from 'path';
import {
  beeperOAuthCallbackSchema, beeperOutboxCreateSchema, beeperOutboxListSchema,
  beeperOutboxParamsSchema, beeperOutboxSendSchema, beeperPastedTokenSchema, validateRequest,
} from '../lib/validation.js';
import { getBeeperStatus, checkBeeperConnection } from '../services/beeperStatus.js';
import { completeBeeperOAuth, connectWithPastedToken, disconnectBeeper, startBeeperOAuth } from '../services/beeperOAuth.js';
import { runBeeperSweep } from '../services/beeperSync.js';
import {
  clearOutboxBreaker, createOutboxEntry, discardOutboxEntry, listOutboxEntries, sendOutboxEntry,
} from '../services/beeperOutbox.js';
import {
  listConversations,
  getConversation,
  listMessages,
  listNetworks,
  markConversationSeen,
  purgeConversation,
  setConversationArchived,
  setConversationLowPriority,
} from '../services/beeperConversations.js';
import {
  backfillAttachments,
  ensureAttachmentBytes,
  getAttachment,
  getAttachmentSummary,
  setAttachmentKeep,
} from '../services/beeperAttachments.js';

const router = Router();

// BeeperApiError#status can be 0 on a pure network failure (no HTTP response
// at all — see beeperClient.js's NETWORK_ERROR case), and `res.status(0)`
// crashes Express. This mapper NEVER passes the client's raw status through:
// every recognized code gets its own explicit HTTP status here, per the
// contract wave-one reviewers set for every Beeper route built on this client.
// The OAUTH_* codes (#31) join the same table rather than inventing a second
// one, so a connect failure renders through the client's existing handling.
const BEEPER_ERROR_STATUS = {
  NETWORK_ERROR: 503,
  NOT_CONFIGURED: 412,
  MALFORMED_RESPONSE: 502,
  ASSET_UNAVAILABLE: 404,
  // Every account failed in one sweep (#32). An upstream failure, not the
  // caller's, and worth retrying — it must not answer 200 with a quietly
  // non-zero `failedAccounts`.
  SWEEP_FAILED: 502,
  UNAUTHORIZED: 401,
  TOKEN_REQUIRED: 400,
  TOKEN_REJECTED: 401,
  OAUTH_INTROSPECTION_FAILED: 502,
  OAUTH_REDIRECT_URI_MISSING: 400,
  OAUTH_STATE_UNKNOWN: 400,
  OAUTH_DISCOVERY_FAILED: 502,
  OAUTH_DISCOVERY_INVALID: 502,
  OAUTH_REGISTRATION_FAILED: 502,
  OAUTH_EXCHANGE_FAILED: 502,
  // The attachment mirror (#37). An over-cap attachment is not an error the
  // user can fix by retrying — it is a deliberate refusal with a named escape
  // hatch ("fetch anyway"), so it gets its own status rather than riding on
  // 400. ATTACHMENT_DOWNLOAD_FAILED/ATTACHMENT_STORE_FAILED are local-side
  // failures of a fetch that Beeper itself answered.
  ATTACHMENT_TOO_LARGE: 413,
  ATTACHMENT_DOWNLOAD_FAILED: 502,
  ATTACHMENT_STORE_FAILED: 500,
  // Outbox (#36). Every one is a 4xx the composer renders inline: the entry is
  // gone, it is not in a sendable state, the first-contact confirmation has not
  // been given, or the runaway breaker is open and only a human closes it.
  OUTBOX_ENTRY_NOT_FOUND: 404,
  OUTBOX_INVALID_STATE: 409,
  OUTBOX_EMPTY_BODY: 400,
  FIRST_CONTACT_CONFIRMATION_REQUIRED: 409,
  OUTBOX_BREAKER_OPEN: 429,
  CONVERSATION_NOT_FOUND: 404,
  SEND_FAILED: 502,
};

// The one code whose envelope carries data the client can act on: an over-cap
// refusal states the size it measured and the ceiling it measured against, so
// a caller is not left to re-derive either. `createServiceErrorMapper` builds a
// FRESH ServerError, so a context the service attached is dropped unless it is
// rebuilt here; returning `undefined` for every other code leaves those
// envelopes exactly as they were.
const mapBeeperError = createServiceErrorMapper(BEEPER_ERROR_STATUS, (err) => (
  err?.code === 'ATTACHMENT_TOO_LARGE'
    ? { bytes: err?.context?.bytes, maxBytes: err?.context?.maxBytes }
    : undefined
));

// Write paths (connect / paste / disconnect) carry `retryable: false` into the
// error envelope. Beeper sends are non-idempotent and the connect exchange
// burns a single-use code, so a client that auto-retried either would do real
// damage — the flag is the contract the client keys on rather than re-deriving
// "is a 502 transient" for itself.
// The chat-surface writes (#35) go through the same mapper, so its table also
// carries every HTTP-derived code beeperClient's STATUS_TABLE can raise on a
// PATCH — an unmapped code would fall through as a raw BeeperApiError whose
// `status` can be 0.
const mapBeeperWriteError = createServiceErrorMapper({
  ...BEEPER_ERROR_STATUS,
  BAD_REQUEST: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION_ERROR: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 502,
  UPSTREAM_ERROR: 502,
  UNKNOWN_ERROR: 502,
}, () => ({ retryable: false }));

// OAuth must use the same public origin the browser used to reach this request,
// so the flow works over HTTPS, on a Tailscale hostname, or behind a proxy —
// never a hardcoded localhost. Same derivation as routes/spotify.js.
//
// It is the FALLBACK rather than the answer, because it is wrong under the Vite
// dev proxy: `changeOrigin: true` with no `x-forwarded-*` makes the server see
// its own HTTPS origin on the API port, and the consent redirect then lands the
// browser on a host the certificate does not cover. The browser sends its own
// `window.location.origin` instead, validated by `resolveOAuthOrigin`.
function requestOrigin(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http')
    .toString().split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '')
    .toString().split(',')[0].trim();
  return ['http', 'https'].includes(proto) && host ? `${proto}://${host}` : null;
}

const redirectUriFrom = (origin) => (origin ? `${origin}/api/beeper/oauth/callback` : null);

// The browser's own origin. Optional, so an older client (or a caller with no
// window) still gets today's request-derived behaviour.
const oauthStartSchema = z.object({ origin: z.string().min(1).max(2048).optional() }).strict();

// GET /api/beeper/status — the status card's read model (#30): whether a
// token is configured (never the token), how it was obtained, its expiry, a
// cached-cheap reachability probe, and the read-only account roster mirrored
// from beeper_accounts.
router.get('/status', asyncHandler(async (_req, res) => {
  res.json(await getBeeperStatus());
}));

// POST /api/beeper/status/check — the status card's "Retry" action on the
// "token present, unreachable" state. Does a live, uncached probe and
// surfaces a real, coded error instead of GET /status's always-200 flattened
// `lastProbeError` string, so the client can render an actionable message
// per HTTP status (503 unreachable, 412 not configured, 502 malformed reply).
router.post('/status/check', asyncHandler(async (_req, res) => {
  const result = await checkBeeperConnection().catch((err) => { throw mapBeeperError(err); });
  res.json(result);
}));

// POST /api/beeper/sync — run one watermark-bounded ingestion sweep now
// (#32). The scheduled sweep is the normal path; this is the explicit
// user-triggered equivalent, for a user who has just connected a token or
// just changed a setting and does not want to wait out the interval. Deterministic
// ingestion only — no AI provider call — so it needs no consent step.
//
// A sweep already in flight is reported as `skipped: true` rather than queued
// or run concurrently; a missing token maps to 412 through the same coded
// mapper the status routes use, never a raw `status: 0`.
router.post('/sync', asyncHandler(async (_req, res) => {
  const result = await runBeeperSweep({ reason: 'manual' }).catch((err) => { throw mapBeeperError(err); });
  res.json(result);
}));

// ---------------------------------------------------------------------------
// Chat surface read model (#35) — served from the MIRROR, never from Beeper.
// ---------------------------------------------------------------------------

// A query-string boolean is a STRING, so `z.coerce.boolean()` is wrong here:
// it maps the literal "false" to `true`. Omission stays `undefined`, which the
// service reads as "do not filter on this at all" — a different query from
// `false` (root AGENTS.md, absent-vs-empty).
const queryBoolean = z.enum(['true', 'false']).transform((value) => value === 'true').optional();

const conversationListQuerySchema = z.object({
  network: z.string().min(1).max(100).optional(),
  unreadOnly: queryBoolean,
  archived: queryBoolean,
  lowPriority: queryBoolean,
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().max(500).optional(),
}).strict();

const messageListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().max(500).optional(),
}).strict();

const conversationParamsSchema = z.object({ id: z.string().guid() });

const archiveSchema = z.object({ archived: z.boolean() }).strict();
const lowPrioritySchema = z.object({ lowPriority: z.boolean() }).strict();

// GET /api/beeper/conversations — the rail's list for one scope. Filters are
// per-network and unread-only (#9's MVP scoping) plus the two system scopes
// the wired rail controls produce, archived and low-priority.
router.get('/conversations', asyncHandler(async (req, res) => {
  const filters = validateRequest(conversationListQuerySchema, req.query);
  res.json(await listConversations(filters));
}));

// GET /api/beeper/networks — the rail's scope list, derived from the mirror.
// Never a hardcoded network roster: #9 records that the development machine's
// account shape is an outlier, so the rail renders whatever data holds.
router.get('/networks', asyncHandler(async (_req, res) => {
  res.json({ networks: await listNetworks() });
}));

// GET /api/beeper/conversations/:id — one conversation with its full mirrored
// participant set. 404 when the id is unknown, so a stale deep link degrades to
// the surface's not-found state instead of an empty thread that looks live.
//
// The chat surface fetches this with `silent: true` and renders its own inline
// not-found state, and it re-fetches on every invalidation frame while the
// missing id stays selected — so this is a speculative, expected-high-volume
// 404, not an operator-actionable one. `severity: 'warning'` (mediaJobs.js's
// GET /:id pattern) keeps it out of the global toast and the server console
// via `useErrorNotifications` / `asyncHandler` while the body is unchanged:
// callers still get a 404 + NOT_FOUND code, and it still reaches errorEvents.
router.get('/conversations/:id', asyncHandler(async (req, res) => {
  const { id } = validateRequest(conversationParamsSchema, req.params);
  const conversation = await getConversation(id);
  if (!conversation) {
    throw new ServerError('Conversation not found', { status: 404, code: 'NOT_FOUND', severity: 'warning' });
  }
  res.json(conversation);
}));

// GET /api/beeper/conversations/:id/messages — cursor-paginated, newest first.
// An empty page is a legitimate answer, not an error: history depth varies
// enormously per network (#3), so the surface says so rather than spinning.
router.get('/conversations/:id/messages', asyncHandler(async (req, res) => {
  const { id } = validateRequest(conversationParamsSchema, req.params);
  const options = validateRequest(messageListQuerySchema, req.query);
  res.json(await listMessages(id, options));
}));

// POST /api/beeper/conversations/:id/archive — one of the two rail controls #9
// wired. Beeper owns `isArchived`, so this PATCHes Beeper first and mirrors the
// answer second; a failure leaves the mirror untouched.
router.post('/conversations/:id/archive', asyncHandler(async (req, res) => {
  const { id } = validateRequest(conversationParamsSchema, req.params);
  const { archived } = validateRequest(archiveSchema, req.body);
  const conversation = await setConversationArchived(id, archived)
    .catch((err) => { throw mapBeeperWriteError(err); });
  res.json(conversation);
}));

// POST /api/beeper/conversations/:id/low-priority — the other wired control.
// `isPinned` deliberately has no route: the pinned set is Beeper's own state,
// mirrored (#27), and a PortOS-local pin would be a second source of truth.
router.post('/conversations/:id/low-priority', asyncHandler(async (req, res) => {
  const { id } = validateRequest(conversationParamsSchema, req.params);
  const { lowPriority } = validateRequest(lowPrioritySchema, req.body);
  const conversation = await setConversationLowPriority(id, lowPriority)
    .catch((err) => { throw mapBeeperWriteError(err); });
  res.json(conversation);
}));

// POST /api/beeper/conversations/:id/seen — the LOCAL "seen in PortOS"
// watermark (#83), the fix for opening an unread thread leaving its badge
// untouched. Unlike archive/low-priority above, this NEVER calls Beeper: no
// PATCH, no read receipt, nothing that reaches the source network — just a
// local `seen_at` stamp the read model compares against the conversation's
// own activity (`markConversationSeen`). No request body: it is called with
// nothing to validate beyond the id, on every thread open and, cheaply, again
// when a new message lands in the open thread.
router.post('/conversations/:id/seen', asyncHandler(async (req, res) => {
  const { id } = validateRequest(conversationParamsSchema, req.params);
  const conversation = await markConversationSeen(id);
  res.json(conversation);
}));

// ---------------------------------------------------------------------------
// Attachment byte mirror (#37)
// ---------------------------------------------------------------------------

// `messageId` is Beeper's own message id (TEXT — bridges do not promise a UUID
// shape), so it is bounded and pattern-free rather than `.guid()`. It never
// becomes a path: the file is addressed by the sha256 the mirror computed.
const attachmentParamsSchema = z.object({
  messageId: z.string().min(1).max(500),
  idx: z.coerce.number().int().min(0).max(999),
});
const attachmentKeepSchema = z.object({ keep: z.boolean() }).strict();
const backfillSchema = z.object({ limit: z.number().int().min(1).max(5000).optional() }).strict();

// GET /api/beeper/attachments/summary — what the bulk-backfill consent step has
// to state before it runs (how many attachments, how many bytes, how many of
// unknown size) plus the budget picture the settings card renders. Declared
// BEFORE the `:messageId/:idx` routes so "summary" can never be read as a
// message id.
router.get('/attachments/summary', asyncHandler(async (_req, res) => {
  res.json(await getAttachmentSummary());
}));

// POST /api/beeper/attachments/backfill — mirror every reference-only
// attachment. A USER action, never automatic: the client gates it behind a
// consent modal naming the count and the byte size first (root AGENTS.md's
// no-unbidden-work policy, applied to bytes rather than to LLM calls), and the
// run stops at the disk budget instead of blowing through it.
router.post('/attachments/backfill', asyncHandler(async (req, res) => {
  const { limit } = validateRequest(backfillSchema, req.body ?? {});
  const result = await backfillAttachments({ limit }).catch((err) => { throw mapBeeperError(err); });
  res.json(result);
}));

// GET /api/beeper/attachments/:messageId/:idx — the BYTES, served from disk and
// fetched from Beeper on a miss. This is the lazy mirror's whole trigger: the
// thread renders the reference, the browser asks for it when it scrolls into
// view, and only then does anything leave the machine.
//
// An authenticated `/api/` route on `serveLocalFile` rather than a `/data/`
// static mount (#13): message media is PII, and the store is a content-addressed
// pile of hashes that a directory mount would expose without the row-level check
// this route does. `serveLocalFile` is handed an explicit `contentType` because
// the file's own extension is cosmetic — `GET /v1/assets/serve` sends no
// `Content-Type` at all, so Beeper's declared `mimeType` from the message
// payload is the only real answer.
//
// No `force` query param (SEC-4): this is a safe (GET) method, and
// `ensureAttachmentBytes` treats `force: true` as "raise the 32 MiB mirror
// ceiling AND clear a terminal `unavailable_at` refusal so it retries a source
// that already said no." Reading `force` off the query string here let a plain
// GET — no confirmation, no method-level intent — do both. `force: true`
// stays reachable ONLY through the dedicated
// `POST /attachments/:messageId/:idx/fetch` "fetch anyway" route below.
router.get('/attachments/:messageId/:idx', asyncHandler(async (req, res) => {
  const { messageId, idx } = validateRequest(attachmentParamsSchema, req.params);
  const resolved = await ensureAttachmentBytes(messageId, idx)
    .catch((err) => { throw mapBeeperError(err); });
  await serveLocalFile(res, dirname(resolved.filePath), basename(resolved.filePath), {
    contentType: resolved.mimeType,
    missingError: { message: 'Attachment bytes are not on this machine', code: 'NOT_ON_THIS_MACHINE' },
  });
}));

// POST /api/beeper/attachments/:messageId/:idx/fetch — the over-cap
// placeholder's "fetch anyway", and the one path that also retries an
// attachment the source previously refused. Returns the row rather than the
// bytes, so the surface can swap the placeholder for the real thing and let the
// GET above stream it.
router.post('/attachments/:messageId/:idx/fetch', asyncHandler(async (req, res) => {
  const { messageId, idx } = validateRequest(attachmentParamsSchema, req.params);
  await ensureAttachmentBytes(messageId, idx, { force: true })
    .catch((err) => { throw mapBeeperError(err); });
  res.json(await getAttachment(messageId, idx));
}));

// PATCH /api/beeper/attachments/:messageId/:idx — the per-attachment `keep`
// lock: exempt this one from least-recently-viewed eviction forever.
router.patch('/attachments/:messageId/:idx', asyncHandler(async (req, res) => {
  const { messageId, idx } = validateRequest(attachmentParamsSchema, req.params);
  const { keep } = validateRequest(attachmentKeepSchema, req.body);
  res.json(await setAttachmentKeep(messageId, idx, keep));
}));

// DELETE /api/beeper/conversations/:id — purge ONE conversation's mirror:
// messages, participants, attachment rows and the bytes those rows were
// holding. Local only — Beeper still has the chat, and the next sweep will
// mirror it again. The client gates this behind a typed confirmation naming the
// conversation and the byte count, never a `window.confirm`.
router.delete('/conversations/:id', asyncHandler(async (req, res) => {
  const { id } = validateRequest(conversationParamsSchema, req.params);
  res.json(await purgeConversation(id));
}));

// POST /api/beeper/oauth/start — discover, dynamically register PortOS as a
// public client, and mint the PKCE authorization URL the browser opens (#31).
// A POST because it registers a client and stores a pending authorization; the
// PKCE verifier never leaves the server.
router.post('/oauth/start', asyncHandler(async (req, res) => {
  const { origin: clientOrigin } = validateRequest(oauthStartSchema, req.body ?? {});
  const { origin, rejectedClientOrigin } = resolveOAuthOrigin({
    clientOrigin,
    requestOrigin: requestOrigin(req),
    configuredOrigins: [PORTOS_UI_URL, PORTOS_API_URL],
  });
  // Never interpolate the value: it is a host off the user's own machine or
  // tailnet, and this line can end up in a shared log.
  if (rejectedClientOrigin) {
    console.warn('⚠️ Beeper OAuth: browser origin is not one this install serves — using the request origin instead');
  }
  const result = await startBeeperOAuth({ redirectUri: redirectUriFrom(origin), clientUri: origin })
    .catch((err) => { throw mapBeeperWriteError(err); });
  res.json(result);
}));

// GET /api/beeper/oauth/callback — hit by a BROWSER redirect from Beeper's
// consent screen, not by the SPA, so every outcome renders as a redirect back
// to the Beeper tab (which toasts the params) instead of the JSON envelope the
// error middleware would send. The `code` never reaches the client: it is
// exchanged here and only the outcome flag rides the redirect.
router.get('/oauth/callback', asyncHandler(async (req, res) => {
  const tabUrl = (error) => (error
    ? `/messages/beeper?beeperOauthError=${encodeURIComponent(error)}`
    : '/messages/beeper?beeperConnected=1');
  // safeParse rather than validateRequest: a browser landing here must always
  // end up back on the tab with a readable message, never on the JSON error
  // envelope validateRequest's throw would render in the address bar.
  const parsed = beeperOAuthCallbackSchema.safeParse(req.query);
  if (!parsed.success) return res.redirect(tabUrl('Malformed OAuth callback'));
  const params = parsed.data;
  if (params.error) return res.redirect(tabUrl(params.error));
  if (!params.code || !params.state) return res.redirect(tabUrl('Missing authorization code or state'));

  const outcome = await completeBeeperOAuth({ code: params.code, state: params.state })
    .then((result) => ({ result }))
    .catch((err) => {
      // The redirect swallows the throw, so asyncHandler never logs it — keep
      // the failure visible here. `err.message` is built from an RFC 6749 error
      // code or an HTTP status; it never carries a token or a code.
      console.error(`❌ Beeper OAuth callback failed: ${err.message}`);
      return { error: err.message || 'Beeper OAuth callback failed' };
    });
  if (outcome.error) return res.redirect(tabUrl(outcome.error));
  console.log('🔗 Beeper OAuth callback completed, credential stored');
  res.redirect(tabUrl());
}));

// POST /api/beeper/token — the paste path (#11 decision 3), a first-class
// alternative to OAuth rather than a fallback: Beeper's own UI can mint a
// no-expiry token and the OAuth surface accepts no lifetime at all. Validated
// by RFC 7662 introspection (or, failing that, a call that requires the
// bearer) so a token the server refuses is never stored, then vaulted with
// whatever expiry introspection reported. The response carries presence,
// expiry and provenance — never the value.
router.post('/token', asyncHandler(async (req, res) => {
  const { token } = validateRequest(beeperPastedTokenSchema, req.body);
  const result = await connectWithPastedToken(token).catch((err) => { throw mapBeeperWriteError(err); });
  res.json(result);
}));

// DELETE /api/beeper/token — disconnect. Revokes at the authorization server
// when the credential came from OAuth and the server advertises a revocation
// endpoint, then deletes the vaulted copy either way. Idempotent.
router.delete('/token', asyncHandler(async (_req, res) => {
  const result = await disconnectBeeper().catch((err) => { throw mapBeeperWriteError(err); });
  res.json(result);
}));

// ---------------------------------------------------------------------------
// Outbox (#36, decided on #8) — the ONLY send path, and a human one.
//
// Two steps, two routes, two human actions, mirroring the email drafts surface
// (`POST /api/messages/drafts/:id/approve` then `.../send`): creating the entry
// records the approved text, sending it performs the POST. No scheduler, no
// agent, no voice tool and no CoS tool reaches either — asserted structurally
// by `beeperOutboxHumanGate.test.js`, not left to convention.
// ---------------------------------------------------------------------------

// GET /api/beeper/outbox?conversationId=… — the composer's own history for one
// conversation, newest first. Failed entries stay in it: a failed send is
// visible and never silently retried.
router.get('/outbox', asyncHandler(async (req, res) => {
  const params = validateRequest(beeperOutboxListSchema, req.query);
  res.json({ entries: await listOutboxEntries(params) });
}));

// POST /api/beeper/outbox — step one. Writes the durable row BEFORE anything is
// sent, so intent survives a crash between the click and the POST.
router.post('/outbox', asyncHandler(async (req, res) => {
  const input = validateRequest(beeperOutboxCreateSchema, req.body);
  const entry = await createOutboxEntry(input).catch((err) => { throw mapBeeperWriteError(err); });
  res.status(201).json(entry);
}));

// POST /api/beeper/outbox/:id/send — step two. `confirmFirstContact` must be
// explicitly true on the first outbound message to a conversation; without it
// the send is refused with a coded 409 the composer renders as an inline
// confirmation. A transport failure answers a coded error and leaves exactly
// one row in `failed` — the client never retries it (`retryable: false`), and
// re-sending means composing a new entry.
router.post('/outbox/:id/send', asyncHandler(async (req, res) => {
  const { id } = validateRequest(beeperOutboxParamsSchema, req.params);
  const { confirmFirstContact } = validateRequest(beeperOutboxSendSchema, req.body ?? {});
  const entry = await sendOutboxEntry(id, { confirmFirstContact: confirmFirstContact === true })
    .catch((err) => { throw mapBeeperWriteError(err); });
  res.json(entry);
}));

// DELETE /api/beeper/outbox/:id — discard a row the human declined to send:
// the first-contact confirmation's "Cancel" (#53). Only an `approved` row can
// be discarded — nothing has POSTed to Beeper for it yet, so this is a pure
// local record removal, never an unsend. Anything further along answers 409.
router.delete('/outbox/:id', asyncHandler(async (req, res) => {
  const { id } = validateRequest(beeperOutboxParamsSchema, req.params);
  await discardOutboxEntry(id).catch((err) => { throw mapBeeperWriteError(err); });
  res.status(204).send();
}));

// POST /api/beeper/outbox/breaker/clear — the runaway breaker's only reset.
// Deliberately a human HTTP action with no timed recovery anywhere: a breaker
// that clears itself is a delay, not a breaker.
router.post('/outbox/breaker/clear', asyncHandler(async (_req, res) => {
  res.json(clearOutboxBreaker());
}));

export default router;

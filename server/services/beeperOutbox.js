/**
 * Beeper outbound outbox (fork issue #36, decided on #8, confirmation
 * transport decided on #12).
 *
 * PortOS's send posture is upstream's tier 2 — draft → human approve → human
 * send, through ONE service whose only non-test caller is a human HTTP route
 * (`server/routes/beeper.js`). `messageSender.sendDraft` is the shape this
 * reuses: the `status === 'approved'` gate, the mismatch gate, and the
 * one-human-caller rule. What it deliberately does NOT reuse is that service's
 * FILE-BACKED draft store — the `beeper_*` tables are `db-primary`, and #8
 * rejected straddling two storage classifications. Hence a Beeper-native
 * `beeper_outbox` row.
 *
 * Four rules this module exists to enforce:
 *
 *  1. **The row is written before the POST.** Intent survives a crash between
 *     the click and the send, and the row is the one serialization point per
 *     entry — the `approved → sending` transition is a conditional UPDATE, so
 *     a double-click cannot double-post.
 *  2. **A send is NEVER retried automatically.** Beeper has no idempotency key
 *     on `POST /v1/chats/{chatID}/messages`, so a retry delivers a second real
 *     message to a real person. A response-less transport failure leaves the
 *     row in `awaiting-confirmation`, because the POST may have landed. Only a
 *     definitive rejection becomes `failed` and offers a new human send.
 *  3. **Confirmation is a resolve, never a re-send.** The send is asynchronous
 *     and answers only `{ chatID, pendingMessageID }`. The row confirms on the
 *     `message.upserted` invalidation relayed by #33, with a 30-second fallback
 *     to `GET /v1/chats/{chatID}/messages/{messageID}` — WebSocket delivery is
 *     at-most-once with no replay, so the socket cannot be the only path.
 *     Neither path sends anything.
 *  4. **A runaway breaker, not a rate quota.** Every send is one human click,
 *     so a quota paces a human who is already paced. The breaker catches the
 *     failure this design cannot otherwise see — a software loop — and only a
 *     human clears it.
 *
 * No AI drafting and no AI review (#8 decision 8), and no agent reach: no
 * `cosToolRegistry` entry, no voice tool, no scheduler. `beeperOutboxHumanGate.test.js`
 * asserts that structurally rather than by convention.
 */

import { query, withTransaction } from '../lib/db.js';
import { BeeperApiError, getMessage, listMessagesPage, sendMessage } from './beeperClient.js';
import { normalizeMessageRow } from './beeperSync.js';
import { beeperSocketEvents } from './beeperSocketEvents.js';

const LOG_PREFIX = '🫧 Beeper outbox';

/**
 * The socket is the fast path; this is the floor under it. 30 s is #12's
 * decision: long enough that a healthy `message.upserted` almost always wins
 * the race (so the fallback GET is rare rather than routine), short enough
 * that a dropped frame does not leave a send unresolved on screen.
 */
export const CONFIRMATION_TIMEOUT_MS = 30_000;

/**
 * The code and the recorded reason for a send this process found stranded in
 * `sending` at boot — a POST that was in flight when the previous process died.
 *
 * The outcome is UNKNOWABLE: the request may have been delivered, refused, or
 * never have left. Rule 2 above therefore still holds — nothing re-POSTs it.
 * The row lands in the existing terminal `failed` state so it cannot spin
 * forever, while this error code tells the client to show uncertainty with no
 * Retry control. The copy says what actually happened rather than claiming a
 * delivery verdict PortOS does not have. The client renders this sentence
 * verbatim off the code, so the same string is repeated in
 * `client/src/components/messages/beeper/BeeperThread.jsx` — the two bundles
 * cannot share a module, so they share a test instead.
 */
export const SEND_INTERRUPTED_CODE = 'SEND_INTERRUPTED';
export const SEND_INTERRUPTED_MESSAGE = 'Delivery unconfirmed: PortOS restarted mid-send. Check the chat before retrying.';

/** A send whose POST may have landed, but whose response never reached PortOS. */
export const DELIVERY_UNCONFIRMED_CODE = 'DELIVERY_UNCONFIRMED';
export const DELIVERY_UNCONFIRMED_MESSAGE = 'Delivery unconfirmed; check the chat before sending again.';

/**
 * PostgreSQL's `undefined_table`. The boot reconcile runs before the DB phase
 * has called `ensureSchema()`, so a brand-new install's very first start can
 * reach it with no `beeper_outbox` table — which is not a fault to narrate: an
 * absent table holds no interrupted sends. Every other error still logs.
 */
const UNDEFINED_TABLE = '42P01';

/**
 * Runaway-breaker thresholds. Deliberately far above anything a human at a
 * composer produces and far below what an unattended loop produces in the same
 * minute: eleven sends inside a minute is one every 5.5 seconds, sustained,
 * which is a fault rather than a conversation. The consecutive-failure arm
 * catches the other loop shape — a caller that keeps firing at a Beeper that
 * keeps refusing.
 */
export const BREAKER_WINDOW_MS = 60_000;
export const BREAKER_MAX_SENDS_IN_WINDOW = 10;
export const BREAKER_MAX_CONSECUTIVE_FAILURES = 3;

const DEFAULT_RUNTIME = Object.freeze({
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
});

let runtime = { ...DEFAULT_RUNTIME };

// Breaker + confirmation state is in-memory ON PURPOSE. The failure it defends
// against is a live in-process loop, so process-lifetime scope is the right
// scope: a restart clears it, and a loop that survived the restart re-trips it
// within the same window. Persisting it would instead let one bad minute wedge
// the composer across restarts with no way back except the same human click.
let sendTimestamps = [];
let consecutiveFailures = 0;
let breaker = { tripped: false, reason: null, trippedAt: null };

// outboxId → { chatId, body, pendingMessageId, requestedAt,
//   deliveryOutcomeUnknown, timer, resolving }
const pendingConfirmations = new Map();
const localTransitions = new Map();
const activeSends = new Set();
const reconciliationOperations = new Map();
export const PERSISTENCE_RETRY_DELAYS_MS = Object.freeze([1000, 2000, 4000]);
const PERSISTENCE_RECOVERY_MESSAGE = 'Delivery unconfirmed: saving the send outcome failed. Check delivery to reconcile without sending again.';

function invalidateOutbox(id) {
  beeperSocketEvents.emit('invalidate', { kind: 'outbox.updated', chatID: null, ids: [id], seq: null, ts: new Date(runtime.now()).toISOString() });
}

function recoveryView(entry) {
  if (!entry) return entry;
  if (!localTransitions.has(entry.id)) return entry;
  return { ...entry, state: 'awaiting-confirmation', errorCode: DELIVERY_UNCONFIRMED_CODE, errorMessage: PERSISTENCE_RECOVERY_MESSAGE };
}

// Own only local persistence here: the closure must NEVER contain a send POST.
// Retain it after the bounded timer budget, so a human can resume it later.
async function runLocalTransition(id, transition) {
  if (transition.running) return transition.running;
  runtime.clearTimeout(transition.timer);
  transition.running = transition.write().then((value) => {
    if (localTransitions.get(id) === transition) localTransitions.delete(id);
    transition.committed?.(value);
    invalidateOutbox(id);
    return value;
  }).catch(() => {
    if (transition.attempt < PERSISTENCE_RETRY_DELAYS_MS.length) {
      const delay = PERSISTENCE_RETRY_DELAYS_MS[transition.attempt++];
      transition.timer = runtime.setTimeout(() => {
        runLocalTransition(id, transition).catch((err) => console.error(`${LOG_PREFIX}: local recovery failed (${err.code || 'unknown'})`));
      }, delay);
    }
    invalidateOutbox(id);
    return null;
  }).finally(() => { transition.running = null; });
  return transition.running;
}

function persistTransition(id, write, committed) {
  const transition = { write, committed, attempt: 0, running: null, timer: null };
  localTransitions.set(id, transition);
  return runLocalTransition(id, transition);
}
let invalidateListenerAttached = false;

/** Test seam for injected time (mirrors `beeperSocket.js`'s runtime object). */
export function configureOutboxRuntime(overrides = {}) {
  runtime = { ...DEFAULT_RUNTIME, ...overrides };
}

export function resetOutboxRuntime() {
  runtime = { ...DEFAULT_RUNTIME };
}

// ---------------------------------------------------------------------------
// Runaway breaker
// ---------------------------------------------------------------------------

function trip(reason) {
  breaker = { tripped: true, reason, trippedAt: new Date(runtime.now()).toISOString() };
  console.error(`${LOG_PREFIX}: runaway breaker tripped (${reason}) — sends blocked until a human clears it`);
}

/**
 * The breaker's read model, surfaced on `GET /api/beeper/status`. `tripped` is
 * the gate; the two counters ride along so the card can say WHY rather than
 * just that something is blocked.
 */
export function getOutboxBreakerState() {
  const cutoff = runtime.now() - BREAKER_WINDOW_MS;
  return {
    tripped: breaker.tripped,
    reason: breaker.reason,
    trippedAt: breaker.trippedAt,
    sendsInWindow: sendTimestamps.filter((ts) => ts > cutoff).length,
    consecutiveFailures,
    windowMs: BREAKER_WINDOW_MS,
    maxSendsInWindow: BREAKER_MAX_SENDS_IN_WINDOW,
    maxConsecutiveFailures: BREAKER_MAX_CONSECUTIVE_FAILURES,
  };
}

/**
 * The ONLY way back. Reachable exclusively from `POST /api/beeper/outbox/breaker/clear`
 * — no timer, no backoff, no automatic recovery: a breaker that resets itself
 * is a delay, not a breaker.
 */
export function clearOutboxBreaker() {
  breaker = { tripped: false, reason: null, trippedAt: null };
  sendTimestamps = [];
  consecutiveFailures = 0;
  console.log(`${LOG_PREFIX}: runaway breaker cleared by a human action`);
  return getOutboxBreakerState();
}

function assertBreakerClosed() {
  if (!breaker.tripped) return;
  throw new BeeperApiError(
    `Beeper sending is blocked by the runaway breaker (${breaker.reason}). Clear it to send again.`,
    { status: 429, code: 'OUTBOX_BREAKER_OPEN', retryable: false },
  );
}

/**
 * Count this attempt against the window BEFORE the POST, and refuse the one
 * that crosses the line. Counting after the POST would let the loop's own
 * first burst through before the breaker ever saw it.
 */
function registerSendAttempt() {
  const now = runtime.now();
  sendTimestamps = sendTimestamps.filter((ts) => ts > now - BREAKER_WINDOW_MS);
  sendTimestamps.push(now);
  if (sendTimestamps.length > BREAKER_MAX_SENDS_IN_WINDOW) {
    trip(`more than ${BREAKER_MAX_SENDS_IN_WINDOW} sends in ${BREAKER_WINDOW_MS / 1000}s`);
    assertBreakerClosed();
  }
}

function registerSendFailure() {
  consecutiveFailures += 1;
  if (consecutiveFailures >= BREAKER_MAX_CONSECUTIVE_FAILURES) {
    trip(`${consecutiveFailures} consecutive send failures`);
  }
}

function registerSendSuccess() {
  consecutiveFailures = 0;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const ENTRY_COLUMNS = `id, conversation_id AS "conversationId", chat_id AS "chatId", body, state,
  pending_message_id AS "pendingMessageId", message_id AS "messageId",
  error_code AS "errorCode", error_message AS "errorMessage",
  send_requested_at AS "requestedAt", created_at AS "createdAt", updated_at AS "updatedAt", approved_at AS "approvedAt", sent_at AS "sentAt"`;

async function readEntry(id) {
  const result = await query(`SELECT ${ENTRY_COLUMNS} FROM beeper_outbox WHERE id = $1`, [id]);
  return result?.rows?.[0] ?? null;
}

/** Every outbox row for one conversation, newest first — including failed ones. */
export async function listOutboxEntries({ conversationId, limit = 50 } = {}) {
  const result = await query(
    `SELECT ${ENTRY_COLUMNS} FROM beeper_outbox
     WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [conversationId, Math.min(200, Math.max(1, Math.trunc(limit) || 50))],
  );
  return Array.isArray(result?.rows) ? result.rows.map(recoveryView) : [];
}

/**
 * Step one of the two-step send: a human composed this text and submitted it.
 * The row lands `approved` (with `approved_at` stamped) because the create call
 * itself IS the approval — it is reachable only from a human HTTP route, and
 * the send is a second, separate human action against the row this returns.
 * `draft` exists in the state CHECK for a later persisted/AI-assisted draft and
 * has no writer here; the send gate keys on `approved`, so nothing can send
 * from it.
 */
export async function createOutboxEntry({ conversationId, body }) {
  const text = typeof body === 'string' ? body.trim() : '';
  if (!text) {
    throw new BeeperApiError('An outbox entry needs a non-empty message body', {
      status: 400, code: 'OUTBOX_EMPTY_BODY', retryable: false,
    });
  }

  const conversation = await query(
    'SELECT id, source_chat_id AS "sourceChatId" FROM beeper_conversations WHERE id = $1',
    [conversationId],
  );
  const chatId = conversation?.rows?.[0]?.sourceChatId;
  if (!chatId) {
    throw new BeeperApiError('Conversation not found in the Beeper mirror', {
      status: 404, code: 'CONVERSATION_NOT_FOUND', retryable: false,
    });
  }

  const inserted = await query(
    `INSERT INTO beeper_outbox (conversation_id, chat_id, body, state, approved_at)
     VALUES ($1, $2, $3, 'approved', NOW())
     RETURNING ${ENTRY_COLUMNS}`,
    [conversationId, chatId, text],
  );
  console.log(`${LOG_PREFIX}: entry approved for chat (${text.length} chars)`);
  return inserted.rows[0];
}

/**
 * States that mean PortOS has already ADDRESSED this conversation — the POST
 * reached Beeper, whatever the mirror has confirmed since. `sent` alone is the
 * wrong test: an `awaiting-confirmation` row is a send that left this machine
 * and was very likely delivered (the unresolved case is deliberately not
 * `failed` for exactly that reason), and `sending` is one in flight right now.
 * Counting only `sent` re-asks the first-contact question on the next message
 * to someone PortOS has already messaged — which is precisely the prompt the
 * design says must fire once and never again, or the user learns to click
 * through it.
 */
const CONTACTED_STATES = ['sent', 'awaiting-confirmation', 'sending'];

/**
 * Whether PortOS has ever ADDRESSED this conversation. First contact is the
 * case #8 decision 5 puts a confirmation on — a first message to a possibly
 * mis-resolved handle on a possibly wrong network — and it is the only one,
 * because confirming every reply trains the user to click through.
 *
 * Keyed on EITHER source of outbound history, not the outbox alone (fork
 * issue #82): a mirrored `beeper_messages` row with `is_sender` true means the
 * user has messaged this chat from some client, which is exactly the "have I
 * addressed this recipient and network before" question the confirmation
 * exists to answer — restricting it to sends this particular PortOS install
 * made re-asked the question on every chat with older phone/desktop history,
 * which is precisely the "fires when it should not" case #82 reports. The
 * outbox arm stays for the gap the mirror cannot see: a send whose POST left
 * this machine but has not (yet, or ever) come back through the mirror as an
 * `isSender` message — `awaiting-confirmation` and `sending` are exactly that
 * gap, per `CONTACTED_STATES` above. Either source alone is sufficient; the
 * confirmation is reserved for a conversation neither source has any
 * outbound history for.
 */
export async function isFirstContact(conversationId) {
  const outboxSend = await query(
    `SELECT 1 FROM beeper_outbox
     WHERE conversation_id = $1 AND state = ANY($2::text[]) LIMIT 1`,
    [conversationId, CONTACTED_STATES],
  );
  if ((outboxSend?.rows?.length ?? 0) > 0) return false;

  const mirroredSend = await query(
    `SELECT 1 FROM beeper_messages
     WHERE conversation_id = $1 AND is_sender = TRUE LIMIT 1`,
    [conversationId],
  );
  return (mirroredSend?.rows?.length ?? 0) === 0;
}

async function markFailed(id, code, message) {
  await query(
    `UPDATE beeper_outbox SET state = 'failed', error_code = $2, error_message = $3, updated_at = NOW()
     WHERE id = $1`,
    [id, code || 'SEND_FAILED', String(message || '').slice(0, 2000)],
  );
}

async function markAwaitingConfirmation(id, {
  pendingMessageId = null, errorCode = null, errorMessage = null,
} = {}) {
  const updated = await query(
    `UPDATE beeper_outbox SET state = 'awaiting-confirmation', pending_message_id = $2,
       error_code = $3, error_message = $4, updated_at = NOW()
     WHERE id = $1 RETURNING ${ENTRY_COLUMNS}`,
    [id, pendingMessageId, errorCode, errorMessage],
  );
  return updated.rows[0];
}

/** No HTTP response means the server cannot prove whether the POST landed. */
function isDeliveryOutcomeUnknown(err) {
  return err?.status === 0 || err?.code === 'NETWORK_ERROR';
}

/**
 * Discard a row the human declined to send — the first-contact confirmation's
 * "Cancel" (#53's fix; the original design deliberately left the row
 * `approved` and visible, which the client had no way to render or dismiss,
 * so it surfaced as a permanent phantom "Sending…" bubble). Reachable only
 * while the row is `approved`: nothing has POSTed to Beeper for it yet, so
 * removing it is a pure local record change, never an unsend. Anything past
 * `approved` is a record of a real send attempt and stays — the client
 * composes a new entry rather than discarding one that already touched the
 * wire.
 */
export async function discardOutboxEntry(id) {
  const entry = await readEntry(id);
  if (!entry) {
    throw new BeeperApiError('Outbox entry not found', {
      status: 404, code: 'OUTBOX_ENTRY_NOT_FOUND', retryable: false,
    });
  }
  if (entry.state !== 'approved') {
    throw new BeeperApiError(
      `Outbox entry is "${entry.state}", must be "approved" to discard — it has already been sent or attempted.`,
      { status: 409, code: 'OUTBOX_INVALID_STATE', retryable: false },
    );
  }
  await query("DELETE FROM beeper_outbox WHERE id = $1 AND state = 'approved'", [id]);
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

/**
 * Step two: perform the send. Every gate below runs BEFORE the row is claimed,
 * so a refused send leaves the row exactly as it was and re-sendable by the
 * same human action.
 *
 * `confirmFirstContact` must be explicitly `true` on the first outbound message
 * to a conversation. The client obtains it from an inline confirmation row, not
 * a `window.confirm` (client conventions forbid the latter).
 */
export async function sendOutboxEntry(id, { confirmFirstContact = false } = {}) {
  const entry = await readEntry(id);
  if (!entry) {
    throw new BeeperApiError('Outbox entry not found', {
      status: 404, code: 'OUTBOX_ENTRY_NOT_FOUND', retryable: false,
    });
  }
  if (entry.state !== 'approved') {
    throw new BeeperApiError(
      `Outbox entry is "${entry.state}", must be "approved" to send. A failed or already-sent entry is never re-sent in place — compose a new message.`,
      { status: 409, code: 'OUTBOX_INVALID_STATE', retryable: false },
    );
  }
  assertBreakerClosed();
  if (!confirmFirstContact && await isFirstContact(entry.conversationId)) {
    throw new BeeperApiError(
      'This is the first message PortOS has ever sent to this conversation — confirm the recipient and network before sending.',
      { status: 409, code: 'FIRST_CONTACT_CONFIRMATION_REQUIRED', retryable: false },
    );
  }
  registerSendAttempt();

  // The serialization point. A second concurrent send of the same row loses
  // this conditional UPDATE and never reaches the POST.
  const requestedAt = runtime.now();
  const claimed = await query(
    "UPDATE beeper_outbox SET state = 'sending', send_requested_at = $2::timestamptz, updated_at = NOW() WHERE id = $1 AND state = 'approved' RETURNING id",
    [id, new Date(requestedAt).toISOString()],
  );
  if ((claimed?.rowCount ?? 0) !== 1) {
    throw new BeeperApiError('Outbox entry is already being sent', {
      status: 409, code: 'OUTBOX_INVALID_STATE', retryable: false,
    });
  }

  // Retry is OFF (the client's send-safe default): no idempotency key means a
  // retried POST is a second real message. One attempt, one row, no second POST.
  activeSends.add(id);
  const result = await sendMessage(entry.chatId, { text: entry.body })
    .then((value) => ({ ok: true, value }))
    .catch((err) => ({ ok: false, err }));
  activeSends.delete(id);
  const confirmation = { ...entry, pendingMessageId: null, requestedAt };

  if (!result.ok) {
    const err = result.err;
    if (isDeliveryOutcomeUnknown(err)) {
      registerSendFailure();
      const updated = await persistTransition(id,
        () => markAwaitingConfirmation(id, { errorCode: DELIVERY_UNCONFIRMED_CODE, errorMessage: DELIVERY_UNCONFIRMED_MESSAGE }),
        () => armConfirmation({ ...confirmation, deliveryOutcomeUnknown: true }));
      return updated ?? recoveryView(entry);
    }
    await persistTransition(id, () => markFailed(id, err?.code, err?.message));
    registerSendFailure();
    console.error(`${LOG_PREFIX}: send failed (${err?.code || 'SEND_FAILED'})`);
    throw new BeeperApiError(err?.message || 'Beeper send failed', {
      status: err?.status === 0 || !err?.status ? 0 : err.status,
      code: err?.code || 'SEND_FAILED',
      retryable: false,
      details: { outboxId: id },
    });
  }

  registerSendSuccess();
  const pendingMessageId = typeof result.value?.pendingMessageID === 'string' ? result.value.pendingMessageID : null;
  const updated = await persistTransition(id,
    () => markAwaitingConfirmation(id, { pendingMessageId }),
    () => armConfirmation({ ...confirmation, pendingMessageId }));
  console.log(`${LOG_PREFIX}: sent, awaiting confirmation${pendingMessageId ? '' : ' (no pending id returned)'}`);
  return updated ?? recoveryView(entry);
}

// ---------------------------------------------------------------------------
// Confirmation (socket first, 30s GET fallback)
// ---------------------------------------------------------------------------

function detachInvalidateListener() {
  if (!invalidateListenerAttached || pendingConfirmations.size > 0) return;
  beeperSocketEvents.off('invalidate', handleInvalidation);
  invalidateListenerAttached = false;
}

/**
 * Relayed invalidation frames carry ids and kinds only — never bodies — so a
 * frame is a PROMPT to resolve, not the resolution. Any `message.upserted` on a
 * chat with a send in flight triggers the same lookup the timer would have run,
 * just sooner.
 *
 * Runs outside the Express lifecycle (an EventEmitter callback), so the
 * rejection is caught and logged here rather than crashing the process.
 */
function handleInvalidation(frame) {
  if (frame?.kind !== 'message.upserted') return;
  for (const [id, pending] of pendingConfirmations) {
    if (frame.chatID && frame.chatID !== pending.chatId) continue;
    resolveConfirmation(id, 'socket').catch((err) => {
      console.error(`${LOG_PREFIX}: socket-triggered confirmation failed: ${err.message}`);
    });
  }
}

/**
 * `requestedAt` defaults to now because the ordinary caller is the send that
 * just happened. The boot reconcile passes the row's persisted send moment
 * instead: it is the floor `lookupSentMessage` matches timestamps against, so
 * dating a week-old re-armed row to boot time would reject the very message it
 * is looking for.
 */
function armConfirmation({
  id, chatId, conversationId, body, pendingMessageId,
  requestedAt = runtime.now(), deliveryOutcomeUnknown = false,
}) {
  const timer = runtime.setTimeout(() => {
    resolveConfirmation(id, 'fallback-timeout').catch((err) => {
      console.error(`${LOG_PREFIX}: fallback confirmation failed: ${err.message}`);
    });
  }, CONFIRMATION_TIMEOUT_MS);
  pendingConfirmations.set(id, {
    chatId, conversationId, body, pendingMessageId, requestedAt,
    deliveryOutcomeUnknown, timer, resolving: false,
  });
  if (!invalidateListenerAttached) {
    beeperSocketEvents.on('invalidate', handleInvalidation);
    invalidateListenerAttached = true;
  }
}

/**
 * Find the message this send became. Two lookups, in order, and NEITHER sends:
 *
 *  1. `GET /v1/chats/{chatID}/messages/{messageID}` with the `pendingMessageID`
 *     — the spec states that endpoint accepts a pending id, a final id, or a
 *     Matrix event id, which is exactly what makes the resolve step work.
 *  2. Failing that (no pending id came back, or the id 404s because the network
 *     assigned a final one), the chat's newest page, matched on
 *     `isSender` + the exact body + a timestamp at or after the send. The body
 *     match is deliberately exact: a near-match is a different message.
 */
async function lookupSentMessage(pending) {
  if (pending.pendingMessageId) {
    const direct = await getMessage(pending.chatId, pending.pendingMessageId)
      .then((value) => value)
      .catch((err) => {
        if (err?.code === 'NOT_FOUND') return null;
        throw err;
      });
    if (direct?.id) return direct;
  }

  const page = await listMessagesPage(pending.chatId);
  const items = Array.isArray(page?.items) ? page.items : [];
  // A normal send response proves the POST landed, so tolerate clock skew (and
  // old payloads without a timestamp) while finding its final id. When the
  // response itself was lost, body alone is not evidence: an earlier identical
  // message could otherwise turn an unknowable outcome into a false `sent`.
  // Be conservative there and require a valid network timestamp at or after
  // this attempt. Clock skew may leave a real send unconfirmed, which is safer
  // than attaching a prior message and inviting the wrong delivery verdict.
  const floor = pending.deliveryOutcomeUnknown
    ? pending.requestedAt
    : pending.requestedAt - 60_000;
  return items.find((message) => {
    if (message?.isSender !== true || message?.text !== pending.body) return false;
    const messageTime = Date.parse(message?.timestamp ?? '');
    return pending.deliveryOutcomeUnknown
      ? Number.isFinite(messageTime) && messageTime >= floor
      : !message?.timestamp || (Number.isFinite(messageTime) && messageTime >= floor);
  }) ?? null;
}

/**
 * Mirror the confirmed message so the thread shows it without waiting for the
 * next sweep. `normalizeMessageRow` is beeperSync's own normalizer, reused so
 * an outbound row is shaped exactly like an ingested one; the upsert carries
 * the same non-destructive COALESCE guards as the sweep's, and the sweep's
 * later re-observation of the same id updates rather than duplicates it.
 *
 * `is_sender` is written as TRUE literally rather than from the normalizer's
 * `row.isSender`: PortOS just sent this message, so it is outbound whatever the
 * confirming payload says, and the field is optional on the API's own `Message`
 * (`normalizeMessageRow` lands an omitted one on FALSE). The ON CONFLICT arm
 * keeps the sweep's never-downgrade rule, so a later inbound page that omits
 * the field cannot flip a message the user sent onto the other side of the
 * thread.
 */
async function mirrorSentMessage(client, conversationId, message) {
  const row = normalizeMessageRow(message, new Date(runtime.now()).toISOString());
  if (!row.id) return;
  await client.query(
    `INSERT INTO beeper_messages (id, conversation_id, sender_id, body, sent_at, edited_at, unsent_at, sort_key, is_sender)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)
     ON CONFLICT (id) DO UPDATE SET
       body = COALESCE(NULLIF(EXCLUDED.body, ''), beeper_messages.body),
       sender_id = COALESCE(NULLIF(EXCLUDED.sender_id, ''), beeper_messages.sender_id),
       sent_at = COALESCE(EXCLUDED.sent_at, beeper_messages.sent_at),
       edited_at = COALESCE(EXCLUDED.edited_at, beeper_messages.edited_at),
       unsent_at = COALESCE(beeper_messages.unsent_at, EXCLUDED.unsent_at),
       sort_key = COALESCE(NULLIF(EXCLUDED.sort_key, ''), beeper_messages.sort_key),
       is_sender = beeper_messages.is_sender OR EXCLUDED.is_sender,
       updated_at = NOW()`,
    [row.id, conversationId, row.senderId, row.body, row.sentAt, row.editedAt, row.unsentAt, row.sortKey],
  );
}

function releasePending(id) {
  const pending = pendingConfirmations.get(id);
  if (pending?.timer !== undefined) runtime.clearTimeout(pending.timer);
  pendingConfirmations.delete(id);
  detachInvalidateListener();
}

/**
 * Resolve one in-flight send. Idempotent by construction: the `resolving` flag
 * stops the socket path and the timer path overlapping, and the terminal UPDATE
 * is conditional on `awaiting-confirmation`, so whichever path lands first is
 * the one that writes.
 *
 * The unresolved case is deliberately NOT `failed`. A send whose message cannot
 * be found may well have been delivered, and marking it failed invites a
 * re-send — the one mistake that cannot be taken back, since Beeper's own
 * `DELETE` unsends for everyone. It stays `awaiting-confirmation` with a
 * recorded reason, which reads as "sent, unconfirmed" and offers no re-send.
 */
async function resolveConfirmation(id, reason) {
  const pending = pendingConfirmations.get(id);
  if (!pending || localTransitions.has(id)) return null;
  if (reason === 'fallback-timeout' || reason === 'manual') pending.deadlineReached = true;
  // The one-shot timer can fire during a socket lookup. Let that lookup own
  // the deadline outcome rather than dropping the only fallback signal.
  if (pending.resolving) return null;
  pending.resolving = true;

  const found = await lookupSentMessage(pending)
    .then((value) => ({ ok: true, value }))
    .catch((err) => ({ ok: false, err }));
  pending.resolving = false;
  if (pendingConfirmations.get(id) !== pending) return null;
  if (pending.deadlineReached) reason = 'fallback-timeout';

  if (!found.ok) {
    // A lookup failure on the socket path costs nothing — the timer is still
    // armed. On the fallback path it is the end of the road.
    console.error(`${LOG_PREFIX}: confirmation lookup failed (${found.err?.code || 'unknown'})`);
    if (reason === 'fallback-timeout') {
      await noteUnresolved(
        id,
        `Confirmation lookup failed: ${found.err?.code || 'unknown error'}`,
        pending.deliveryOutcomeUnknown,
      );
    }
    return null;
  }

  const message = found.value;
  if (!message) {
    if (reason === 'fallback-timeout') {
      await noteUnresolved(
        id,
        'Beeper reported no matching message within 30s — it may still have been delivered, so it was not re-sent.',
        pending.deliveryOutcomeUnknown,
      );
    }
    return null;
  }

  const status = typeof message?.sendStatus?.status === 'string' ? message.sendStatus.status : null;
  if (status?.startsWith('FAIL')) {
    await persistTransition(id,
      () => markFailed(id, `SEND_${status}`, message?.sendStatus?.message || message?.sendStatus?.reason || 'Beeper reported a failed send'),
      () => releasePending(id));
    return null;
  }

  return persistTransition(id, () => withTransaction(async (client) => {
    const settled = await client.query(
      `UPDATE beeper_outbox SET state = 'sent', message_id = $2, sent_at = COALESCE($3::timestamptz, NOW()),
         error_code = NULL, error_message = NULL, updated_at = NOW()
       WHERE id = $1 AND state = 'awaiting-confirmation' RETURNING ${ENTRY_COLUMNS}`,
      [id, String(message.id), message?.timestamp ?? null],
    );
    if ((settled?.rowCount ?? 0) !== 1) return null;
    await mirrorSentMessage(client, pending.conversationId, message);
    return settled.rows[0];
  }), () => {
    releasePending(id);
    beeperSocketEvents.emit('invalidate', {
      kind: 'message.upserted', chatID: pending.chatId, ids: [String(message.id)],
      seq: null, ts: new Date(runtime.now()).toISOString(),
    });
    console.log(`${LOG_PREFIX}: send confirmed via ${reason}`);
  });
}

/** Record why a send is unconfirmed without moving it out of flight. */
async function noteUnresolved(id, message, deliveryOutcomeUnknown = false) {
  await persistTransition(id, () => query(
    `UPDATE beeper_outbox SET error_code = $2, error_message = $3, updated_at = NOW()
     WHERE id = $1 AND state = 'awaiting-confirmation'`,
    [id, deliveryOutcomeUnknown ? DELIVERY_UNCONFIRMED_CODE : 'CONFIRMATION_UNRESOLVED', message],
  ), () => releasePending(id));
  console.warn(`${LOG_PREFIX}: send unconfirmed — never re-sent`);
}

/**
 * Drop every armed confirmation timer. Used by the suite between cases; there
 * is no production caller, because a process that is exiting takes its timers
 * with it and the durable state is the row, not the timer.
 */
export function cancelPendingConfirmations() {
  for (const id of [...pendingConfirmations.keys()]) releasePending(id);
  for (const transition of localTransitions.values()) runtime.clearTimeout(transition.timer);
  localTransitions.clear();
  activeSends.clear();
  reconciliationOperations.clear();
}

/** Human-triggered reconciliation. Remote operations are GETs only. */
export function reconcileOutboxEntry(id) {
  if (reconciliationOperations.has(id)) return reconciliationOperations.get(id);
  const operation = reconcileEntry(id).finally(() => reconciliationOperations.delete(id));
  reconciliationOperations.set(id, operation);
  return operation;
}

async function reconcileEntry(id) {
  let entry = await readEntry(id);
  if (!entry) throw new BeeperApiError('Outbox entry not found', { status: 404, code: 'OUTBOX_ENTRY_NOT_FOUND' });
  if (activeSends.has(id)) return entry;
  const transition = localTransitions.get(id);
  if (transition) {
    await runLocalTransition(id, transition);
    if (localTransitions.has(id)) return recoveryView(entry);
    entry = await readEntry(id);
  }
  const uncertainFailure = entry.state === 'failed' && [SEND_INTERRUPTED_CODE, DELIVERY_UNCONFIRMED_CODE, 'NETWORK_ERROR'].includes(entry.errorCode);
  if (!['sending', 'awaiting-confirmation'].includes(entry.state) && !uncertainFailure) return entry;
  if (!pendingConfirmations.has(id)) {
    const unknown = entry.state === 'sending' || uncertainFailure || entry.errorCode === DELIVERY_UNCONFIRMED_CODE;
    const requestedAt = persistedSendMoment(entry);
    if (entry.state !== 'awaiting-confirmation') {
      entry = await markAwaitingConfirmation(id, { errorCode: DELIVERY_UNCONFIRMED_CODE, errorMessage: DELIVERY_UNCONFIRMED_MESSAGE });
    }
    armConfirmation({ ...entry, requestedAt, deliveryOutcomeUnknown: unknown });
  }
  await resolveConfirmation(id, 'manual');
  return recoveryView(await readEntry(id));
}

// ---------------------------------------------------------------------------
// Boot reconcile
// ---------------------------------------------------------------------------

/** The send moment a re-armed row is matched against, from what the row kept. */
function persistedSendMoment(row) {
  const stamped = Date.parse(row?.requestedAt ?? row?.updatedAt ?? row?.createdAt ?? '');
  return Number.isFinite(stamped) ? stamped : runtime.now();
}

/**
 * Reconcile the two NON-TERMINAL states against a process that no longer
 * exists. Called once per server start, from `bootstrap.js`, regardless of
 * whether the Beeper feature is armed — a stranded row is stranded whether or
 * not ingestion is switched on.
 *
 * `sending` and `awaiting-confirmation` are exit-only through in-memory state:
 * `pendingConfirmations`, its timer, and the socket listener. A restart mid-
 * flight takes all three with it. Boot reconciles automatically; a human can
 * also invoke the lookup-only reconciliation route without restarting.
 *
 * Two different faults, two different answers:
 *
 *  - **`sending` → `failed` / `SEND_INTERRUPTED`.** The POST was in flight; its
 *    outcome is unknowable. Never auto-resent (rule 2 has no exception for a
 *    crash — Beeper has no idempotency key, so a "recovery" resend is a second
 *    real message). `failed` terminates the spinner, while the error code keeps
 *    the client from presenting the ordinary definitive-failure Retry control.
 *  - **`awaiting-confirmation` → re-armed.** The send DID leave; only the
 *    resolve was lost. Re-arming replays the lookup from the row's own
 *    `chat_id` / `pending_message_id` / `body`, which is a read on both paths
 *    (`getMessage`, then the newest page) and sends nothing. A row already
 *    recorded `CONFIRMATION_UNRESOLVED` is re-armed too: the message may have
 *    landed in the mirror since, and one more GET can only upgrade the record.
 *
 * Terminal rows (`sent`, `failed`) are not touched. Idempotent: the second call
 * finds no `sending` rows left, and skips every `awaiting-confirmation` row the
 * first call already armed rather than stacking a second timer on it.
 *
 * @returns {Promise<{interrupted: number, rearmed: number}>}
 */
export async function reconcileOutboxOnBoot() {
  const interrupted = await query(
    `UPDATE beeper_outbox SET state = 'failed', error_code = $1, error_message = $2
     WHERE state = 'sending' RETURNING id`,
    [SEND_INTERRUPTED_CODE, SEND_INTERRUPTED_MESSAGE],
  ).catch((err) => {
    if (err?.code === UNDEFINED_TABLE) return null;
    throw err;
  });
  // The table does not exist yet, so neither do the rows this would reconcile.
  if (!interrupted) return { interrupted: 0, rearmed: 0 };

  // JSON access tolerates the first upgrade boot, which can precede ensureSchema.
  // Old rows have no immutable timestamp: keep their prior conservative floor.
  const inFlight = await query(
    `SELECT id, conversation_id AS "conversationId", chat_id AS "chatId", body,
       pending_message_id AS "pendingMessageId", error_code AS "errorCode",
       created_at AS "createdAt", updated_at AS "updatedAt",
       to_jsonb(beeper_outbox)->>'send_requested_at' AS "requestedAt"
     FROM beeper_outbox WHERE state = 'awaiting-confirmation'`,
  );

  let rearmed = 0;
  for (const row of inFlight?.rows ?? []) {
    if (pendingConfirmations.has(row.id)) continue;
    armConfirmation({
      id: row.id,
      chatId: row.chatId,
      conversationId: row.conversationId,
      body: row.body,
      pendingMessageId: row.pendingMessageId,
      requestedAt: persistedSendMoment(row),
      deliveryOutcomeUnknown: row.errorCode === DELIVERY_UNCONFIRMED_CODE,
    });
    rearmed += 1;
  }

  const counts = { interrupted: interrupted.rows?.length ?? 0, rearmed };
  if (counts.interrupted || counts.rearmed) {
    console.log(`${LOG_PREFIX}: boot reconcile — ${counts.interrupted} interrupted send(s) failed, ${counts.rearmed} awaiting confirmation re-armed`);
  }
  return counts;
}

/** The outbox's slice of `GET /api/beeper/status`. */
export function getOutboxStatus() {
  return {
    breaker: getOutboxBreakerState(),
    awaitingConfirmation: pendingConfirmations.size,
  };
}

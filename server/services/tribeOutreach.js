/**
 * Tribe Outreach (#2158)
 *
 * Timeline-aware outreach for Tribe relationships — the follow-on to the
 * cadence-only nudges in `proactiveAlerts.js`. Two layers, deliberately split so
 * the AI-provider policy holds (no cold-bootstrap LLM calls):
 *
 *   1. Detection (NO LLM) — `findUnansweredTribeThreads()` scans the human-activity
 *      timeline (#2150) for inbound messages from Tribe people that were never
 *      replied to, grouped by conversation. Pure timeline + Tribe reads, cheap and
 *      safe to run from the on-demand proactive-alerts sweep and background jobs.
 *
 *   2. Draft generation (USER-ACTION-GATED LLM) — `generateOutreachDraft()` takes
 *      one detected thread, grounds a reply in the real conversation (the message
 *      cache when available, else the timeline's own message summaries), runs the
 *      existing reply-generation pipeline (`messageEvaluator.generateReplyBody`),
 *      and files a DRAFT through `messageDrafts.createDraft`. It NEVER auto-sends —
 *      the user reviews/approves/sends through the existing draft pipeline.
 *
 * The detection layer is source-agnostic in shape but gated to sources whose
 * ingestion records BOTH directions per conversation, so an "unanswered" verdict is
 * trustworthy: iMessage (#2151) and Signal (#2154) source-wide, and Gmail (#2033)
 * PER ACCOUNT once its sent mail is ingested as `message.sent` (#2796). See
 * `buildTwoWayGate` for the per-account gate.
 */

import { ServerError } from '../lib/errorHandler.js';

const DAY_MS = 86400000;
const HOUR_MS = 3600000;

// Detection window defaults. `staleAfterHours` gives the user time to reply
// naturally before we nudge; `withinDays` drops threads too old to still be
// worth a fresh reply (they read as necromancy, not attentiveness).
export const DEFAULT_WITHIN_DAYS = 14;
export const DEFAULT_STALE_HOURS = 20;
export const DEFAULT_LIMIT = 8;

// Grounding thread bodies are capped downstream (buildThreadContext slices to
// 500 chars) — this bounds how many prior turns we feed the model per draft.
const MAX_GROUNDING_EVENTS = 12;

const MESSAGE_KINDS = new Set(['message.sent', 'message.received']);

// NOTE (upgrade transient): activity rows synced BEFORE the isReaction tag shipped
// lack it, so a Tapback already in the timeline at upgrade isn't excluded until it
// ages out of the detection window (≤14 days) — a bounded, self-healing edge. A
// retroactive backfill would need to re-read chat.db by rowid (macOS + Full Disk
// Access only), so it's deliberately not attempted here.
//
// Chat sources ingest BOTH directions per conversation intrinsically — iMessage
// (#2151) and Signal (#2154) emit a `message.sent` for every outgoing turn — so an
// "unanswered" verdict is always trustworthy regardless of which account it came
// through. They are two-way source-wide.
const TWO_WAY_CHAT_SOURCES = new Set(['imessage', 'signal']);

// Email sources can ALSO be two-way, but only PER ACCOUNT (#2796). Gmail's API
// sync gained an opt-out `syncConfig.ingestSent` (default on) that pulls `in:sent`
// into the same cache the timeline ingest reads, so a replied thread cancels its
// own inbound via the existing `lastSentT >= inbound` answered-check. The gate must
// key on the specific accountId, NOT the source: a source-wide gate would let ONE
// gmail account's sent import vouch for EVERY gmail account — including ones with no
// sent evidence, whose every stale inbound would then read as unanswered forever.
// Outlook/Teams ingest the inbox only (no sent-fetch path yet), so they stay
// one-way until one is added — an inbound from them is never surfaced.
const SENT_INGEST_SOURCES = new Set(['gmail']);

/**
 * Pure per-account two-way gate (unit-tested without a DB). Given the message-
 * account list, returns the sources worth scanning and an `isTwoWay(event)`
 * predicate. An email account counts as two-way only when ALL of:
 *   - its provider has a sent-ingest path (`SENT_INGEST_SOURCES`);
 *   - it isn't opted out (`syncConfig.ingestSent !== false` — absent means the
 *     default-on capability);
 *   - it has an owner email set (sent-vs-received direction needs it — see
 *     `messageActivityCandidates`; without it no `message.sent` events are produced,
 *     so every inbound would read as unanswered);
 *   - it is enabled (a disabled account never syncs, so its sent history never
 *     updates — trusting it would nudge on stale/absent reply evidence);
 *   - its last sent sync was NOT truncated (`sentCoveragePartial !== true`, #2820):
 *     a sync that hit the sent ceiling (>SENT_INGEST_MAX in the window) has an
 *     incomplete sent window, so an un-ingested older reply could read as
 *     unanswered — fail closed until a full sync clears the flag;
 *   - it has a RECENT sent-ingest watermark (`sentIngestedAt` within `coverageMs`).
 *     This is the reliability guard: an account default-on at upgrade, or one whose
 *     OAuth/sync has been failing, has no current sent evidence — trusting it on
 *     config alone would produce false "unanswered" nudges for already-replied
 *     threads. `coverageMs` defaults to Infinity (presence-only) for pure tests; the
 *     real caller passes the detection window.
 *
 * @param {Array} accounts message-account records ({ id, type, email, enabled, syncConfig, sentIngestedAt })
 * @param {{ now?: number, coverageMs?: number }} opts staleness bound for the watermark
 * @returns {{ sources: string[], emailAccounts: Array<{ id: string, source: string }>, isTwoWay: (ev: object) => boolean }}
 *   `emailAccounts` are the two-way email accounts to query PER ACCOUNT (#2820) so
 *   one high-volume account can't fill a shared cap and suppress another's nudges.
 */
export function buildTwoWayGate(accounts = [], { now = Date.now(), coverageMs = Infinity } = {}) {
  const twoWayEmailAccountIds = new Set(
    (accounts || [])
      .filter((a) => {
        if (!SENT_INGEST_SOURCES.has(a?.type)) return false;
        if (a?.syncConfig?.ingestSent === false) return false;
        if (String(a?.email || '').trim() === '') return false;
        if (a?.enabled === false) return false;
        // The last sent sync truncated at its ceiling (>SENT_INGEST_MAX in the
        // window, #2820) → an older reply may be un-ingested, so its reply evidence
        // is incomplete and can't be trusted until a full sync clears the flag.
        if (a?.sentCoveragePartial === true) return false;
        const at = Date.parse(a?.sentIngestedAt);
        if (Number.isNaN(at)) return false; // never successfully ingested sent mail
        return (now - at) <= coverageMs; // stale watermark → coverage can't be trusted
      })
      .map((a) => a.id)
  );
  // Only scan an email source when at least one of its accounts is two-way — a
  // one-way-only provider is never queried, so a high-volume inbox can't burn the
  // per-account 2000-row cap on data we'd discard anyway.
  const sources = new Set(TWO_WAY_CHAT_SOURCES);
  const emailAccounts = [];
  for (const a of accounts || []) {
    if (twoWayEmailAccountIds.has(a?.id)) {
      sources.add(a.type);
      emailAccounts.push({ id: a.id, source: a.type });
    }
  }
  const isTwoWay = (ev) =>
    TWO_WAY_CHAT_SOURCES.has(ev?.source) ||
    (ev?.accountId != null && twoWayEmailAccountIds.has(ev.accountId));
  return { sources: [...sources], emailAccounts, isTwoWay };
}

// Channel-appropriate reply prompt for chat outreach — generateReplyBody's default
// template is email-toned ("Write a professional reply to this email"), which reads
// wrong for a text message. generateReplyBody substitutes {{from}}/{{body}} and
// resolves the {{#instructions}} conditional block, so any caller-supplied guidance
// actually reaches the model (the default template omits it and drops it silently).
const OUTREACH_CHAT_TEMPLATE = 'Write a brief, warm, casual reply to reconnect over a text message. Keep it short and personal — no email subject line, no formal salutation or sign-off.{{#instructions}}\n\nAdditional guidance: {{instructions}}{{/instructions}}\n\nFrom: {{from}}\nTheir message:\n{{body}}';

// Channel-appropriate reply prompt for EMAIL outreach (#2796). Email threads can now
// reach draft generation, and the chat template above explicitly forbids a salutation/
// sign-off — wrong for email. This one asks for a natural greeting + sign-off while
// staying warm and concise, and (like the chat one) resolves the {{#instructions}}
// block so caller guidance reaches the model (the default template drops it silently).
const OUTREACH_EMAIL_TEMPLATE = 'Write a brief, warm, personal email reply to reconnect. Keep it genuine and concise, with a natural greeting and a friendly sign-off.{{#instructions}}\n\nAdditional guidance: {{instructions}}{{/instructions}}\n\nFrom: {{from}}\nTheir message:\n{{body}}';

// Chat sources are the two-way messaging apps; everything else here is email-shaped.
// Picks the channel-appropriate outreach reply template.
export function outreachTemplateForSource(source) {
  return TWO_WAY_CHAT_SOURCES.has(source) ? OUTREACH_CHAT_TEMPLATE : OUTREACH_EMAIL_TEMPLATE;
}

// A conversation is keyed by the most specific stable identifier available:
// chatGuid (iMessage), conversationId (Signal — its outbound turns carry no
// handle, so keying on the shared conversationId is the only thing that unifies
// sent + received), the email threadId, then the raw handle. Person-scoped
// fallback only when an event carries none of those — it keeps a lone
// handle-less inbound groupable, but is deliberately last so that sent + received
// turns of the SAME thread always share a key (a person fallback would split them
// whenever one side lacks a person match — e.g. an iMessage/Signal sent turn).
//
// Email threadId is namespaced by accountId (#2820): a Gmail threadId is only
// unique WITHIN one account, so two accounts that happen to share a threadId value
// would otherwise merge into one (false) conversation — one account's sent turn
// could then "answer" the other's inbound. chatGuid/conversationId are already
// globally unique (iMessage/Signal), so they stay un-namespaced.
function conversationKey(event) {
  const m = event?.metadata || {};
  if (m.chatGuid) return `chat:${m.chatGuid}`;
  if (m.conversationId) return `convo:${m.conversationId}`;
  if (m.threadId) return `thread:${event?.accountId ?? 'x'}:${m.threadId}`;
  if (m.handle) return `handle:${String(m.handle).toLowerCase()}`;
  if (event?.personId) return `person:${event.personId}`;
  return null;
}

function threadFields(inbound, eventCount, ageMs) {
  const m = inbound.metadata || {};
  return {
    personId: inbound.personId,
    personName: inbound.personName || 'someone',
    ring: inbound.ring || null,
    source: inbound.source || null,
    // The detected conversation key must round-trip to draft generation so the
    // reply is grounded in THIS conversation. chatGuid (iMessage) /
    // conversationId (Signal) / threadId (email) are the per-source keys; handle
    // is the counterpart. personId is NOT a usable key — message events don't
    // persist it on their participants (it's resolved at read time).
    threadId: m.threadId || null,
    chatGuid: m.chatGuid || null,
    conversationId: m.conversationId || null,
    handle: m.handle || null,
    // Round-trips to draft generation so the grounding query can scope to this
    // account (#2820) — an email threadId is only unique within its account.
    accountId: inbound.accountId || null,
    lastInboundAt: inbound.happenedAt,
    daysAgo: Math.floor(ageMs / DAY_MS),
    // Only the real message text — NOT `title`, which for an attachment-only/
    // undecodable chat message is just the contact/conversation name and would
    // render as `You never replied to "Alex"`. Empty → the alert's own
    // "their message" fallback is used instead.
    snippet: String(inbound.summary || '').trim(),
    eventCount,
  };
}

/**
 * Pure grouping/staleness core (unit-tested without a DB). Given message activity
 * events already tagged with the resolved Tribe person on the INBOUND side, return
 * one entry per conversation whose latest turn is an unanswered inbound from a
 * Tribe person, within the actionable window.
 *
 * Events shape (per item): {
 *   kind: 'message.sent' | 'message.received',
 *   happenedAt: ISO string,
 *   source, accountId, summary, title, metadata: { chatGuid?, threadId?, handle?, externalId? },
 *   // inbound (received) events additionally carry the resolved Tribe person:
 *   personId?, personName?, ring?
 * }
 * Outbound (sent) events need NO person resolution — they only cancel the
 * unanswered flag when newer than the last inbound (iMessage sent turns carry no
 * counterpart handle, so they'd never resolve, but still count as "you replied").
 *
 * @returns {Array} unanswered-thread descriptors, most overdue first.
 */
export function groupUnansweredThreads(events, { now = Date.now(), staleAfterMs = 0, withinMs = Infinity } = {}) {
  const groups = new Map();
  for (const ev of events || []) {
    if (!ev || !MESSAGE_KINDS.has(ev.kind)) continue;
    // A Tapback/reaction is not a message awaiting (or constituting) a reply.
    if (ev.metadata?.isReaction) continue;
    const key = conversationKey(ev);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ev);
  }

  const out = [];
  for (const [key, evs] of groups) {
    let lastInbound = null;
    let lastSentT = -Infinity;
    for (const ev of evs) {
      const t = Date.parse(ev.happenedAt);
      if (Number.isNaN(t)) continue;
      if (ev.kind === 'message.sent') {
        if (t > lastSentT) lastSentT = t;
      } else if (ev.personId && ev.ring !== 'external') {
        // Only a Tribe-resolved inbound can anchor an unanswered thread.
        if (!lastInbound || t > Date.parse(lastInbound.happenedAt)) lastInbound = ev;
      }
    }
    if (!lastInbound) continue;
    const recvT = Date.parse(lastInbound.happenedAt);
    if (lastSentT >= recvT) continue; // already replied after their last message
    const age = now - recvT;
    if (age < staleAfterMs || age > withinMs) continue;
    out.push({ conversationKey: key, ...threadFields(lastInbound, evs.length, age) });
  }

  // Most overdue first, then alphabetical for a stable order.
  out.sort((a, b) => b.daysAgo - a.daysAgo || a.personName.localeCompare(b.personName));
  return out;
}

/**
 * Detect unanswered inbound threads from Tribe people via the activity timeline.
 * No LLM — pure timeline + Tribe reads. Returns [] on any read failure (a nudge
 * source that quietly yields nothing beats one that throws into the alert sweep).
 */
export async function findUnansweredTribeThreads({
  withinDays = DEFAULT_WITHIN_DAYS,
  staleAfterHours = DEFAULT_STALE_HOURS,
  limit = DEFAULT_LIMIT,
} = {}) {
  const [{ listEvents }, { loadResolverContext, enrichActivityEvent }, { listAccounts }] = await Promise.all([
    import('./humanActivity.js'),
    import('./identityResolve.js'),
    import('./messageAccounts.js'),
  ]);

  const ctx = await loadResolverContext().catch(() => null);
  if (!ctx) return [];
  const now = Date.now();
  const withinMs = withinDays * DAY_MS;
  // Per-account two-way gate: which chat sources to scan source-wide, which email
  // accounts to scan per-account, and which inbound events are trustworthy (chat
  // source-wide, email only from sent-ingesting accounts whose reply-evidence
  // watermark covers the detection window).
  const { emailAccounts: twoWayEmailAccounts, isTwoWay } = buildTwoWayGate(
    await listAccounts().catch(() => []),
    { now, coverageMs: withinMs }
  );
  const ringById = new Map((ctx.people || []).map((p) => [p.id, p.ring]));
  const nameById = new Map((ctx.people || []).map((p) => [p.id, p.name]));
  // No non-external Tribe people → nothing to nudge about; skip the timeline scan.
  const hasTribe = (ctx.people || []).some((p) => p.ring && p.ring !== 'external');
  if (!hasTribe) return [];

  const from = new Date(now - withinMs).toISOString();
  const EVENT_CAP = 2000;
  const received = [];
  const sent = [];
  // Fetch one scope's received + sent turns under its OWN cap, failing CLOSED.
  // `label` is source-only (never the account id) so nothing sensitive is logged.
  //
  // Fail CLOSED on a read error: if EITHER direction's query fails, drop this
  // scope's turns entirely. Substituting [] for only the failed direction would
  // leave received without its sent counterpart, making every inbound look
  // unanswered and emitting false nudges — the contract is to stay quiet on a read
  // failure, not to nudge on half the data.
  //
  // Fail CLOSED on the cap too: the two directions are capped independently, so a
  // truncated `sent` result could omit an older reply while its inbound survives in
  // `received` — reporting an answered thread as unanswered. Better no nudge for
  // that (very heavy) scope than a false one. (received-cap is a false-negative
  // only, but skip either to be safe.)
  const fetchScope = (label, filter) =>
    Promise.all([
      listEvents({ ...filter, from, kind: 'message.received', limit: EVENT_CAP }),
      listEvents({ ...filter, from, kind: 'message.sent', limit: EVENT_CAP }),
    ]).then(([r, s]) => {
      if (r.length >= EVENT_CAP || s.length >= EVENT_CAP) {
        console.warn(`🤝 Skipping ${label} outreach scan — timeline query hit the ${EVENT_CAP}-row cap (can't verify reply state)`);
        return;
      }
      received.push(...r); sent.push(...s);
    }).catch(() => { /* partial read → drop this scope to avoid false nudges */ });

  // Chat sources are queried source-wide (both directions carry the same source,
  // and their conversation keys are globally unique). Email accounts are queried
  // PER ACCOUNT (#2820) under their own cap — a shared per-source query let one
  // high-volume opted-out/heavy account fill the newest-2000 slice and suppress a
  // legitimately opted-in account's nudges.
  await Promise.all([
    ...[...TWO_WAY_CHAT_SOURCES].map((src) => fetchScope(src, { source: src })),
    ...twoWayEmailAccounts.map((acct) =>
      fetchScope(acct.source, { source: acct.source, accountId: acct.id })),
  ]);

  // Drop Tapbacks/reactions from both directions — a reaction is not a message
  // awaiting a reply (it must not anchor an "unanswered" thread), and a sent
  // reaction is not a real reply (it must not mark a thread answered). The
  // `isTwoWay` filter is now a defensive backstop: email is queried per two-way
  // accountId (#2820) so only trustworthy accounts' events are fetched, but the
  // guard still drops any stray one-way event — a reply from a one-way account is
  // invisible, so its inbound must not surface (and its sent turns must not vouch
  // for another account's thread).
  const tagged = sent.filter((ev) => !ev.metadata?.isReaction && isTwoWay(ev));
  for (const ev of received) {
    if (ev.metadata?.isReaction) continue;
    if (!isTwoWay(ev)) continue;
    // Scope to 1:1 conversations — a chat with more than one counterpart is a
    // group, where "you never replied" rarely means a personal obligation and
    // multi-sender turns can't be cleanly attributed or anchored. A 1:1 chat's
    // participant list is exactly the counterpart.
    if (Array.isArray(ev.participants) && ev.participants.length > 1) continue;
    // Resolve the SENDER to a Tribe person via the event's counterpart handle
    // ONLY (a 1:1 received event's `metadata.handle` IS the sender, which
    // `enrichActivityEvent` resolves). An unresolved sender is skipped, not guessed.
    const enriched = enrichActivityEvent(ev, ctx);
    const personId = enriched.personId || null;
    if (!personId) continue;
    const ring = ringById.get(personId);
    if (!ring || ring === 'external') continue;
    tagged.push({ ...ev, personId, personName: nameById.get(personId) || enriched.displayName || 'someone', ring });
  }

  const threads = groupUnansweredThreads(tagged, {
    now,
    staleAfterMs: staleAfterHours * HOUR_MS,
    withinMs,
  });
  return threads.slice(0, Math.max(0, limit));
}

// Map one timeline event to a synthetic message (buildThreadContext /
// generateReplyBody shape). The summary is the real message text (shortSummary-
// capped). Detection is 1:1-only, so a received turn is always from the resolved
// person; the user's own sent turns are labeled "You". An attachment-only turn has
// no summary — the chat TITLE is merely the contact name, so a placeholder is used
// rather than feeding the model a fabricated body.
function eventToMessage(ev, personName) {
  const text = String(ev.summary || '').trim();
  return {
    from: { name: ev.kind === 'message.sent' ? 'You' : (personName || 'them') },
    date: ev.happenedAt,
    bodyText: text || '[non-text message]',
  };
}

// Per-(conversation, inbound) in-flight guard so two concurrent requests for the
// same thread (two tabs, a retry) don't each fire a paid LLM call before either
// files its draft — the file-write queue serializes the writes, not the
// lookup→generate→create span. The second caller awaits the first's result.
const inflightOutreach = new Map();

/**
 * Generate a grounded outreach draft for one detected unanswered thread and file
 * it through the existing draft-then-approve pipeline. USER-ACTION-GATED: only ever
 * called from an explicit request (the Tribe Outreach panel / an opt-in automation)
 * — it is the single LLM entry point here and must never be wired into a boot/sweep
 * path. Detection surfaces the two-way sources — chat (iMessage/Signal) plus
 * sent-ingesting Gmail accounts (#2796) — grounding the reply from the timeline by
 * the detected conversation key (chatGuid / conversationId / threadId / handle). The
 * draft is always filed as review-only (`sendVia: 'review'`) — never auto-sent, even
 * for email, which the user approves/sends through the existing draft pipeline.
 *
 * @returns {Promise<{ draft, person: { id, name } | null }>}
 */
export async function generateOutreachDraft(params = {}) {
  const conversationKey = params.chatGuid || params.conversationId || params.threadId || params.handle || null;
  // No key to guard on (validated away at the route, but defensive) → run directly.
  if (!conversationKey) return generateOutreachDraftImpl(params);
  // Prefix the accountId (#2820): an email threadId is only unique within its
  // account, so two accounts sharing a threadId must not coalesce onto one guard.
  const guardKey = `${params.accountId ?? ''}::${conversationKey}::${params.lastInboundAt || ''}`;
  const pending = inflightOutreach.get(guardKey);
  if (pending) return pending;
  const promise = generateOutreachDraftImpl(params);
  inflightOutreach.set(guardKey, promise);
  promise.finally(() => {
    if (inflightOutreach.get(guardKey) === promise) inflightOutreach.delete(guardKey);
  }).catch(() => {}); // finally's own rejection is irrelevant; callers see `promise`
  return promise;
}

async function generateOutreachDraftImpl({
  personId = null,
  source = null,
  accountId = null,
  chatGuid = null,
  conversationId = null,
  threadId = null,
  handle = null,
  lastInboundAt = null,
  instructions = '',
  useVoice,
} = {}) {
  const [{ getPerson }, { listEvents }, { generateReplyBody }, { createDraft, listDrafts }] = await Promise.all([
    import('./tribe.js'),
    import('./humanActivity.js'),
    import('./messageEvaluator.js'),
    import('./messageDrafts.js'),
  ]);

  const person = personId ? await getPerson(personId).catch(() => null) : null;
  // The draft-reuse / guard key. Email threadId is namespaced by accountId (#2820)
  // — it's only unique within its account — while chatGuid/conversationId are
  // globally unique and stay raw. Kept consistent with the detection grouping key.
  const conversationKey = chatGuid || conversationId
    || (threadId ? (accountId ? `thread:${accountId}:${threadId}` : threadId) : null)
    || handle || null;

  // Ground the reply in the actual conversation, pulled from the timeline by the
  // DETECTED conversation key — chatGuid (iMessage) / conversationId (Signal) /
  // threadId (email) / handle (counterpart). NOT personId: message events don't
  // persist it on their participants, so a personId query returns nothing. Pass
  // exactly the most-selective key present (listEvents ANDs its filters). For email,
  // also scope by accountId (#2820) so a threadId shared across accounts can't pull
  // another account's turns into the grounding context.
  const convoEvents = await listEvents({
    source: source || undefined,
    accountId: accountId || undefined,
    chatGuid: chatGuid || undefined,
    conversationId: chatGuid ? undefined : (conversationId || undefined),
    threadId: (chatGuid || conversationId) ? undefined : (threadId || undefined),
    handle: (chatGuid || conversationId || threadId) ? undefined : (handle || undefined),
    limit: 200,
  }).catch(() => []);

  const sorted = (convoEvents || [])
    // Exclude reactions here too — they must neither anchor the reply nor pad the
    // grounding context as spurious '[non-text message]' turns.
    .filter((ev) => MESSAGE_KINDS.has(ev.kind) && !ev.metadata?.isReaction)
    .sort((a, b) => Date.parse(a.happenedAt) - Date.parse(b.happenedAt));
  // Anchor to the EXACT detected inbound (by timestamp) in the FULL list, BEFORE
  // any grounding-window truncation — otherwise a long tail of later turns could
  // drop it and the reply would target a newer message. Fall back to the newest
  // inbound, then the newest turn.
  const anchorEv = (lastInboundAt
    ? sorted.find((ev) => ev.kind === 'message.received' && ev.happenedAt === lastInboundAt)
    : null)
    || [...sorted].reverse().find((ev) => ev.kind === 'message.received')
    || sorted[sorted.length - 1]
    || null;
  if (!anchorEv) {
    // No conversational grounding at all — refuse rather than fabricate context.
    throw new ServerError('No conversation history found to ground an outreach draft', { status: 404 });
  }

  // Revalidate against fresh timeline state BEFORE any reuse or generation: the
  // Care Queue fetched once, so between then and this click the user may have
  // replied (a newer `message.sent`) OR the contact may have sent a follow-up (a
  // newer `message.received`). Either makes the detected anchor stale — bail with a
  // clear signal so we don't reply to the wrong (old) turn or an answered thread.
  // Doing this before the draft-reuse lookup means a since-answered thread returns
  // 409 even when an obsolete un-sent draft is still on file.
  const anchorT = Date.parse(anchorEv.happenedAt);
  if (sorted.some((ev) => ev.kind === 'message.sent' && Date.parse(ev.happenedAt) > anchorT)) {
    throw new ServerError('You have already replied to this conversation', { status: 409, code: 'ALREADY_REPLIED' });
  }
  if (lastInboundAt && sorted.some((ev) => ev.kind === 'message.received' && Date.parse(ev.happenedAt) > anchorT)) {
    throw new ServerError('A newer message arrived — reload to draft a reply to the latest one', { status: 409, code: 'STALE_INBOUND' });
  }

  // Idempotency: a Tribe-outreach draft is a paid LLM call, and detection doesn't
  // clear when a draft is filed (the inbound is still the last turn), so the same
  // thread resurfaces after a reload / tab remount. Reuse an existing un-sent draft
  // for the SAME conversation + inbound instead of regenerating. (A newer inbound
  // has a different lastInboundAt and was already rejected above as stale.)
  if (conversationKey) {
    const existing = (await listDrafts().catch(() => []))
      .find((d) => d.generatedBy === 'tribe-outreach'
        && d.conversationKey === conversationKey
        && d.lastInboundAt === lastInboundAt
        && d.status !== 'sent');
    if (existing) {
      return { draft: existing, person: person ? { id: person.id, name: person.name } : null, reused: true };
    }
  }

  // Grounding context: the last N turns, but always keep the anchor in-window.
  const windowEvents = sorted.slice(-MAX_GROUNDING_EVENTS);
  if (!windowEvents.includes(anchorEv)) windowEvents.unshift(anchorEv);
  const threadMessages = windowEvents.map((ev) => eventToMessage(ev, person?.name));
  const replyTo = eventToMessage(anchorEv, person?.name);

  const aiResult = await generateReplyBody(replyTo, instructions, {
    useVoice,
    threadMessages,
    // Channel-appropriate template: casual/no-signoff for chat, greeting+signoff for
    // email (Gmail threads now reach here via #2796).
    templateOverride: outreachTemplateForSource(source),
  }).catch((err) => {
    console.error(`❌ Outreach draft generation failed: ${err.message}`);
    return null;
  });
  const body = aiResult?.body;
  if (!body) {
    throw new ServerError('Could not generate an outreach draft — check your reply provider in Messages > Config', { status: 502 });
  }

  // Recipient: `to` is a string[] (the shape every draft consumer expects —
  // DraftsTab and the Gmail serializer both call `draft.to.join(', ')`). Chat
  // sources are review-only, so prefer the actual chat handle/phone over a generic
  // person email — the To must name the channel the conversation happened on.
  const to = [];
  const recipient = handle || person?.phones?.[0] || person?.emails?.[0];
  if (recipient) to.push(recipient);

  const draft = await createDraft({
    accountId: null,
    threadId: threadId || null,
    to,
    subject: '',
    body,
    // Distinct provenance so the drafts list can badge Tribe-originated outreach.
    generatedBy: 'tribe-outreach',
    // Stable per-conversation key + the inbound it answers, so a repeat request
    // reuses this draft (above) but a NEWER inbound generates a fresh one.
    conversationKey,
    lastInboundAt,
    // Chat sources have no programmatic send channel — review-only (never sent).
    sendVia: 'review',
  });

  console.log(`🤝 Outreach draft filed for ${person?.name || 'a Tribe contact'} (${source || 'timeline'})`);
  return { draft, person: person ? { id: person.id, name: person.name } : null };
}

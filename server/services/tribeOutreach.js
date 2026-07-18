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
 * The detection layer is source-agnostic: it works across every message source
 * that records `message.sent`/`message.received` activity events — Gmail/Outlook
 * (#2033), iMessage (#2151), Signal (#2154) — because it keys off the timeline,
 * not any one provider's cache.
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

// Sources whose ingestion records BOTH directions per conversation, so an
// "unanswered" verdict is trustworthy. iMessage (#2151) and Signal (#2154) emit a
// `message.sent` for every outgoing turn; email sync ingests the inbox only (no
// `message.sent`), so a reply is invisible to the timeline and every stale inbound
// would read as unanswered forever. Email/other one-way sources are deferred until
// per-account sent/replied ingestion exists — see #2796.
const TWO_WAY_SOURCES = new Set(['imessage', 'signal']);

// Channel-appropriate reply prompt for chat outreach — generateReplyBody's default
// template is email-toned ("Write a professional reply to this email"), which reads
// wrong for a text message. generateReplyBody substitutes {{from}}/{{body}} and
// resolves the {{#instructions}} conditional block, so any caller-supplied guidance
// actually reaches the model (the default template omits it and drops it silently).
const OUTREACH_CHAT_TEMPLATE = 'Write a brief, warm, casual reply to reconnect over a text message. Keep it short and personal — no email subject line, no formal salutation or sign-off.{{#instructions}}\n\nAdditional guidance: {{instructions}}{{/instructions}}\n\nFrom: {{from}}\nTheir message:\n{{body}}';

// A conversation is keyed by the most specific stable identifier available:
// chatGuid (iMessage), conversationId (Signal — its outbound turns carry no
// handle, so keying on the shared conversationId is the only thing that unifies
// sent + received), the email threadId, then the raw handle. Person-scoped
// fallback only when an event carries none of those — it keeps a lone
// handle-less inbound groupable, but is deliberately last so that sent + received
// turns of the SAME thread always share a key (a person fallback would split them
// whenever one side lacks a person match — e.g. an iMessage/Signal sent turn).
function conversationKey(event) {
  const m = event?.metadata || {};
  if (m.chatGuid) return `chat:${m.chatGuid}`;
  if (m.conversationId) return `convo:${m.conversationId}`;
  if (m.threadId) return `thread:${m.threadId}`;
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
    lastInboundAt: inbound.happenedAt,
    daysAgo: Math.floor(ageMs / DAY_MS),
    snippet: String(inbound.summary || inbound.title || '').trim(),
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
  const [{ listEvents }, { loadResolverContext, enrichActivityEvent }] = await Promise.all([
    import('./humanActivity.js'),
    import('./identityResolve.js'),
  ]);

  const ctx = await loadResolverContext().catch(() => null);
  if (!ctx) return [];
  const ringById = new Map((ctx.people || []).map((p) => [p.id, p.ring]));
  const nameById = new Map((ctx.people || []).map((p) => [p.id, p.name]));
  // No non-external Tribe people → nothing to nudge about; skip the timeline scan.
  const hasTribe = (ctx.people || []).some((p) => p.ring && p.ring !== 'external');
  if (!hasTribe) return [];

  const now = Date.now();
  const from = new Date(now - withinDays * DAY_MS).toISOString();
  // Query each two-way source × kind separately, each with its own 2000-row cap.
  // A single shared query would let a high-volume source (e.g. thousands of
  // imported email events) fill the newest-2000 slice and push older iMessage /
  // Signal turns out of range — missing an alert, or hiding the reply that would
  // mark a thread answered.
  const received = [];
  const sent = [];
  await Promise.all([...TWO_WAY_SOURCES].map((src) =>
    // Fail CLOSED per source: if EITHER direction's query fails, drop this source's
    // turns entirely. Substituting [] for only the failed direction would leave
    // received without its sent counterpart, making every inbound look unanswered
    // and emitting false nudges — the function's contract is to stay quiet on a
    // read failure, not to nudge on half the data.
    Promise.all([
      listEvents({ from, source: src, kind: 'message.received', limit: 2000 }),
      listEvents({ from, source: src, kind: 'message.sent', limit: 2000 }),
    ]).then(([r, s]) => {
      // Fail CLOSED when either direction hits the 2000-row cap: the two queries
      // are capped independently, so a truncated `sent` result could omit an older
      // reply while its inbound survives in `received` — reporting an answered
      // thread as unanswered. Better no nudge for that (very heavy) source than a
      // false one. (received-cap is a false-negative only, but skip either to be safe.)
      if (r.length >= 2000 || s.length >= 2000) {
        console.warn(`🤝 Skipping ${src} outreach scan — timeline query hit the 2000-row cap (can't verify reply state)`);
        return;
      }
      received.push(...r); sent.push(...s);
    }).catch(() => { /* partial read → drop this source to avoid false nudges */ })
  ));

  // Every outbound turn just needs to cancel the unanswered flag for its
  // conversation (grouped by chatGuid/conversationId).
  const tagged = [...sent];
  for (const ev of received) {
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
    withinMs: withinDays * DAY_MS,
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
 * path. Detection only surfaces the two-way chat sources (iMessage/Signal), which
 * carry no message account and no programmatic send channel, so the draft is always
 * grounded from the timeline and filed as review-only — never auto-sent.
 *
 * @returns {Promise<{ draft, person: { id, name } | null }>}
 */
export async function generateOutreachDraft(params = {}) {
  const conversationKey = params.chatGuid || params.conversationId || params.threadId || params.handle || null;
  // No key to guard on (validated away at the route, but defensive) → run directly.
  if (!conversationKey) return generateOutreachDraftImpl(params);
  const guardKey = `${conversationKey}::${params.lastInboundAt || ''}`;
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
  const conversationKey = chatGuid || conversationId || threadId || handle || null;

  // Ground the reply in the actual conversation, pulled from the timeline by the
  // DETECTED conversation key — chatGuid (iMessage) / conversationId (Signal) /
  // threadId (email) / handle (counterpart). NOT personId: message events don't
  // persist it on their participants, so a personId query returns nothing. Pass
  // exactly the most-selective key present (listEvents ANDs its filters).
  const convoEvents = await listEvents({
    source: source || undefined,
    chatGuid: chatGuid || undefined,
    conversationId: chatGuid ? undefined : (conversationId || undefined),
    threadId: (chatGuid || conversationId) ? undefined : (threadId || undefined),
    handle: (chatGuid || conversationId || threadId) ? undefined : (handle || undefined),
    limit: 200,
  }).catch(() => []);

  const sorted = (convoEvents || [])
    .filter((ev) => MESSAGE_KINDS.has(ev.kind))
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
    templateOverride: OUTREACH_CHAT_TEMPLATE,
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

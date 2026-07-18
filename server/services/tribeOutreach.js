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
  // Two kind-filtered queries instead of one broad scan: the timeline is capped
  // at 2000 rows per query, so on a busy install a single unfiltered query could
  // return 2000 non-message rows and drop every message event.
  const [received, sent] = await Promise.all([
    listEvents({ from, kind: 'message.received', limit: 2000 }).catch(() => []),
    listEvents({ from, kind: 'message.sent', limit: 2000 }).catch(() => []),
  ]);

  // Keep every outbound turn from a two-way source — it only needs to cancel the
  // unanswered flag for its conversation (grouped by chatGuid/conversationId).
  const tagged = sent.filter((ev) => TWO_WAY_SOURCES.has(ev.source));
  for (const ev of received) {
    // Only nudge for sources where a reply would actually be visible (chat).
    if (!TWO_WAY_SOURCES.has(ev.source)) continue;
    // Resolve the SENDER to a Tribe person via the event's counterpart handle
    // ONLY. For iMessage/Signal a received event's `metadata.handle` IS the
    // sender, which is what `enrichActivityEvent` resolves. Do NOT fall back to
    // participants[]: iMessage builds it from every chat member in unspecified
    // order, so a group message from an untracked sender to a Tribe member would
    // be misattributed to that member — a false "unanswered" nudge for someone
    // who never wrote. An unresolved sender is skipped, not guessed.
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

// Build a synthetic thread (buildThreadContext / generateReplyBody shape) from the
// conversation's own timeline events. The message summaries are the actual message
// text (shortSummary-capped), so this grounds the reply in the real conversation —
// including the user's own sent turns (labeled "You"), which is why the draft query
// keys on the conversation, not just the counterpart handle.
function timelineThreadMessages(events, personName) {
  return (events || [])
    .filter((ev) => MESSAGE_KINDS.has(ev.kind) && (ev.summary || ev.title))
    .sort((a, b) => Date.parse(a.happenedAt) - Date.parse(b.happenedAt))
    .slice(-MAX_GROUNDING_EVENTS)
    .map((ev) => ({
      from: { name: ev.kind === 'message.sent' ? 'You' : (personName || 'them') },
      date: ev.happenedAt,
      bodyText: String(ev.summary || ev.title || ''),
    }));
}

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
export async function generateOutreachDraft({
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

  // Idempotency: a Tribe-outreach draft is a paid LLM call. Detection doesn't
  // clear when a draft is filed (the inbound is still the last turn), so the same
  // thread resurfaces after a page reload / tab remount. If an un-sent outreach
  // draft already exists for this conversation, return it instead of generating —
  // otherwise a second click bills the provider again and files a duplicate.
  if (conversationKey) {
    const existing = (await listDrafts().catch(() => []))
      .find((d) => d.generatedBy === 'tribe-outreach' && d.conversationKey === conversationKey && d.status !== 'sent');
    if (existing) {
      return { draft: existing, person: person ? { id: person.id, name: person.name } : null, reused: true };
    }
  }

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
  const threadMessages = timelineThreadMessages(convoEvents, person?.name);
  // Anchor to the EXACT detected inbound (by its timestamp) — a group chat's
  // chatGuid loads every member's turns, so "newest inbound from anyone" could
  // reply to a different member who spoke after the Tribe person. Fall back to the
  // newest inbound, then the newest turn, only when the anchor isn't found.
  const replyTo = (lastInboundAt
    ? threadMessages.find((m) => m.from?.name !== 'You' && m.date === lastInboundAt)
    : null)
    || [...threadMessages].reverse().find((m) => m.from?.name !== 'You')
    || threadMessages[threadMessages.length - 1]
    || null;
  if (!replyTo) {
    // No conversational grounding at all — refuse rather than fabricate context.
    throw new ServerError('No conversation history found to ground an outreach draft', { status: 404 });
  }

  const aiResult = await generateReplyBody(replyTo, instructions, { useVoice, threadMessages }).catch((err) => {
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
    // Stable per-conversation key so a repeat request reuses this draft (above).
    conversationKey,
    // Chat sources have no programmatic send channel — review-only (never sent).
    sendVia: 'review',
  });

  console.log(`🤝 Outreach draft filed for ${person?.name || 'a Tribe contact'} (${source || 'timeline'})`);
  return { draft, person: person ? { id: person.id, name: person.name } : null };
}

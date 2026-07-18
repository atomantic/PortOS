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
    accountId: inbound.accountId || null,
    threadId: m.threadId || null,
    chatGuid: m.chatGuid || null,
    handle: m.handle || null,
    replyToExternalId: m.externalId || null,
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
  // return 2000 non-message rows and drop every message event. Fetch inbound
  // within the window; fetch outbound WITHOUT a `from` bound (2000 newest) so it
  // doubles as the source-capability probe below — a source that has never
  // recorded an outbound turn (e.g. email, whose sync ingests the inbox only and
  // never emits `message.sent`) must not have its stale inbound reported as
  // "unanswered" just because a reply is structurally invisible to the timeline.
  const [received, sent] = await Promise.all([
    listEvents({ from, kind: 'message.received', limit: 2000 }).catch(() => []),
    listEvents({ kind: 'message.sent', limit: 2000 }).catch(() => []),
  ]);

  // Sources that demonstrably record outbound activity (two-way observable).
  const outboundSources = new Set();
  for (const ev of sent) if (ev.source) outboundSources.add(ev.source);

  // Keep every outbound turn — it only needs to cancel the unanswered flag for
  // its conversation (grouped by chatGuid/conversationId/threadId).
  const tagged = [...sent];
  for (const ev of received) {
    // Only nudge for sources we can actually see replies on; otherwise every
    // stale Tribe inbound would read as unanswered forever (finding: email).
    if (!outboundSources.has(ev.source)) continue;
    // Resolve the counterpart to a Tribe person (handle first, then any
    // participant with a resolved personId). Drop inbound we can't tie to Tribe.
    const enriched = enrichActivityEvent(ev, ctx);
    let personId = enriched.personId;
    if (!personId) personId = (enriched.participants || []).find((p) => p.personId)?.personId || null;
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

// Build a synthetic thread (buildThreadContext / generateReplyBody shape) from
// the conversation's own timeline events when no rich provider cache is available
// (iMessage/Signal, or an email thread pruned from cache). The message summaries
// are the actual message text (shortSummary-capped), so this still grounds the
// reply in the real conversation. `selfName` labels the user's own sent turns.
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

function replySubject(subject) {
  const s = String(subject || '').trim();
  if (!s) return '';
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

/**
 * Generate a grounded outreach draft for one unanswered thread and file it through
 * the existing draft-then-approve pipeline. USER-ACTION-GATED: only ever called
 * from an explicit request (the Tribe Outreach panel / an opt-in automation) — it
 * is the single LLM entry point here and must never be wired into a boot/sweep path.
 *
 * @returns {Promise<{ draft, person: { id, name } | null }>}
 */
export async function generateOutreachDraft({
  personId = null,
  source = null,
  accountId = null,
  threadId = null,
  chatGuid = null,
  handle = null,
  replyToExternalId = null,
  instructions = '',
  useVoice,
} = {}) {
  const [
    { getPerson },
    { getAccount },
    { getThread },
    { listEvents },
    { generateReplyBody },
    { createDraft },
  ] = await Promise.all([
    import('./tribe.js'),
    import('./messageAccounts.js'),
    import('./messageSync.js'),
    import('./humanActivity.js'),
    import('./messageEvaluator.js'),
    import('./messageDrafts.js'),
  ]);

  const person = personId ? await getPerson(personId).catch(() => null) : null;
  // accountId is optional: iMessage/Signal threads have no message account, so a
  // real messageAccounts row exists only for email sources. Absent/unknown → the
  // draft grounds off the timeline and stays review-only (no derived send channel).
  const account = accountId ? await getAccount(accountId).catch(() => null) : null;
  const selfEmail = String(account?.email || '').trim().toLowerCase();

  // Prefer the rich provider cache (full message bodies) when an email account +
  // threadId are present; otherwise ground off the conversation's timeline events.
  let cacheThread = [];
  if (account && threadId) {
    cacheThread = await getThread(accountId, threadId).catch(() => []);
  }

  let replyTo = null;
  let threadMessages = null;
  if (cacheThread.length) {
    // Reply to the EXACT detected inbound first (its externalId came from the
    // Tribe-resolved timeline event). Only when that message isn't in the cache
    // fall back to the newest non-self inbound — in a multi-participant thread the
    // newest inbound may be from someone else entirely, so anchoring on the
    // detected message keeps the draft addressed to the right person.
    replyTo = (replyToExternalId ? cacheThread.find((m) => m.externalId === replyToExternalId) : null)
      || [...cacheThread].reverse().find((m) => {
        const fromEmail = String(m.from?.email || '').trim().toLowerCase();
        return !(selfEmail && fromEmail === selfEmail);
      })
      || cacheThread[cacheThread.length - 1];
    threadMessages = cacheThread;
  } else {
    // Timeline grounding: pull this conversation's message events. chatGuid is the
    // most selective key; fall back to handle, then the person's whole history.
    const convoEvents = await listEvents({
      source: source || undefined,
      chatGuid: chatGuid || undefined,
      handle: chatGuid ? undefined : (handle || undefined),
      personId: (chatGuid || handle) ? undefined : (personId || undefined),
      limit: 200,
    }).catch(() => []);
    const msgs = timelineThreadMessages(convoEvents, person?.name);
    threadMessages = msgs;
    // Reply to the last inbound turn (the person's), else the newest turn.
    replyTo = [...msgs].reverse().find((m) => m.from?.name !== 'You') || msgs[msgs.length - 1] || null;
  }

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

  // Recipient: `to` is a string[] of addresses/handles (the shape every existing
  // draft consumer expects — DraftsTab and the Gmail serializer both call
  // `draft.to.join(', ')`). Prefer the detected sender's email, else the person's
  // known email, else the conversation handle / phone for review-only channels.
  const to = [];
  const recipient = replyTo.from?.email
    || person?.emails?.[0]
    || handle
    || person?.phones?.[0];
  if (recipient) to.push(recipient);

  const draft = await createDraft({
    accountId: accountId || null,
    replyToMessageId: replyTo.id || null,
    threadId: threadId || replyTo.threadId || null,
    to,
    subject: replySubject(replyTo.subject),
    body,
    // Distinct provenance so the drafts list can badge Tribe-originated outreach.
    generatedBy: 'tribe-outreach',
    // Only email accounts have a real send channel; leave others as review-only.
    sendVia: account ? (account.type === 'gmail' ? 'api' : 'playwright') : 'review',
  });

  console.log(`🤝 Outreach draft filed for ${person?.name || 'a Tribe contact'} (${source || 'timeline'})`);
  return { draft, person: person ? { id: person.id, name: person.name } : null };
}

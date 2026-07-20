import { describe, it, expect, vi, beforeEach } from 'vitest';

import { groupUnansweredThreads, generateOutreachDraft, findUnansweredTribeThreads, buildTwoWayGate, outreachTemplateForSource } from './tribeOutreach.js';

// generateOutreachDraft / findUnansweredTribeThreads dynamically import these —
// mock them so the draft-side logic (idempotent reuse, anchoring the reply to the
// detected inbound) and the detector are testable without a DB or a live LLM.
vi.mock('./tribe.js', () => ({ getPerson: vi.fn() }));
vi.mock('./humanActivity.js', () => ({ listEvents: vi.fn() }));
vi.mock('./messageEvaluator.js', () => ({ generateReplyBody: vi.fn() }));
vi.mock('./messageDrafts.js', () => ({ createDraft: vi.fn(), listDrafts: vi.fn() }));
vi.mock('./identityResolve.js', () => ({ loadResolverContext: vi.fn(), enrichActivityEvent: vi.fn() }));
vi.mock('./messageAccounts.js', () => ({ listAccounts: vi.fn() }));

import { getPerson } from './tribe.js';
import { listEvents } from './humanActivity.js';
import { generateReplyBody } from './messageEvaluator.js';
import { createDraft, listDrafts } from './messageDrafts.js';
import { loadResolverContext, enrichActivityEvent } from './identityResolve.js';
import { listAccounts } from './messageAccounts.js';

// `groupUnansweredThreads` is the pure detection core — no DB, no LLM. These
// tests pin the "unanswered inbound from a Tribe person, within the actionable
// window" contract that both the /tribe/outreach route and the `tribe_unanswered`
// proactive alert depend on (#2158).

const NOW = Date.parse('2026-07-18T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();

// Default window: nudge after 20h stale, drop after 14 days.
const WINDOW = { now: NOW, staleAfterMs: 20 * 3600000, withinMs: 14 * 86400000 };

const inbound = (over) => ({
  kind: 'message.received',
  source: 'imessage',
  personId: 'p1',
  personName: 'Alex',
  ring: 'tribe',
  summary: 'dinner Friday?',
  metadata: { chatGuid: 'chat-1', handle: '+15550001' },
  ...over,
});
const sent = (over) => ({
  kind: 'message.sent',
  source: 'imessage',
  summary: 'sounds good',
  metadata: { chatGuid: 'chat-1' },
  ...over,
});

describe('groupUnansweredThreads', () => {
  it('surfaces an unanswered inbound from a Tribe person within the window', () => {
    const out = groupUnansweredThreads([inbound({ happenedAt: daysAgo(3) })], WINDOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      personId: 'p1',
      personName: 'Alex',
      source: 'imessage',
      chatGuid: 'chat-1',
      daysAgo: 3,
      snippet: 'dinner Friday?',
    });
  });

  it('excludes a thread you already replied to (sent after their last inbound)', () => {
    const out = groupUnansweredThreads([
      inbound({ happenedAt: daysAgo(3) }),
      sent({ happenedAt: daysAgo(2) }), // replied one day later
    ], WINDOW);
    expect(out).toHaveLength(0);
  });

  it('still surfaces when your reply predates their newest message', () => {
    const out = groupUnansweredThreads([
      sent({ happenedAt: daysAgo(5) }),      // old reply
      inbound({ happenedAt: daysAgo(2) }),   // they came back after
    ], WINDOW);
    expect(out).toHaveLength(1);
    expect(out[0].daysAgo).toBe(2);
  });

  it('excludes threads too fresh to nudge (within staleAfter)', () => {
    const out = groupUnansweredThreads([inbound({ happenedAt: hoursAgo(4) })], WINDOW);
    expect(out).toHaveLength(0);
  });

  it('excludes threads too old to still be actionable (beyond withinMs)', () => {
    const out = groupUnansweredThreads([inbound({ happenedAt: daysAgo(30) })], WINDOW);
    expect(out).toHaveLength(0);
  });

  it('ignores inbound from non-Tribe people (external ring / unresolved)', () => {
    const out = groupUnansweredThreads([
      inbound({ happenedAt: daysAgo(3), personId: 'p2', ring: 'external', metadata: { chatGuid: 'chat-2' } }),
      inbound({ happenedAt: daysAgo(3), personId: null, metadata: { chatGuid: 'chat-3' } }),
    ], WINDOW);
    expect(out).toHaveLength(0);
  });

  it('cancels an iMessage thread via chatGuid even when the sent turn carries no handle', () => {
    // Real iMessage `message.sent` events have no counterpart handle and never
    // resolve to a person — they must still cancel the unanswered flag by chatGuid.
    const out = groupUnansweredThreads([
      inbound({ happenedAt: daysAgo(3) }),
      { kind: 'message.sent', source: 'imessage', happenedAt: daysAgo(1), metadata: { chatGuid: 'chat-1', handle: null } },
    ], WINDOW);
    expect(out).toHaveLength(0);
  });

  it('groups separate conversations independently and sorts most-overdue first', () => {
    const out = groupUnansweredThreads([
      inbound({ happenedAt: daysAgo(2), personId: 'p1', personName: 'Alex', metadata: { chatGuid: 'chat-1' } }),
      inbound({ happenedAt: daysAgo(6), personId: 'p2', personName: 'Bo', ring: 'core', metadata: { chatGuid: 'chat-2' } }),
    ], WINDOW);
    expect(out.map((t) => t.personName)).toEqual(['Bo', 'Alex']);
    expect(out[0].daysAgo).toBe(6);
  });

  it('cancels a Signal thread via conversationId when the sent turn has no handle', () => {
    // Signal writes metadata.conversationId (not chatGuid), and outbound Signal
    // events carry no handle — so grouping must key on conversationId or the
    // reply is discarded and the thread looks unanswered.
    const out = groupUnansweredThreads([
      { kind: 'message.received', source: 'signal', personId: 'p1', personName: 'Alex', ring: 'tribe',
        happenedAt: daysAgo(4), summary: 'you around?', metadata: { conversationId: 'c-77', handle: '+15550009' } },
      { kind: 'message.sent', source: 'signal', happenedAt: daysAgo(2),
        metadata: { conversationId: 'c-77', handle: null } },
    ], WINDOW);
    expect(out).toHaveLength(0);
  });

  it('surfaces an unanswered Signal thread keyed by conversationId', () => {
    const out = groupUnansweredThreads([
      { kind: 'message.received', source: 'signal', personId: 'p1', personName: 'Alex', ring: 'tribe',
        happenedAt: daysAgo(4), summary: 'you around?', metadata: { conversationId: 'c-77', handle: '+15550009' } },
    ], WINDOW);
    expect(out).toHaveLength(1);
    expect(out[0].conversationKey).toBe('convo:c-77');
    expect(out[0].handle).toBe('+15550009');
  });

  it('keys email conversations by threadId so sent + received turns unify', () => {
    const out = groupUnansweredThreads([
      { kind: 'message.received', source: 'gmail', accountId: 'acct-a', personId: 'p1', personName: 'Alex', ring: 'tribe',
        happenedAt: daysAgo(4), summary: 'proposal attached', metadata: { threadId: 't-9' } },
      { kind: 'message.sent', source: 'gmail', accountId: 'acct-a', happenedAt: daysAgo(3), metadata: { threadId: 't-9' } },
    ], WINDOW);
    expect(out).toHaveLength(0); // replied within the same email thread
  });

  it('does NOT merge two accounts that share a threadId value (#2820)', () => {
    // A Gmail threadId is only unique within one account. Account A got an inbound;
    // account B sent a reply on ITS OWN thread that happens to share the id value.
    // Namespacing by accountId keeps them separate so B's reply can't answer A's
    // inbound — A's thread must still surface as unanswered.
    const out = groupUnansweredThreads([
      { kind: 'message.received', source: 'gmail', accountId: 'acct-a', personId: 'p1', personName: 'Alex', ring: 'tribe',
        happenedAt: daysAgo(4), summary: 'proposal attached', metadata: { threadId: 'shared-id' } },
      { kind: 'message.sent', source: 'gmail', accountId: 'acct-b', happenedAt: daysAgo(3), metadata: { threadId: 'shared-id' } },
    ], WINDOW);
    expect(out).toHaveLength(1);
    expect(out[0].conversationKey).toBe('thread:acct-a:shared-id');
    expect(out[0].accountId).toBe('acct-a');
  });

  it('ignores Tapback/reaction turns — a reaction neither anchors nor answers', () => {
    // A reaction as the last inbound must NOT create an unanswered nudge.
    const out = groupUnansweredThreads([
      inbound({ happenedAt: daysAgo(5), summary: 'dinner Friday?' }),
      { kind: 'message.sent', source: 'imessage', happenedAt: daysAgo(4), metadata: { chatGuid: 'chat-1' } },
      inbound({ happenedAt: daysAgo(2), summary: 'liked "sounds good"', metadata: { chatGuid: 'chat-1', handle: '+15550001', isReaction: true } }),
    ], WINDOW);
    expect(out).toHaveLength(0); // the real inbound was answered; the reaction is ignored
  });

  it('drops events with unparseable timestamps without throwing', () => {
    const out = groupUnansweredThreads([inbound({ happenedAt: 'not-a-date' })], WINDOW);
    expect(out).toHaveLength(0);
  });
});

describe('buildTwoWayGate (per-account #2796)', () => {
  const NOW = Date.parse('2026-07-18T12:00:00Z');
  const recent = new Date(NOW - 3600000).toISOString(); // 1h ago — fresh watermark
  const OPTS = { now: NOW, coverageMs: 14 * 86400000 };
  // A trustworthy Gmail account: email set, enabled, sent-ingest on, recent watermark.
  const gmail = (over) => ({ id: 'g1', type: 'gmail', email: 'me@example.com', enabled: true, syncConfig: {}, sentIngestedAt: recent, ...over });

  it('chat sources are always two-way, no account needed', () => {
    const { sources, isTwoWay } = buildTwoWayGate([], OPTS);
    expect(sources).toEqual(expect.arrayContaining(['imessage', 'signal']));
    expect(isTwoWay({ source: 'imessage' })).toBe(true);
    expect(isTwoWay({ source: 'signal', accountId: null })).toBe(true);
  });

  it('a Gmail account with email, default ingestSent, and a recent watermark is two-way', () => {
    const { sources, isTwoWay } = buildTwoWayGate([gmail()], OPTS);
    expect(sources).toContain('gmail');
    expect(isTwoWay({ source: 'gmail', accountId: 'g1' })).toBe(true);
  });

  it('opting a Gmail account out (ingestSent:false) drops it from the gate', () => {
    const { sources, isTwoWay } = buildTwoWayGate([gmail({ syncConfig: { ingestSent: false } })], OPTS);
    expect(sources).not.toContain('gmail');
    expect(isTwoWay({ source: 'gmail', accountId: 'g1' })).toBe(false);
  });

  it('a Gmail account with no owner email is NOT two-way (sent direction underivable)', () => {
    expect(buildTwoWayGate([gmail({ email: '' })], OPTS).isTwoWay({ source: 'gmail', accountId: 'g1' })).toBe(false);
  });

  it('a disabled Gmail account is NOT two-way (its sent history never syncs)', () => {
    expect(buildTwoWayGate([gmail({ enabled: false })], OPTS).isTwoWay({ source: 'gmail', accountId: 'g1' })).toBe(false);
  });

  it('a Gmail account with NO sent-ingest watermark is NOT two-way (upgrade/first-sync window)', () => {
    // Default-on at upgrade but no sync yet → no reply evidence → must not be trusted.
    expect(buildTwoWayGate([gmail({ sentIngestedAt: undefined })], OPTS).isTwoWay({ source: 'gmail', accountId: 'g1' })).toBe(false);
  });

  it('a STALE watermark (older than the detection window) drops the account (sync failing)', () => {
    const stale = new Date(NOW - 20 * 86400000).toISOString(); // 20d ago > 14d window
    expect(buildTwoWayGate([gmail({ sentIngestedAt: stale })], OPTS).isTwoWay({ source: 'gmail', accountId: 'g1' })).toBe(false);
  });

  it('a PARTIAL sent-coverage watermark drops the account (#2820 — truncated sent window)', () => {
    // The last sync hit the sent ceiling → incomplete reply evidence → fail closed,
    // even with a fresh watermark, until a full sync clears the flag.
    const gate = buildTwoWayGate([gmail({ sentCoveragePartial: true })], OPTS);
    expect(gate.sources).not.toContain('gmail');
    expect(gate.emailAccounts).toEqual([]);
    expect(gate.isTwoWay({ source: 'gmail', accountId: 'g1' })).toBe(false);
  });

  it('does NOT let one Gmail account vouch for another (per-account, not source-wide)', () => {
    // g1 ingests sent; g2 opted out. Both are source `gmail`, but only g1's events
    // are trustworthy — a source-wide gate would wrongly trust g2's inbound too.
    const gate = buildTwoWayGate([
      gmail({ id: 'g1' }),
      gmail({ id: 'g2', email: 'other@example.com', syncConfig: { ingestSent: false } }),
    ], OPTS);
    expect(gate.sources).toContain('gmail'); // scanned because g1 is two-way
    expect(gate.isTwoWay({ source: 'gmail', accountId: 'g1' })).toBe(true);
    expect(gate.isTwoWay({ source: 'gmail', accountId: 'g2' })).toBe(false);
    // Only g1 is surfaced for per-account querying (#2820) — g2 is never queried.
    expect(gate.emailAccounts).toEqual([{ id: 'g1', source: 'gmail' }]);
  });

  it('Outlook is never two-way (no sent-fetch path yet), even with ingestSent:true', () => {
    const { sources, isTwoWay } = buildTwoWayGate([
      { id: 'o1', type: 'outlook', email: 'me@example.com', enabled: true, syncConfig: { ingestSent: true }, sentIngestedAt: recent },
    ], OPTS);
    expect(sources).not.toContain('outlook');
    expect(isTwoWay({ source: 'outlook', accountId: 'o1' })).toBe(false);
  });
});

describe('outreachTemplateForSource (#2796)', () => {
  it('uses a no-signoff casual template for chat sources', () => {
    const t = outreachTemplateForSource('imessage');
    expect(t).toContain('text message');
    expect(t).toContain('no formal salutation or sign-off');
    expect(outreachTemplateForSource('signal')).toBe(t);
  });
  it('uses a greeting+signoff email template for Gmail (not the chat template)', () => {
    const t = outreachTemplateForSource('gmail');
    expect(t).toContain('email reply');
    expect(t).toContain('sign-off');
    expect(t).not.toContain('no formal salutation');
  });
});

describe('findUnansweredTribeThreads — per-account email querying (#2820)', () => {
  const RECENT = new Date(NOW - 3600000).toISOString();

  beforeEach(() => {
    vi.clearAllMocks();
    // One tribe person, resolved from the inbound's handle.
    loadResolverContext.mockResolvedValue({ people: [{ id: 'p1', ring: 'tribe', name: 'Alex' }] });
    enrichActivityEvent.mockReturnValue({ personId: 'p1', displayName: 'Alex' });
  });

  it('queries each two-way Gmail account under its OWN cap so a noisy account cannot suppress an opted-in one', async () => {
    // acct-opted is two-way; acct-noisy opted out (high volume, never trustworthy).
    listAccounts.mockResolvedValue([
      { id: 'acct-opted', type: 'gmail', email: 'me@example.com', enabled: true, syncConfig: {}, sentIngestedAt: RECENT },
      { id: 'acct-noisy', type: 'gmail', email: 'noisy@example.com', enabled: true, syncConfig: { ingestSent: false }, sentIngestedAt: RECENT },
    ]);

    const openInbound = {
      kind: 'message.received', source: 'gmail', accountId: 'acct-opted',
      happenedAt: daysAgo(3), summary: 'lunch soon?',
      metadata: { threadId: 't-opted', handle: 'friend@example.com' },
    };

    // Per-account query returns the opted account's unanswered inbound; a source-wide
    // gmail query (no accountId — the OLD, cap-sharing path) would return a full
    // noisy slice with NO opted inbound, suppressing the nudge. Chat sources empty.
    listEvents.mockImplementation(async ({ source, accountId, kind }) => {
      if (source === 'gmail' && accountId === 'acct-opted') {
        return kind === 'message.received' ? [openInbound] : [];
      }
      if (source === 'gmail' && accountId == null) {
        // Simulate the pre-#2820 cap-filling noise (2000 rows, none from acct-opted).
        return kind === 'message.received'
          ? Array.from({ length: 2000 }, (_, i) => ({
            kind: 'message.received', source: 'gmail', accountId: 'acct-noisy',
            happenedAt: daysAgo(1), summary: `noise ${i}`, metadata: { threadId: `n-${i}` },
          }))
          : [];
      }
      return [];
    });

    const threads = await findUnansweredTribeThreads();

    // The opted-in account's nudge surfaces despite the noisy account's volume.
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ personId: 'p1', source: 'gmail', threadId: 't-opted', accountId: 'acct-opted' });
    // It queried the opted account PER ACCOUNT and never ran a cap-sharing
    // source-wide gmail query.
    const gmailCalls = listEvents.mock.calls.map(([a]) => a).filter((a) => a.source === 'gmail');
    expect(gmailCalls.every((a) => a.accountId === 'acct-opted')).toBe(true);
    expect(gmailCalls.length).toBeGreaterThan(0);
  });
});

describe('generateOutreachDraft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPerson.mockResolvedValue({ id: 'p1', name: 'Alex', phones: ['+15550001'], emails: [] });
    generateReplyBody.mockResolvedValue({ body: 'Hey Alex — sorry for the delay!' });
    createDraft.mockImplementation(async (d) => ({ id: 'draft-new', status: 'draft', ...d }));
    listDrafts.mockResolvedValue([]);
    // Default timeline: a single inbound matching the tests' lastInboundAt, so the
    // pre-generation freshness read (now runs before reuse) finds a fresh anchor.
    listEvents.mockResolvedValue([
      { kind: 'message.received', happenedAt: '2026-07-15T00:00:00.000Z', summary: 'hi' },
    ]);
  });

  it('reuses an existing un-sent outreach draft for the same conversation + inbound (no duplicate LLM call)', async () => {
    listDrafts.mockResolvedValue([
      { id: 'draft-old', generatedBy: 'tribe-outreach', conversationKey: 'chat-1', lastInboundAt: '2026-07-15T00:00:00.000Z', status: 'draft', body: 'earlier' },
    ]);
    const result = await generateOutreachDraft({ personId: 'p1', source: 'imessage', chatGuid: 'chat-1', lastInboundAt: '2026-07-15T00:00:00.000Z' });
    expect(result.reused).toBe(true);
    expect(result.draft.id).toBe('draft-old');
    expect(generateReplyBody).not.toHaveBeenCalled();
    expect(createDraft).not.toHaveBeenCalled();
  });

  it('anchors the reply to the detected inbound even with older turns present', async () => {
    listEvents.mockResolvedValue([
      { kind: 'message.sent', happenedAt: '2026-07-10T00:00:00.000Z', summary: 'an older reply of mine' },
      { kind: 'message.received', happenedAt: '2026-07-15T00:00:00.000Z', summary: 'the detected one' },
    ]);
    await generateOutreachDraft({ personId: 'p1', source: 'imessage', chatGuid: 'chat-1', lastInboundAt: '2026-07-15T00:00:00.000Z' });
    const [replyTo] = generateReplyBody.mock.calls[0];
    expect(replyTo.bodyText).toBe('the detected one');
  });

  it('does NOT reuse a draft for a stale inbound — a newer message generates a fresh draft', async () => {
    listDrafts.mockResolvedValue([
      { id: 'draft-old', generatedBy: 'tribe-outreach', conversationKey: 'chat-1', lastInboundAt: '2026-07-15T00:00:00.000Z', status: 'draft', body: 'earlier' },
    ]);
    listEvents.mockResolvedValue([
      { kind: 'message.received', happenedAt: '2026-07-17T00:00:00.000Z', summary: 'a newer message' },
    ]);
    const result = await generateOutreachDraft({ personId: 'p1', source: 'imessage', chatGuid: 'chat-1', lastInboundAt: '2026-07-17T00:00:00.000Z' });
    expect(result.reused).toBeUndefined();
    expect(generateReplyBody).toHaveBeenCalled();
  });

  it('does not reuse an already-sent draft — generates a fresh one', async () => {
    listDrafts.mockResolvedValue([
      { id: 'draft-sent', generatedBy: 'tribe-outreach', conversationKey: 'chat-1', status: 'sent', body: 'sent' },
    ]);
    listEvents.mockResolvedValue([
      { kind: 'message.received', happenedAt: '2026-07-15T00:00:00.000Z', summary: 'you around?' },
    ]);
    const result = await generateOutreachDraft({ personId: 'p1', source: 'imessage', chatGuid: 'chat-1' });
    expect(result.reused).toBeUndefined();
    expect(generateReplyBody).toHaveBeenCalled();
    expect(createDraft).toHaveBeenCalledWith(expect.objectContaining({ conversationKey: 'chat-1', sendVia: 'review' }));
  });

  it('refuses (409) when a reply was sent after the detected inbound', async () => {
    listEvents.mockResolvedValue([
      { kind: 'message.received', happenedAt: '2026-07-15T00:00:00.000Z', summary: 'you around?' },
      { kind: 'message.sent', happenedAt: '2026-07-16T00:00:00.000Z', summary: 'yes!' },
    ]);
    await expect(generateOutreachDraft({
      personId: 'p1', source: 'imessage', chatGuid: 'chat-1', lastInboundAt: '2026-07-15T00:00:00.000Z',
    })).rejects.toMatchObject({ status: 409 });
    expect(generateReplyBody).not.toHaveBeenCalled();
    expect(createDraft).not.toHaveBeenCalled();
  });

  it('refuses (409 STALE_INBOUND) when a newer inbound arrived after the detected one', async () => {
    listEvents.mockResolvedValue([
      { kind: 'message.received', happenedAt: '2026-07-15T00:00:00.000Z', summary: 'the detected one' },
      { kind: 'message.received', happenedAt: '2026-07-18T00:00:00.000Z', summary: 'a newer follow-up' },
    ]);
    await expect(generateOutreachDraft({
      personId: 'p1', source: 'imessage', chatGuid: 'chat-1', lastInboundAt: '2026-07-15T00:00:00.000Z',
    })).rejects.toMatchObject({ status: 409, code: 'STALE_INBOUND' });
    expect(generateReplyBody).not.toHaveBeenCalled();
  });

  it('coalesces two concurrent generations for the same thread into one LLM call', async () => {
    listEvents.mockResolvedValue([
      { kind: 'message.received', happenedAt: '2026-07-15T00:00:00.000Z', summary: 'hi' },
    ]);
    const seed = { personId: 'p1', source: 'imessage', chatGuid: 'chat-1', lastInboundAt: '2026-07-15T00:00:00.000Z' };
    const [a, b] = await Promise.all([generateOutreachDraft(seed), generateOutreachDraft(seed)]);
    expect(generateReplyBody).toHaveBeenCalledTimes(1);
    expect(createDraft).toHaveBeenCalledTimes(1);
    expect(a.draft).toBe(b.draft);
  });

  it('uses a chat-appropriate reply template, not the email default', async () => {
    listEvents.mockResolvedValue([
      { kind: 'message.received', happenedAt: '2026-07-15T00:00:00.000Z', summary: 'hey' },
    ]);
    await generateOutreachDraft({ personId: 'p1', source: 'imessage', chatGuid: 'chat-1' });
    const [, , opts] = generateReplyBody.mock.calls[0];
    expect(opts.templateOverride).toMatch(/text message/i);
    expect(opts.templateOverride).toMatch(/casual/i);
    expect(opts.templateOverride).not.toMatch(/professional reply to this email/i);
  });

  it('fails closed (400) for an email thread keyed only by threadId with no accountId (#2820)', async () => {
    // A legacy-queued / older-client / direct request omits accountId — grounding by
    // an account-unscoped threadId could merge accounts, so refuse rather than guess.
    await expect(generateOutreachDraft({
      personId: 'p1', source: 'gmail', threadId: 't-ambiguous', lastInboundAt: '2026-07-15T00:00:00.000Z',
    })).rejects.toMatchObject({ status: 400, code: 'ACCOUNT_ID_REQUIRED' });
    expect(generateReplyBody).not.toHaveBeenCalled();
  });

  it('allows an email thread when accountId disambiguates it (#2820)', async () => {
    listEvents.mockResolvedValue([
      { kind: 'message.received', accountId: 'acct-a', happenedAt: '2026-07-15T00:00:00.000Z', summary: 'proposal?', metadata: { threadId: 't-9' } },
    ]);
    getPerson.mockResolvedValue({ id: 'p1', name: 'Alex', phones: [], emails: ['alex@example.com'] });
    const result = await generateOutreachDraft({
      personId: 'p1', source: 'gmail', accountId: 'acct-a', threadId: 't-9', lastInboundAt: '2026-07-15T00:00:00.000Z',
    });
    expect(generateReplyBody).toHaveBeenCalled();
    // The grounding query is scoped to the account.
    expect(listEvents).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acct-a', threadId: 't-9' }));
    // The stored draft key is account-namespaced.
    expect(createDraft).toHaveBeenCalledWith(expect.objectContaining({ conversationKey: 'thread:acct-a:t-9' }));
    expect(result.draft).toBeDefined();
  });

  it('prefers the chat handle over a person email in the review-only recipient', async () => {
    getPerson.mockResolvedValue({ id: 'p1', name: 'Alex', phones: [], emails: ['alex@example.com'] });
    listEvents.mockResolvedValue([
      { kind: 'message.received', happenedAt: '2026-07-15T00:00:00.000Z', summary: 'hi' },
    ]);
    await generateOutreachDraft({ personId: 'p1', source: 'imessage', chatGuid: 'chat-1', handle: '+15559999' });
    expect(createDraft).toHaveBeenCalledWith(expect.objectContaining({ to: ['+15559999'] }));
  });
});

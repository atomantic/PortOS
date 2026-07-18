import { describe, it, expect, vi, beforeEach } from 'vitest';

import { groupUnansweredThreads, generateOutreachDraft } from './tribeOutreach.js';

// generateOutreachDraft dynamically imports these — mock them so the draft-side
// logic (idempotent reuse, anchoring the reply to the detected inbound) is
// testable without a DB or a live LLM.
vi.mock('./tribe.js', () => ({ getPerson: vi.fn() }));
vi.mock('./humanActivity.js', () => ({ listEvents: vi.fn() }));
vi.mock('./messageEvaluator.js', () => ({ generateReplyBody: vi.fn() }));
vi.mock('./messageDrafts.js', () => ({ createDraft: vi.fn(), listDrafts: vi.fn() }));

import { getPerson } from './tribe.js';
import { listEvents } from './humanActivity.js';
import { generateReplyBody } from './messageEvaluator.js';
import { createDraft, listDrafts } from './messageDrafts.js';

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
      { kind: 'message.received', source: 'gmail', personId: 'p1', personName: 'Alex', ring: 'tribe',
        happenedAt: daysAgo(4), summary: 'proposal attached', metadata: { threadId: 't-9' } },
      { kind: 'message.sent', source: 'gmail', happenedAt: daysAgo(3), metadata: { threadId: 't-9' } },
    ], WINDOW);
    expect(out).toHaveLength(0); // replied within the same email thread
  });

  it('drops events with unparseable timestamps without throwing', () => {
    const out = groupUnansweredThreads([inbound({ happenedAt: 'not-a-date' })], WINDOW);
    expect(out).toHaveLength(0);
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

  it('prefers the chat handle over a person email in the review-only recipient', async () => {
    getPerson.mockResolvedValue({ id: 'p1', name: 'Alex', phones: [], emails: ['alex@example.com'] });
    listEvents.mockResolvedValue([
      { kind: 'message.received', happenedAt: '2026-07-15T00:00:00.000Z', summary: 'hi' },
    ]);
    await generateOutreachDraft({ personId: 'p1', source: 'imessage', chatGuid: 'chat-1', handle: '+15559999' });
    expect(createDraft).toHaveBeenCalledWith(expect.objectContaining({ to: ['+15559999'] }));
  });
});

import { describe, it, expect } from 'vitest';
import {
  signalTimestampToDate,
  signalActivityKind,
  signalActivityCandidate,
  signalActivityCandidates,
  signalTouchpointCandidates,
} from './signalSync.js';

describe('signalSync pure helpers', () => {
  describe('signalTimestampToDate', () => {
    it('converts a millisecond epoch value', () => {
      const ms = Date.UTC(2024, 5, 1, 12, 0, 0);
      expect(signalTimestampToDate(ms).getTime()).toBe(ms);
    });
    it('accepts a bigint (node:sqlite may return BigInt)', () => {
      const ms = Date.UTC(2024, 0, 2, 3, 4, 5);
      expect(signalTimestampToDate(BigInt(ms)).getTime()).toBe(ms);
    });
    it('returns null for 0 / null / non-finite / negative', () => {
      expect(signalTimestampToDate(0)).toBeNull();
      expect(signalTimestampToDate(null)).toBeNull();
      expect(signalTimestampToDate(undefined)).toBeNull();
      expect(signalTimestampToDate(-5)).toBeNull();
      expect(signalTimestampToDate('nope')).toBeNull();
    });
  });

  describe('signalActivityKind', () => {
    it('maps outgoing/incoming to sent/received', () => {
      expect(signalActivityKind('outgoing')).toBe('message.sent');
      expect(signalActivityKind('incoming')).toBe('message.received');
    });
    it('falls back to the direction flag when type is absent', () => {
      expect(signalActivityKind('', true)).toBe('message.sent');
      expect(signalActivityKind(null, false)).toBe('message.received');
    });
    it('skips non-message types (call-history, group updates, etc.)', () => {
      expect(signalActivityKind('call-history')).toBeNull();
      expect(signalActivityKind('group-v2-change')).toBeNull();
      expect(signalActivityKind('verified-change')).toBeNull();
    });
  });

  describe('signalActivityCandidate', () => {
    const base = {
      messageId: 'abc-123',
      rowid: 42,
      at: new Date('2024-06-01T12:00:00Z'),
      text: 'hey there, long time',
      type: 'incoming',
      conversationId: 'conv-1',
      conversationName: 'Jane Doe',
      handles: ['+15551234567'],
    };

    it('maps an incoming message to a message.received activity event', () => {
      const c = signalActivityCandidate(base);
      expect(c).toMatchObject({
        source: 'signal',
        kind: 'message.received',
        happenedAt: '2024-06-01T12:00:00.000Z',
        title: 'Jane Doe',
        dedupeKey: 'signal:abc-123',
      });
      expect(c.participants).toEqual([{ phone: '+15551234567' }]);
      expect(c.metadata.conversationId).toBe('conv-1');
      expect(c.metadata.rowid).toBe(42);
    });

    it('maps an outgoing message to message.sent and drops the counterpart handle from the title', () => {
      const c = signalActivityCandidate({ ...base, type: 'outgoing', conversationName: '' });
      expect(c.kind).toBe('message.sent');
      // No conversation name + outgoing → counterpart is empty → title falls back.
      expect(c.title).toBe('Signal');
      expect(c.metadata.handle).toBeNull();
    });

    it('returns null for messages without an id, a bad date, or a skipped type', () => {
      expect(signalActivityCandidate({ ...base, messageId: '' })).toBeNull();
      expect(signalActivityCandidate({ ...base, at: new Date('nope') })).toBeNull();
      expect(signalActivityCandidate({ ...base, type: 'call-history', isFromMe: undefined })).toBeNull();
    });

    it('summarizes long bodies (metadata + short summary, not full body)', () => {
      const long = 'x'.repeat(500);
      const c = signalActivityCandidate({ ...base, text: long });
      expect(c.summary.length).toBeLessThanOrEqual(161);
    });
  });

  describe('signalActivityCandidates', () => {
    it('filters out unmappable rows', () => {
      const out = signalActivityCandidates([
        { messageId: 'a', rowid: 1, at: new Date('2024-06-01T00:00:00Z'), type: 'incoming', conversationId: 'c', handles: ['+15550000000'] },
        { messageId: '', rowid: 2, at: new Date('2024-06-01T00:00:00Z'), type: 'incoming', conversationId: 'c' },
        { messageId: 'b', rowid: 3, at: new Date('2024-06-01T00:00:00Z'), type: 'call-history', conversationId: 'c' },
      ]);
      expect(out).toHaveLength(1);
      expect(out[0].dedupeKey).toBe('signal:a');
    });
  });

  describe('signalTouchpointCandidates', () => {
    const tz = 'America/Los_Angeles';

    it('groups a busy thread into one touchpoint per conversation per local day', () => {
      const messages = [
        { messageId: 'm1', at: new Date('2024-06-01T18:00:00Z'), conversationId: 'conv-1', conversationName: 'Jane', handles: ['+15551234567'] },
        { messageId: 'm2', at: new Date('2024-06-01T19:30:00Z'), conversationId: 'conv-1', conversationName: 'Jane', handles: ['+15551234567'] },
        { messageId: 'm3', at: new Date('2024-06-02T20:00:00Z'), conversationId: 'conv-1', conversationName: 'Jane', handles: ['+15551234567'] },
      ];
      const out = signalTouchpointCandidates(messages, tz);
      expect(out).toHaveLength(2); // two distinct local days
      expect(out.every((t) => t.source === 'signal' && t.channel === 'Signal')).toBe(true);
      // Latest instant of the day is retained.
      const day1 = out.find((t) => t.dedupeKey.endsWith(':2024-06-01'));
      expect(day1.happenedAt).toBe('2024-06-01T19:30:00.000Z');
      expect(day1.identities).toEqual([{ phone: '+15551234567' }]);
    });

    it('skips conversations with no matchable handle', () => {
      const out = signalTouchpointCandidates([
        { messageId: 'm1', at: new Date('2024-06-01T18:00:00Z'), conversationId: 'group-1', conversationName: 'A Group', handles: [] },
      ], tz);
      expect(out).toHaveLength(0);
    });

    it('skips messages missing a conversationId or a valid date', () => {
      const out = signalTouchpointCandidates([
        { messageId: 'm1', at: new Date('2024-06-01T18:00:00Z'), conversationId: null, handles: ['+15551234567'] },
        { messageId: 'm2', at: new Date('bad'), conversationId: 'c', handles: ['+15551234567'] },
      ], tz);
      expect(out).toHaveLength(0);
    });
  });
});

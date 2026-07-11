import { describe, it, expect } from 'vitest';
import {
  encodeChatKey,
  decodeChatKey,
  blocklistKey,
  isHandleBlocked,
  filterBlockedActivityCandidates,
  filterBlockedTouchpointCandidates,
} from './imessageManage.js';

describe('imessageManage pure helpers', () => {
  describe('encodeChatKey / decodeChatKey', () => {
    it('round-trips an Apple chat GUID', () => {
      const guid = 'iMessage;-;+15551234567';
      const key = encodeChatKey(guid);
      expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeChatKey(key)).toBe(guid);
    });

    it('round-trips group chat GUIDs with special chars', () => {
      const guid = 'iMessage;+;chat1234567890';
      expect(decodeChatKey(encodeChatKey(guid))).toBe(guid);
    });

    it('maps empty chatGuid to a stable non-empty path key', () => {
      expect(encodeChatKey('')).toBe('_');
      expect(encodeChatKey(null)).toBe('_');
      expect(decodeChatKey('_')).toBe('');
      expect(decodeChatKey('')).toBeNull();
      expect(decodeChatKey(null)).toBeNull();
    });
  });

  describe('blocklistKey', () => {
    it('normalizes phone variants to E.164-ish', () => {
      expect(blocklistKey('+1 555 123 4567')).toBe('+15551234567');
      expect(blocklistKey('5551234567')).toBe('+15551234567');
      expect(blocklistKey('15551234567')).toBe('+15551234567');
    });

    it('lowercases emails', () => {
      expect(blocklistKey('Spam@Example.COM')).toBe('spam@example.com');
    });

    it('returns empty for blank handles', () => {
      expect(blocklistKey('')).toBe('');
      expect(blocklistKey(null)).toBe('');
    });
  });

  describe('isHandleBlocked / filterBlocked*', () => {
    const blocked = new Set(['+15551234567', 'spam@example.com']);

    it('matches normalized phone and email', () => {
      expect(isHandleBlocked('+1 (555) 123-4567', blocked)).toBe(true);
      expect(isHandleBlocked('spam@example.com', blocked)).toBe(true);
      expect(isHandleBlocked('+19998887777', blocked)).toBe(false);
    });

    it('filters activity candidates by metadata.handle', () => {
      const candidates = [
        { dedupeKey: 'a', metadata: { handle: '+15551234567' }, participants: [] },
        { dedupeKey: 'b', metadata: { handle: '+19998887777' }, participants: [] },
        { dedupeKey: 'c', metadata: { handle: '' }, participants: [{ phone: '+15551234567' }] },
      ];
      const { kept, skipped } = filterBlockedActivityCandidates(candidates, blocked);
      expect(skipped).toBe(2); // a by handle, c all participants blocked
      expect(kept.map((c) => c.dedupeKey)).toEqual(['b']);
    });

    it('keeps from-me / empty when no blocked participants', () => {
      const candidates = [
        { dedupeKey: 'me', metadata: { handle: '' }, participants: [{ phone: '+19998887777' }] },
      ];
      const { kept, skipped } = filterBlockedActivityCandidates(candidates, blocked);
      expect(skipped).toBe(0);
      expect(kept).toHaveLength(1);
    });

    it('filters touchpoints only when every identity is blocked', () => {
      const candidates = [
        { identities: [{ phone: '+15551234567' }], dedupeKey: 't1' },
        { identities: [{ phone: '+15551234567' }, { phone: '+19998887777' }], dedupeKey: 't2' },
      ];
      const { kept, skipped } = filterBlockedTouchpointCandidates(candidates, blocked);
      expect(skipped).toBe(1);
      expect(kept.map((c) => c.dedupeKey)).toEqual(['t2']);
    });

    it('is a no-op with an empty blocklist', () => {
      const candidates = [{ dedupeKey: 'x', metadata: { handle: '+15551234567' } }];
      expect(filterBlockedActivityCandidates(candidates, new Set()).kept).toHaveLength(1);
      expect(filterBlockedActivityCandidates(candidates, null).kept).toHaveLength(1);
    });
  });
});

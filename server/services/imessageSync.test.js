import { describe, it, expect } from 'vitest';
import {
  appleDateToDate,
  decodeAttributedBody,
  resolveMessageText,
  imessageActivityCandidate,
  imessageActivityCandidates,
  imessageTouchpointCandidates,
} from './imessageSync.js';

// Milliseconds between the Unix epoch and the Apple/Cocoa epoch (2001-01-01 UTC).
const APPLE_EPOCH_OFFSET_MS = 978307200000;

// Build a minimal typedstream-ish attributedBody blob the decoder understands:
// some preamble, the "NSString" class marker, a '+' start-of-value marker, then a
// length prefix + UTF-8 payload. `len < 0x80` uses the single-byte form; larger
// strings use the 0x81 uint16-LE form.
function makeAttributedBody(text) {
  const payload = Buffer.from(text, 'utf8');
  const preamble = Buffer.from('streamtyped\x81\xe8\x03\x84\x01\x40\x84\x84\x84NSString\x01\x94\x84\x01\x2b', 'latin1');
  let lenBytes;
  if (payload.length < 0x80) {
    lenBytes = Buffer.from([payload.length]);
  } else {
    lenBytes = Buffer.from([0x81, payload.length & 0xff, (payload.length >> 8) & 0xff]);
  }
  return Buffer.concat([preamble, lenBytes, payload, Buffer.from('\x86', 'latin1')]);
}

describe('imessageSync pure helpers', () => {
  describe('appleDateToDate', () => {
    const known = Date.UTC(2021, 0, 1, 0, 0, 0); // 2021-01-01T00:00:00Z
    const appleSeconds = (known - APPLE_EPOCH_OFFSET_MS) / 1000;

    it('converts modern nanosecond values (ns since 2001)', () => {
      const ns = appleSeconds * 1e9;
      const d = appleDateToDate(ns);
      expect(d).toBeInstanceOf(Date);
      expect(d.getTime()).toBe(known);
    });
    it('converts legacy second values (s since 2001)', () => {
      const d = appleDateToDate(appleSeconds);
      expect(d.getTime()).toBe(known);
    });
    it('handles a decimal STRING value (the runtime shape — date is CAST to TEXT in SQL)', () => {
      // node:sqlite refuses to return the >2^53 ns integer as a number, so the
      // query CASTs it to TEXT; appleDateToDate must parse that decimal string.
      const d = appleDateToDate(String(appleSeconds * 1e9));
      expect(d.getTime()).toBe(known);
      expect(appleDateToDate(String(appleSeconds))).toEqual(new Date(known)); // legacy seconds as string
    });
    it('handles a bigint nanosecond value (node:sqlite may return BigInt)', () => {
      const d = appleDateToDate(BigInt(Math.round(appleSeconds)) * 1000000000n);
      // second-level accuracy is all we need
      expect(Math.round(d.getTime() / 1000)).toBe(Math.round(known / 1000));
    });
    it('returns null for 0 / null / non-finite', () => {
      expect(appleDateToDate(0)).toBeNull();
      expect(appleDateToDate(null)).toBeNull();
      expect(appleDateToDate(undefined)).toBeNull();
      expect(appleDateToDate(NaN)).toBeNull();
      expect(appleDateToDate('not a number')).toBeNull();
    });
  });

  describe('decodeAttributedBody', () => {
    it('extracts a short single-byte-length string', () => {
      expect(decodeAttributedBody(makeAttributedBody('hello world'))).toBe('hello world');
    });
    it('extracts a long string via the 0x81 uint16-LE length prefix', () => {
      const long = 'x'.repeat(300);
      expect(decodeAttributedBody(makeAttributedBody(long))).toBe(long);
    });
    it('extracts UTF-8 multibyte content', () => {
      expect(decodeAttributedBody(makeAttributedBody('café ☕️ 日本語'))).toBe('café ☕️ 日本語');
    });
    it('returns null when the blob has no NSString marker (parse failure)', () => {
      expect(decodeAttributedBody(Buffer.from('garbage-without-marker'))).toBeNull();
    });
    it('returns null for empty / nullish input', () => {
      expect(decodeAttributedBody(Buffer.alloc(0))).toBeNull();
      expect(decodeAttributedBody(null)).toBeNull();
      expect(decodeAttributedBody(undefined)).toBeNull();
    });
  });

  describe('resolveMessageText', () => {
    it('prefers the plain text column when present', () => {
      expect(resolveMessageText({ text: 'plain body', attributedBody: makeAttributedBody('archived') }))
        .toEqual({ text: 'plain body', decodeFailed: false });
    });
    it('falls back to a decoded attributedBody when text is NULL', () => {
      expect(resolveMessageText({ text: null, attributedBody: makeAttributedBody('archived') }))
        .toEqual({ text: 'archived', decodeFailed: false });
    });
    it('flags decodeFailed when text is NULL and the blob is unparseable', () => {
      const r = resolveMessageText({ text: null, attributedBody: Buffer.from('no-marker-here') });
      expect(r.text).toBe('');
      expect(r.decodeFailed).toBe(true);
    });
    it('is not a failure when there is neither text nor attributedBody', () => {
      expect(resolveMessageText({ text: null, attributedBody: null }))
        .toEqual({ text: '', decodeFailed: false });
    });
  });

  describe('imessageActivityCandidate', () => {
    const at = new Date('2024-03-10T15:30:00.000Z');
    const base = {
      guid: 'ABC-123',
      rowid: 42,
      at,
      text: 'hey there',
      chatGuid: 'iMessage;-;+15551234567',
      chatName: 'Grace',
      service: 'iMessage',
      handle: '+15551234567',
      participants: ['+15551234567'],
    };

    it('maps a received message with the imsg:<guid> dedupe key', () => {
      const c = imessageActivityCandidate({ ...base, isFromMe: false });
      expect(c.source).toBe('imessage');
      expect(c.kind).toBe('message.received');
      expect(c.dedupeKey).toBe('imsg:ABC-123');
      expect(c.happenedAt).toBe(at.toISOString());
      expect(c.participants).toEqual([{ phone: '+15551234567' }]);
      expect(c.metadata.chatGuid).toBe('iMessage;-;+15551234567');
    });
    it('maps a sent message to message.sent', () => {
      const c = imessageActivityCandidate({ ...base, isFromMe: true, handle: '' });
      expect(c.kind).toBe('message.sent');
    });
    it('returns null when guid or timestamp is missing/invalid', () => {
      expect(imessageActivityCandidate({ ...base, guid: '' })).toBeNull();
      expect(imessageActivityCandidate({ ...base, at: new Date('nope') })).toBeNull();
      expect(imessageActivityCandidate(null)).toBeNull();
    });
    it('imessageActivityCandidates filters out invalid rows', () => {
      const list = imessageActivityCandidates([
        { ...base, isFromMe: false },
        { ...base, guid: '' },
      ]);
      expect(list).toHaveLength(1);
    });
  });

  describe('imessageTouchpointCandidates', () => {
    const tz = 'America/New_York';
    // Both instants fall on 2024-03-10 in America/New_York.
    const m1 = {
      guid: 'g1', at: new Date('2024-03-10T14:00:00.000Z'), chatGuid: 'chat-A',
      chatName: 'Grace', isFromMe: false, handle: '+15551234567', participants: ['+15551234567'],
    };
    const m2 = {
      guid: 'g2', at: new Date('2024-03-10T18:00:00.000Z'), chatGuid: 'chat-A',
      chatName: 'Grace', isFromMe: true, handle: '', participants: ['+15551234567'],
    };
    // Next local day, same chat.
    const m3 = {
      guid: 'g3', at: new Date('2024-03-12T02:00:00.000Z'), chatGuid: 'chat-A',
      chatName: 'Grace', isFromMe: false, handle: '+15551234567', participants: ['+15551234567'],
    };

    it('collapses a chat/day to ONE touchpoint with imsg:<chatGuid>:<localDay>', () => {
      const out = imessageTouchpointCandidates([m1, m2], tz);
      expect(out).toHaveLength(1);
      expect(out[0].dedupeKey).toBe('imsg:chat-A:2024-03-10');
      expect(out[0].source).toBe('imessage');
      expect(out[0].channel).toBe('iMessage');
      expect(out[0].identities).toEqual([{ phone: '+15551234567' }]);
      // happenedAt is the latest instant within the day.
      expect(out[0].happenedAt).toBe(m2.at.toISOString());
    });
    it('emits a separate touchpoint per local day', () => {
      const out = imessageTouchpointCandidates([m1, m3], tz);
      const keys = out.map((c) => c.dedupeKey).sort();
      expect(keys).toEqual(['imsg:chat-A:2024-03-10', 'imsg:chat-A:2024-03-11']);
    });
    it('drops entries with no resolvable participant handles', () => {
      const out = imessageTouchpointCandidates([{ ...m1, participants: [] }], tz);
      expect(out).toHaveLength(0);
    });
    it('skips rows without a chatGuid or a valid timestamp', () => {
      const out = imessageTouchpointCandidates([
        { ...m1, chatGuid: null },
        { ...m1, at: new Date('bad') },
      ], tz);
      expect(out).toHaveLength(0);
    });
  });
});

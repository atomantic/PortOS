import { describe, it, expect } from 'vitest';
import {
  parseWhatsappChat,
  detectDateOrder,
  whatsappMessageToCandidate,
  whatsappActivityCandidates,
  summarizeWhatsappCandidates,
  deriveChatTitle,
  normalizeChatScope,
} from './whatsappImport.js';

// A UTC timezone keeps the offset-less-local → instant resolution deterministic
// in the assertions below (WhatsApp timestamps carry no offset).
const UTC = 'UTC';

// Representative iOS-style export (bracketed, 12h clock, seconds).
const iosChat = [
  '[2024-01-15, 6:30:45 PM] Alice: hey there',
  '[2024-01-15, 6:31:00 PM] Bob: hi! how are you?',
  'this is a second line of the same message',
  '[2024-01-15, 6:32:10 PM] Alice: ‎<attached: 00000042-PHOTO-2024-01-15.jpg>',
].join('\n');

// Representative Android-style export (dash separator, no brackets/seconds).
const androidChat = [
  '1/15/24, 6:30 PM - Messages to this chat are now end-to-end encrypted.',
  '1/15/24, 6:30 PM - Alice: morning',
  '1/15/24, 6:45 PM - Bob: <Media omitted>',
].join('\n');

describe('parseWhatsappChat', () => {
  it('parses iOS bracketed lines with a 12h clock and seconds', () => {
    const msgs = parseWhatsappChat(iosChat);
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toMatchObject({ sender: 'Alice', body: 'hey there', hour24: 18, minute: 30, second: 45, isSystem: false });
  });

  it('folds continuation lines into the preceding message body', () => {
    const msgs = parseWhatsappChat(iosChat);
    expect(msgs[1].sender).toBe('Bob');
    expect(msgs[1].body).toBe('hi! how are you?\nthis is a second line of the same message');
  });

  it('strips bidi marks from media placeholders', () => {
    const msgs = parseWhatsappChat(iosChat);
    expect(msgs[2].body).toBe('<attached: 00000042-PHOTO-2024-01-15.jpg>');
  });

  it('parses Android dash-separated lines and flags system notices', () => {
    const msgs = parseWhatsappChat(androidChat);
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toMatchObject({ isSystem: true, sender: null });
    expect(msgs[1]).toMatchObject({ sender: 'Alice', body: 'morning', hour24: 18, minute: 30 });
    expect(msgs[2]).toMatchObject({ sender: 'Bob', body: '<Media omitted>' });
  });

  it('converts 12 AM/PM edge hours correctly', () => {
    const msgs = parseWhatsappChat([
      '[2024-01-15, 12:00:00 AM] A: midnight',
      '[2024-01-15, 12:00:00 PM] A: noon',
    ].join('\n'));
    expect(msgs[0].hour24).toBe(0);
    expect(msgs[1].hour24).toBe(12);
  });

  it('returns [] for empty input', () => {
    expect(parseWhatsappChat('')).toEqual([]);
  });
});

describe('detectDateOrder', () => {
  it('detects year-first from a 4-digit leading group', () => {
    expect(detectDateOrder(parseWhatsappChat('[2024-01-15, 6:30:00 PM] A: x'))).toBe('ymd');
  });
  it('detects day-first when a first group exceeds 12', () => {
    expect(detectDateOrder(parseWhatsappChat('15/01/24, 6:30 PM - A: x'))).toBe('dmy');
  });
  it('detects month-first when a second group exceeds 12', () => {
    expect(detectDateOrder(parseWhatsappChat('1/15/24, 6:30 PM - A: x'))).toBe('mdy');
  });
  it('defaults to month-first when fully ambiguous', () => {
    expect(detectDateOrder(parseWhatsappChat('1/2/24, 6:30 PM - A: x'))).toBe('mdy');
  });
});

describe('whatsappMessageToCandidate', () => {
  const [msg] = parseWhatsappChat('[2024-01-15, 6:30:45 PM] Alice: hey there');

  it('maps a message to a neutral message activity candidate in the given tz', () => {
    const c = whatsappMessageToCandidate(msg, { order: 'ymd', chatTitle: 'Alice', timezone: UTC });
    expect(c).toMatchObject({
      source: 'whatsapp',
      kind: 'message',
      happenedAt: '2024-01-15T18:30:45.000Z',
      title: 'WhatsApp: Alice',
    });
    expect(c.summary).toBe('hey there');
    expect(c.participants).toEqual([{ name: 'Alice' }]);
    expect(c.metadata).toMatchObject({ chatTitle: 'Alice', sender: 'Alice', hasMedia: false, dateOrder: 'ymd' });
  });

  it('interprets the offset-less local time in the user timezone', () => {
    const c = whatsappMessageToCandidate(msg, { order: 'ymd', timezone: 'America/New_York' });
    // 6:30:45 PM EST (UTC-5) → 23:30:45 UTC.
    expect(c.happenedAt).toBe('2024-01-15T23:30:45.000Z');
  });

  it('builds a stable dedupe key that changes with content', () => {
    const c1 = whatsappMessageToCandidate(msg, { order: 'ymd', chatTitle: 'Alice', timezone: UTC });
    const c2 = whatsappMessageToCandidate(msg, { order: 'ymd', chatTitle: 'Alice', timezone: UTC });
    expect(c1.dedupeKey).toBe(c2.dedupeKey);
    expect(c1.dedupeKey).toMatch(/^whatsapp:[0-9a-f]{24}$/);
    const [other] = parseWhatsappChat('[2024-01-15, 6:30:45 PM] Alice: different body');
    expect(whatsappMessageToCandidate(other, { order: 'ymd', chatTitle: 'Alice', timezone: UTC }).dedupeKey)
      .not.toBe(c1.dedupeKey);
  });

  it('keys the dedupe hash independent of chatTitle so upload method does not double-count', () => {
    // Importing `WhatsApp Chat - Alice.zip` (chatTitle "Alice") then the bare
    // `_chat.txt` extracted from it (chatTitle null) must produce the SAME key for
    // the same message, or the whole conversation re-imports as duplicates.
    const zipped = whatsappMessageToCandidate(msg, { order: 'ymd', chatTitle: 'Alice', timezone: UTC });
    const bare = whatsappMessageToCandidate(msg, { order: 'ymd', chatTitle: null, timezone: UTC });
    expect(zipped.dedupeKey).toBe(bare.dedupeKey);
  });

  it('flags a media-only body and shows a placeholder summary', () => {
    const [media] = parseWhatsappChat('[2024-01-15, 6:30:45 PM] Bob: <Media omitted>');
    const c = whatsappMessageToCandidate(media, { order: 'ymd', timezone: UTC });
    expect(c.metadata.hasMedia).toBe(true);
    expect(c.summary).toBe('<Media omitted>');
  });

  it('does not mis-flag a normal message that merely contains the word "omitted"', () => {
    const [normal] = parseWhatsappChat('[2024-01-15, 6:30:45 PM] Bob: I omitted that detail on purpose');
    const c = whatsappMessageToCandidate(normal, { order: 'ymd', timezone: UTC });
    expect(c.metadata.hasMedia).toBe(false);
    expect(c.summary).toBe('I omitted that detail on purpose');
  });

  it('drops system notices and messages with no sender', () => {
    const [sys] = parseWhatsappChat('1/15/24, 6:30 PM - Messages are end-to-end encrypted.');
    expect(whatsappMessageToCandidate(sys, { timezone: UTC })).toBeNull();
    expect(whatsappMessageToCandidate(null, { timezone: UTC })).toBeNull();
  });

  it('stays a neutral message with no direction when no yourName is given', () => {
    const c = whatsappMessageToCandidate(msg, { order: 'ymd', timezone: UTC });
    expect(c.kind).toBe('message');
    expect(c.metadata.direction).toBeNull();
  });

  it('classifies a sender matching yourName as message.sent (case/space-insensitive)', () => {
    const c = whatsappMessageToCandidate(msg, { order: 'ymd', timezone: UTC, yourName: '  alice ' });
    expect(c.kind).toBe('message.sent');
    expect(c.metadata.direction).toBe('sent');
  });

  it('classifies a non-matching sender as message.received', () => {
    const c = whatsappMessageToCandidate(msg, { order: 'ymd', timezone: UTC, yourName: 'Bob' });
    expect(c.kind).toBe('message.received');
    expect(c.metadata.direction).toBe('received');
  });

  it('keeps the dedupe key independent of direction so re-import with a name is a no-op', () => {
    const neutral = whatsappMessageToCandidate(msg, { order: 'ymd', timezone: UTC });
    const sent = whatsappMessageToCandidate(msg, { order: 'ymd', timezone: UTC, yourName: 'Alice' });
    expect(sent.dedupeKey).toBe(neutral.dedupeKey);
  });

  it('leaves the dedupe key byte-identical to the legacy key when no chatScope is given', () => {
    const withNullScope = whatsappMessageToCandidate(msg, { order: 'ymd', timezone: UTC, chatScope: null });
    const withBlankScope = whatsappMessageToCandidate(msg, { order: 'ymd', timezone: UTC, chatScope: '   ' });
    const legacy = whatsappMessageToCandidate(msg, { order: 'ymd', timezone: UTC });
    expect(withNullScope.dedupeKey).toBe(legacy.dedupeKey);
    expect(withBlankScope.dedupeKey).toBe(legacy.dedupeKey);
    expect(legacy.metadata.chatScope).toBeNull();
  });

  it('scopes the dedupe key by chatScope so distinct chats do not collide', () => {
    const unscoped = whatsappMessageToCandidate(msg, { order: 'ymd', timezone: UTC });
    const family = whatsappMessageToCandidate(msg, { order: 'ymd', timezone: UTC, chatScope: 'Family group' });
    const work = whatsappMessageToCandidate(msg, { order: 'ymd', timezone: UTC, chatScope: 'Work chat' });
    // Same message, different chat scopes → three distinct dedupe keys.
    expect(family.dedupeKey).not.toBe(unscoped.dedupeKey);
    expect(work.dedupeKey).not.toBe(unscoped.dedupeKey);
    expect(family.dedupeKey).not.toBe(work.dedupeKey);
    expect(family.metadata.chatScope).toBe('family group');
  });

  it('normalizes chatScope (case/space-insensitive) so a chat labels stably across imports', () => {
    const a = whatsappMessageToCandidate(msg, { order: 'ymd', timezone: UTC, chatScope: 'Family Group' });
    const b = whatsappMessageToCandidate(msg, { order: 'ymd', timezone: UTC, chatScope: '  family group ' });
    expect(a.dedupeKey).toBe(b.dedupeKey);
  });
});

describe('whatsappActivityCandidates', () => {
  it('detects the order once and maps every non-system message', () => {
    const out = whatsappActivityCandidates(parseWhatsappChat(androidChat), { chatTitle: 'Alice', timezone: UTC });
    // 3 lines: 1 system (dropped) + 2 real messages.
    expect(out).toHaveLength(2);
    expect(out.every((c) => c.source === 'whatsapp' && c.kind === 'message')).toBe(true);
    expect(out.every((c) => c.metadata.dateOrder === 'mdy')).toBe(true);
  });
  it('classifies direction across the batch when yourName is supplied', () => {
    const out = whatsappActivityCandidates(parseWhatsappChat(androidChat), { timezone: UTC, yourName: 'Alice' });
    const alice = out.find((c) => c.metadata.sender === 'Alice');
    const bob = out.find((c) => c.metadata.sender === 'Bob');
    expect(alice.kind).toBe('message.sent');
    expect(bob.kind).toBe('message.received');
  });
  it('threads chatScope through the batch so the same messages key apart per chat', () => {
    const msgs = parseWhatsappChat(androidChat);
    const chatA = whatsappActivityCandidates(msgs, { timezone: UTC, chatScope: 'Chat A' });
    const chatB = whatsappActivityCandidates(msgs, { timezone: UTC, chatScope: 'Chat B' });
    const unscoped = whatsappActivityCandidates(msgs, { timezone: UTC });
    expect(chatA.map((c) => c.dedupeKey)).not.toEqual(chatB.map((c) => c.dedupeKey));
    expect(chatA.map((c) => c.dedupeKey)).not.toEqual(unscoped.map((c) => c.dedupeKey));
    expect(chatA.every((c) => c.metadata.chatScope === 'chat a')).toBe(true);
  });
  it('returns [] for non-arrays', () => {
    expect(whatsappActivityCandidates(null)).toEqual([]);
    expect(whatsappActivityCandidates({})).toEqual([]);
  });
});

describe('summarizeWhatsappCandidates', () => {
  it('computes range, message count, unique senders, and top senders', () => {
    const candidates = whatsappActivityCandidates(parseWhatsappChat(iosChat), { chatTitle: 'Group', timezone: UTC });
    const s = summarizeWhatsappCandidates(candidates);
    expect(s.messages).toBe(3);
    expect(s.uniqueSenders).toBe(2);
    expect(s.from).toBe('2024-01-15T18:30:45.000Z');
    expect(s.to).toBe('2024-01-15T18:32:10.000Z');
    expect(s.topSenders[0]).toEqual({ name: 'Alice', count: 2 });
    expect(s.chatTitle).toBe('Group');
    expect(s.directionKnown).toBe(false);
  });
  it('tallies sent/received when direction is classified', () => {
    const candidates = whatsappActivityCandidates(parseWhatsappChat(iosChat), { timezone: UTC, yourName: 'Alice' });
    const s = summarizeWhatsappCandidates(candidates);
    expect(s.directionKnown).toBe(true);
    expect(s.sent).toBe(2); // Alice x2
    expect(s.received).toBe(1); // Bob x1
  });
  it('handles an empty batch', () => {
    const s = summarizeWhatsappCandidates([]);
    expect(s).toMatchObject({ messages: 0, uniqueSenders: 0, from: null, to: null, sent: 0, received: 0, directionKnown: false });
    expect(s.topSenders).toEqual([]);
  });
});

describe('deriveChatTitle', () => {
  it('extracts the contact/group name from a WhatsApp export filename', () => {
    expect(deriveChatTitle('WhatsApp Chat with Alice.txt')).toBe('Alice');
    expect(deriveChatTitle('WhatsApp Chat - Book Club.zip')).toBe('Book Club');
  });
  it('returns null for the anonymous in-zip _chat.txt', () => {
    expect(deriveChatTitle('_chat.txt')).toBeNull();
    expect(deriveChatTitle('')).toBeNull();
    expect(deriveChatTitle(null)).toBeNull();
  });
  it('falls back to the bare basename when no known prefix matches', () => {
    expect(deriveChatTitle('my-export.txt')).toBe('my-export');
  });
});

describe('normalizeChatScope', () => {
  it('trims and lower-cases a label so it is stable across casing/space', () => {
    expect(normalizeChatScope('  Family Group ')).toBe('family group');
    expect(normalizeChatScope('WORK')).toBe('work');
  });
  it('returns "" for a blank or non-string value (→ legacy un-scoped key)', () => {
    expect(normalizeChatScope('')).toBe('');
    expect(normalizeChatScope('   ')).toBe('');
    expect(normalizeChatScope(null)).toBe('');
    expect(normalizeChatScope(undefined)).toBe('');
    expect(normalizeChatScope(42)).toBe('');
  });
});

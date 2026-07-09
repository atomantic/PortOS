import { describe, it, expect } from 'vitest';
import {
  decodeMimeWords,
  parseAddressList,
  parseHeaderLines,
  headerValue,
  parseGmailLabels,
  resolveMboxInstant,
  cleanMessageId,
  gmailDirection,
  mboxMessageToCandidate,
  createMboxLineReader,
  parseMboxText,
} from './gmailMboxImport.js';

describe('gmailMboxImport — pure helpers', () => {
  describe('decodeMimeWords', () => {
    it('passes plain text through unchanged', () => {
      expect(decodeMimeWords('Hello world')).toBe('Hello world');
    });
    it('decodes a base64 (B) UTF-8 encoded word', () => {
      // "Héllo" as UTF-8 base64
      const enc = `=?UTF-8?B?${Buffer.from('Héllo', 'utf-8').toString('base64')}?=`;
      expect(decodeMimeWords(enc)).toBe('Héllo');
    });
    it('decodes a quoted-printable (Q) encoded word with _ as space', () => {
      expect(decodeMimeWords('=?UTF-8?Q?Hi_there=21?=')).toBe('Hi there!');
    });
    it('joins adjacent encoded words without the separating whitespace', () => {
      const a = `=?UTF-8?B?${Buffer.from('foo', 'utf-8').toString('base64')}?=`;
      const b = `=?UTF-8?B?${Buffer.from('bar', 'utf-8').toString('base64')}?=`;
      expect(decodeMimeWords(`${a} ${b}`)).toBe('foobar');
    });
    it('returns empty string for null/undefined', () => {
      expect(decodeMimeWords(null)).toBe('');
      expect(decodeMimeWords(undefined)).toBe('');
    });
  });

  describe('parseAddressList', () => {
    it('parses name + angle-bracket email', () => {
      expect(parseAddressList('Jane Doe <jane@example.com>')).toEqual([
        { name: 'Jane Doe', email: 'jane@example.com' },
      ]);
    });
    it('keeps a comma inside a quoted display name intact', () => {
      expect(parseAddressList('"Doe, John" <john@x.com>, jane@y.com')).toEqual([
        { name: 'Doe, John', email: 'john@x.com' },
        { email: 'jane@y.com' },
      ]);
    });
    it('lowercases the email and decodes an encoded display name', () => {
      const enc = `=?UTF-8?B?${Buffer.from('Björk', 'utf-8').toString('base64')}?=`;
      expect(parseAddressList(`${enc} <BJORK@Example.COM>`)).toEqual([
        { name: 'Björk', email: 'bjork@example.com' },
      ]);
    });
    it('drops tokens with no usable email', () => {
      expect(parseAddressList('Just A Name, real@x.com')).toEqual([{ email: 'real@x.com' }]);
    });
    it('returns [] for empty input', () => {
      expect(parseAddressList('')).toEqual([]);
    });
  });

  describe('parseHeaderLines + headerValue', () => {
    it('unfolds a folded header continuation line', () => {
      const headers = parseHeaderLines(['Subject: hello', '  world', 'From: a@b.com']);
      expect(headerValue(headers, 'subject')).toBe('hello world');
      expect(headerValue(headers, 'From')).toBe('a@b.com');
    });
    it('is case-insensitive and returns the first occurrence', () => {
      const headers = parseHeaderLines(['Received: one', 'Received: two']);
      expect(headerValue(headers, 'received')).toBe('one');
    });
    it('returns empty string for an absent header', () => {
      expect(headerValue(parseHeaderLines(['X: y']), 'z')).toBe('');
    });
  });

  describe('parseGmailLabels', () => {
    it('splits and trims a comma-separated label list', () => {
      expect(parseGmailLabels('Inbox, Important, Category Personal')).toEqual([
        'Inbox', 'Important', 'Category Personal',
      ]);
    });
    it('returns [] for empty input', () => {
      expect(parseGmailLabels('')).toEqual([]);
    });
  });

  describe('resolveMboxInstant', () => {
    it('parses an RFC-2822 date with explicit offset', () => {
      expect(resolveMboxInstant('Mon, 15 Jan 2024 18:30:45 -0800')).toBe('2024-01-16T02:30:45.000Z');
    });
    it('returns null for an unparseable date', () => {
      expect(resolveMboxInstant('not a date')).toBeNull();
      expect(resolveMboxInstant('')).toBeNull();
    });
  });

  describe('cleanMessageId', () => {
    it('strips surrounding angle brackets', () => {
      expect(cleanMessageId('<abc123@mail.gmail.com>')).toBe('abc123@mail.gmail.com');
    });
  });

  describe('gmailDirection', () => {
    it('is sent when the Gmail labels include Sent', () => {
      expect(gmailDirection(['Inbox', 'Sent'], 'x@y.com', [])).toBe('sent');
    });
    it('is sent when the From matches a self email even without the label', () => {
      expect(gmailDirection(['Inbox'], 'me@gmail.com', ['ME@gmail.com'])).toBe('sent');
    });
    it('defaults to received', () => {
      expect(gmailDirection(['Inbox'], 'friend@x.com', ['me@gmail.com'])).toBe('received');
    });
  });
});

describe('gmailMboxImport — mboxMessageToCandidate', () => {
  const headerLines = [
    'Message-ID: <abc@mail.gmail.com>',
    'Date: Mon, 15 Jan 2024 18:30:45 -0800',
    'Subject: Weekend plans',
    'From: Alice <alice@example.com>',
    'To: Me <me@gmail.com>, Bob <bob@example.com>',
    'X-Gmail-Labels: Inbox,Important',
    'X-GM-THRID: 99887766',
  ];

  it('maps a received message with metadata + no body', () => {
    const c = mboxMessageToCandidate(headerLines, { selfEmails: ['me@gmail.com'] });
    expect(c).toMatchObject({
      source: 'gmail',
      kind: 'message.received',
      happenedAt: '2024-01-16T02:30:45.000Z',
      title: 'Weekend plans',
      dedupeKey: 'gmail:abc@mail.gmail.com',
    });
    expect(c.metadata).toMatchObject({ messageId: 'abc@mail.gmail.com', threadId: '99887766', direction: 'received' });
    expect(c.metadata.labels).toEqual(['Inbox', 'Important']);
  });

  it('excludes the self email from participants', () => {
    const c = mboxMessageToCandidate(headerLines, { selfEmails: ['me@gmail.com'] });
    const emails = c.participants.map((p) => p.email);
    expect(emails).toContain('alice@example.com');
    expect(emails).toContain('bob@example.com');
    expect(emails).not.toContain('me@gmail.com');
  });

  it('classifies a Sent-labeled message as message.sent', () => {
    const sent = [
      'Message-ID: <sent1@mail.gmail.com>',
      'Date: Tue, 16 Jan 2024 09:00:00 +0000',
      'Subject: Re: Weekend plans',
      'From: Me <me@gmail.com>',
      'To: Alice <alice@example.com>',
      'X-Gmail-Labels: Sent',
    ];
    const c = mboxMessageToCandidate(sent, { selfEmails: [] });
    expect(c.kind).toBe('message.sent');
    expect(c.summary).toBe('To: Alice');
  });

  it('falls back to a content hash when Message-ID is absent', () => {
    const noId = headerLines.filter((l) => !l.startsWith('Message-ID'));
    const c = mboxMessageToCandidate(noId, { selfEmails: [] });
    expect(c.dedupeKey).toMatch(/^gmail:h:[0-9a-f]{24}$/);
    expect(c.metadata.messageId).toBeNull();
  });

  it('returns null when the Date header is missing/unparseable', () => {
    const noDate = ['From: a@b.com', 'Subject: hi'];
    expect(mboxMessageToCandidate(noDate, {})).toBeNull();
  });

  it('uses (no subject) when the Subject is empty', () => {
    const noSubject = ['Date: Mon, 15 Jan 2024 18:30:45 -0800', 'From: a@b.com'];
    expect(mboxMessageToCandidate(noSubject, {}).title).toBe('(no subject)');
  });
});

describe('gmailMboxImport — mbox stream state machine', () => {
  const MBOX = [
    'From 1234567890@xxx Mon Jan 15 18:30:45 2024',
    'Message-ID: <m1@mail.gmail.com>',
    'Date: Mon, 15 Jan 2024 18:30:45 -0800',
    'Subject: First',
    'From: Alice <alice@example.com>',
    'To: me@gmail.com',
    'X-Gmail-Labels: Inbox',
    '',
    'Body line one.',
    'From here it looks like a header but is body text.', // false "From " inside a body — must NOT split (no preceding blank)
    '',
    'From 9999@yyy Tue Jan 16 09:00:00 2024',
    'Message-ID: <m2@mail.gmail.com>',
    'Date: Tue, 16 Jan 2024 09:00:00 +0000',
    'Subject: Second',
    'From: me@gmail.com',
    'To: Bob <bob@example.com>',
    'X-Gmail-Labels: Sent',
    '',
    'Reply body.',
    '',
  ].join('\n');

  it('parses two messages and does not split on a body line starting with "From "', () => {
    const candidates = parseMboxText(MBOX, { selfEmails: ['me@gmail.com'] });
    expect(candidates).toHaveLength(2);
    expect(candidates[0].dedupeKey).toBe('gmail:m1@mail.gmail.com');
    expect(candidates[0].kind).toBe('message.received');
    expect(candidates[1].dedupeKey).toBe('gmail:m2@mail.gmail.com');
    expect(candidates[1].kind).toBe('message.sent');
  });

  it('createMboxLineReader flushes the final message on end()', () => {
    const seen = [];
    const reader = createMboxLineReader((h) => seen.push(h));
    ['From x', 'Subject: only', 'From: a@b.com'].forEach((l) => reader.push(l));
    expect(seen).toHaveLength(0); // not yet flushed
    reader.end();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(['Subject: only', 'From: a@b.com']);
  });

  it('splits a "From " line only after a blank line (mbox postmark rule)', () => {
    // A "From " line immediately after a non-blank body line is NOT a boundary.
    const text = [
      'From a Mon Jan 15 00:00:00 2024',
      'Date: Mon, 15 Jan 2024 00:00:00 +0000',
      'From: a@b.com',
      '',
      'body',
      'From b Tue Jan 16 00:00:00 2024', // preceded by non-blank "body" → NOT a split
    ].join('\n');
    expect(parseMboxText(text, {})).toHaveLength(1);
  });
});

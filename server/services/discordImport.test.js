import { describe, it, expect } from 'vitest';
import {
  resolveDiscordInstant,
  parseCsv,
  parseDiscordMessagesText,
  channelLabel,
  discordMessageToCandidate,
  discordActivityCandidates,
  summarizeDiscordCandidates,
} from './discordImport.js';

// A representative newer-export (messages.json) record.
const jsonRecord = {
  ID: '1103456789012345678',
  Timestamp: '2023-05-01T18:30:45.123+00:00',
  Contents: 'hey did you see the game last night?',
  Attachments: '',
};

// A guild channel context (channel.json).
const guildChannel = {
  id: '900000000000000001',
  type: 0,
  name: 'general',
  guild: { id: '800000000000000001', name: 'Dev Server' },
};

// A DM channel context.
const dmChannel = {
  id: '900000000000000002',
  type: 1,
  recipients: [{ username: 'alice' }, { username: 'bob' }],
};

describe('resolveDiscordInstant', () => {
  it('passes ISO-8601 timestamps with an offset straight through', () => {
    expect(resolveDiscordInstant('2023-05-01T18:30:45.123+00:00')).toBe('2023-05-01T18:30:45.123Z');
  });
  it('interprets legacy space-separated CSV timestamps as UTC (not OS-local)', () => {
    expect(resolveDiscordInstant('2023-05-01 18:30:45')).toBe('2023-05-01T18:30:45.000Z');
  });
  it('returns null for empty/unparseable values', () => {
    expect(resolveDiscordInstant('')).toBeNull();
    expect(resolveDiscordInstant(null)).toBeNull();
    expect(resolveDiscordInstant('not a date')).toBeNull();
  });
});

describe('parseCsv', () => {
  it('parses a header + rows into keyed objects', () => {
    const rows = parseCsv('ID,Timestamp,Contents,Attachments\n1,2023-05-01 18:30:45,hi,\n');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ ID: '1', Timestamp: '2023-05-01 18:30:45', Contents: 'hi', Attachments: '' });
  });
  it('handles quoted fields with embedded commas, quotes, and newlines', () => {
    const csv = 'ID,Contents\n1,"a, b, ""c""\nsecond line"\n';
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].Contents).toBe('a, b, "c"\nsecond line');
  });
  it('flushes a trailing row with no final newline', () => {
    const rows = parseCsv('ID,Contents\n1,hi');
    expect(rows).toHaveLength(1);
    expect(rows[0].ID).toBe('1');
  });
  it('returns [] for empty input', () => {
    expect(parseCsv('')).toEqual([]);
  });
});

describe('parseDiscordMessagesText', () => {
  it('parses a top-level JSON array', () => {
    expect(parseDiscordMessagesText(JSON.stringify([jsonRecord]))).toHaveLength(1);
  });
  it('unwraps a { messages: [...] } shape', () => {
    expect(parseDiscordMessagesText(JSON.stringify({ messages: [jsonRecord] }))).toHaveLength(1);
  });
  it('dispatches to CSV on a .csv entry path', () => {
    const rows = parseDiscordMessagesText('ID,Timestamp,Contents\n1,2023-01-01 00:00:00,hi\n', 'messages/c1/messages.csv');
    expect(rows).toHaveLength(1);
    expect(rows[0].Contents).toBe('hi');
  });
  it('dispatches to CSV on a leading ID, header even without a path', () => {
    const rows = parseDiscordMessagesText('ID,Timestamp\n1,2023-01-01 00:00:00\n');
    expect(rows).toHaveLength(1);
  });
  it('returns [] for a non-array/object JSON shape', () => {
    expect(parseDiscordMessagesText('42')).toEqual([]);
    expect(parseDiscordMessagesText('{"foo":1}')).toEqual([]);
  });
  it('throws on malformed JSON', () => {
    expect(() => parseDiscordMessagesText('{not json')).toThrow();
  });
});

describe('channelLabel', () => {
  it('labels a guild channel as "Guild — #channel"', () => {
    expect(channelLabel(guildChannel)).toBe('Dev Server — #general');
  });
  it('labels a DM by its recipients', () => {
    expect(channelLabel(dmChannel)).toBe('DM with alice, bob');
  });
  it('falls back to the channel name/id, then null', () => {
    expect(channelLabel({ name: 'lonely' })).toBe('lonely');
    expect(channelLabel({ id: '42' })).toBe('Channel 42');
    expect(channelLabel(null)).toBeNull();
  });
});

describe('discordMessageToCandidate', () => {
  it('maps a JSON record + guild channel to a message.sent candidate', () => {
    const c = discordMessageToCandidate(jsonRecord, guildChannel);
    expect(c).toMatchObject({
      source: 'discord',
      kind: 'message.sent',
      happenedAt: '2023-05-01T18:30:45.123Z',
      title: 'Dev Server — #general',
    });
    expect(c.summary).toBe('hey did you see the game last night?');
    expect(c.metadata).toMatchObject({
      messageId: '1103456789012345678',
      channelId: '900000000000000001',
      guildName: 'Dev Server',
      hasAttachments: false,
    });
  });

  it('builds a stable dedupe key from the message snowflake id', () => {
    const c1 = discordMessageToCandidate(jsonRecord, guildChannel);
    const c2 = discordMessageToCandidate({ ...jsonRecord }, dmChannel);
    // Same message id → same dedupe key regardless of channel context.
    expect(c1.dedupeKey).toBe('discord:1103456789012345678');
    expect(c1.dedupeKey).toBe(c2.dedupeKey);
  });

  it('carries DM recipients as participants', () => {
    const c = discordMessageToCandidate(jsonRecord, dmChannel);
    expect(c.participants).toEqual([{ name: 'alice' }, { name: 'bob' }]);
  });

  it('keeps an attachment-only message with a placeholder body', () => {
    const c = discordMessageToCandidate(
      { ID: '9', Timestamp: '2023-01-01 00:00:00', Contents: '', Attachments: 'https://cdn/x.png' },
      null,
    );
    expect(c.summary).toBe('(attachment)');
    expect(c.metadata.hasAttachments).toBe(true);
    expect(c.title).toBe('Discord message');
  });

  it('drops records with no id or no timestamp', () => {
    expect(discordMessageToCandidate({ Timestamp: '2023-01-01 00:00:00' })).toBeNull();
    expect(discordMessageToCandidate({ ID: '1' })).toBeNull();
    expect(discordMessageToCandidate(null)).toBeNull();
  });
});

describe('discordActivityCandidates', () => {
  it('maps a batch of { record, channel } intermediates and filters unmappable rows', () => {
    const out = discordActivityCandidates([
      { record: jsonRecord, channel: guildChannel },
      { record: { ID: '2' }, channel: null }, // no timestamp → dropped
      { record: { ID: '3', Timestamp: '2023-02-02 12:00:00', Contents: 'yo' }, channel: dmChannel },
    ]);
    expect(out).toHaveLength(2);
    expect(out.every((c) => c.source === 'discord' && c.kind === 'message.sent')).toBe(true);
  });
  it('returns [] for non-arrays', () => {
    expect(discordActivityCandidates(null)).toEqual([]);
    expect(discordActivityCandidates({})).toEqual([]);
  });
});

describe('summarizeDiscordCandidates', () => {
  it('computes range, message count, unique channels, and top channels', () => {
    const candidates = discordActivityCandidates([
      { record: jsonRecord, channel: guildChannel },
      { record: { ID: '2', Timestamp: '2022-01-01 09:00:00', Contents: 'earlier' }, channel: guildChannel },
      { record: { ID: '3', Timestamp: '2023-06-01 10:00:00', Contents: 'dm' }, channel: dmChannel },
    ]);
    const s = summarizeDiscordCandidates(candidates);
    expect(s.messages).toBe(3);
    expect(s.uniqueChannels).toBe(2);
    expect(s.from).toBe('2022-01-01T09:00:00.000Z');
    expect(s.to).toBe('2023-06-01T10:00:00.000Z');
    expect(s.topChannels[0]).toEqual({ name: 'Dev Server — #general', count: 2 });
  });
  it('handles an empty batch', () => {
    const s = summarizeDiscordCandidates([]);
    expect(s).toMatchObject({ messages: 0, uniqueChannels: 0, from: null, to: null });
    expect(s.topChannels).toEqual([]);
  });
});

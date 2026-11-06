import { describe, expect, it } from 'vitest';
import { parseNativeAgyMetadata } from './nativeAgyMetadata.js';
import { encodeMessage } from './protobufWire.js';

const v = no => ({ no, type: 'varint' });
const s = no => ({ no, type: 'string' });
const b = no => ({ no, type: 'bytes' });
const m = (no, schema) => ({ no, type: 'message', schema });
const TIME = { seconds: v(1), nanos: v(2) };
const USAGE = {
  model: v(1), input: v(2), output: v(3), cacheWrite: v(4), cacheRead: v(5), provider: v(6),
  message: s(7), headers: b(8), thinking: v(9), response: v(10), responseId: s(11), providerId: s(12),
};
const META = { created: m(1, TIME), completed: m(8, TIME), usage: m(9, USAGE), cost: b(10), generator: v(11), version: v(21), info: b(24), unknown: b(500) };
const parse = value => parseNativeAgyMetadata(encodeMessage(META, value));
const rawUsage = bytes => encodeMessage({ usage: b(9) }, { usage: Buffer.from(bytes) });
const reject = bytes => expect(() => parseNativeAgyMetadata(Buffer.from(bytes))).toThrow('Invalid native Antigravity metadata');

describe('native Antigravity v1 metadata projection', () => {
  it('projects the verified token fields without summing reasoning or inventing cost', () => {
    const result = parse({
      created: { seconds: 1700000000, nanos: 123456789 }, completed: { seconds: 1700000001 },
      generator: 999, usage: { model: 12345, provider: 678, input: 10, output: 5, cacheRead: 100,
        thinking: 3, response: 2, message: 'fake-message', responseId: 'fake-response', providerId: 'fake-provider' },
      cost: Buffer.from([255]), info: Buffer.from('PRIVATE CONTENT'), unknown: Buffer.from([255]),
    });
    expect(result).toEqual({ createdAt: '2023-11-14T22:13:20.123Z', completedAt: '2023-11-14T22:13:21.000Z',
      generationVersion: 0, usage: { model: 12345, apiProvider: 678, inputTokens: 10, outputTokens: 5,
        cacheWriteTokens: 0, cacheReadTokens: 100, thinkingOutputTokens: 3, responseOutputTokens: 2,
        messageId: 'fake-message', responseId: 'fake-response', providerMessageId: 'fake-provider' } });
  });

  it('distinguishes absent usage from a present zero-valued protobuf message', () => {
    expect(parse({})).toEqual({ createdAt: null, completedAt: null, generationVersion: 0, usage: null });
    expect(parse({ version: 0, usage: {} }).usage).toEqual({ model: 0, apiProvider: 0,
      inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0,
      thinkingOutputTokens: 0, responseOutputTokens: 0, messageId: null, responseId: null, providerMessageId: null });
    expect(parse({ usage: { model: -1, provider: -2, input: Number.MAX_SAFE_INTEGER } }).usage)
      .toMatchObject({ model: -1, apiProvider: -2, inputTokens: Number.MAX_SAFE_INTEGER });
  });

  it('skips unknown fields and sensitive nested bytes without decoding them', () => {
    const base = encodeMessage(META, { usage: { headers: Buffer.from([0xff]) }, info: Buffer.from([0xff]) });
    const unknown = Buffer.from([0xf0, 1, 1, 0xf9, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0x85, 2, 0, 0, 0, 0]);
    expect(parseNativeAgyMetadata(Buffer.concat([base, unknown]))).toEqual(parse({ usage: {} }));
  });

  it('preserves bounded opaque UTF8 identities for private hashing only', () => {
    expect(parse({ usage: { message: 'fake-識別子/🙂', responseId: 'x'.repeat(1024) } }).usage)
      .toMatchObject({ messageId: 'fake-識別子/🙂', responseId: 'x'.repeat(1024) });
    for (const message of ['', '  ', 'fake\nmessage', 'fake\0message', 'fake\u202emessage', 'x'.repeat(1025)]) {
      expect(() => parse({ usage: { message } })).toThrow();
    }
    reject(rawUsage([0x3a, 2, 0xc3, 0x28]));
  });

  it('refuses ambiguous singular fields and wrong known wire types at each level', () => {
    for (const bytes of [
      [0x4a, 0, 0x4a, 0], // duplicate usage
      [0xa8, 1, 0, 0xa8, 1, 0], // duplicate generation version
      [0x58, 0, 0x58, 0], // duplicate generator enum
      [0x48, 0], // usage with wrong wire
      [0x0a, 4, 8, 0, 8, 1], // duplicate timestamp seconds
      [0x0a, 2, 0x0a, 0], // timestamp seconds wrong wire
      [...rawUsage([0x10, 0, 0x10, 1])], // duplicate counter
      [...rawUsage([0x12, 0])], // counter wrong wire
      [...rawUsage([0x38, 0])], // identity wrong wire
    ]) reject(bytes);
  });

  it('rejects truncated, invalid and overflowing wire values including unknown fields', () => {
    for (const bytes of [
      [0], [0x80], [0x4a, 3, 0x10], [0xf3, 1], [0xf9, 1, 0], [0x85, 2, 0],
      [0xf0, 1, ...Array(9).fill(0xff), 2], // overflowing uint64 on unknown field
      [0x80, 0x80, 0x80, 0x80, 0x10, 0], // tag above uint32
      [...rawUsage([0x10, ...Array(10).fill(0x80)])],
    ]) reject(bytes);
    for (const input of [9007199254740992n, 18446744073709551615n, -1]) {
      expect(() => parse({ usage: { input } })).toThrow();
    }
    expect(() => parse({ usage: { model: 2147483648 } })).toThrow();
  });

  it('validates protobuf timestamps and refuses unsupported generation versions', () => {
    expect(parse({ created: {} }).createdAt).toBe('1970-01-01T00:00:00.000Z');
    expect(parse({ created: { seconds: -1, nanos: 999999999 } }).createdAt).toBe('1969-12-31T23:59:59.999Z');
    expect(parse({ created: { seconds: -62135596800 } }).createdAt).toBe('0001-01-01T00:00:00.000Z');
    expect(parse({ created: { seconds: 253402300799, nanos: 999999999 } }).createdAt).toBe('9999-12-31T23:59:59.999Z');
    for (const created of [{ seconds: -62135596801 }, { seconds: 253402300800 }, { nanos: -1 }, { nanos: 1000000000 }]) {
      expect(() => parse({ created })).toThrow();
    }
    for (const version of [1, 4294967296n, -1]) expect(() => parse({ version })).toThrow();
  });

  it('bounds the input and refuses nonbinary values without coercion or content leaks', () => {
    for (const input of [null, 'PRIVATE CONTENT', {}, [], Buffer.alloc(1024 * 1024 + 1)]) {
      expect(() => parseNativeAgyMetadata(input)).toThrow('Invalid native Antigravity metadata');
    }
    expect(parseNativeAgyMetadata(new Uint8Array())).toEqual(parse({}));
  });
});

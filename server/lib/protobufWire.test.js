import { describe, expect, it } from 'vitest';
import { PROTOBUF_WIRE_ERROR, decodeMessage, encodeMessage } from './protobufWire.js';

const NODE = {
  label: { no: 1, type: 'string' },
  children: { no: 2, type: 'message', repeated: true, schema: () => NODE },
};

const SCHEMA = {
  id: { no: 1, type: 'varint' },
  flag: { no: 2, type: 'bool' },
  name: { no: 3, type: 'string' },
  blob: { no: 4, type: 'bytes' },
  ratio: { no: 5, type: 'double' },
  tags: { no: 6, type: 'string', repeated: true },
  counts: { no: 7, type: 'varint', repeated: true },
  tree: { no: 8, type: 'message', schema: NODE },
};

// Hand-built wire bytes for fields the schema does not declare.
const unknownVarint = [0x48, 0x96, 0x01]; // field 9, varint 150
const unknownFixed64 = [0x51, 1, 2, 3, 4, 5, 6, 7, 8]; // field 10, fixed64
const unknownLengthDelimited = [0x5a, 0x03, 0x61, 0x62, 0x63]; // field 11, "abc"
const unknownFixed32 = [0x65, 1, 2, 3, 4]; // field 12, fixed32

describe('protobufWire', () => {
  it('round-trips every field type, repeated fields and recursive messages', () => {
    const value = {
      id: 300, // multi-byte varint
      flag: true,
      name: 'héllo ✓',
      blob: Buffer.from([0, 255, 7]),
      ratio: 1.5,
      tags: ['a', 'b'],
      counts: [1, 2 ** 40, -1],
      tree: { label: 'root', children: [{ label: 'leaf', children: [{ label: 'deep', children: [] }] }] },
    };
    const decoded = decodeMessage(SCHEMA, encodeMessage(SCHEMA, value));
    expect(decoded).toEqual(value);
  });

  it('encodes varints with the standard little-endian base-128 layout', () => {
    expect([...encodeMessage(SCHEMA, { id: 150 })]).toEqual([0x08, 0x96, 0x01]);
    // A negative int64 is ten bytes of two's complement and reads back negative.
    const negative = encodeMessage(SCHEMA, { id: -2 });
    expect(negative.length).toBe(11);
    expect(decodeMessage(SCHEMA, negative).id).toBe(-2);
  });

  it('omits absent fields and decodes them as undefined (repeated as [])', () => {
    expect(encodeMessage(SCHEMA, { name: undefined, flag: null }).length).toBe(0);
    const decoded = decodeMessage(SCHEMA, Buffer.alloc(0));
    expect(decoded.name).toBeUndefined();
    expect(decoded.tags).toEqual([]);
  });

  it('skips unknown fields of every wire type', () => {
    const known = [...encodeMessage(SCHEMA, { id: 7, name: 'x' })];
    const buf = Buffer.from([
      ...unknownVarint, ...known.slice(0, 2), ...unknownFixed64,
      ...unknownLengthDelimited, ...known.slice(2), ...unknownFixed32,
    ]);
    expect(decodeMessage(SCHEMA, buf)).toMatchObject({ id: 7, name: 'x' });
  });

  it('accepts packed encoding for a repeated varint field', () => {
    const packed = Buffer.from([0x3a, 0x03, 0x01, 0x96, 0x01]); // field 7, [1, 150]
    expect(decodeMessage(SCHEMA, packed).counts).toEqual([1, 150]);
  });

  it('rejects truncated input instead of returning a partial object', () => {
    const full = encodeMessage(SCHEMA, { name: 'truncate me', id: 300 });
    for (const cut of [1, 5, full.length - 1]) {
      expect(() => decodeMessage(SCHEMA, full.subarray(0, cut))).toThrow(expect.objectContaining({ code: PROTOBUF_WIRE_ERROR }));
    }
    expect(() => decodeMessage(SCHEMA, Buffer.from(unknownFixed64.slice(0, 5)))).toThrow(/Truncated/);
    expect(() => decodeMessage(SCHEMA, Buffer.from([0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]))).toThrow(/10 bytes/);
  });
});

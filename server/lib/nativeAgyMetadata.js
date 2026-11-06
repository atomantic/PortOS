// Antigravity 1.5.2 native SQLite v1 CortexStepMetadata contract. This is a
// projection, not a general protobuf decoder: content/model_info/headers/cost
// are never decoded. protobufWire's permissive singular/number semantics are
// unsuitable for accounting, which must reject ambiguous or rounded values.
import { isUtf8 } from 'node:buffer';

const MAX_BYTES = 1024 * 1024;
const MAX_ID_BYTES = 1024;
const fail = () => { throw Object.assign(new Error('Invalid native Antigravity metadata'), { code: 'NATIVE_AGY_METADATA' }); };

const varint = (reader) => {
  let value = 0n;
  for (let i = 0; i < 10; i += 1) {
    if (reader.pos >= reader.bytes.length) fail();
    const byte = reader.bytes[reader.pos++];
    if (i === 9 && byte > 1) fail();
    value |= BigInt(byte & 127) << BigInt(i * 7);
    if (!(byte & 128)) return value;
  }
  return fail();
};

const take = (reader, length) => {
  if (length > BigInt(reader.bytes.length - reader.pos)) fail();
  const end = reader.pos + Number(length);
  const bytes = reader.bytes.subarray(reader.pos, end);
  reader.pos = end;
  return bytes;
};
const delimited = reader => take(reader, varint(reader));
const skip = (reader, wire) => {
  if (wire === 0) varint(reader);
  else if (wire === 1) take(reader, 8n);
  else if (wire === 2) delimited(reader);
  else if (wire === 5) take(reader, 4n);
  else fail();
};

const uint = (value, max = BigInt(Number.MAX_SAFE_INTEGER)) => {
  if (value > max) fail();
  return Number(value);
};
const int32 = value => {
  const signed = BigInt.asIntN(64, value);
  if (signed < -2147483648n || signed > 2147483647n) fail();
  return Number(signed);
};
const identity = bytes => {
  if (!bytes.length || bytes.length > MAX_ID_BYTES || !isUtf8(bytes)) fail();
  const value = bytes.toString('utf8');
  if (!value.trim() || /[\p{Cc}\p{Cf}]/u.test(value)) fail();
  return value;
};

const decode = (bytes, schema, defaults) => {
  const reader = { bytes, pos: 0 };
  const seen = new Set();
  const result = { ...defaults };
  while (reader.pos < bytes.length) {
    const tag = varint(reader);
    if (tag > 0xffffffffn || tag < 8n) fail();
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    const entry = schema[field];
    if (!entry) { skip(reader, wire); continue; }
    if (seen.has(field) || wire !== entry.wire) fail();
    seen.add(field);
    result[entry.name] = entry.parse(wire === 0 ? varint(reader) : delimited(reader));
  }
  return result;
};
const scalar = (name, parse = uint) => ({ name, wire: 0, parse });
const message = (name, parse) => ({ name, wire: 2, parse });
const timestamp = bytes => {
  const { seconds, nanos } = decode(bytes, {
    1: scalar('seconds', value => BigInt.asIntN(64, value)),
    2: scalar('nanos', int32),
  }, { seconds: 0n, nanos: 0 });
  if (seconds < -62135596800n || seconds > 253402300799n || nanos < 0 || nanos > 999999999) fail();
  return new Date(Number(seconds) * 1000 + Math.floor(nanos / 1000000)).toISOString();
};

const USAGE_SCHEMA = {
  1: scalar('model', int32),
  2: scalar('inputTokens'),
  3: scalar('outputTokens'),
  4: scalar('cacheWriteTokens'),
  5: scalar('cacheReadTokens'),
  6: scalar('apiProvider', int32),
  7: message('messageId', identity),
  // 8 response_header intentionally skipped, including its nested payload.
  9: scalar('thinkingOutputTokens'),
  10: scalar('responseOutputTokens'),
  11: message('responseId', identity),
  12: message('providerMessageId', identity),
};
const usage = bytes => decode(bytes, USAGE_SCHEMA, {
  model: 0, apiProvider: 0, messageId: null, responseId: null, providerMessageId: null,
  inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0,
  thinkingOutputTokens: 0, responseOutputTokens: 0,
});
const METADATA_SCHEMA = {
  1: message('createdAt', timestamp),
  8: message('completedAt', timestamp),
  9: message('usage', usage),
  // 10 model_cost units are unverified; 24 model_info contains content.
  11: scalar('generatorModel', int32),
  21: scalar('generationVersion', value => uint(value, 0xffffffffn)),
};

/** Strict v1 metadata projection; throws without including input in errors.
 * Timestamps are ISO UTC at millisecond precision; enum values stay integers.
 * Only generation version 0 (including its protobuf default) is verified.
 * Identity strings are private caller inputs, never public reporting fields.
 */
export const parseNativeAgyMetadata = input => {
  if (!(input instanceof Uint8Array) || input.byteLength > MAX_BYTES) fail();
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const parsed = decode(bytes, METADATA_SCHEMA, {
    createdAt: null, completedAt: null, generationVersion: 0, usage: null,
  });
  if (parsed.generationVersion !== 0) fail();
  const { createdAt, completedAt, generationVersion, usage: parsedUsage } = parsed;
  return { createdAt, completedAt, generationVersion, usage: parsedUsage };
};

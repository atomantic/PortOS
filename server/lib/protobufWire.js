// Minimal, dependency-free protobuf wire codec for a small declarative schema.
//
// A schema maps a JS field name to its wire declaration:
//
//   { id: { no: 1, type: 'varint' }, name: { no: 2, type: 'string' },
//     tags: { no: 3, type: 'string', repeated: true },
//     child: { no: 4, type: 'message', schema: () => CHILD_SCHEMA } }
//
// Types: 'varint' (int32/int64/uint32/uint64/enum — decoded as a Number, with
// 64-bit two's complement read back as a negative), 'bool', 'string', 'bytes'
// (Buffer), 'message' (nested; `schema` is an object or a thunk so recursive
// messages can reference themselves), and 'double'.
//
// Decoding skips any field number the schema does not declare (and a declared
// field whose wire type does not match), for every skippable wire type
// (varint, fixed64, length-delimited, fixed32). Truncated or malformed input
// throws an Error with `code: PROTOBUF_WIRE_ERROR` rather than returning a partial object.
// Absent singular fields decode as `undefined`; absent repeated fields as `[]`.

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_FIXED32 = 5;

const TWO_POW_63 = 1n << 63n;
const TWO_POW_64 = 1n << 64n;

export const PROTOBUF_WIRE_ERROR = 'PROTOBUF_WIRE';
const wireError = (message) => Object.assign(new Error(message), { code: PROTOBUF_WIRE_ERROR });

const WIRE_TYPE_FOR = Object.freeze({
  varint: WIRE_VARINT,
  bool: WIRE_VARINT,
  string: WIRE_LENGTH_DELIMITED,
  bytes: WIRE_LENGTH_DELIMITED,
  message: WIRE_LENGTH_DELIMITED,
  double: WIRE_FIXED64,
});

const resolveSchema = (schema) => (typeof schema === 'function' ? schema() : schema);

// --- encoding ---------------------------------------------------------------

const encodeVarint = (value, out) => {
  let v = typeof value === 'bigint' ? value : BigInt(Math.trunc(Number(value)));
  if (v < 0n) v += TWO_POW_64;
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
};

const pushBytes = (out, bytes) => {
  for (const b of bytes) out.push(b);
};

const encodeField = (field, value, out) => {
  const wireType = WIRE_TYPE_FOR[field.type];
  if (wireType === undefined) throw wireError(`Unsupported field type: ${field.type}`);
  encodeVarint((field.no << 3) | wireType, out);
  switch (field.type) {
    case 'varint':
      encodeVarint(value, out);
      break;
    case 'bool':
      out.push(value ? 1 : 0);
      break;
    case 'double': {
      const buf = Buffer.alloc(8);
      buf.writeDoubleLE(Number(value), 0);
      pushBytes(out, buf);
      break;
    }
    case 'string':
    case 'bytes':
    case 'message': {
      const payload = field.type === 'string'
        ? Buffer.from(String(value), 'utf8')
        : field.type === 'bytes'
          ? Buffer.from(value)
          : encodeMessage(resolveSchema(field.schema), value);
      encodeVarint(payload.length, out);
      pushBytes(out, payload);
      break;
    }
    default:
      throw wireError(`Unsupported field type: ${field.type}`);
  }
};

/** Encode `obj` against `schema`; `undefined`/`null` fields are omitted. */
export const encodeMessage = (schema, obj = {}) => {
  const out = [];
  for (const [name, field] of Object.entries(schema)) {
    const value = obj?.[name];
    if (value === undefined || value === null) continue;
    if (field.repeated) {
      if (!Array.isArray(value)) throw wireError(`Repeated field "${name}" must be an array`);
      for (const item of value) encodeField(field, item, out);
    } else {
      encodeField(field, value, out);
    }
  }
  return Buffer.from(out);
};

// --- decoding ---------------------------------------------------------------

const readVarint = (buf, state) => {
  let result = 0n;
  let shift = 0n;
  for (let i = 0; i < 10; i += 1) {
    if (state.pos >= buf.length) throw wireError('Truncated varint');
    const byte = buf[state.pos];
    state.pos += 1;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return result & (TWO_POW_64 - 1n);
    shift += 7n;
  }
  throw wireError('Varint exceeds 10 bytes');
};

const varintToNumber = (big) => Number(big >= TWO_POW_63 ? big - TWO_POW_64 : big);

const readLengthDelimited = (buf, state) => {
  const length = Number(readVarint(buf, state));
  const end = state.pos + length;
  if (end > buf.length) throw wireError('Truncated length-delimited field');
  const slice = buf.subarray(state.pos, end);
  state.pos = end;
  return slice;
};

const skipField = (buf, state, wireType) => {
  switch (wireType) {
    case WIRE_VARINT:
      readVarint(buf, state);
      return;
    case WIRE_FIXED64:
      if (state.pos + 8 > buf.length) throw wireError('Truncated fixed64 field');
      state.pos += 8;
      return;
    case WIRE_LENGTH_DELIMITED:
      readLengthDelimited(buf, state);
      return;
    case WIRE_FIXED32:
      if (state.pos + 4 > buf.length) throw wireError('Truncated fixed32 field');
      state.pos += 4;
      return;
    default:
      throw wireError(`Unsupported wire type ${wireType}`);
  }
};

const decodeScalar = (field, buf, state) => {
  switch (field.type) {
    case 'varint':
      return varintToNumber(readVarint(buf, state));
    case 'bool':
      return readVarint(buf, state) !== 0n;
    case 'double': {
      if (state.pos + 8 > buf.length) throw wireError('Truncated double field');
      const value = buf.readDoubleLE(state.pos);
      state.pos += 8;
      return value;
    }
    case 'string':
      return readLengthDelimited(buf, state).toString('utf8');
    case 'bytes':
      return Buffer.from(readLengthDelimited(buf, state));
    case 'message':
      return decodeMessage(resolveSchema(field.schema), readLengthDelimited(buf, state));
    default:
      throw wireError(`Unsupported field type: ${field.type}`);
  }
};

const fieldsByNumber = new WeakMap();
const indexSchema = (schema) => {
  let index = fieldsByNumber.get(schema);
  if (!index) {
    index = new Map(Object.entries(schema).map(([name, field]) => [field.no, { name, field }]));
    fieldsByNumber.set(schema, index);
  }
  return index;
};

/** Decode `input` (Buffer/Uint8Array) against `schema`. Throws on malformed input. */
export const decodeMessage = (schema, input) => {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const index = indexSchema(schema);
  const result = {};
  for (const [name, field] of Object.entries(schema)) {
    if (field.repeated) result[name] = [];
  }
  const state = { pos: 0 };
  while (state.pos < buf.length) {
    const tag = Number(readVarint(buf, state));
    const fieldNo = tag >>> 3;
    const wireType = tag & 0x7;
    if (fieldNo === 0) throw wireError('Invalid field number 0');
    const entry = index.get(fieldNo);
    if (!entry) {
      skipField(buf, state, wireType);
      continue;
    }
    const { name, field } = entry;
    const expected = WIRE_TYPE_FOR[field.type];
    const packable = field.repeated && (expected === WIRE_VARINT || expected === WIRE_FIXED64);
    if (packable && wireType === WIRE_LENGTH_DELIMITED) {
      const packed = readLengthDelimited(buf, state);
      const inner = { pos: 0 };
      while (inner.pos < packed.length) result[name].push(decodeScalar(field, packed, inner));
      continue;
    }
    if (wireType !== expected) {
      skipField(buf, state, wireType);
      continue;
    }
    const value = decodeScalar(field, buf, state);
    if (field.repeated) result[name].push(value);
    else result[name] = value;
  }
  return result;
};

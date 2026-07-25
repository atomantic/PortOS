import { readFile, writeFile } from 'node:fs/promises';

const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const JSON_CHUNK_TYPE = 0x4e4f534a;
const GLB_HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;

function invalidGlb(message) {
  const error = new Error(`Invalid GLB: ${message}`);
  error.code = 'INVALID_GLB';
  return error;
}

/**
 * Rewrite every explicitly transparent glTF material to OPAQUE while preserving
 * the binary payload byte-for-byte.
 *
 * TRELLIS predicts an alpha channel as one of its PBR surface attributes. The
 * Apple-Silicon exporter currently auto-promotes a material to BLEND when even
 * one baked texel falls below alpha 250, despite upstream TRELLIS documenting
 * OPAQUE as the default export mode. For ordinary image-to-3D objects that turns
 * harmless alpha noise into holes across whichever UV islands sample it.
 *
 * @param {Buffer|Uint8Array} input
 * @returns {Buffer}
 */
export function forceOpaqueGlbMaterials(input) {
  const source = Buffer.from(input);
  if (source.length < GLB_HEADER_BYTES + CHUNK_HEADER_BYTES) {
    throw invalidGlb('file is shorter than its header');
  }
  if (source.readUInt32LE(0) !== GLB_MAGIC) throw invalidGlb('bad magic');
  if (source.readUInt32LE(4) !== GLB_VERSION) throw invalidGlb('unsupported version');
  if (source.readUInt32LE(8) !== source.length) throw invalidGlb('declared length does not match file size');

  const jsonLength = source.readUInt32LE(GLB_HEADER_BYTES);
  const jsonType = source.readUInt32LE(GLB_HEADER_BYTES + 4);
  const jsonStart = GLB_HEADER_BYTES + CHUNK_HEADER_BYTES;
  const jsonEnd = jsonStart + jsonLength;
  if (jsonType !== JSON_CHUNK_TYPE) throw invalidGlb('first chunk is not JSON');
  if (jsonEnd > source.length) throw invalidGlb('JSON chunk exceeds file size');

  const document = JSON.parse(source.toString('utf8', jsonStart, jsonEnd).replace(/\0+$/, '').trimEnd());
  let changed = false;
  for (const material of Array.isArray(document.materials) ? document.materials : []) {
    // An absent alphaMode already means OPAQUE in glTF. Only rewrite an explicit
    // BLEND/MASK so a no-op pass leaves an already-correct file byte-identical.
    if (material?.alphaMode === 'BLEND' || material?.alphaMode === 'MASK') {
      material.alphaMode = 'OPAQUE';
      changed = true;
    }
  }
  if (!changed) return source;

  const json = Buffer.from(JSON.stringify(document));
  const paddedJsonLength = Math.ceil(json.length / 4) * 4;
  const rest = source.subarray(jsonEnd);
  const output = Buffer.alloc(jsonStart + paddedJsonLength + rest.length, 0x20);

  source.copy(output, 0, 0, GLB_HEADER_BYTES);
  output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(paddedJsonLength, GLB_HEADER_BYTES);
  output.writeUInt32LE(JSON_CHUNK_TYPE, GLB_HEADER_BYTES + 4);
  json.copy(output, jsonStart);
  rest.copy(output, jsonStart + paddedJsonLength);
  return output;
}

/**
 * Apply the opaque-material normalization to a generated GLB on disk.
 *
 * @param {string} path
 * @param {{readFileImpl?: typeof readFile, writeFileImpl?: typeof writeFile}} [deps]
 */
export async function rewriteGlbMaterialsOpaque(
  path,
  { readFileImpl = readFile, writeFileImpl = writeFile } = {},
) {
  const source = await readFileImpl(path);
  const output = forceOpaqueGlbMaterials(source);
  if (output !== source && !output.equals(source)) await writeFileImpl(path, output);
}

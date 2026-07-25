import { describe, expect, it, vi } from 'vitest';
import { forceOpaqueGlbMaterials, rewriteGlbMaterialsOpaque } from './glbMaterials.js';

const JSON_CHUNK_TYPE = 0x4e4f534a;
const BIN_CHUNK_TYPE = 0x004e4942;

function makeGlb(document, bin = Buffer.from([1, 2, 3, 4])) {
  const json = Buffer.from(JSON.stringify(document));
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const binLength = Math.ceil(bin.length / 4) * 4;
  const output = Buffer.alloc(12 + 8 + jsonLength + 8 + binLength, 0);
  output.writeUInt32LE(0x46546c67, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(jsonLength, 12);
  output.writeUInt32LE(JSON_CHUNK_TYPE, 16);
  output.fill(0x20, 20, 20 + jsonLength);
  json.copy(output, 20);
  const binHeader = 20 + jsonLength;
  output.writeUInt32LE(binLength, binHeader);
  output.writeUInt32LE(BIN_CHUNK_TYPE, binHeader + 4);
  bin.copy(output, binHeader + 8);
  return output;
}

function readDocument(glb) {
  const jsonLength = glb.readUInt32LE(12);
  return JSON.parse(glb.toString('utf8', 20, 20 + jsonLength).trimEnd());
}

function readBinaryChunk(glb) {
  const jsonLength = glb.readUInt32LE(12);
  return glb.subarray(20 + jsonLength);
}

describe('forceOpaqueGlbMaterials', () => {
  it('rewrites BLEND and MASK materials while preserving the binary chunk', () => {
    const source = makeGlb({
      asset: { version: '2.0' },
      materials: [
        { name: 'predicted-alpha', alphaMode: 'BLEND' },
        { name: 'cutout', alphaMode: 'MASK', alphaCutoff: 0.4 },
        { name: 'already-solid', alphaMode: 'OPAQUE' },
        { name: 'implicit-solid' },
      ],
    });

    const output = forceOpaqueGlbMaterials(source);
    expect(readDocument(output).materials.map((material) => material.alphaMode)).toEqual([
      'OPAQUE', 'OPAQUE', 'OPAQUE', undefined,
    ]);
    expect(readBinaryChunk(output)).toEqual(readBinaryChunk(source));
    expect(output.readUInt32LE(8)).toBe(output.length);
  });

  it('keeps an already-opaque GLB byte-identical', () => {
    const source = makeGlb({
      asset: { version: '2.0' },
      materials: [{ alphaMode: 'OPAQUE' }, {}],
    });
    expect(forceOpaqueGlbMaterials(source)).toEqual(source);
  });

  it('rejects malformed input instead of corrupting an unknown file', () => {
    expect(() => forceOpaqueGlbMaterials(Buffer.from('not a glb')))
      .toThrow(/Invalid GLB/);
  });
});

describe('rewriteGlbMaterialsOpaque', () => {
  it('writes the normalized GLB back to the same path', async () => {
    const source = makeGlb({
      asset: { version: '2.0' },
      materials: [{ alphaMode: 'BLEND' }],
    });
    const writeFileImpl = vi.fn(async () => {});
    await rewriteGlbMaterialsOpaque('/tmp/model.glb', {
      readFileImpl: vi.fn(async () => source),
      writeFileImpl,
    });
    expect(writeFileImpl).toHaveBeenCalledWith(
      '/tmp/model.glb',
      expect.any(Buffer),
    );
    expect(readDocument(writeFileImpl.mock.calls[0][1]).materials[0].alphaMode).toBe('OPAQUE');
  });

  it('does not write when no material needs normalization', async () => {
    const source = makeGlb({ asset: { version: '2.0' }, materials: [{}] });
    const writeFileImpl = vi.fn(async () => {});
    await rewriteGlbMaterialsOpaque('/tmp/model.glb', {
      readFileImpl: vi.fn(async () => source),
      writeFileImpl,
    });
    expect(writeFileImpl).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { buildEidoverseCitySurface } from './eidoverseCitySurface.js';
import { EIDOVERSE_WORLD_DESIGN_V3 } from './eidoverseWorldDesign.js';

// Serialization boundary: readers require exact chunk lengths, finite accessors,
// valid indices, and an entirely self-contained artifact on every install.
describe('Commons portable GLB', () => {
  it('encodes valid self-contained geometry at a stable content address', () => {
    const first = buildEidoverseCitySurface(EIDOVERSE_WORLD_DESIGN_V3.districts);
    expect(buildEidoverseCitySurface([...EIDOVERSE_WORLD_DESIGN_V3.districts].reverse())).toEqual(first);
    const { bytes } = first;
    expect(bytes.length).toBeLessThan(1_000_000);
    expect(bytes.readUInt32LE(0)).toBe(0x46546c67);
    expect(bytes.readUInt32LE(4)).toBe(2);
    expect(bytes.readUInt32LE(8)).toBe(bytes.length);
    const jsonLength = bytes.readUInt32LE(12);
    const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
    const binStart = 28 + jsonLength;
    expect(bytes.readUInt32LE(24 + jsonLength)).toBe(0x004e4942);
    expect(gltf.buffers).toEqual([{ byteLength: bytes.length - binStart }]);
    expect(gltf.images).toBeUndefined();
    for (const mesh of gltf.meshes) for (const primitive of mesh.primitives) {
      const positions = gltf.accessors[primitive.attributes.POSITION];
      expect(positions.count).toBeGreaterThan(0);
      const indices = gltf.accessors[primitive.indices];
      const view = gltf.bufferViews[indices.bufferView];
      const references = Array.from({ length: indices.count }, (_, i) => bytes.readUInt32LE(binStart + view.byteOffset + i * 4));
      expect(references.every((index) => index < positions.count)).toBe(true);
    }
    for (const accessor of gltf.accessors) {
      expect([...accessor.min, ...accessor.max].every(Number.isFinite)).toBe(true);
      const view = gltf.bufferViews[accessor.bufferView];
      expect(view.byteOffset + view.byteLength).toBeLessThanOrEqual(gltf.buffers[0].byteLength);
      expect(view.byteOffset % 4).toBe(0);
    }
    expect(first.path).toBe(`store/${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.glb`);
    const renamed = structuredClone(EIDOVERSE_WORLD_DESIGN_V3.districts);
    renamed[0].label = 'Example civic hall';
    expect(buildEidoverseCitySurface(renamed).path).not.toBe(first.path);
  });
});

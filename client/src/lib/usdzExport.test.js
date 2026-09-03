import { describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry, Group, Mesh, MeshStandardMaterial, Points } from 'three';
import { countSceneTriangles, supportsArQuickLook } from './usdzExport.js';

const geometry = (vertexCount, { indexed = false } = {}) => {
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(vertexCount * 3), 3));
  if (indexed) geo.setIndex(new BufferAttribute(new Uint16Array(vertexCount), 1));
  return geo;
};

describe('countSceneTriangles', () => {
  // Indexed and non-indexed geometry keep the triangle count in DIFFERENT places
  // (`index.count` vs the position attribute), and a GLB from the render pipeline
  // may be either — reading only one silently reports the wrong budget for half of
  // every user's models, which is exactly the warning this number drives.
  it('reads the count from the index when the geometry is indexed', () => {
    const group = new Group();
    group.add(new Mesh(geometry(12, { indexed: true }), new MeshStandardMaterial()));
    expect(countSceneTriangles(group)).toBe(4);
  });

  it('falls back to the position attribute for non-indexed geometry', () => {
    const group = new Group();
    group.add(new Mesh(geometry(9), new MeshStandardMaterial()));
    expect(countSceneTriangles(group)).toBe(3);
  });

  // A GLB can carry a Points/Line child (and always carries plain Object3D
  // groups). Those have no triangles, and treating their vertex count as
  // triangles would inflate the budget check into a false warning.
  it('ignores non-mesh children and sums the meshes', () => {
    const group = new Group();
    group.add(new Group());
    group.add(new Points(geometry(300)));
    group.add(new Mesh(geometry(6), new MeshStandardMaterial()));
    group.add(new Mesh(geometry(30, { indexed: true }), new MeshStandardMaterial()));
    expect(countSceneTriangles(group)).toBe(12);
  });

  it('reports zero rather than throwing for a missing scene', () => {
    expect(countSceneTriangles(null)).toBe(0);
  });
});

describe('supportsArQuickLook', () => {
  // jsdom's relList reports no `ar` support, which is the correct answer for
  // every non-Safari browser — the panel must offer a download and a QR code
  // there instead of a "View in AR" button that does nothing.
  it('is false where the rel="ar" handoff is unimplemented', () => {
    expect(supportsArQuickLook()).toBe(false);
  });
});

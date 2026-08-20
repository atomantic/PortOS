import { describe, expect, it } from 'vitest';
import { createSculptBufferGeometry, needsSculptBufferGeometry, sculptMaterialProps } from './threejsSculpt.js';

const extrudeDefinition = (overrides = {}) => ({
  type: 'extrude',
  outline: [[-1, -1], [1, -1], [1, 1], [-1, 1]],
  holes: [],
  depth: 0.5,
  bevelEnabled: false,
  bevelThickness: 0.1,
  bevelSize: 0.1,
  bevelSegments: 2,
  curveSegments: 8,
  steps: 1,
  ...overrides,
});

const tubeDefinition = (overrides = {}) => ({
  type: 'tube',
  path: [[0, 0, 0], [0, 1, 0.5], [0.6, 1.6, 0]],
  radius: 0.1,
  tubularSegments: 24,
  radialSegments: 8,
  closed: false,
  curveType: 'centripetal',
  tension: 0.5,
  ...overrides,
});

describe('needsSculptBufferGeometry', () => {
  it('claims only the imperatively built forms', () => {
    expect(needsSculptBufferGeometry({ type: 'custom' })).toBe(true);
    expect(needsSculptBufferGeometry({ type: 'extrude' })).toBe(true);
    expect(needsSculptBufferGeometry({ type: 'tube' })).toBe(true);
    expect(needsSculptBufferGeometry({ type: 'box' })).toBe(false);
    expect(needsSculptBufferGeometry(undefined)).toBe(false);
  });
});

describe('createSculptBufferGeometry', () => {
  it('builds an indexed custom triangle mesh with normals', () => {
    const geometry = createSculptBufferGeometry({
      type: 'custom',
      vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
    });
    expect(geometry.getAttribute('position').count).toBe(3);
    expect(geometry.getAttribute('normal')).toBeTruthy();
    expect(geometry.index.count).toBe(3);
  });

  it('extrudes a closed outline to the requested depth', () => {
    const geometry = createSculptBufferGeometry(extrudeDefinition());
    geometry.computeBoundingBox();
    const { min, max } = geometry.boundingBox;
    expect(max.z - min.z).toBeCloseTo(0.5, 5);
    expect(max.x - min.x).toBeCloseTo(2, 5);
    expect(geometry.getAttribute('position').count).toBeGreaterThan(0);
  });

  it('cuts holes out of the extruded outline', () => {
    const solid = createSculptBufferGeometry(extrudeDefinition());
    const perforated = createSculptBufferGeometry(extrudeDefinition({
      holes: [[[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]]],
    }));
    expect(perforated.getAttribute('position').count).toBeGreaterThan(solid.getAttribute('position').count);
  });

  it('sweeps a tube along the path without producing NaN positions', () => {
    const geometry = createSculptBufferGeometry(tubeDefinition());
    const positions = geometry.getAttribute('position').array;
    expect(positions.length).toBeGreaterThan(0);
    expect(Array.from(positions).every(Number.isFinite)).toBe(true);
    geometry.computeBoundingBox();
    expect(geometry.boundingBox.max.y).toBeGreaterThan(1.5);
  });

  it('returns null for primitives the preview renders declaratively', () => {
    expect(createSculptBufferGeometry({ type: 'box', width: 1, height: 1, depth: 1 })).toBeNull();
  });
});

describe('sculptMaterialProps', () => {
  const definition = {
    type: 'physical',
    color: '#ffffff',
    metalness: 0.2,
    roughness: 0.4,
    emissive: '#000000',
    emissiveIntensity: 0,
    opacity: 1,
    transparent: false,
    wireframe: false,
    clearcoat: 0.5,
    clearcoatRoughness: 0.1,
    ior: 1.45,
    transmission: 0.8,
    thickness: 0.6,
    sheen: 0.3,
    iridescence: 0.7,
    anisotropy: 0.9,
  };

  it('forwards physical channels for physical materials', () => {
    expect(sculptMaterialProps(definition)).toMatchObject({
      metalness: 0.2, roughness: 0.4, clearcoat: 0.5, clearcoatRoughness: 0.1,
      ior: 1.45, transmission: 0.8, thickness: 0.6, sheen: 0.3, iridescence: 0.7, anisotropy: 0.9,
    });
  });

  it('drops physical-only channels for standard materials', () => {
    const props = sculptMaterialProps({ ...definition, type: 'standard' });
    expect(props.metalness).toBe(0.2);
    for (const key of ['clearcoat', 'ior', 'transmission', 'thickness', 'sheen', 'iridescence', 'anisotropy']) {
      expect(props).not.toHaveProperty(key);
    }
  });

  it('keeps basic materials unlit', () => {
    const props = sculptMaterialProps({ ...definition, type: 'basic' });
    expect(props).toEqual({ color: '#ffffff', opacity: 1, transparent: false, wireframe: false });
  });

  // Without this the spec's environment intensity never reaches a surface, and
  // every model reflects at exactly 1 whatever it authored.
  it('forwards the environment intensity to lit materials only', () => {
    expect(sculptMaterialProps(definition, 2.5).envMapIntensity).toBe(2.5);
    expect(sculptMaterialProps({ ...definition, type: 'standard' }, 2.5).envMapIntensity).toBe(2.5);
    expect(sculptMaterialProps({ ...definition, type: 'basic' }, 2.5)).not.toHaveProperty('envMapIntensity');
    // A caller that has no environment to declare still gets the neutral value,
    // never `undefined` — three reads that as "leave the material's own".
    expect(sculptMaterialProps(definition).envMapIntensity).toBe(1);
  });
});
// @vitest-environment node

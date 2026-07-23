import { describe, expect, it } from 'vitest';
import { buildThreejsFactorySource, threejsSculptSpecSchema } from './threejsModel.js';

const validSpec = () => ({
  schemaVersion: 1,
  name: 'Example Crate',
  summary: 'A beveled-looking shipping crate assembled from nested boxes.',
  subjectType: 'object',
  limitations: ['The hidden rear panel is inferred.'],
  background: '#111827',
  camera: { position: [4, 3, 5], target: [0, 0, 0], fov: 42 },
  materials: {
    body: { type: 'standard', color: '#8b5a2b', metalness: 0, roughness: 0.7 },
    trim: { type: 'physical', color: '#d4af37', metalness: 0.8, roughness: 0.25 },
  },
  lights: [
    { type: 'ambient', color: '#ffffff', intensity: 0.4 },
    { type: 'directional', color: '#ffffff', intensity: 2, position: [4, 6, 3] },
  ],
  parts: [{
    id: 'crateBody',
    name: 'Crate body',
    geometry: { type: 'box', width: 2, height: 1.4, depth: 1.2 },
    material: 'body',
    position: [0, 0.7, 0],
    rotationDegrees: [0, 0, 0],
    scale: [1, 1, 1],
    children: [{
      id: 'frontTrim',
      name: 'Front trim',
      geometry: { type: 'box', width: 1.8, height: 0.1, depth: 0.08 },
      material: 'trim',
      position: [0, 0, 0.64],
      rotationDegrees: [0, 0, 0],
      scale: [1, 1, 1],
      children: [],
    }],
  }],
  sockets: [{ name: 'lidPivot', parentPartId: 'crateBody', position: [0, 0.7, -0.6], rotationDegrees: [0, 0, 0] }],
  detailInventory: [{
    feature: 'Gold front trim',
    evidence: 'A narrow metallic band crosses the visible front panel.',
    implementationPartIds: ['frontTrim'],
    priority: 'identity',
  }],
});

describe('threejsSculptSpecSchema', () => {
  it('accepts a bounded hierarchy and fills material/part defaults', () => {
    const parsed = threejsSculptSpecSchema.parse(validSpec());
    expect(parsed.materials.body.emissive).toBe('#000000');
    expect(parsed.parts[0].castShadow).toBe(true);
    expect(parsed.parts[0].children[0].id).toBe('frontTrim');
  });

  it('rejects unknown material and detail references', () => {
    const spec = validSpec();
    spec.parts[0].material = 'missing';
    spec.detailInventory[0].implementationPartIds = ['notARealPart'];
    const result = threejsSculptSpecSchema.safeParse(spec);
    expect(result.success).toBe(false);
    expect(result.error.issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
      'unknown material: missing',
      'unknown detail part: notARealPart',
    ]));
  });

  it('rejects out-of-range custom geometry indices', () => {
    const spec = validSpec();
    spec.parts[0].geometry = {
      type: 'custom',
      vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 4],
    };
    const result = threejsSculptSpecSchema.safeParse(spec);
    expect(result.success).toBe(false);
    expect(result.error.issues.some((issue) => issue.message.includes('exceeds vertex count'))).toBe(true);
  });
});
describe('buildThreejsFactorySource', () => {
  it('exports a deterministic Group factory from validated data', () => {
    const source = buildThreejsFactorySource(validSpec());
    expect(source).toContain("import * as THREE from 'three'");
    expect(source).toContain('export function createExampleCrateModel()');
    expect(source).toContain('root.userData.sculptRuntime');
    expect(source).toContain("case 'custom'");
    expect(source).toContain('new THREE.MeshBasicMaterial(unlit)');
  });
});

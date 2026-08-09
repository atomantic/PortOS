import { describe, expect, it } from 'vitest';
import {
  buildThreejsFactorySource,
  buildThreejsFlatnessFeedback,
  evaluateThreejsFlatness,
  storedThreejsSculptSpecSchema,
  threejsGeometrySchema,
  threejsSculptSpecSchema,
} from './threejsModel.js';

const squareOutline = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
const validExtrude = () => ({
  type: 'extrude',
  outline: squareOutline,
  holes: [[[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]]],
  depth: 0.4,
});
const validTube = () => ({
  type: 'tube',
  path: [[0, 0, 0], [0, 1, 0.5], [0.6, 1.6, 0]],
  radius: 0.08,
});

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

  it('defaults surface relief off and preserves an explicit flag', () => {
    const spec = validSpec();
    spec.parts[0].children[0].explodeWithParent = true;
    const parsed = threejsSculptSpecSchema.parse(spec);
    // A part is a component unless the model says it merely rides one.
    expect(parsed.parts[0].explodeWithParent).toBe(false);
    expect(parsed.parts[0].children[0].explodeWithParent).toBe(true);
  });

  it('rejects a non-boolean surface-relief flag', () => {
    const spec = validSpec();
    spec.parts[0].explodeWithParent = 'yes';
    expect(threejsSculptSpecSchema.safeParse(spec).success).toBe(false);
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

  it('accepts extrude and tube parts and fills their construction defaults', () => {
    const spec = validSpec();
    spec.parts[0].geometry = validExtrude();
    spec.parts[0].children[0].geometry = validTube();
    const parsed = threejsSculptSpecSchema.parse(spec);
    expect(parsed.parts[0].geometry).toMatchObject({
      bevelEnabled: false, bevelSegments: 2, curveSegments: 8, steps: 1,
    });
    expect(parsed.parts[0].children[0].geometry).toMatchObject({
      tubularSegments: 64, radialSegments: 12, closed: false, curveType: 'centripetal', tension: 0.5,
    });
  });

  it('fills physical material channel defaults', () => {
    const parsed = threejsSculptSpecSchema.parse(validSpec());
    expect(parsed.materials.trim).toMatchObject({
      ior: 1.5, transmission: 0, thickness: 0, sheen: 0, iridescence: 0, anisotropy: 0,
    });
  });

  it('defaults an omitted part scale to an untouched [1, 1, 1]', () => {
    const spec = validSpec();
    delete spec.parts[0].scale;
    delete spec.parts[0].children[0].scale;
    const parsed = threejsSculptSpecSchema.parse(spec);
    expect(parsed.parts[0].scale).toEqual([1, 1, 1]);
    expect(parsed.parts[0].children[0].scale).toEqual([1, 1, 1]);
  });

  // A zero component collapses the part to an invisible plane and a negative one
  // reflects it — neither throws at render time (three.js flips the front face for a
  // negative determinant), so the schema is the only place they can be caught.
  it('rejects a negative or zero part scale component, at any depth', () => {
    for (const bad of [[1, -1, 1], [1, 0, 1], [-1, -1, -1]]) {
      const spec = validSpec();
      spec.parts[0].scale = bad;
      const result = threejsSculptSpecSchema.safeParse(spec);
      expect(result.success).toBe(false);
      expect(result.error.issues.some((issue) => issue.path.join('.') === 'parts.0.scale.1'
        || issue.path.join('.') === 'parts.0.scale.0')).toBe(true);

      const nested = validSpec();
      nested.parts[0].children[0].scale = bad;
      expect(threejsSculptSpecSchema.safeParse(nested).success).toBe(false);
    }
  });

  it('keeps accepting a legacy stored scale that the authoring contract now rejects', () => {
    for (const legacy of [[1, -1, 1], [1, 0, 1], [1, 5e-5, 1]]) {
      const spec = validSpec();
      spec.parts[0].children[0].scale = legacy;
      expect(threejsSculptSpecSchema.safeParse(spec).success).toBe(false);
      expect(storedThreejsSculptSpecSchema.parse(spec).parts[0].children[0].scale).toEqual(legacy);
    }
  });

  it('rejects a near-zero part scale below the floor but accepts the floor itself', () => {
    const tooSmall = validSpec();
    tooSmall.parts[0].scale = [1, 5e-5, 1];
    expect(threejsSculptSpecSchema.safeParse(tooSmall).success).toBe(false);

    const atFloor = validSpec();
    atFloor.parts[0].scale = [1, 1e-4, 1];
    expect(threejsSculptSpecSchema.parse(atFloor).parts[0].scale).toEqual([1, 1e-4, 1]);
  });

  it('rejects out-of-range physical material channels', () => {
    const spec = validSpec();
    spec.materials.trim.ior = 4;
    spec.materials.trim.transmission = 1.5;
    expect(threejsSculptSpecSchema.safeParse(spec).success).toBe(false);
  });
});

describe('threejsGeometrySchema extrude/tube validation', () => {
  it('rejects an outline or hole that encloses no area', () => {
    const collinear = [[0, 0], [1, 0], [2, 0], [3, 0]];
    expect(threejsGeometrySchema.safeParse({ ...validExtrude(), outline: collinear }).success).toBe(false);
    expect(threejsGeometrySchema.safeParse({ ...validExtrude(), holes: [collinear] }).success).toBe(false);
  });

  it('rejects a self-crossing outline or hole', () => {
    // Non-zero shoelace area, but the lobes cross so the interior is undefined.
    const crossing = [[0, 0], [2, 4], [4, 0], [0, 3], [4, 3]];
    const result = threejsGeometrySchema.safeParse({ ...validExtrude(), outline: crossing });
    expect(result.success).toBe(false);
    expect(result.error.issues.some((issue) => issue.message.includes('must not cross itself'))).toBe(true);
    expect(threejsGeometrySchema.safeParse({ ...validExtrude(), holes: [crossing] }).success).toBe(false);
  });

  it('rejects an outline with fewer than three points', () => {
    expect(threejsGeometrySchema.safeParse({ ...validExtrude(), outline: [[0, 0], [1, 1]] }).success).toBe(false);
  });

  it('rejects a hole that falls outside the outline', () => {
    const result = threejsGeometrySchema.safeParse({
      ...validExtrude(),
      holes: [[[5, 5], [6, 5], [6, 6], [5, 6]]],
    });
    expect(result.success).toBe(false);
    expect(result.error.issues.some((issue) => issue.message.includes('falls outside the outline'))).toBe(true);
  });

  // An L-shape: the bounding box covers the notch, so a bounds-only containment
  // check would accept a hole floating in empty space outside the outline.
  const lShapedOutline = [[0, 0], [3, 0], [3, 1], [1, 1], [1, 3], [0, 3]];

  it('rejects a hole sitting in the notch of a concave outline', () => {
    const result = threejsGeometrySchema.safeParse({
      ...validExtrude(),
      outline: lShapedOutline,
      holes: [[[1.5, 1.5], [2.5, 1.5], [2.5, 2.5], [1.5, 2.5]]],
    });
    expect(result.success).toBe(false);
    expect(result.error.issues.some((issue) => issue.message.includes('falls outside the outline'))).toBe(true);
  });

  it('rejects a hole whose vertices are inside but whose edge leaves the outline', () => {
    const result = threejsGeometrySchema.safeParse({
      ...validExtrude(),
      outline: lShapedOutline,
      holes: [[[0.5, 0.5], [2.5, 0.5], [0.5, 2.5]]],
    });
    expect(result.success).toBe(false);
    expect(result.error.issues.some((issue) => issue.message.includes('falls outside the outline'))).toBe(true);
  });

  it('rejects overlapping and nested holes', () => {
    const overlapping = threejsGeometrySchema.safeParse({
      ...validExtrude(),
      holes: [
        [[-0.6, -0.4], [0.1, -0.4], [0.1, 0.4], [-0.6, 0.4]],
        [[-0.1, -0.4], [0.6, -0.4], [0.6, 0.4], [-0.1, 0.4]],
      ],
    });
    expect(overlapping.success).toBe(false);
    expect(overlapping.error.issues.some((issue) => issue.message.includes('overlaps hole 0'))).toBe(true);

    const nested = threejsGeometrySchema.safeParse({
      ...validExtrude(),
      holes: [
        [[-0.6, -0.6], [0.6, -0.6], [0.6, 0.6], [-0.6, 0.6]],
        [[-0.2, -0.2], [0.2, -0.2], [0.2, 0.2], [-0.2, 0.2]],
      ],
    });
    expect(nested.success).toBe(false);
    expect(nested.error.issues.some((issue) => issue.message.includes('overlaps hole 0'))).toBe(true);
  });

  it('accepts disjoint holes inside the outline', () => {
    expect(threejsGeometrySchema.safeParse({
      ...validExtrude(),
      holes: [
        [[-0.7, -0.3], [-0.3, -0.3], [-0.3, 0.3], [-0.7, 0.3]],
        [[0.3, -0.3], [0.7, -0.3], [0.7, 0.3], [0.3, 0.3]],
      ],
    }).success).toBe(true);
  });

  it('rejects a closed tube that cannot enclose a loop', () => {
    const twoPoint = threejsGeometrySchema.safeParse({
      type: 'tube', radius: 0.1, closed: true, path: [[0, 0, 0], [1, 0, 0]],
    });
    expect(twoPoint.success).toBe(false);
    expect(twoPoint.error.issues.some((issue) => issue.message.includes('three non-collinear points'))).toBe(true);

    const collinear = threejsGeometrySchema.safeParse({
      type: 'tube', radius: 0.1, closed: true, path: [[0, 0, 0], [1, 1, 1], [3, 3, 3]],
    });
    expect(collinear.success).toBe(false);
    expect(collinear.error.issues.some((issue) => issue.message.includes('three non-collinear points'))).toBe(true);
  });

  it('accepts a two-point open tube path', () => {
    expect(threejsGeometrySchema.safeParse({
      type: 'tube', radius: 0.1, path: [[0, 0, 0], [1, 0, 0]],
    }).success).toBe(true);
  });

  it('accepts a hole fully inside a concave outline', () => {
    const result = threejsGeometrySchema.safeParse({
      ...validExtrude(),
      outline: lShapedOutline,
      holes: [[[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]]],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a tube path that repeats a point consecutively', () => {
    const result = threejsGeometrySchema.safeParse({
      ...validTube(),
      path: [[0, 0, 0], [0, 0, 0], [1, 0, 0]],
    });
    expect(result.success).toBe(false);
    expect(result.error.issues.some((issue) => issue.message.includes('repeat the same point consecutively'))).toBe(true);
  });

  it('rejects a closed tube path that repeats its first point at the end', () => {
    const result = threejsGeometrySchema.safeParse({
      type: 'tube',
      radius: 0.1,
      closed: true,
      path: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 0, 0]],
    });
    expect(result.success).toBe(false);
    expect(result.error.issues.some((issue) => issue.message.includes('must not repeat its first point'))).toBe(true);
  });

  it('accepts a closed tube path with distinct endpoints', () => {
    expect(threejsGeometrySchema.safeParse({ ...validTube(), closed: true }).success).toBe(true);
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

  it('carries the surface-relief flag into part userData so an export can disassemble too', () => {
    const spec = validSpec();
    spec.parts[0].children[0].explodeWithParent = true;
    const source = buildThreejsFactorySource(spec);
    expect(source).toContain('node.userData.partId = definition.id;');
    expect(source).toContain('node.userData.explodeWithParent = definition.explodeWithParent;');
    // The serialized spec the factory closes over must carry the flag, not just
    // the code that reads it.
    expect(source).toContain('"explodeWithParent": true');
  });

  it('emits extrude, tube, and physical-channel construction', () => {
    const spec = validSpec();
    spec.parts[0].geometry = validExtrude();
    spec.parts[0].children[0].geometry = validTube();
    const source = buildThreejsFactorySource(spec);
    expect(source).toContain('new THREE.ExtrudeGeometry(shape');
    expect(source).toContain('shape.holes.push(new THREE.Path(');
    expect(source).toContain('new THREE.CatmullRomCurve3(');
    expect(source).toContain('new THREE.TubeGeometry(curve');
    for (const channel of ['ior', 'transmission', 'thickness', 'sheen', 'iridescence', 'anisotropy']) {
      expect(source).toContain(`${channel}: definition.${channel},`);
    }
  });

  // A spec an older install stored under the looser bound must stay exportable —
  // tightening what a provider may author cannot retroactively take Copy/Download
  // away from a `ready` model — and it exports verbatim, since neither dropping
  // the sign nor flooring the zero is a repair this module is entitled to make.
  it('still exports a stored spec whose part scale predates the authoring bound', () => {
    const legacy = validSpec();
    legacy.parts[0].children[0].scale = [1, -1, 0];
    expect(threejsSculptSpecSchema.safeParse(legacy).success).toBe(false);

    const source = buildThreejsFactorySource(legacy);
    expect(source.replace(/\s+/g, '')).toContain('"scale":[1,-1,0]');
  });

  it('reports a malformed stored spec as a 400 naming the offending path', () => {
    const broken = validSpec();
    broken.parts[0].material = 'missing';
    let thrown = null;
    try {
      buildThreejsFactorySource(broken);
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.message).toMatch(/parts\.0\.material: unknown material: missing/);
    expect(thrown?.status).toBe(400);
    expect(thrown?.code).toBe('VALIDATION_ERROR');
  });
});

// A wide, finely-sampled outline that is nonetheless ONE plane in Z: the shape
// the gate exists to catch, and the one a head-on similarity score rewards.
const flatFanGeometry = () => {
  const points = 24;
  const vertices = [];
  const indices = [];
  for (let index = 0; index < points; index += 1) {
    const angle = (index / points) * Math.PI * 2;
    vertices.push(Number(Math.cos(angle).toFixed(3)), Number(Math.sin(angle).toFixed(3)), 0);
  }
  vertices.push(0, 0, 0);
  for (let index = 0; index < points; index += 1) indices.push(points, index, (index + 1) % points);
  return { type: 'custom', vertices, indices };
};

// A lat/long sphere shell — every axis carries far more than the plane
// threshold, which is what having a cross-section looks like numerically.
const solidShellGeometry = () => {
  const rings = 12;
  const segments = 12;
  const vertices = [];
  const indices = [];
  for (let ring = 0; ring <= rings; ring += 1) {
    const phi = (ring / rings) * Math.PI;
    for (let segment = 0; segment < segments; segment += 1) {
      const theta = (segment / segments) * Math.PI * 2;
      vertices.push(
        Number((Math.sin(phi) * Math.cos(theta)).toFixed(3)),
        Number(Math.cos(phi).toFixed(3)),
        Number((Math.sin(phi) * Math.sin(theta)).toFixed(3)),
      );
    }
  }
  for (let index = 0; index + 2 < vertices.length / 3; index += 3) indices.push(index, index + 1, index + 2);
  return { type: 'custom', vertices, indices };
};

const geometryPart = (id, geometry) => ({
  id,
  name: `${id} part`,
  geometry,
  material: 'body',
  position: [0, 0, 0],
  rotationDegrees: [0, 0, 0],
  scale: [1, 1, 1],
  children: [],
});

// Every part gets its own identity-priority detail, so the aggregate ratio is
// exactly the fraction of parts that are slabs.
const flatnessSpec = (parts, priority = 'identity') => ({
  ...validSpec(),
  parts,
  sockets: [],
  detailInventory: parts.map((part) => ({
    feature: `${part.name} silhouette`,
    evidence: 'Visible in the reference image.',
    implementationPartIds: [part.id],
    priority,
  })),
});

describe('evaluateThreejsFlatness', () => {
  it('keeps the fixtures inside the authoring contract', () => {
    const spec = flatnessSpec([geometryPart('fan', flatFanGeometry()), geometryPart('shell', solidShellGeometry())]);
    expect(threejsSculptSpecSchema.safeParse(spec).success).toBe(true);
  });

  it('flags a spec whose identity parts are all slab custom meshes', () => {
    const flatness = evaluateThreejsFlatness(flatnessSpec([
      geometryPart('front', flatFanGeometry()),
      geometryPart('back', flatFanGeometry()),
    ]));
    expect(flatness.findings).toHaveLength(1);
    expect(flatness.findings[0]).toMatchObject({
      code: 'flat-identity-parts',
      severity: 'warning',
      partIds: ['front', 'back'],
    });
    expect(flatness).toMatchObject({
      errorCount: 0,
      warningCount: 1,
      identityDetailCount: 2,
      flatIdentityDetailCount: 2,
      flatRatio: 1,
    });
  });

  it('accepts a custom mesh with a real cross-section on every axis', () => {
    const flatness = evaluateThreejsFlatness(flatnessSpec([
      geometryPart('shellA', solidShellGeometry()),
      geometryPart('shellB', solidShellGeometry()),
    ]));
    expect(flatness.findings).toEqual([]);
    expect(flatness).toMatchObject({ flatIdentityDetailCount: 0, flatRatio: 0, slabPartIds: [] });
  });

  it('still catches a flat fan whose rotation was baked into its vertices', () => {
    // Turned 45° about X, the fan samples a distinct value on every axis, so
    // axis-aligned plane counting alone would read it as solid.
    const turned = flatFanGeometry();
    const half = Math.SQRT1_2;
    for (let index = 0; index < turned.vertices.length; index += 3) {
      const y = turned.vertices[index + 1];
      const z = turned.vertices[index + 2];
      turned.vertices[index + 1] = Number(((y * half) - (z * half)).toFixed(6));
      turned.vertices[index + 2] = Number(((y * half) + (z * half)).toFixed(6));
    }
    const distinctPerAxis = [0, 1, 2].map((axis) => new Set(
      turned.vertices.filter((_, index) => index % 3 === axis),
    ).size);
    // Every axis is now well past the 11-plane threshold the counter uses.
    expect(Math.min(...distinctPerAxis)).toBeGreaterThan(11);

    const flatness = evaluateThreejsFlatness(flatnessSpec([geometryPart('badge', turned)]));
    expect(flatness.findings.map((finding) => finding.code)).toEqual(['flat-identity-parts']);
  });

  it('judges the shape, not where it was authored', () => {
    const shifted = solidShellGeometry();
    shifted.vertices = shifted.vertices.map((value, index) => (index % 3 === 0 ? value + 900 : value));
    const flatness = evaluateThreejsFlatness(flatnessSpec([geometryPart('shell', shifted)]));
    expect(flatness).toMatchObject({ flatIdentityDetailCount: 0, findings: [] });
  });

  it('does not punish a small part for being small', () => {
    // A fixed absolute plane grid would give a 0.005-unit mesh five planes per
    // axis however round it is; the quantum is relative to the mesh's own size.
    const tiny = solidShellGeometry();
    tiny.vertices = tiny.vertices.map((value) => Number((value * 0.005).toFixed(6)));
    const flatness = evaluateThreejsFlatness(flatnessSpec([geometryPart('rivet', tiny)]));
    expect(flatness).toMatchObject({ flatIdentityDetailCount: 0, findings: [] });
  });

  it('reads an unbevelled extrude as a slab and a bevelled one as solid', () => {
    const unbevelled = { ...validExtrude(), bevelEnabled: false };
    const bevelled = { ...validExtrude(), bevelEnabled: true, bevelThickness: 0.15, bevelSize: 0.1 };

    const flat = evaluateThreejsFlatness(flatnessSpec([geometryPart('plate', unbevelled)]));
    expect(flat.findings.map((finding) => finding.code)).toEqual(['flat-identity-parts']);
    expect(flat.flatRatio).toBe(1);

    const solid = evaluateThreejsFlatness(flatnessSpec([geometryPart('plate', bevelled)]));
    expect(solid.findings).toEqual([]);
    expect(solid.flatRatio).toBe(0);
  });

  it('does not accept a zero-thickness bevel as depth', () => {
    // Flipping the flag while leaving the bevel flat is the cheapest way to
    // answer the gate without touching the geometry, so it stays a slab.
    const pretend = { ...validExtrude(), bevelEnabled: true, bevelThickness: 0, bevelSize: 0.2 };
    const flatness = evaluateThreejsFlatness(flatnessSpec([geometryPart('plate', pretend)]));
    expect(flatness.findings.map((finding) => finding.code)).toEqual(['flat-identity-parts']);
  });

  it('stays quiet while flat parts are the minority — extrude is right for a plate', () => {
    const flatness = evaluateThreejsFlatness(flatnessSpec([
      geometryPart('badge', { ...validExtrude(), bevelEnabled: false }),
      geometryPart('shellA', solidShellGeometry()),
      geometryPart('shellB', solidShellGeometry()),
    ]));
    expect(flatness.findings).toEqual([]);
    // Still recorded, so the UI can show which part the one flat feature used.
    expect(flatness).toMatchObject({ flatIdentityDetailCount: 1, slabPartIds: ['badge'] });
    expect(flatness.flatRatio).toBeCloseTo(1 / 3);
  });

  it('ignores flat parts that carry no identity-priority feature', () => {
    const flatness = evaluateThreejsFlatness(flatnessSpec([
      geometryPart('vent', flatFanGeometry()),
      geometryPart('grille', flatFanGeometry()),
    ], 'minor'));
    expect(flatness.findings).toEqual([]);
    expect(flatness).toMatchObject({ identityDetailCount: 0, flatIdentityDetailCount: 0, flatRatio: null });
  });

  it('measures the meshes beneath a group rather than the group itself', () => {
    const group = {
      ...geometryPart('housing', undefined),
      children: [geometryPart('housingShell', solidShellGeometry())],
    };
    delete group.geometry;
    delete group.material;
    const flatness = evaluateThreejsFlatness(flatnessSpec([group]));
    expect(flatness).toMatchObject({ identityDetailCount: 1, flatIdentityDetailCount: 0 });
  });

  it('leaves a detail nothing was built for to the assembly-coverage gate', () => {
    const locator = { ...geometryPart('anchor', undefined), children: [] };
    delete locator.geometry;
    delete locator.material;
    const flatness = evaluateThreejsFlatness(flatnessSpec([locator]));
    // `null`, not 0 — nothing was measured, which is not the same as passing.
    expect(flatness).toMatchObject({ identityDetailCount: 0, flatRatio: null, findings: [] });
  });

  it('returns a clean result for a missing spec', () => {
    expect(evaluateThreejsFlatness(null)).toMatchObject({ findings: [], flatRatio: null });
  });
});

describe('buildThreejsFlatnessFeedback', () => {
  it('returns empty for a missing or clean flatness result', () => {
    expect(buildThreejsFlatnessFeedback(null)).toBe('');
    expect(buildThreejsFlatnessFeedback({ findings: [] })).toBe('');
  });

  it('turns the warning into a numbered instruction naming the offending parts', () => {
    const flatness = evaluateThreejsFlatness(flatnessSpec([
      geometryPart('front', flatFanGeometry()),
      geometryPart('back', flatFanGeometry()),
    ]));
    const feedback = buildThreejsFlatnessFeedback(flatness);
    expect(feedback).toContain('cross-section check');
    expect(feedback).toContain('1. ');
    expect(feedback).toContain('front part');
    expect(feedback).toContain('genuine depth');
  });
});

// A two-joint character graph over the shared fixture: the crate body is the
// root and its trim is a child that pivots about a declared socket.
const articulatedSpec = () => {
  const spec = validSpec();
  spec.subjectType = 'character';
  spec.sockets = [
    ...spec.sockets,
    { name: 'trimPivot', parentPartId: 'frontTrim', position: [0, 0, 0], rotationDegrees: [0, 0, 0] },
  ];
  spec.articulation = {
    joints: [
      { id: 'rootJoint', partId: 'crateBody', parentJointId: null, pivotSocket: null },
      { id: 'trimJoint', partId: 'frontTrim', parentJointId: 'rootJoint', pivotSocket: 'trimPivot' },
    ],
    attachmentPartIds: [],
  };
  return spec;
};

const articulationIssues = (mutate) => {
  const spec = articulatedSpec();
  mutate(spec);
  const result = threejsSculptSpecSchema.safeParse(spec);
  expect(result.success).toBe(false);
  return result.error.issues.map((issue) => issue.message);
};

describe('threejsSculptSpecSchema articulation', () => {
  it('accepts a well-formed graph and fills the optional joint fields', () => {
    const parsed = threejsSculptSpecSchema.parse(articulatedSpec());
    expect(parsed.articulation.joints[0].parentJointId).toBeNull();
    expect(parsed.articulation.joints[1].pivotSocket).toBe('trimPivot');
    expect(parsed.articulation.attachmentPartIds).toEqual([]);
  });

  // The whole point of the field being optional: a record written before it
  // existed has no key at all, and must not acquire one on read.
  it('leaves a spec that declares no articulation without the key', () => {
    const parsed = threejsSculptSpecSchema.parse(validSpec());
    expect(parsed.articulation).toBeUndefined();
    expect(storedThreejsSculptSpecSchema.parse(validSpec()).articulation).toBeUndefined();
  });

  it('rejects duplicate joint ids', () => {
    expect(articulationIssues((spec) => {
      spec.articulation.joints[1].id = 'rootJoint';
    })).toEqual(expect.arrayContaining(['duplicate joint id: rootJoint']));
  });

  it('rejects two roots and a graph with no root at all', () => {
    expect(articulationIssues((spec) => {
      spec.articulation.joints[1].parentJointId = null;
    })).toEqual(expect.arrayContaining([expect.stringContaining('exactly one root joint')]));
    expect(articulationIssues((spec) => {
      spec.articulation.joints[0].parentJointId = 'trimJoint';
    })).toEqual(expect.arrayContaining([expect.stringContaining('exactly one root joint')]));
  });

  it('rejects a dangling parent and a forward reference, which is what makes a cycle unrepresentable', () => {
    expect(articulationIssues((spec) => {
      spec.articulation.joints[1].parentJointId = 'noSuchJoint';
    })).toEqual(expect.arrayContaining([
      'joint trimJoint names parent noSuchJoint, which is not a joint declared before it',
    ]));
    // A two-joint cycle can only be written as a forward reference, so the
    // earlier-only rule rejects it without walking the graph.
    expect(articulationIssues((spec) => {
      spec.articulation.joints[0].parentJointId = 'trimJoint';
      spec.articulation.joints[1].parentJointId = 'rootJoint';
    })).toEqual(expect.arrayContaining([
      'joint rootJoint names parent trimJoint, which is not a joint declared before it',
    ]));
  });

  it('rejects joints pointed at parts and sockets that do not exist', () => {
    expect(articulationIssues((spec) => {
      spec.articulation.joints[1].partId = 'notARealPart';
      spec.articulation.joints[1].pivotSocket = 'notARealSocket';
    })).toEqual(expect.arrayContaining([
      'unknown joint part: notARealPart',
      'unknown pivot socket: notARealSocket',
    ]));
  });

  it('rejects one part driven by two joints', () => {
    expect(articulationIssues((spec) => {
      spec.articulation.joints[1].partId = 'crateBody';
    })).toEqual(expect.arrayContaining(['part crateBody is already driven by another joint']));
  });

  it('rejects an attachment that is unknown or also articulated', () => {
    expect(articulationIssues((spec) => {
      spec.articulation.attachmentPartIds = ['notARealPart'];
    })).toEqual(expect.arrayContaining(['unknown attachment part: notARealPart']));
    expect(articulationIssues((spec) => {
      spec.articulation.attachmentPartIds = ['frontTrim'];
    })).toEqual(expect.arrayContaining([
      'part frontTrim is declared as an attachment and also driven by a joint',
    ]));
  });
});

describe('buildThreejsFactorySource articulation', () => {
  it('carries a validated graph into the exported runtime metadata', () => {
    const source = buildThreejsFactorySource(articulatedSpec());
    expect(source).toContain('articulation: spec.articulation || null,');
    expect(source.replace(/\s+/g, '')).toContain('"pivotSocket":"trimPivot"');
  });

  it('exports null articulation for a spec that declares none, and never invents one', () => {
    const source = buildThreejsFactorySource(validSpec());
    expect(source).toContain('articulation: spec.articulation || null,');
    expect(source).not.toContain('"joints"');
  });

  // Only VALIDATED metadata reaches the factory: an impossible graph fails the
  // export the same way a bad material reference does, rather than being
  // serialized into a file a downstream tool would trust.
  it('refuses to export an impossible graph', () => {
    const broken = articulatedSpec();
    broken.articulation.joints[1].parentJointId = 'noSuchJoint';
    let thrown = null;
    try {
      buildThreejsFactorySource(broken);
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.status).toBe(400);
    expect(thrown?.message).toMatch(/not a joint declared before it/);
  });
});

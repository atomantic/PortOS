import { describe, expect, it } from 'vitest';
import {
  buildThreejsFactorySource,
  buildThreejsFlatnessFeedback,
  buildThreejsMaterialFeedback,
  collectDeclaredCurvedParts,
  DEFAULT_ATTACHMENT_MAX_OFFSET,
  evaluateSweptArcCurvature,
  evaluateSweptGeometryCurvature,
  evaluateThreejsFlatness,
  evaluateThreejsMaterialPlausibility,
  isThreejsAttachmentAnchored,
  measureOutlineConcaveTurn,
  resolveThreejsAttachments,
  storedThreejsSculptSpecSchema,
  threejsGeometrySchema,
  threejsSculptSpecSchema,
} from './threejsModel.js';
import { resolveThreejsEnvironment } from './threejsModelEnvironment.js';

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
    expect(parsed.materials.body.side).toBe('front');
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

  it('emits the declared double-sided material option for the standalone factory', () => {
    const spec = validSpec();
    spec.materials.body.side = 'double';
    const source = buildThreejsFactorySource(spec);
    expect(source).toContain('"side": "double"');
    expect(source).toContain('const doubleSided = definition.side === \'double\' ? { side: THREE.DoubleSide } : {};');
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

const thinCustomGeometry = () => {
  const outline = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const vertices = [-0.0005, 0.0005].flatMap((z) => outline.flatMap(([x, y]) => [x, y, z]));
  return { type: 'custom', vertices, indices: [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6] };
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

  it('notes a flat identity part as an intentional membrane when its material is double-sided', () => {
    const spec = flatnessSpec([geometryPart('membrane', flatFanGeometry())]);
    spec.materials.body.side = 'double';
    const flatness = evaluateThreejsFlatness(spec);
    expect(flatness).toMatchObject({
      warningCount: 0,
      noteCount: 1,
      flatIdentityDetailCount: 1,
      flatRatio: 1,
    });
    expect(flatness.findings[0]).toMatchObject({
      code: 'flat-identity-parts',
      severity: 'note',
      partIds: ['membrane'],
      features: ['membrane part silhouette'],
    });
    expect(flatness.findings[0].message).toContain('intentional membrane surfaces');
    expect(buildThreejsFlatnessFeedback(flatness)).toBe('');
  });

  it('keeps a positive-depth double-sided extrude in the solid-part warning', () => {
    const spec = flatnessSpec([geometryPart('plate', validExtrude())]);
    spec.materials.body.side = 'double';
    const flatness = evaluateThreejsFlatness(spec);
    expect(flatness).toMatchObject({ warningCount: 1, noteCount: 0, flatRatio: 1 });
    expect(flatness.findings[0].severity).toBe('warning');
    expect(buildThreejsFlatnessFeedback(flatness)).toContain('genuine depth');
  });

  it('accepts a double-sided near-zero-depth extrude as an intentional membrane', () => {
    const spec = flatnessSpec([geometryPart('membrane', { ...validExtrude(), depth: 0.001 })]);
    spec.materials.body.side = 'double';
    const flatness = evaluateThreejsFlatness(spec);
    expect(flatness).toMatchObject({ warningCount: 0, noteCount: 1, flatRatio: 1 });
    expect(flatness.findings[0].severity).toBe('note');
  });

  it('keeps a scaled near-zero-depth child in the solid-part warning', () => {
    const parent = geometryPart('parent', undefined);
    delete parent.material;
    parent.scale = [1, 1, 1_000];
    parent.children = [geometryPart('plate', { ...validExtrude(), depth: 0.001 })];
    const spec = flatnessSpec([parent]);
    spec.materials.body.side = 'double';
    const flatness = evaluateThreejsFlatness(spec);
    expect(flatness).toMatchObject({ warningCount: 1, noteCount: 0, flatRatio: 1 });
    expect(flatness.findings[0].severity).toBe('warning');
  });

  it('keeps a thin custom solid in the warning after normal-axis scaling', () => {
    const spec = flatnessSpec([geometryPart('plate', thinCustomGeometry())]);
    spec.parts[0].scale = [1, 1, 1_000];
    spec.materials.body.side = 'double';
    const flatness = evaluateThreejsFlatness(spec);
    expect(flatness).toMatchObject({ warningCount: 1, noteCount: 0, flatRatio: 1 });
    expect(flatness.findings[0].severity).toBe('warning');
  });

  it('keeps duplicate feature labels classified independently', () => {
    const membrane = geometryPart('membrane', flatFanGeometry());
    const plate = geometryPart('plate', validExtrude());
    membrane.material = 'membrane';
    plate.material = 'plate';
    const spec = flatnessSpec([membrane, plate]);
    spec.materials.membrane = { ...spec.materials.body, side: 'double' };
    spec.materials.plate = { ...spec.materials.body, side: 'double' };
    spec.detailInventory[0].feature = 'shared feature';
    spec.detailInventory[1].feature = 'shared feature';
    const flatness = evaluateThreejsFlatness(spec);
    expect(flatness).toMatchObject({ warningCount: 1, noteCount: 1, flatRatio: 1 });
    expect(flatness.findings.map((finding) => finding.severity)).toEqual(['note', 'warning']);
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

// The same graph plus a carried part and the plate it hangs from, both nested
// under the single top-level part so the model root stays unambiguous.
const anchoredSpec = () => {
  const spec = articulatedSpec();
  const body = spec.parts[0];
  body.children.push({
    id: 'backPlate',
    name: 'Back plate',
    geometry: { type: 'box', width: 1.6, height: 1, depth: 0.06 },
    material: 'body',
    position: [0, 0, -0.63],
    rotationDegrees: [0, 0, 0],
    scale: [1, 1, 1],
    children: [],
  });
  body.children.push({
    id: 'pack',
    name: 'Pack',
    geometry: { type: 'box', width: 0.8, height: 0.6, depth: 0.3 },
    material: 'body',
    position: [0, 0, -0.8],
    rotationDegrees: [0, 0, 0],
    scale: [1, 1, 1],
    children: [],
  });
  spec.sockets = [
    ...spec.sockets,
    { name: 'packSocket', parentPartId: 'backPlate', position: [0, 0, -0.03], rotationDegrees: [0, 0, 0] },
  ];
  spec.articulation.attachments = [{ partId: 'pack', anchorPartId: 'backPlate' }];
  return spec;
};

const anchorIssues = (mutate) => {
  const spec = anchoredSpec();
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

  // Attachment anchors. `attachmentPartIds` says a part is CARRIED; only an
  // anchor says what carries it, which is the difference between a hat on a head
  // and a hat at hip height that every other gate reads as fine.
  it('accepts an anchored attachment and defaults its offset tolerance', () => {
    const parsed = threejsSculptSpecSchema.parse(anchoredSpec());
    expect(parsed.articulation.attachments).toEqual([
      { partId: 'pack', anchorPartId: 'backPlate', anchorSocket: null, maxOffset: DEFAULT_ATTACHMENT_MAX_OFFSET },
    ]);
  });

  // Additive, not a replacement: a spec written before anchors shipped keeps
  // parsing and simply carries an empty anchored list.
  it('leaves a legacy attachmentPartIds spec valid, on both the authoring and stored schemas', () => {
    const legacy = anchoredSpec();
    legacy.articulation.attachmentPartIds = ['pack'];
    delete legacy.articulation.attachments;
    for (const schema of [threejsSculptSpecSchema, storedThreejsSculptSpecSchema]) {
      const parsed = schema.parse(legacy);
      expect(parsed.articulation.attachmentPartIds).toEqual(['pack']);
      expect(parsed.articulation.attachments).toEqual([]);
    }
  });

  it('requires exactly one anchor field per attachment', () => {
    expect(anchorIssues((spec) => {
      spec.articulation.attachments[0].anchorPartId = null;
    })).toEqual(expect.arrayContaining([
      'attachment pack needs exactly one of anchorPartId or anchorSocket, found 0',
    ]));
    expect(anchorIssues((spec) => {
      spec.articulation.attachments[0].anchorSocket = 'packSocket';
    })).toEqual(expect.arrayContaining([
      'attachment pack needs exactly one of anchorPartId or anchorSocket, found 2',
    ]));
  });

  it('rejects an anchor that names no declared part or socket', () => {
    expect(anchorIssues((spec) => {
      spec.articulation.attachments[0].anchorPartId = 'notARealPart';
    })).toEqual(expect.arrayContaining(['unknown attachment anchor part: notARealPart']));
    expect(anchorIssues((spec) => {
      spec.articulation.attachments[0].anchorPartId = null;
      spec.articulation.attachments[0].anchorSocket = 'notARealSocket';
    })).toEqual(expect.arrayContaining(['unknown attachment anchor socket: notARealSocket']));
  });

  it('rejects an attachment anchored to itself', () => {
    expect(anchorIssues((spec) => {
      spec.articulation.attachments[0].anchorPartId = 'pack';
    })).toEqual(expect.arrayContaining(['attachment pack is anchored to itself']));
  });

  // The literal defect this field exists for: the root carries no relationship
  // to any body part, so "anchored to the root" is the same silence as no anchor.
  it('rejects an anchor on the model root, named through a part or through a socket', () => {
    expect(anchorIssues((spec) => {
      spec.articulation.attachments[0].anchorPartId = 'crateBody';
    })).toEqual(expect.arrayContaining([
      'attachment pack is anchored to the model root crateBody, which names no body part to hang from',
    ]));
    expect(anchorIssues((spec) => {
      spec.articulation.attachments[0].anchorPartId = null;
      spec.articulation.attachments[0].anchorSocket = 'lidPivot';
    })).toEqual(expect.arrayContaining([
      'attachment pack is anchored to the model root crateBody, which names no body part to hang from',
    ]));
  });

  // A model with several top-level parts has no single container, so each of
  // them is a real component worth anchoring to.
  it('allows a top-level anchor when the spec has more than one top-level part', () => {
    const spec = anchoredSpec();
    spec.parts.push({
      id: 'standAlone',
      name: 'Stand',
      geometry: { type: 'box', width: 1, height: 0.2, depth: 1 },
      material: 'body',
      position: [0, 0.1, 0],
      rotationDegrees: [0, 0, 0],
      scale: [1, 1, 1],
      children: [],
    });
    spec.articulation.attachments[0].anchorPartId = 'crateBody';
    expect(threejsSculptSpecSchema.safeParse(spec).success).toBe(true);
  });

  it('rejects an anchor chain that cycles', () => {
    expect(anchorIssues((spec) => {
      spec.articulation.attachments = [
        { partId: 'pack', anchorPartId: 'backPlate' },
        { partId: 'backPlate', anchorPartId: 'pack' },
      ];
    })).toEqual(expect.arrayContaining([
      expect.stringContaining('sits on an anchor chain that cycles back through'),
    ]));
  });

  it('rejects a duplicate attachment entry and one that is also driven by a joint', () => {
    expect(anchorIssues((spec) => {
      spec.articulation.attachments.push({ partId: 'pack', anchorPartId: 'backPlate' });
    })).toEqual(expect.arrayContaining(['duplicate attachment part: pack']));
    expect(anchorIssues((spec) => {
      spec.articulation.attachments[0].partId = 'frontTrim';
    })).toEqual(expect.arrayContaining([
      'part frontTrim is declared as an attachment and also driven by a joint',
    ]));
  });
});

describe('resolveThreejsAttachments', () => {
  it('reads the legacy list forward as anchor-less entries', () => {
    expect(resolveThreejsAttachments({ attachmentPartIds: ['pack'] })).toEqual([
      { partId: 'pack', anchorPartId: null, anchorSocket: null, maxOffset: DEFAULT_ATTACHMENT_MAX_OFFSET },
    ]);
  });

  // The richer declaration is the one the author meant, so it wins rather than
  // the part being counted twice with contradictory anchors.
  it('lets an anchored entry win over a bare id for the same part', () => {
    const resolved = resolveThreejsAttachments({
      attachmentPartIds: ['pack'],
      attachments: [{ partId: 'pack', anchorPartId: 'backPlate', anchorSocket: null, maxOffset: 1 }],
    });
    expect(resolved).toEqual([
      { partId: 'pack', anchorPartId: 'backPlate', anchorSocket: null, maxOffset: 1 },
    ]);
    expect(resolved.every(isThreejsAttachmentAnchored)).toBe(true);
  });

  it('reads a missing or malformed articulation as no attachments at all', () => {
    for (const value of [null, undefined, {}, { attachmentPartIds: 'nope', attachments: 7 }]) {
      expect(resolveThreejsAttachments(value)).toEqual([]);
    }
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

// The plausibility gate reads materials only, so the fixture keeps the shared
// crate hierarchy and swaps the material map. Every material is parsed through
// the real schema first, so a fixture can never assert on a value the authoring
// contract would have rejected anyway.
// Every case that is about SUBSTANCE plausibility gets a real environment, so the
// unlit-reflective note never lands in its findings; the environment cases pass
// null to omit the key entirely, which is what a record stored before the block
// shipped looks like.
const materialSpec = (materials, environment = { preset: 'studio', intensity: 1 }) => threejsSculptSpecSchema.parse({
  ...validSpec(),
  ...(environment ? { environment } : {}),
  materials,
  parts: [{ ...validSpec().parts[0], children: [], material: Object.keys(materials)[0] }],
  sockets: [],
  detailInventory: [{
    feature: 'Crate body silhouette',
    evidence: 'Visible in the reference image.',
    implementationPartIds: ['crateBody'],
    priority: 'identity',
  }],
});

describe('evaluateThreejsMaterialPlausibility', () => {
  it('flags metallic wood and names the channel, the value, and the plausible range', () => {
    const result = evaluateThreejsMaterialPlausibility(materialSpec({
      oakPanel: { type: 'standard', color: '#8b5a2b', metalness: 0.9, roughness: 0.7 },
    }));
    expect(result.warningCount).toBe(1);
    expect(result.errorCount).toBe(0);
    expect(result.matchedMaterialCount).toBe(1);
    const [finding] = result.findings;
    expect(finding.code).toBe('implausible-material-values');
    expect(finding.family).toBe('wood');
    expect(finding.materialIds).toEqual(['oakPanel']);
    expect(finding.channels).toEqual([{ channel: 'metalness', value: 0.9, min: 0, max: 0.15 }]);
    expect(finding.message).toContain('metalness 0.9');
    expect(finding.message).toContain('0–0.15');
  });

  it('flags a transmissive metal and an opaque glass — the two directions of the same error', () => {
    const result = evaluateThreejsMaterialPlausibility(materialSpec({
      steelPlate: { type: 'physical', color: '#8a8f98', metalness: 0.95, roughness: 0.3, transmission: 1 },
      windowGlass: { type: 'physical', color: '#cfe8ff', metalness: 0, roughness: 0.05, transmission: 0 },
    }));
    expect(result.warningCount).toBe(2);
    expect(result.findings.map((finding) => finding.family)).toEqual(['metal', 'glass']);
    expect(result.findings[0].channels[0].channel).toBe('transmission');
    expect(result.findings[1].channels[0]).toMatchObject({ channel: 'transmission', value: 0, min: 0.4 });
  });

  it('flags bare metal that is not metallic at all', () => {
    const result = evaluateThreejsMaterialPlausibility(materialSpec({
      brassFitting: { type: 'standard', color: '#d4af37', metalness: 0, roughness: 0.3 },
    }));
    expect(result.findings[0].channels).toEqual([{ channel: 'metalness', value: 0, min: 0.6, max: 1 }]);
  });

  it('reports every offending channel of one material in a single finding', () => {
    const result = evaluateThreejsMaterialPlausibility(materialSpec({
      rubberTire: { type: 'physical', color: '#1b1b1b', metalness: 0.5, roughness: 0.05, clearcoat: 1 },
    }));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].channels.map((entry) => entry.channel)).toEqual(['metalness', 'roughness', 'clearcoat']);
  });

  it('stays silent on plausible materials, unrecognized ids, and mixed-substance ids', () => {
    const result = evaluateThreejsMaterialPlausibility(materialSpec({
      oakPanel: { type: 'standard', color: '#8b5a2b', metalness: 0, roughness: 0.7 },
      primarySurface: { type: 'standard', color: '#334155', metalness: 0.9, roughness: 0.05 },
      woodAndMetalTrim: { type: 'standard', color: '#8b5a2b', metalness: 0.9, roughness: 0.05 },
    }));
    expect(result.findings).toEqual([]);
    expect(result.materialCount).toBe(3);
    // Only the plausible oak matched a family — the other two were skipped.
    expect(result.matchedMaterialCount).toBe(1);
  });

  it('tokenizes camelCase, separators, and plurals the same way', () => {
    for (const id of ['oakPlanks', 'oak_planks', 'oak-planks-01']) {
      const result = evaluateThreejsMaterialPlausibility(materialSpec({
        [id]: { type: 'standard', color: '#8b5a2b', metalness: 0.9, roughness: 0.7 },
      }));
      expect(result.findings[0]?.family).toBe('wood');
    }
  });

  it('ignores channels the material type never forwards to Three.js', () => {
    // `transmission` is physical-only and `basic` is unlit, so neither material
    // renders the implausible value it carries.
    const result = evaluateThreejsMaterialPlausibility(materialSpec({
      steelPanel: { type: 'standard', color: '#8a8f98', metalness: 0.9, roughness: 0.3, transmission: 1 },
      chromeDecal: { type: 'basic', color: '#8a8f98', metalness: 0, roughness: 1 },
    }));
    expect(result.findings).toEqual([]);
  });

  it('returns a clean result for a missing spec', () => {
    expect(evaluateThreejsMaterialPlausibility(null)).toMatchObject({
      findings: [],
      materialCount: 0,
      matchedMaterialCount: 0,
    });
  });
});

describe('evaluateThreejsMaterialPlausibility environment', () => {
  const notes = (result) => result.findings.filter((finding) => finding.severity === 'note');

  // The whole point of the note: metalness 0.95 is exactly what the metal prior
  // ASKS for, so it draws no substance warning — and in a scene with no
  // environment it renders near-black anyway.
  it('notes a plausible conductor that has nothing to reflect', () => {
    const result = evaluateThreejsMaterialPlausibility(materialSpec({
      steelPlate: { type: 'standard', color: '#8a8f98', metalness: 0.95, roughness: 0.2 },
    }, null));
    expect(result.warningCount).toBe(0);
    expect(result.noteCount).toBe(1);
    const [note] = notes(result);
    expect(note.code).toBe('reflective-material-without-environment');
    expect(note.materialIds).toEqual(['steelPlate']);
    expect(note.message).toContain('metalness');
    expect(note.message).toContain('"none"');
  });

  it('names transmission, clearcoat, and iridescence as reflective too', () => {
    const result = evaluateThreejsMaterialPlausibility(materialSpec({
      windowPane: { type: 'physical', color: '#cfe8ff', metalness: 0, roughness: 0.05, transmission: 0.9, ior: 1.5 },
      lacquerShell: { type: 'physical', color: '#334155', metalness: 0, roughness: 0.3, clearcoat: 0.8 },
      pearlInlay: { type: 'physical', color: '#f5f5f4', metalness: 0, roughness: 0.2, iridescence: 0.7 },
    }, null));
    const [note] = notes(result);
    expect(note.materialIds).toEqual(['windowPane', 'lacquerShell', 'pearlInlay']);
    expect(note.message).toContain('transmission');
    expect(note.message).toContain('clearcoat');
    expect(note.message).toContain('iridescence');
  });

  it('stays silent once the spec authors an environment', () => {
    const materials = {
      steelPlate: { type: 'standard', color: '#8a8f98', metalness: 0.95, roughness: 0.2 },
    };
    expect(notes(evaluateThreejsMaterialPlausibility(materialSpec(materials, { preset: 'neutral', intensity: 1 })))).toEqual([]);
    expect(notes(evaluateThreejsMaterialPlausibility(materialSpec(materials, { preset: 'studio', intensity: 2 })))).toEqual([]);
    // An explicit "none" is the same scene as no key at all, so it still notes.
    expect(notes(evaluateThreejsMaterialPlausibility(materialSpec(materials, { preset: 'none', intensity: 1 })))).toHaveLength(1);
  });

  // A channel the material's type never forwards cannot render, so it cannot be
  // the reason anything looks wrong — and a dielectric with a trace of metalness
  // has essentially nothing to lose.
  it('ignores channels the type drops, unlit materials, and non-reflective values', () => {
    const result = evaluateThreejsMaterialPlausibility(materialSpec({
      plasticShell: { type: 'standard', color: '#334155', metalness: 0.2, roughness: 0.5, transmission: 1, clearcoat: 1 },
      decalSticker: { type: 'basic', color: '#8a8f98', metalness: 1, roughness: 0 },
    }, null));
    expect(notes(result)).toEqual([]);
  });

  it('feeds the note back so a refinement fixes the scene instead of the metal', () => {
    const feedback = buildThreejsMaterialFeedback(evaluateThreejsMaterialPlausibility(materialSpec({
      steelPlate: { type: 'standard', color: '#8a8f98', metalness: 0.95, roughness: 0.2 },
    }, null)));
    expect(feedback).toContain('steelPlate');
    expect(feedback).toContain('environment');
    // No substance warning fired, so the feedback must not open with one.
    expect(feedback).not.toContain('do not match the substance');
  });
});

describe('threejsSculptSpecSchema environment', () => {
  it('accepts a bounded preset and intensity', () => {
    const parsed = threejsSculptSpecSchema.parse({ ...validSpec(), environment: { preset: 'studio', intensity: 2.5 } });
    expect(parsed.environment).toEqual({ preset: 'studio', intensity: 2.5 });
    expect(threejsSculptSpecSchema.safeParse({ ...validSpec(), environment: { preset: 'hdri' } }).success).toBe(false);
    expect(threejsSculptSpecSchema.safeParse({ ...validSpec(), environment: { preset: 'studio', intensity: 9 } }).success).toBe(false);
  });

  // Additive-optional, the same contract as `articulation` and `animation`: a
  // record an install stored before this block shipped must parse untouched, and
  // must not acquire a key claiming an environment it never had.
  it('leaves a stored spec that predates it alone, and reads it as none', () => {
    const legacy = validSpec();
    const parsed = storedThreejsSculptSpecSchema.parse(legacy);
    expect(parsed.environment).toBeUndefined();
    expect(resolveThreejsEnvironment(parsed)).toEqual({ preset: 'none', intensity: 1 });
  });

  it('reads a partial or unrecognized block as the default for the missing half', () => {
    // A newer peer's preset name resolves to `none` rather than to a guess.
    expect(resolveThreejsEnvironment({ environment: { preset: 'hdri', intensity: 2 } })).toEqual({ preset: 'none', intensity: 2 });
    expect(resolveThreejsEnvironment({ environment: { preset: 'studio' } })).toEqual({ preset: 'studio', intensity: 1 });
    expect(resolveThreejsEnvironment(null)).toEqual({ preset: 'none', intensity: 1 });
  });
});

describe('buildThreejsFactorySource render profile', () => {
  it('stamps the renderer contract the model was authored against', () => {
    const source = buildThreejsFactorySource({ ...validSpec(), environment: { preset: 'studio', intensity: 1.5 } });
    expect(source).toContain('const renderProfile = {');
    expect(source).toContain('export { spec, renderProfile };');
    expect(source).toContain('render: renderProfile,');
    const flat = source.replace(/\s+/g, '');
    expect(flat).toContain('"outputColorSpace":"srgb"');
    expect(flat).toContain('"toneMapping":"ACESFilmic"');
    expect(flat).toContain('"toneMappingExposure":1');
    expect(flat).toContain('"environment":{"preset":"studio","intensity":1.5}');
    // The intensity has to REACH the material, or the profile is a claim the
    // export does not honour.
    expect(source).toContain('envMapIntensity: renderProfile.environment.intensity,');
  });

  it('stamps the none profile for a stored spec that predates the environment block', () => {
    const source = buildThreejsFactorySource(validSpec());
    expect(source.replace(/\s+/g, '')).toContain('"environment":{"preset":"none","intensity":1}');
    // …without inventing the key on the serialized spec itself: the ONE
    // occurrence is the render profile's, so the exported spec still round-trips
    // as the environment-less record the install actually stored.
    expect(source.match(/"environment"/g)).toHaveLength(1);
    expect(buildThreejsFactorySource({ ...validSpec(), environment: { preset: 'neutral', intensity: 1 } })
      .match(/"environment"/g)).toHaveLength(2);
  });
});

describe('buildThreejsMaterialFeedback', () => {
  it('returns empty for a missing or clean plausibility result', () => {
    expect(buildThreejsMaterialFeedback(null)).toBe('');
    expect(buildThreejsMaterialFeedback({ findings: [] })).toBe('');
  });

  it('turns the warnings into a numbered instruction naming each material', () => {
    const feedback = buildThreejsMaterialFeedback(evaluateThreejsMaterialPlausibility(materialSpec({
      oakPanel: { type: 'standard', color: '#8b5a2b', metalness: 0.9, roughness: 0.7 },
      steelPlate: { type: 'standard', color: '#8a8f98', metalness: 0, roughness: 0.3 },
    })));
    expect(feedback).toContain('do not match the substance');
    expect(feedback).toContain('1. ');
    expect(feedback).toContain('2. ');
    expect(feedback).toContain('oakPanel');
    expect(feedback).toContain('steelPlate');
  });
});

const animatedSpec = () => {
  const spec = validSpec();
  spec.animation = {
    cues: [{ id: 'latchRelease', label: 'Latch lets go', kind: 'latch' }],
    clips: [{
      id: 'deploy',
      name: 'Deploy',
      role: 'deploy',
      durationSeconds: 2,
      sequences: [
        {
          id: 'liftLid',
          name: 'Lift lid',
          partId: 'frontTrim',
          startSeconds: 0,
          endSeconds: 1,
          easing: 'easeOut',
          channels: { position: { from: [0, 0, 0.64], to: [0, 0.6, 0.64] } },
          cueId: 'latchRelease',
        },
        {
          id: 'hideTrim',
          name: 'Hide trim',
          partId: 'frontTrim',
          startSeconds: 1,
          endSeconds: 2,
          channels: { visible: { from: true, to: false } },
        },
      ],
    }],
  };
  return spec;
};

const animationIssues = (mutate) => {
  const spec = animatedSpec();
  mutate(spec);
  const result = threejsSculptSpecSchema.safeParse(spec);
  expect(result.success).toBe(false);
  return result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
};

describe('threejsSculptSpecSchema animation', () => {
  it('accepts a well-formed clip and fills the optional sequence fields', () => {
    const parsed = threejsSculptSpecSchema.parse(animatedSpec());
    expect(parsed.animation.clips[0].loop).toBe(false);
    expect(parsed.animation.clips[0].sequences[1].easing).toBe('easeInOut');
    expect(parsed.animation.clips[0].sequences[1].cueId).toBeNull();
    expect(parsed.animation.cues[0].kind).toBe('latch');
  });

  // The whole point of the field being optional: a record written before clips
  // existed has no key at all, and must not acquire one on read.
  it('leaves a spec that declares no animation without the key, on both contracts', () => {
    expect(threejsSculptSpecSchema.parse(validSpec()).animation).toBeUndefined();
    expect(storedThreejsSculptSpecSchema.parse(validSpec()).animation).toBeUndefined();
  });

  it('accepts a stored animated spec whose part scale predates the authoring floor', () => {
    const spec = animatedSpec();
    spec.parts[0].scale = [1, 0, 1];
    spec.animation.clips[0].sequences[0].channels.scale = { from: [1, 0, 1], to: [1, 1, 1] };
    expect(threejsSculptSpecSchema.safeParse(spec).success).toBe(false);
    expect(storedThreejsSculptSpecSchema.safeParse(spec).success).toBe(true);
  });

  it('rejects a sequence pointed at a part that does not exist, naming the path', () => {
    expect(animationIssues((spec) => {
      spec.animation.clips[0].sequences[0].partId = 'notARealPart';
    })).toEqual(expect.arrayContaining([
      'animation.clips.0.sequences.0.partId: unknown sequence part: notARealPart',
    ]));
  });

  it('rejects a window that ends before it starts and one that outruns its clip', () => {
    expect(animationIssues((spec) => {
      spec.animation.clips[0].sequences[0].endSeconds = 0;
    })).toEqual(expect.arrayContaining([
      'animation.clips.0.sequences.0.endSeconds: a sequence must end after it starts',
    ]));
    expect(animationIssues((spec) => {
      spec.animation.clips[0].sequences[1].endSeconds = 9;
    })).toEqual(expect.arrayContaining([
      'animation.clips.0.sequences.1.endSeconds: sequence hideTrim ends at 9s, past the clip\'s 2s duration',
    ]));
  });

  it('rejects an easing name it does not implement', () => {
    expect(animationIssues((spec) => {
      spec.animation.clips[0].sequences[0].easing = 'elasticOut';
    })).toEqual(expect.arrayContaining([expect.stringContaining('animation.clips.0.sequences.0.easing')]));
  });

  it('rejects a sequence whose endpoints are equal, which occupies time and moves nothing', () => {
    expect(animationIssues((spec) => {
      spec.animation.clips[0].sequences[0].channels = { position: { from: [0, 0, 0.64], to: [0, 0, 0.64] } };
    })).toEqual(expect.arrayContaining([
      'animation.clips.0.sequences.0.channels: a sequence must change at least one channel',
    ]));
  });

  it('rejects a cue on a sequence that only fades or hides — a sound needs motion to ride', () => {
    expect(animationIssues((spec) => {
      spec.animation.clips[0].sequences[1].cueId = 'latchRelease';
    })).toEqual(expect.arrayContaining([
      'animation.clips.0.sequences.1.cueId: sequence hideTrim fires cue latchRelease without moving the part — attach a cue to a sequence that changes position, rotation, or scale',
    ]));
    expect(animationIssues((spec) => {
      spec.animation.clips[0].sequences[0].channels = { opacity: { from: 1, to: 0 } };
    })).toEqual(expect.arrayContaining([expect.stringContaining('without moving the part')]));
  });

  it('rejects a cue nothing declared', () => {
    expect(animationIssues((spec) => {
      spec.animation.cues = [];
    })).toEqual(expect.arrayContaining([
      'animation.clips.0.sequences.0.cueId: unknown cue: latchRelease',
    ]));
  });

  it('rejects two sequences driving one part+channel at overlapping times', () => {
    expect(animationIssues((spec) => {
      spec.animation.clips[0].sequences[1].channels = { position: { from: [0, 0.6, 0.64], to: [0, 0, 0.64] } };
      spec.animation.clips[0].sequences[1].startSeconds = 0.5;
    })).toEqual(expect.arrayContaining([
      'animation.clips.0.sequences.1.channels.position: sequences liftLid and hideTrim both drive position of part frontTrim at the same time',
    ]));
  });

  // Handing one window off to the next at a shared instant is how a multi-step
  // deployment is authored, so it must NOT read as an overlap.
  it('accepts two windows on one channel that meet end-to-start', () => {
    const spec = animatedSpec();
    spec.animation.clips[0].sequences[1].channels = { position: { from: [0, 0.6, 0.64], to: [0, 0, 0.64] } };
    expect(threejsSculptSpecSchema.safeParse(spec).success).toBe(true);
  });

  it('rejects duplicate clip, sequence, and cue ids', () => {
    expect(animationIssues((spec) => {
      spec.animation.clips[0].sequences[1].id = 'liftLid';
    })).toEqual(expect.arrayContaining([
      'animation.clips.0.sequences.1.id: duplicate sequence id: liftLid',
    ]));
    expect(animationIssues((spec) => {
      spec.animation.clips.push({ ...spec.animation.clips[0] });
    })).toEqual(expect.arrayContaining(['animation.clips.1.id: duplicate clip id: deploy']));
    expect(animationIssues((spec) => {
      spec.animation.cues.push({ ...spec.animation.cues[0] });
    })).toEqual(expect.arrayContaining(['animation.cues.1.id: duplicate cue id: latchRelease']));
  });
});

describe('buildThreejsFactorySource animation', () => {
  it('carries validated clips into the exported runtime metadata as data', () => {
    const source = buildThreejsFactorySource(animatedSpec());
    expect(source).toContain('animation: spec.animation || null,');
    expect(source.replace(/\s+/g, '')).toContain('"cueId":"latchRelease"');
  });

  it('exports null animation for a static spec, and never invents a clip', () => {
    const source = buildThreejsFactorySource(validSpec());
    expect(source).toContain('animation: spec.animation || null,');
    expect(source).not.toContain('"sequences"');
  });
});

// A generated horn that never bends passes every bounds check in the audit — its
// box is a reasonable box — so the input matrix here is the whole gate. Each
// case names a different way a path can fail to be an arc.
describe('evaluateSweptArcCurvature', () => {
  const arcPath = (spanDegrees, { count = 8, radius = 1 } = {}) => Array.from({ length: count }, (_, index) => {
    const angle = (index / (count - 1)) * spanDegrees * (Math.PI / 180);
    return [radius * Math.cos(angle), radius * Math.sin(angle), 0];
  });

  it('reports a collinear path as straight without fitting anything', () => {
    const curvature = evaluateSweptArcCurvature([[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]]);
    expect(curvature.collinear).toBe(true);
    expect(curvature.straight).toBe(true);
    expect(curvature.radius).toBeNull();
  });

  it('reports a two-point path as straight', () => {
    expect(evaluateSweptArcCurvature([[0, 0, 0], [0, 2, 0]]).straight).toBe(true);
  });

  it('measures the span of a genuine arc and passes it', () => {
    const curvature = evaluateSweptArcCurvature(arcPath(90));
    expect(curvature.straight).toBe(false);
    expect(curvature.arcSpanDegrees).toBeCloseTo(90, 4);
    expect(curvature.radius).toBeCloseTo(1, 4);
  });

  // The measurement has to be a property of the shape, not of the axes it was
  // authored against, or a horn tilted off the world planes reads as straight.
  it('fits the path plane rather than a world plane', () => {
    const tilted = arcPath(90).map(([x, y]) => [x, y * Math.SQRT1_2, y * Math.SQRT1_2]);
    const curvature = evaluateSweptArcCurvature(tilted);
    expect(curvature.straight).toBe(false);
    expect(curvature.arcSpanDegrees).toBeCloseTo(90, 3);
  });

  it('reports a shallow arc below the span threshold as straight', () => {
    const curvature = evaluateSweptArcCurvature(arcPath(15));
    expect(curvature.arcSpanDegrees).toBeCloseTo(15, 4);
    expect(curvature.straight).toBe(true);
  });

  // Angular travel is accumulated unsigned, so alternating authoring noise adds
  // up to a span the path never swept. Only the radial fit error says the points
  // are nowhere near the circle that produced it.
  it('does not credit a jittered straight run with the span its noise accumulates', () => {
    const jittered = Array.from({ length: 12 }, (_, index) => [index * 0.2, (index % 2 ? 1 : -1) * 0.002, 0]);
    const curvature = evaluateSweptArcCurvature(jittered);
    expect(curvature.arcSpanDegrees).toBeGreaterThan(25);
    expect(curvature.radialErrorRatio).toBeGreaterThan(0.05);
    expect(curvature.straight).toBe(true);
  });

  // The other side of that trade: an S-curve rides no single circle either, and
  // rejecting it on fit alone would report a bent tail as a straight one.
  it('accepts an S-curve that rides no single circle', () => {
    const sCurve = Array.from({ length: 16 }, (_, index) => {
      const t = (index / 15) * 2 * Math.PI;
      return [t * 0.3, Math.sin(t) * 0.4, 0];
    });
    const curvature = evaluateSweptArcCurvature(sCurve);
    expect(curvature.radialErrorRatio).toBeGreaterThan(0.05);
    expect(curvature.straight).toBe(false);
  });

  it('ignores non-finite and malformed points', () => {
    expect(evaluateSweptArcCurvature([[0, 0, 0], [1, Number.NaN, 0], [2, 0]]).straight).toBe(true);
    expect(evaluateSweptArcCurvature(null).straight).toBe(true);
  });
});

describe('measureOutlineConcaveTurn', () => {
  const crescent = () => {
    const outer = Array.from({ length: 14 }, (_, index) => {
      const angle = (index / 13) * Math.PI * 0.75;
      return [Math.cos(angle), Math.sin(angle)];
    });
    const inner = Array.from({ length: 14 }, (_, index) => {
      const angle = (Math.PI * 0.75) - ((index / 13) * Math.PI * 0.75);
      return [0.8 * Math.cos(angle), 0.8 * Math.sin(angle)];
    });
    return [...outer, ...inner];
  };

  it('reports no concave turning for a convex outline', () => {
    expect(measureOutlineConcaveTurn([[0, 0], [1, 0], [1, 1], [0, 1]])).toBeCloseTo(0, 6);
  });

  it('reports the inner sweep of a crescent', () => {
    expect(measureOutlineConcaveTurn(crescent())).toBeGreaterThan(100);
  });

  // Winding is read off the turning itself, so an outline authored clockwise is
  // not reported as concave along its whole boundary.
  it('measures the same crescent whichever way it winds', () => {
    expect(measureOutlineConcaveTurn([...crescent()].reverse()))
      .toBeCloseTo(measureOutlineConcaveTurn(crescent()), 6);
  });

  // Summed over the whole ring, one deep notch buys hundreds of degrees and lets
  // a straight spike through the gate that exists to catch it. Only a SUSTAINED
  // run — one governing a real stretch of boundary — counts.
  it('ignores a notch cut into an otherwise straight silhouette', () => {
    const notchedSpike = [[0, 0], [0.45, 0], [0.5, 0.3], [0.55, 0], [1, 0], [0.5, 6]];
    expect(measureOutlineConcaveTurn(notchedSpike)).toBeCloseTo(0, 6);
  });

  // The same rule must not throw away the crescent: its inner boundary is one
  // long run, not a nick.
  it('still reports a crescent whose concavity is one sustained run', () => {
    expect(measureOutlineConcaveTurn(crescent())).toBeGreaterThan(100);
  });
});

describe('evaluateSweptGeometryCurvature', () => {
  it('measures a tube path and an extrude outline, and nothing else', () => {
    expect(evaluateSweptGeometryCurvature({ type: 'tube', path: [[0, 0, 0], [0, 1, 0], [0, 2, 0]] }))
      .toMatchObject({ kind: 'tube', straight: true });
    expect(evaluateSweptGeometryCurvature({ type: 'extrude', outline: [[0, 0], [1, 0], [1, 1], [0, 1]] }))
      .toMatchObject({ kind: 'extrude', straight: true });
    expect(evaluateSweptGeometryCurvature({ type: 'box', width: 1, height: 1, depth: 1 })).toBeNull();
    expect(evaluateSweptGeometryCurvature(null)).toBeNull();
  });

  // A closed tube is a loop with no endpoints, and the schema already refuses a
  // collinear one, so there is no arc span for this gate to mean anything about.
  it('declines to measure a closed tube', () => {
    expect(evaluateSweptGeometryCurvature({
      type: 'tube',
      closed: true,
      path: [[0, 0, 0], [1, 0, 0], [1, 1, 0]],
    })).toBeNull();
  });

  // An arch, a ring, and a slotted plate all put the curve in the HOLE and leave
  // the outline convex, so measuring the outline would report the canonical
  // build as the defect.
  it('declines to measure an extrude whose curve can live in a hole', () => {
    expect(evaluateSweptGeometryCurvature({
      type: 'extrude',
      outline: [[-1, 0], [1, 0], [1, 2], [-1, 2]],
      holes: [Array.from({ length: 12 }, (_, index) => {
        const angle = Math.PI * (index / 11);
        return [0.8 * Math.cos(angle), 0.8 * Math.sin(angle)];
      })],
      depth: 0.3,
    })).toBeNull();
  });
});

describe('collectDeclaredCurvedParts', () => {
  const tube = { type: 'tube', path: [[0, 0, 0], [0, 1, 0], [0, 2, 0]] };

  it('declares a part by its own name and by a detail feature that names it', () => {
    const declared = collectDeclaredCurvedParts({
      parts: [
        { id: 'horn', name: 'Left Horn', geometry: tube },
        { id: 'part_17', name: 'part_17', geometry: tube },
        { id: 'rail', name: 'Support Rail', geometry: tube },
      ],
      detailInventory: [{ feature: 'curved brass conduit', implementationPartIds: ['part_17'] }],
    });
    expect([...declared.entries()]).toEqual([['horn', 'Left Horn'], ['part_17', 'curved brass conduit']]);
  });

  // A horn of five straight segments arranged along an arc is the CORRECT build,
  // and every segment of it is straight — so an assembly is never measured piece
  // by piece, from either declaration source, and not through its parent either
  // even when the parent carries a sweep of its own.
  it('skips an assembly that can curve by arrangement', () => {
    const declared = collectDeclaredCurvedParts({
      parts: [
        {
          id: 'horn',
          name: 'Horn',
          geometry: tube,
          children: [
            { id: 'horn-a', name: 'Horn Segment A', geometry: tube },
            { id: 'horn-b', name: 'Horn Segment B', geometry: tube },
          ],
        },
      ],
      detailInventory: [{ feature: 'curved horn', implementationPartIds: ['horn-a', 'horn-b'] }],
    });
    expect([...declared.keys()]).toEqual([]);
  });

  // These read as curved about as often as they read as straight — a tail boom
  // runs down a fuselage, a whisker is a bristle — and the finding text steers
  // the next refinement pass, so a bare noun must not tell it to bend them.
  it('needs a curve modifier before an ambiguous noun declares anything', () => {
    const bare = collectDeclaredCurvedParts({
      parts: [
        { id: 'boom', name: 'Tail Boom', geometry: tube },
        { id: 'bristle', name: 'whiskerLeft', geometry: tube },
      ],
    });
    expect([...bare.keys()]).toEqual([]);
    const modified = collectDeclaredCurvedParts({
      parts: [{ id: 'boom', name: 'Curled Tail', geometry: tube }],
    });
    expect([...modified.keys()]).toEqual(['boom']);
  });
});

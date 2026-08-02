/**
 * Declarative procedural-model contract used by the Three.js Models workspace.
 *
 * AI providers author this bounded JSON scene spec instead of executable
 * JavaScript. The browser renders only allowlisted Three.js primitives (plus a
 * bounded custom BufferGeometry), and this module deterministically exports the
 * same spec as a standalone Three.js factory.
 */

import { z } from 'zod';

const idSchema = z.string().trim().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const finite = z.number().finite().min(-10_000).max(10_000);
const positive = z.number().finite().positive().max(10_000);
const vec3Schema = z.tuple([finite, finite, finite]);

const boxGeometrySchema = z.object({
  type: z.literal('box'),
  width: positive,
  height: positive,
  depth: positive,
});

const sphereGeometrySchema = z.object({
  type: z.literal('sphere'),
  radius: positive,
  widthSegments: z.number().int().min(8).max(96).default(32),
  heightSegments: z.number().int().min(4).max(64).default(16),
});

const cylinderGeometrySchema = z.object({
  type: z.literal('cylinder'),
  radiusTop: z.number().finite().min(0).max(10_000),
  radiusBottom: z.number().finite().min(0).max(10_000),
  height: positive,
  radialSegments: z.number().int().min(3).max(96).default(32),
});

const coneGeometrySchema = z.object({
  type: z.literal('cone'),
  radius: positive,
  height: positive,
  radialSegments: z.number().int().min(3).max(96).default(32),
});

const torusGeometrySchema = z.object({
  type: z.literal('torus'),
  radius: positive,
  tube: positive,
  radialSegments: z.number().int().min(3).max(64).default(16),
  tubularSegments: z.number().int().min(6).max(128).default(48),
  arcDegrees: z.number().finite().min(1).max(360).default(360),
});

const capsuleGeometrySchema = z.object({
  type: z.literal('capsule'),
  radius: positive,
  length: z.number().finite().min(0).max(10_000),
  capSegments: z.number().int().min(2).max(32).default(8),
  radialSegments: z.number().int().min(3).max(64).default(16),
});

const latheGeometrySchema = z.object({
  type: z.literal('lathe'),
  points: z.array(z.tuple([finite, finite])).min(2).max(96),
  segments: z.number().int().min(3).max(96).default(32),
});

// Shoelace area — a closed outline whose points are coincident or collinear
// extrudes to nothing, so it is rejected rather than rendered as an empty mesh.
const MIN_RING_AREA = 1e-6;
const ringArea = (ring) => {
  let doubled = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[(index + 1) % ring.length];
    doubled += (x1 * y2) - (x2 * y1);
  }
  return Math.abs(doubled) / 2;
};

// Even-odd ray cast. A point exactly on an edge reads as outside, which is what
// we want: a hole touching the outline is a malformed cutout, not a cutout.
const pointInRing = (ring, [px, py]) => {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const [xi, yi] = ring[index];
    const [xj, yj] = ring[previous];
    const straddles = (yi > py) !== (yj > py);
    if (straddles && px < (((xj - xi) * (py - yi)) / (yj - yi)) + xi) inside = !inside;
  }
  return inside;
};

const turn = (a, b, c) => Math.sign(((b[0] - a[0]) * (c[1] - a[1])) - ((b[1] - a[1]) * (c[0] - a[0])));
const onSegment = (a, b, p) => turn(a, b, p) === 0
  && p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0])
  && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);
const segmentsCross = (a, b, c, d) => {
  if (turn(a, b, c) !== turn(a, b, d) && turn(c, d, a) !== turn(c, d, b)) return true;
  return onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
};

const ringsCross = (outer, inner) => {
  for (let i = 0; i < outer.length; i += 1) {
    const a = outer[i];
    const b = outer[(i + 1) % outer.length];
    for (let j = 0; j < inner.length; j += 1) {
      if (segmentsCross(a, b, inner[j], inner[(j + 1) % inner.length])) return true;
    }
  }
  return false;
};

// A ring that crosses itself has no defined interior — the shoelace area stays
// non-zero (the lobes partly cancel) but the triangulator picks an arbitrary
// filling, so require a simple polygon: no two non-adjacent edges may meet.
const isSimpleRing = (ring) => {
  for (let i = 0; i < ring.length; i += 1) {
    for (let j = i + 1; j < ring.length; j += 1) {
      const adjacent = j === i + 1 || (i === 0 && j === ring.length - 1);
      if (!adjacent && segmentsCross(ring[i], ring[(i + 1) % ring.length], ring[j], ring[(j + 1) % ring.length])) {
        return false;
      }
    }
  }
  return true;
};

// Vertex containment alone is not enough: a concave outline can hold every hole
// vertex while an edge between two of them leaves through the notch. Bounded by
// the ring caps (160 outline points × 12 holes × 160 hole points), so the O(n·m)
// edge sweep only runs against provider output that already passed the caps.
const ringContainsRing = (outer, inner) =>
  inner.every((point) => pointInRing(outer, point)) && !ringsCross(outer, inner);

// Two holes that touch, cross, or nest are one cutout described twice; the
// triangulator resolves the doubled winding by leaving material inside them.
const ringsOverlap = (a, b) => ringsCross(a, b)
  || b.every((point) => pointInRing(a, point))
  || a.every((point) => pointInRing(b, point));

const outlineRingSchema = z.array(z.tuple([finite, finite])).min(3).max(160)
  .refine((ring) => ringArea(ring) > MIN_RING_AREA, 'outline must enclose a non-zero area')
  .refine(isSimpleRing, 'outline must not cross itself');

const extrudeGeometrySchema = z.object({
  type: z.literal('extrude'),
  outline: outlineRingSchema,
  holes: z.array(outlineRingSchema).max(12).default([]),
  depth: positive,
  bevelEnabled: z.boolean().default(false),
  bevelThickness: z.number().finite().min(0).max(1_000).default(0.1),
  bevelSize: z.number().finite().min(0).max(1_000).default(0.1),
  bevelSegments: z.number().int().min(0).max(8).default(2),
  curveSegments: z.number().int().min(1).max(24).default(8),
  steps: z.number().int().min(1).max(32).default(1),
}).superRefine((definition, ctx) => {
  // A hole that is not strictly inside the outline is not a cutout — Three.js
  // silently emits a disjoint or self-intersecting face instead of failing.
  definition.holes.forEach((hole, index) => {
    if (!ringContainsRing(definition.outline, hole)) {
      ctx.addIssue({ code: 'custom', message: `extrude hole ${index} falls outside the outline`, path: ['holes', index] });
    }
    for (let other = 0; other < index; other += 1) {
      if (ringsOverlap(definition.holes[other], hole)) {
        ctx.addIssue({ code: 'custom', message: `extrude hole ${index} overlaps hole ${other}`, path: ['holes', index] });
      }
    }
  });
});

// Exact collinearity only — the epsilon guards float noise, never near-straight
// paths, which sweep a perfectly good tube.
const isCollinearPath = (points) => {
  const [origin] = points;
  const spread = points.find((point) => point.some((value, axis) => value !== origin[axis]));
  if (!spread) return true;
  const direction = spread.map((value, axis) => value - origin[axis]);
  return points.every((point) => {
    const offset = point.map((value, axis) => value - origin[axis]);
    const cross = [
      (direction[1] * offset[2]) - (direction[2] * offset[1]),
      (direction[2] * offset[0]) - (direction[0] * offset[2]),
      (direction[0] * offset[1]) - (direction[1] * offset[0]),
    ];
    return cross.every((component) => Math.abs(component) < 1e-9);
  });
};

const tubeGeometrySchema = z.object({
  type: z.literal('tube'),
  path: z.array(vec3Schema).min(2).max(96)
    .refine(
      (points) => points.every((point, index) => index === 0 || point.some((value, axis) => value !== points[index - 1][axis])),
      'tube path cannot repeat the same point consecutively',
    ),
  radius: positive,
  tubularSegments: z.number().int().min(2).max(256).default(64),
  radialSegments: z.number().int().min(3).max(32).default(12),
  closed: z.boolean().default(false),
  curveType: z.enum(['centripetal', 'chordal', 'catmullrom']).default('centripetal'),
  tension: z.number().finite().min(0).max(1).default(0.5),
}).superRefine((definition, ctx) => {
  if (!definition.closed) return;
  const first = definition.path[0];
  const last = definition.path[definition.path.length - 1];
  // A closed curve already joins the endpoints; repeating the seam point yields a
  // zero-length segment and NaN frames in the centripetal/chordal parameterizations.
  if (first.every((value, axis) => value === last[axis])) {
    ctx.addIssue({ code: 'custom', message: 'a closed tube path must not repeat its first point at the end', path: ['path'] });
  }
  // Fewer than three points — or any number of collinear ones — closes into a
  // curve that runs out and retraces itself, so the tube overlaps its own surface.
  if (definition.path.length < 3 || isCollinearPath(definition.path)) {
    ctx.addIssue({ code: 'custom', message: 'a closed tube path needs at least three non-collinear points', path: ['path'] });
  }
});

const customGeometrySchema = z.object({
  type: z.literal('custom'),
  // 900 vertices / 2,700 coordinates is deliberately generous for a
  // procedural reconstruction while bounding provider output and browser work.
  vertices: z.array(finite).min(9).max(2_700)
    .refine((values) => values.length % 3 === 0, 'vertices must contain xyz triples'),
  indices: z.array(z.number().int().min(0).max(899)).min(3).max(5_400)
    .refine((values) => values.length % 3 === 0, 'indices must contain triangle triples'),
});

export const threejsGeometrySchema = z.discriminatedUnion('type', [
  boxGeometrySchema,
  sphereGeometrySchema,
  cylinderGeometrySchema,
  coneGeometrySchema,
  torusGeometrySchema,
  capsuleGeometrySchema,
  latheGeometrySchema,
  extrudeGeometrySchema,
  tubeGeometrySchema,
  customGeometrySchema,
]);

export const threejsMaterialSchema = z.object({
  type: z.enum(['standard', 'physical', 'basic']).default('standard'),
  color: colorSchema,
  metalness: z.number().finite().min(0).max(1).default(0),
  roughness: z.number().finite().min(0).max(1).default(0.65),
  emissive: colorSchema.default('#000000'),
  emissiveIntensity: z.number().finite().min(0).max(20).default(0),
  opacity: z.number().finite().min(0).max(1).default(1),
  transparent: z.boolean().default(false),
  wireframe: z.boolean().default(false),
  clearcoat: z.number().finite().min(0).max(1).default(0),
  clearcoatRoughness: z.number().finite().min(0).max(1).default(0),
  // Physical-only channels. They are parsed for every material type so a spec
  // round-trips unchanged, but only `type: 'physical'` forwards them to Three.js.
  // `ior` is bounded to the range MeshPhysicalMaterial itself clamps to.
  ior: z.number().finite().min(1).max(2.333).default(1.5),
  transmission: z.number().finite().min(0).max(1).default(0),
  thickness: z.number().finite().min(0).max(1_000).default(0),
  sheen: z.number().finite().min(0).max(1).default(0),
  iridescence: z.number().finite().min(0).max(1).default(0),
  anisotropy: z.number().finite().min(0).max(1).default(0),
});

let partSchema;
partSchema = z.lazy(() => z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(120),
  geometry: threejsGeometrySchema.optional(),
  material: idSchema.optional(),
  position: vec3Schema.default([0, 0, 0]),
  rotationDegrees: vec3Schema.default([0, 0, 0]),
  scale: vec3Schema.default([1, 1, 1]),
  castShadow: z.boolean().default(true),
  receiveShadow: z.boolean().default(true),
  children: z.array(partSchema).max(40).default([]),
}));

const lightSchema = z.object({
  type: z.enum(['ambient', 'hemisphere', 'directional', 'point', 'spot']),
  color: colorSchema.default('#ffffff'),
  groundColor: colorSchema.default('#202030'),
  intensity: z.number().finite().min(0).max(100),
  position: vec3Schema.default([4, 6, 4]),
  angleDegrees: z.number().finite().min(1).max(179).default(45),
  penumbra: z.number().finite().min(0).max(1).default(0.25),
});

const socketSchema = z.object({
  name: idSchema,
  parentPartId: idSchema,
  position: vec3Schema.default([0, 0, 0]),
  rotationDegrees: vec3Schema.default([0, 0, 0]),
});

const detailSchema = z.object({
  feature: z.string().trim().min(1).max(240),
  evidence: z.string().trim().min(1).max(500),
  implementationPartIds: z.array(idSchema).min(1).max(12),
  priority: z.enum(['identity', 'major', 'minor']).default('major'),
});

export const threejsSculptSpecSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().trim().min(1).max(120),
  summary: z.string().trim().min(1).max(1_000),
  subjectType: z.enum(['object', 'character', 'hybrid']),
  limitations: z.array(z.string().trim().min(1).max(500)).max(12).default([]),
  background: colorSchema.default('#111827'),
  camera: z.object({
    position: vec3Schema,
    target: vec3Schema.default([0, 0, 0]),
    fov: z.number().finite().min(15).max(90).default(42),
  }),
  materials: z.record(idSchema, threejsMaterialSchema)
    .refine((materials) => Object.keys(materials).length > 0, 'at least one material is required')
    .refine((materials) => Object.keys(materials).length <= 50, 'at most 50 materials are allowed'),
  lights: z.array(lightSchema).min(1).max(8),
  parts: z.array(partSchema).min(1).max(40),
  sockets: z.array(socketSchema).max(40).default([]),
  detailInventory: z.array(detailSchema).min(1).max(80),
}).superRefine((spec, ctx) => {
  const materialIds = new Set(Object.keys(spec.materials));
  const partIds = new Set();
  let partCount = 0;

  const visit = (part, depth, path) => {
    partCount += 1;
    if (depth > 8) {
      ctx.addIssue({ code: 'custom', message: 'part hierarchy cannot exceed 8 levels', path });
    }
    if (partIds.has(part.id)) {
      ctx.addIssue({ code: 'custom', message: `duplicate part id: ${part.id}`, path: [...path, 'id'] });
    }
    partIds.add(part.id);
    if (part.geometry && !part.material) {
      ctx.addIssue({ code: 'custom', message: 'a part with geometry requires a material', path: [...path, 'material'] });
    }
    if (part.material && !materialIds.has(part.material)) {
      ctx.addIssue({ code: 'custom', message: `unknown material: ${part.material}`, path: [...path, 'material'] });
    }
    if (part.geometry?.type === 'custom') {
      const vertexCount = part.geometry.vertices.length / 3;
      const invalidIndex = part.geometry.indices.find((index) => index >= vertexCount);
      if (invalidIndex !== undefined) {
        ctx.addIssue({ code: 'custom', message: `custom geometry index ${invalidIndex} exceeds vertex count ${vertexCount}`, path: [...path, 'geometry', 'indices'] });
      }
    }
    part.children.forEach((child, index) => visit(child, depth + 1, [...path, 'children', index]));
  };

  spec.parts.forEach((part, index) => visit(part, 1, ['parts', index]));
  if (partCount > 160) {
    ctx.addIssue({ code: 'custom', message: 'model cannot exceed 160 total parts', path: ['parts'] });
  }

  for (const [index, socket] of spec.sockets.entries()) {
    if (!partIds.has(socket.parentPartId)) {
      ctx.addIssue({ code: 'custom', message: `unknown socket parent: ${socket.parentPartId}`, path: ['sockets', index, 'parentPartId'] });
    }
  }
  for (const [index, detail] of spec.detailInventory.entries()) {
    for (const [partIndex, id] of detail.implementationPartIds.entries()) {
      if (!partIds.has(id)) {
        ctx.addIssue({ code: 'custom', message: `unknown detail part: ${id}`, path: ['detailInventory', index, 'implementationPartIds', partIndex] });
      }
    }
  }
});

const toIdentifier = (name) => {
  const words = String(name || 'Procedural').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const joined = words.map((word) => word[0].toUpperCase() + word.slice(1)).join('') || 'Procedural';
  return /^[A-Za-z]/.test(joined) ? joined : `Model${joined}`;
};

/**
 * Deterministically package a validated scene spec as a standalone Three.js
 * Group factory. No model-authored JavaScript is executed by PortOS.
 */
export function buildThreejsFactorySource(input) {
  const spec = threejsSculptSpecSchema.parse(input);
  const factoryName = `create${toIdentifier(spec.name)}Model`;
  const serialized = JSON.stringify(spec, null, 2);

  return `// Generated by PortOS Three.js Models.
// Procedural image-to-Three.js workflow inspired by https://github.com/hoainho/img2threejs
import * as THREE from 'three';

const spec = ${serialized};
const radians = (degrees) => THREE.MathUtils.degToRad(degrees);
const rotation = (value) => value.map(radians);

function createGeometry(definition) {
  switch (definition.type) {
    case 'box':
      return new THREE.BoxGeometry(definition.width, definition.height, definition.depth);
    case 'sphere':
      return new THREE.SphereGeometry(definition.radius, definition.widthSegments, definition.heightSegments);
    case 'cylinder':
      return new THREE.CylinderGeometry(definition.radiusTop, definition.radiusBottom, definition.height, definition.radialSegments);
    case 'cone':
      return new THREE.ConeGeometry(definition.radius, definition.height, definition.radialSegments);
    case 'torus':
      return new THREE.TorusGeometry(definition.radius, definition.tube, definition.radialSegments, definition.tubularSegments, radians(definition.arcDegrees));
    case 'capsule':
      return new THREE.CapsuleGeometry(definition.radius, definition.length, definition.capSegments, definition.radialSegments);
    case 'lathe':
      return new THREE.LatheGeometry(definition.points.map(([x, y]) => new THREE.Vector2(x, y)), definition.segments);
    case 'extrude': {
      const shape = new THREE.Shape(definition.outline.map(([x, y]) => new THREE.Vector2(x, y)));
      for (const hole of definition.holes) {
        shape.holes.push(new THREE.Path(hole.map(([x, y]) => new THREE.Vector2(x, y))));
      }
      return new THREE.ExtrudeGeometry(shape, {
        depth: definition.depth,
        bevelEnabled: definition.bevelEnabled,
        bevelThickness: definition.bevelThickness,
        bevelSize: definition.bevelSize,
        bevelSegments: definition.bevelSegments,
        curveSegments: definition.curveSegments,
        steps: definition.steps,
      });
    }
    case 'tube': {
      const curve = new THREE.CatmullRomCurve3(
        definition.path.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
        definition.closed,
        definition.curveType,
        definition.tension
      );
      return new THREE.TubeGeometry(curve, definition.tubularSegments, definition.radius, definition.radialSegments, definition.closed);
    }
    case 'custom': {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(definition.vertices, 3));
      geometry.setIndex(definition.indices);
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      return geometry;
    }
    default:
      throw new Error(\`Unsupported geometry type: \${definition.type}\`);
  }
}

function createMaterial(definition) {
  const unlit = {
    color: definition.color,
    opacity: definition.opacity,
    transparent: definition.transparent,
    wireframe: definition.wireframe,
  };
  if (definition.type === 'basic') {
    return new THREE.MeshBasicMaterial(unlit);
  }
  const lit = {
    ...unlit,
    metalness: definition.metalness,
    roughness: definition.roughness,
    emissive: definition.emissive,
    emissiveIntensity: definition.emissiveIntensity,
  };
  if (definition.type === 'physical') {
    return new THREE.MeshPhysicalMaterial({
      ...lit,
      clearcoat: definition.clearcoat,
      clearcoatRoughness: definition.clearcoatRoughness,
      ior: definition.ior,
      transmission: definition.transmission,
      thickness: definition.thickness,
      sheen: definition.sheen,
      iridescence: definition.iridescence,
      anisotropy: definition.anisotropy,
    });
  }
  return new THREE.MeshStandardMaterial(lit);
}

function createPart(definition, materials, nodes) {
  const node = definition.geometry
    ? new THREE.Mesh(createGeometry(definition.geometry), materials[definition.material])
    : new THREE.Group();
  node.name = definition.name;
  node.position.set(...definition.position);
  node.rotation.set(...rotation(definition.rotationDegrees));
  node.scale.set(...definition.scale);
  node.castShadow = definition.castShadow;
  node.receiveShadow = definition.receiveShadow;
  nodes[definition.id] = node;
  for (const child of definition.children) node.add(createPart(child, materials, nodes));
  return node;
}

export function ${factoryName}() {
  const root = new THREE.Group();
  root.name = spec.name;
  const materials = Object.fromEntries(
    Object.entries(spec.materials).map(([id, definition]) => [id, createMaterial(definition)])
  );
  const nodes = {};
  for (const part of spec.parts) root.add(createPart(part, materials, nodes));
  root.userData.sculptRuntime = {
    schemaVersion: spec.schemaVersion,
    subjectType: spec.subjectType,
    nodes,
    sockets: spec.sockets,
    detailInventory: spec.detailInventory,
    limitations: spec.limitations,
  };
  return root;
}

export { spec };
`;
}

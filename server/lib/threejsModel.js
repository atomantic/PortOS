/**
 * Declarative procedural-model contract used by the Three.js Models workspace.
 *
 * AI providers author this bounded JSON scene spec instead of executable
 * JavaScript. The browser renders only allowlisted Three.js primitives (plus a
 * bounded custom BufferGeometry), and this module deterministically exports the
 * same spec as a standalone Three.js factory.
 */

import { z } from 'zod';

import { failValidation } from './errorHandler.js';

const idSchema = z.string().trim().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const finite = z.number().finite().min(-10_000).max(10_000);
const positive = z.number().finite().positive().max(10_000);
const vec3Schema = z.tuple([finite, finite, finite]);

// A part `scale` is a size multiplier, never a mirror or a visibility switch. A
// component at or near zero collapses the part to an invisible plane; a negative
// one reflects it, and three.js compensates for the negative world determinant by
// flipping the front face, so nothing throws and the preview looks plausible.
// That is what makes both expensive to chase: they are indistinguishable from a
// modeling choice, and a plain `finite` triple accepts either. This spec has no
// reflection concept — the prompt never asks for one, an LLM-authored negative
// component is an authoring slip, and the exported factory is consumed by tools
// that do not all compensate for a mirrored node — so the authoring contract
// rejects both. `storedThreejsSculptSpecSchema` keeps accepting them on read.
const MIN_PART_SCALE = 1e-4;
const scaleComponent = positive.min(MIN_PART_SCALE);
const scale3Schema = z.tuple([scaleComponent, scaleComponent, scaleComponent]);

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

// The scale bound is the ONE thing that differs between what a provider may
// author and what an install may already have stored, so the part hierarchy is
// built from it rather than written twice.
const makePartSchema = (scaleSchema) => {
  let partSchema;
  partSchema = z.lazy(() => z.object({
    id: idSchema,
    name: z.string().trim().min(1).max(120),
    geometry: threejsGeometrySchema.optional(),
    material: idSchema.optional(),
    position: vec3Schema.default([0, 0, 0]),
    rotationDegrees: vec3Schema.default([0, 0, 0]),
    scale: scaleSchema.default([1, 1, 1]),
    castShadow: z.boolean().default(true),
    receiveShadow: z.boolean().default(true),
    // Surface relief (serrations, stria, trim, port floors) belongs TO a part
    // rather than being one: it rides its parent when the model is taken apart,
    // and a click on it selects the parent. Without the flag a disassembly
    // shatters into a comb of loose slivers nobody can read or pick.
    explodeWithParent: z.boolean().default(false),
    children: z.array(partSchema).max(40).default([]),
  }));
  return partSchema;
};

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

// Articulation is a DECLARATION of intent, not a skeleton: PortOS does not skin,
// bind, or deform anything, and nothing downstream of this schema pretends it
// does. A joint names a part that is meant to rotate and the socket it rotates
// about, so a later rig/export path has something stable to attach to and the UI
// can say "articulation-ready" only when the graph is actually well formed.
const jointSchema = z.object({
  id: idSchema,
  // The part this joint drives. One part backs at most one joint — two joints on
  // the same part is a graph that cannot be built, not a redundancy.
  partId: idSchema,
  // `null` marks the single root. Every other joint names a joint declared
  // EARLIER in the array, which is what makes a cycle unrepresentable.
  parentJointId: idSchema.nullable().default(null),
  // The named socket this joint pivots about. Optional on the root (whose pivot
  // is the model origin); a child joint without one has no defined axis, which
  // the rig-readiness report treats as not-ready rather than silently rigged.
  pivotSocket: idSchema.nullable().default(null),
});

const MAX_JOINTS = 64;

const articulationSchema = z.object({
  joints: z.array(jointSchema).min(1).max(MAX_JOINTS),
  // Parts explicitly declared as carried attachments — a pack, a weapon, a hat.
  // They ride an articulated part rather than articulating, and saying so is the
  // point: without the declaration "not a joint" and "nobody classified it" are
  // the same silence.
  attachmentPartIds: z.array(idSchema).max(40).default([]),
});

const detailSchema = z.object({
  feature: z.string().trim().min(1).max(240),
  evidence: z.string().trim().min(1).max(500),
  implementationPartIds: z.array(idSchema).min(1).max(12),
  priority: z.enum(['identity', 'major', 'minor']).default('major'),
});

const makeSpecSchema = (partSchema) => z.object({
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
  // Optional and additive: a spec written before articulation shipped simply has
  // no key, which every consumer reads as "static assembly", never as "rigged".
  articulation: articulationSchema.optional(),
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
  if (spec.articulation) {
    const socketNames = new Set(spec.sockets.map((socket) => socket.name));
    const jointIds = new Set();
    const jointPartIds = new Set();
    let rootCount = 0;
    for (const [index, joint] of spec.articulation.joints.entries()) {
      const at = (key) => ['articulation', 'joints', index, key];
      if (jointIds.has(joint.id)) {
        ctx.addIssue({ code: 'custom', message: `duplicate joint id: ${joint.id}`, path: at('id') });
      }
      if (!partIds.has(joint.partId)) {
        ctx.addIssue({ code: 'custom', message: `unknown joint part: ${joint.partId}`, path: at('partId') });
      } else if (jointPartIds.has(joint.partId)) {
        ctx.addIssue({ code: 'custom', message: `part ${joint.partId} is already driven by another joint`, path: at('partId') });
      }
      if (joint.parentJointId === null) {
        rootCount += 1;
      } else if (!jointIds.has(joint.parentJointId)) {
        // Earlier-only, so a dangling parent, a forward reference, and a cycle
        // are all the same rejection — there is no graph walk to get wrong.
        ctx.addIssue({
          code: 'custom',
          message: `joint ${joint.id} names parent ${joint.parentJointId}, which is not a joint declared before it`,
          path: at('parentJointId'),
        });
      }
      if (joint.pivotSocket !== null && !socketNames.has(joint.pivotSocket)) {
        ctx.addIssue({ code: 'custom', message: `unknown pivot socket: ${joint.pivotSocket}`, path: at('pivotSocket') });
      }
      jointIds.add(joint.id);
      jointPartIds.add(joint.partId);
    }
    if (rootCount !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: `articulation needs exactly one root joint (a joint with parentJointId null), found ${rootCount}`,
        path: ['articulation', 'joints'],
      });
    }
    for (const [index, partId] of spec.articulation.attachmentPartIds.entries()) {
      const path = ['articulation', 'attachmentPartIds', index];
      if (!partIds.has(partId)) {
        ctx.addIssue({ code: 'custom', message: `unknown attachment part: ${partId}`, path });
      } else if (jointPartIds.has(partId)) {
        // A part cannot be both carried and articulated — that is the one
        // ambiguity this declaration exists to remove.
        ctx.addIssue({ code: 'custom', message: `part ${partId} is declared as an attachment and also driven by a joint`, path });
      }
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

/**
 * The AUTHORING contract: what a provider is allowed to hand back. Part scale is
 * floored here, so a spec that would render a part reflected or collapsed is
 * rejected at the one moment the model can still be asked for another pass.
 */
export const threejsSculptSpecSchema = makeSpecSchema(makePartSchema(scale3Schema));

/**
 * The READ contract for a spec an install has already stored. Identical except
 * that part scale keeps the original unbounded `finite` triple.
 *
 * Tightening an authoring bound must not retroactively invalidate data that was
 * accepted under the old one. A stored spec is rendered from the record verbatim
 * (the preview never re-validates), so rejecting it on the way OUT would take
 * Copy/Download away from a `ready` model whose only remedy is a paid
 * regeneration — and machine-repairing it instead would silently un-mirror an
 * asymmetric part or resize a collapsed one back into view. Neither is a repair
 * this schema is entitled to make, so an existing record exports exactly as it
 * renders, while the bound above keeps any NEW spec from acquiring the problem.
 */
export const storedThreejsSculptSpecSchema = makeSpecSchema(makePartSchema(vec3Schema));

const MAX_NAMES_IN_MESSAGE = 8;

/**
 * Render a capped, comma-joined list of spec-level names (parts or features) for
 * a finding message. Shared with `threejsModelCoverage.js` so both gates cap the
 * same way — a finding that prints forty part names is one nobody reads.
 */
export const listSpecNames = (names) => (names.length > MAX_NAMES_IN_MESSAGE
  ? `${names.slice(0, MAX_NAMES_IN_MESSAGE).join(', ')} (+${names.length - MAX_NAMES_IN_MESSAGE} more)`
  : names.join(', '));

// Cross-section gate. A spec can match its reference head-on — silhouette,
// colour zones, part count — and still be a diorama of cardboard cut-outs:
// every load-bearing part a planar extrusion on its own depth plane, correct
// from the generated camera and hollow the moment the user orbits. Neither the
// schema nor the assembly-coverage gate sees it, because a slab is well-formed
// geometry that implements exactly the detail it claims.
//
// Evidence of form is PLANE count, not triangle count: a fan of four hundred
// triangles sharing one Z value has no profile at all. So a `custom` mesh is
// slab-like when its thinnest axis carries fewer distinct coordinates than a
// curved surface needs to read as curved (or when the cloud has no volume in
// any orientation), and an `extrude` with no bevel thickness is one by
// construction — its sweep has exactly two depth planes no matter how many
// `steps` subdivide the side walls.
//
// Honest limit: a genuinely three-dimensional but very coarse custom mesh (an
// eight-vertex box) also lands under the plane threshold. That shape is already
// against the prompt's guidance — `box` exists — so the false positive only
// fires on geometry that should not have been custom triangles in the first
// place.
const SLAB_PLANE_THRESHOLD = 11;

// Planes are quantized relative to the mesh's own size rather than in absolute
// units: a fixed 1e-3 grid would report a 0.005-unit detail mesh as having five
// planes on every axis no matter how round it is, so the gate would punish
// small parts for being small. A thousandth of the largest extent asks the
// scale-free question the gate actually means — does this axis carry structure
// at the scale of the part itself.
const RELATIVE_PLANE_QUANTUM = 1e-3;

// Plane counting is axis-aligned, which a cut-out whose ROTATION was baked into
// its vertices (rather than carried by the part's `rotationDegrees`) slips past
// — turned 45°, a single flat fan samples a distinct value on all three axes. A
// point cloud with no volume is flat in every orientation, so the covariance
// determinant, normalized by the mean variance so it is scale-free, catches
// that case however the mesh is turned. The bound is deliberately strict: only
// an essentially zero-thickness cloud qualifies, leaving thin-but-real parts to
// the plane count above rather than double-jeopardy here.
const COPLANAR_DETERMINANT = 1e-6;

// Aggregate, never per-part: `extrude` is the RIGHT answer for a plate, a badge,
// or a sign, so a flat part is only evidence when the model's identity rides on
// it. The finding is "the load-bearing parts are predominantly flat", reported
// once the majority of buildable identity features are backed by nothing else.
const FLAT_IDENTITY_RATIO_THRESHOLD = 0.6;

const axisBounds = (vertices, axis) => {
  let min = Infinity;
  let max = -Infinity;
  for (let index = axis; index < vertices.length; index += 3) {
    if (vertices[index] < min) min = vertices[index];
    if (vertices[index] > max) max = vertices[index];
  }
  return [min, max];
};

const countAxisPlanes = (vertices) => {
  const bounds = [0, 1, 2].map((axis) => axisBounds(vertices, axis));
  const quantum = Math.max(...bounds.map(([min, max]) => max - min)) * RELATIVE_PLANE_QUANTUM;
  // Every vertex sits on one point, so there is exactly one plane per axis.
  if (!(quantum > 0)) return [1, 1, 1];
  const axes = [new Set(), new Set(), new Set()];
  // Bucketed from each axis's own minimum rather than the absolute coordinate,
  // so the count is a property of the shape and not of where it was authored:
  // a mesh built far from the origin divides a large offset by a small quantum
  // and loses distinct planes to float resolution.
  vertices.forEach((value, index) => {
    const axis = index % 3;
    axes[axis].add(Math.round((value - bounds[axis][0]) / quantum));
  });
  return axes.map((axis) => axis.size);
};

const isCoplanarCloud = (vertices) => {
  const count = vertices.length / 3;
  const mean = [0, 0, 0];
  vertices.forEach((value, index) => { mean[index % 3] += value / count; });
  let xx = 0; let yy = 0; let zz = 0; let xy = 0; let xz = 0; let yz = 0;
  for (let index = 0; index < count; index += 1) {
    const x = vertices[index * 3] - mean[0];
    const y = vertices[(index * 3) + 1] - mean[1];
    const z = vertices[(index * 3) + 2] - mean[2];
    xx += (x * x) / count; yy += (y * y) / count; zz += (z * z) / count;
    xy += (x * y) / count; xz += (x * z) / count; yz += (y * z) / count;
  }
  const determinant = (xx * ((yy * zz) - (yz * yz)))
    - (xy * ((xy * zz) - (yz * xz)))
    + (xz * ((xy * yz) - (yy * xz)));
  const meanVariance = (xx + yy + zz) / 3;
  if (!(meanVariance > 0)) return true;
  return Math.abs(determinant) / (meanVariance ** 3) < COPLANAR_DETERMINANT;
};

const isSlabGeometry = (geometry) => {
  if (!geometry) return false;
  if (geometry.type === 'extrude') {
    // `bevelEnabled` defaults to false in the schema, so a parsed spec always
    // carries it; `!== true` also reads a stored spec that predates it. The
    // thickness matters as much as the flag: a bevel of zero thickness adds no
    // depth plane, and flipping the boolean alone is the cheapest way for a
    // model to answer this gate without changing the geometry at all.
    return geometry.bevelEnabled !== true || !(geometry.bevelThickness > 0);
  }
  if (geometry.type !== 'custom') return false;
  const vertices = Array.isArray(geometry.vertices) ? geometry.vertices : [];
  if (vertices.length < 9) return false;
  return Math.min(...countAxisPlanes(vertices)) < SLAB_PLANE_THRESHOLD || isCoplanarCloud(vertices);
};

const collectMeshes = (part, out = []) => {
  if (part.geometry) out.push(part);
  for (const child of part.children || []) collectMeshes(child, out);
  return out;
};

/**
 * @param {object} spec a spec that has already passed `threejsSculptSpecSchema`
 * @returns {{findings: Array, errorCount: number, warningCount: number, noteCount: number,
 *   identityDetailCount: number, flatIdentityDetailCount: number, flatRatio: number|null,
 *   slabPartIds: string[]}}
 */
export function evaluateThreejsFlatness(spec) {
  const byId = new Map();
  const indexPart = (part) => {
    byId.set(part.id, part);
    for (const child of part.children || []) indexPart(child);
  };
  for (const part of spec?.parts || []) indexPart(part);

  const details = Array.isArray(spec?.detailInventory) ? spec.detailInventory : [];
  const slabPartIds = new Set();
  const flatFeatures = [];
  let evaluated = 0;

  for (const detail of details) {
    if (detail.priority !== 'identity') continue;
    const meshes = new Map();
    for (const id of new Set(detail.implementationPartIds || [])) {
      const part = byId.get(id);
      if (!part) continue;
      // A detail may point at a group whose children carry the geometry, and two
      // of its ids may nest, so meshes are collected by id rather than counted.
      for (const mesh of collectMeshes(part)) meshes.set(mesh.id, mesh);
    }
    // Nothing was built for this feature anywhere — that is the assembly-coverage
    // gate's `unbuilt-detail`, and counting it here would let a spec that built
    // almost nothing read as a flat one.
    if (meshes.size === 0) continue;
    evaluated += 1;
    const implementing = [...meshes.values()];
    if (!implementing.every((mesh) => isSlabGeometry(mesh.geometry))) continue;
    flatFeatures.push(detail.feature);
    for (const mesh of implementing) slabPartIds.add(mesh.id);
  }

  // `null`, not 0: a spec with no buildable identity feature was not measured
  // flat, it was not measured at all, and a 0 would read as a clean result.
  const flatRatio = evaluated === 0 ? null : flatFeatures.length / evaluated;
  const findings = [];
  if (flatRatio !== null && flatRatio > FLAT_IDENTITY_RATIO_THRESHOLD) {
    const offenders = [...slabPartIds];
    findings.push({
      code: 'flat-identity-parts',
      severity: 'warning',
      partIds: offenders,
      features: flatFeatures,
      message: `${flatFeatures.length} of ${evaluated} identity-defining features are built only from flat parts (${listSpecNames(offenders.map((id) => byId.get(id)?.name || id))}). The model will read as a projection the moment it is orbited — give the parts the subject's identity rides on a real cross-section instead of stacking unbevelled extrusions and planar triangle fans.`,
    });
  }

  return {
    findings,
    errorCount: 0,
    warningCount: findings.length,
    noteCount: 0,
    identityDetailCount: evaluated,
    flatIdentityDetailCount: flatFeatures.length,
    flatRatio,
    slabPartIds: [...slabPartIds],
  };
}

/**
 * Default refinement feedback derived from a stored flatness result. Returns ''
 * when the model has a cross-section, so the caller falls through to whatever
 * other feedback it has.
 */
export function buildThreejsFlatnessFeedback(flatness) {
  const warnings = (flatness?.findings || []).filter((finding) => finding.severity === 'warning');
  if (warnings.length === 0) return '';
  return [
    'The previous pass failed the cross-section check — it reads as a flat projection rather than a solid:',
    ...warnings.map((finding, index) => `${index + 1}. ${finding.message}`),
    'Rebuild those parts with genuine depth: compose them from primitives, or give an extrude a bevel, so the model holds up from any orbit angle.',
  ].join('\n');
}

// Material-plausibility gate. `threejsMaterialSchema` bounds every PBR channel
// to what Three.js itself accepts, which says nothing about whether the values
// describe the substance the material is named for: metalness 0.9 oak and
// transmission 1.0 steel both parse, and both light completely wrong.
//
// The priors below are per-family plausible ranges, keyed off tokens in the
// material's own id — the only name a material carries in the spec. Matching is
// deliberately conservative: a material keys a prior only when exactly ONE
// family's keywords appear in it, so an unrecognized id (`mat_primary`) or a
// genuinely mixed one (`wood_metal_trim`) produces no feedback rather than a
// wrong one. That trade is affordable because this gate NEVER clamps — a
// stylized model is entitled to break every prior here, and the only cost of a
// missed match is a skipped hint.
//
// Bounds are stated only where a family really constrains the channel, and only
// in the direction it constrains: `undefined` is "this family says nothing",
// which is different from a bound of 0. Channels left out entirely (thickness,
// iridescence, anisotropy, emissive) are art direction, not substance.
const MATERIAL_FAMILY_PRIORS = [
  {
    family: 'metal',
    keywords: ['metal', 'metallic', 'steel', 'iron', 'chrome', 'brass', 'bronze', 'copper', 'aluminum', 'aluminium', 'silver', 'gold', 'gilt', 'titanium', 'pewter', 'nickel', 'alloy', 'gunmetal'],
    // The one family with a metalness FLOOR: a bare metal surface that is not
    // metallic is the single most common way a generated spec reads as plastic.
    channels: { metalness: [0.6, 1], roughness: [0.02, 0.6], transmission: [0, 0.05], sheen: [0, 0.1] },
  },
  {
    family: 'wood',
    keywords: ['wood', 'wooden', 'timber', 'oak', 'walnut', 'birch', 'maple', 'pine', 'mahogany', 'teak', 'bamboo', 'plank', 'lumber'],
    channels: { metalness: [0, 0.15], roughness: [0.35, 1], transmission: [0, 0.05], sheen: [0, 0.3] },
  },
  {
    family: 'plastic',
    keywords: ['plastic', 'abs', 'pvc', 'nylon', 'resin', 'acrylic', 'vinyl', 'polymer', 'polycarbonate'],
    channels: { metalness: [0, 0.1], roughness: [0.05, 0.95], ior: [1.3, 1.8] },
  },
  {
    family: 'glass',
    keywords: ['glass', 'crystal', 'lens', 'glazing', 'pane', 'windshield', 'quartz'],
    // The transmission floor is the point of this entry: opaque "glass" is the
    // mirror image of the metalness case above.
    channels: { metalness: [0, 0.1], roughness: [0, 0.35], transmission: [0.4, 1], ior: [1.3, 1.9] },
  },
  {
    family: 'fabric',
    keywords: ['fabric', 'cloth', 'cotton', 'linen', 'wool', 'velvet', 'silk', 'canvas', 'denim', 'textile', 'felt', 'upholstery', 'curtain'],
    channels: { metalness: [0, 0.1], roughness: [0.5, 1], clearcoat: [0, 0.2], transmission: [0, 0.15] },
  },
  {
    family: 'ceramic',
    keywords: ['ceramic', 'porcelain', 'clay', 'terracotta', 'tile', 'earthenware'],
    channels: { metalness: [0, 0.1], roughness: [0.03, 0.7], transmission: [0, 0.2], ior: [1.3, 1.9] },
  },
  {
    family: 'rubber',
    keywords: ['rubber', 'tire', 'tyre', 'tread', 'silicone', 'neoprene', 'gasket'],
    channels: { metalness: [0, 0.1], roughness: [0.5, 1], clearcoat: [0, 0.2], transmission: [0, 0.05] },
  },
  {
    family: 'stone',
    keywords: ['stone', 'rock', 'granite', 'marble', 'concrete', 'cement', 'slate', 'brick', 'asphalt', 'sandstone'],
    channels: { metalness: [0, 0.15], roughness: [0.3, 1], transmission: [0, 0.1] },
  },
  {
    family: 'leather',
    keywords: ['leather', 'suede', 'hide'],
    channels: { metalness: [0, 0.1], roughness: [0.3, 0.95], transmission: [0, 0.05] },
  },
  {
    family: 'paper',
    keywords: ['paper', 'cardboard', 'carton', 'paperboard', 'parchment'],
    channels: { metalness: [0, 0.1], roughness: [0.5, 1], transmission: [0, 0.2] },
  },
];

const MATERIAL_KEYWORD_FAMILIES = new Map(
  MATERIAL_FAMILY_PRIORS.flatMap((prior) => prior.keywords.map((keyword) => [keyword, prior]))
);

// `basic` is unlit, so none of these channels reach the renderer at all; the
// physical-only ones are parsed for every type but only forwarded by
// `type: 'physical'` (see `createMaterial`). Reporting a channel that cannot
// affect the render would be a finding the user can do nothing useful with.
const MATERIAL_CHANNELS_BY_TYPE = {
  basic: [],
  standard: ['metalness', 'roughness'],
  physical: ['metalness', 'roughness', 'clearcoat', 'ior', 'transmission', 'sheen'],
};

/**
 * Split a material id into lowercase word tokens, breaking on separators AND on
 * camelCase boundaries so `oakTrim` and `oak_trim` tokenize the same. A trailing
 * plural is folded in as an extra candidate token rather than replacing the
 * original, so `planks` matches `plank` without `abs` losing its own keyword.
 */
const tokenizeMaterialId = (id) => {
  const words = String(id || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const tokens = new Set(words);
  for (const word of words) {
    if (word.length > 3 && word.endsWith('s')) tokens.add(word.slice(0, -1));
  }
  return [...tokens];
};

/**
 * The single family a material id names, or `null` when it names none or more
 * than one. Ambiguity is deliberately NOT resolved by precedence — picking one
 * of two competing substances is how a prior table starts producing confident
 * nonsense.
 */
const matchMaterialFamily = (id) => {
  const matched = new Set();
  for (const token of tokenizeMaterialId(id)) {
    const prior = MATERIAL_KEYWORD_FAMILIES.get(token);
    if (prior) matched.add(prior);
  }
  return matched.size === 1 ? [...matched][0] : null;
};

/**
 * Report PBR channels whose values are implausible for the substance a material
 * id names. Advisory ONLY — nothing here rewrites a spec, because a stylized
 * model may legitimately break every prior in the table.
 *
 * @param {object} spec a spec that has already passed `threejsSculptSpecSchema`
 * @returns {{findings: Array, errorCount: number, warningCount: number, noteCount: number,
 *   materialCount: number, matchedMaterialCount: number, implausibleMaterialCount: number}}
 */
export function evaluateThreejsMaterialPlausibility(spec) {
  const materials = (spec?.materials && typeof spec.materials === 'object') ? spec.materials : {};
  const findings = [];
  let matched = 0;

  for (const [id, material] of Object.entries(materials)) {
    const prior = matchMaterialFamily(id);
    if (!prior) continue;
    matched += 1;
    const channels = MATERIAL_CHANNELS_BY_TYPE[material?.type] || MATERIAL_CHANNELS_BY_TYPE.standard;
    const offenders = [];
    for (const channel of channels) {
      const range = prior.channels[channel];
      const value = material?.[channel];
      // A stored spec predating a channel reads back undefined — unevaluated,
      // not out of range.
      if (!range || typeof value !== 'number' || !Number.isFinite(value)) continue;
      const [min, max] = range;
      if (value >= min && value <= max) continue;
      offenders.push({ channel, value, min, max });
    }
    if (offenders.length === 0) continue;
    findings.push({
      code: 'implausible-material-values',
      severity: 'warning',
      materialIds: [id],
      family: prior.family,
      channels: offenders,
      message: `Material "${id}" reads as ${prior.family}, but ${offenders
        .map(({ channel, value, min, max }) => `${channel} ${value} is outside the ${min}–${max} a ${prior.family} surface normally sits in`)
        .join(', and ')}. Re-derive those channels from the substance (or rename the material if it is not ${prior.family} at all) — unless the look is deliberately stylized, in which case leave it.`,
    });
  }

  return {
    findings,
    errorCount: 0,
    warningCount: findings.length,
    noteCount: 0,
    materialCount: Object.keys(materials).length,
    matchedMaterialCount: matched,
    implausibleMaterialCount: findings.length,
  };
}

/**
 * Default refinement feedback derived from a stored material-plausibility
 * result. Returns '' when every recognized material is plausible, so the caller
 * falls through to whatever other feedback it has.
 */
export function buildThreejsMaterialFeedback(plausibility) {
  const warnings = (plausibility?.findings || []).filter((finding) => finding.severity === 'warning');
  if (warnings.length === 0) return '';
  return [
    'The previous pass gave some materials values that do not match the substance they are named for:',
    ...warnings.map((finding, index) => `${index + 1}. ${finding.message}`),
    'Set each channel from what the surface actually is — bare metal is metallic and fairly smooth, wood and stone are rough dielectrics, glass transmits — and keep any deliberate stylization you still want.',
  ].join('\n');
}

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
  // Exporting reads a STORED spec, so it validates against the read contract —
  // an install's existing model stays downloadable even if it predates a bound.
  // The parse still has to happen (the emitted source must be well-formed), and
  // a raw ZodError would normalize to an opaque 500 saying nothing a user can act
  // on, so `failValidation` names the offending path in a 400 instead.
  const parsed = storedThreejsSculptSpecSchema.safeParse(input);
  if (!parsed.success) failValidation(parsed);
  const spec = parsed.data;
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
  // Carried through so a standalone consumer of the exported factory can build
  // the same disassembly the PortOS preview does: relief rides its parent.
  node.userData.partId = definition.id;
  node.userData.explodeWithParent = definition.explodeWithParent;
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
    // Declared articulation intent, or null when the spec has none — the parse
    // above is what makes this trustworthy, so a consumer reads a graph that is
    // known single-rooted, acyclic, and pointed at real parts and sockets. It is
    // NOT a skeleton: nothing here is skinned, bound, or deformed.
    articulation: spec.articulation || null,
    detailInventory: spec.detailInventory,
    limitations: spec.limitations,
  };
  return root;
}

export { spec };
`;
}

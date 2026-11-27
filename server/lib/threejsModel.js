/**
 * Declarative procedural-model contract used by the Three.js Models workspace.
 *
 * AI providers author this bounded JSON scene spec instead of executable
 * JavaScript. The browser renders only allowlisted Three.js primitives (plus a
 * bounded custom BufferGeometry). Export uses the stored-spec contract and
 * packages the validated scene as a standalone Three.js factory.
 */

import { z } from 'zod';

import { failValidation } from './errorHandler.js';
import { isCollinearPath } from './threejsModelCurvature.js';
import { THREEJS_ENVIRONMENT_PRESETS } from './threejsModelEnvironment.js';
import { buildThreejsFactorySourceFromSpec } from './threejsModelFactorySource.js';

export {
  CURVED_OUTLINE_MIN_CONCAVE_TURN_DEGREES,
  SWEPT_ARC_MIN_SPAN_DEGREES,
  collectDeclaredCurvedParts,
  evaluateSweptArcCurvature,
  evaluateSweptGeometryCurvature,
  measureOutlineConcaveTurn,
} from './threejsModelCurvature.js';
export { buildThreejsFlatnessFeedback, evaluateThreejsFlatness } from './threejsModelFlatness.js';
export { buildThreejsMaterialFeedback, evaluateThreejsMaterialPlausibility } from './threejsModelMaterialAudit.js';
export { listSpecNames } from './threejsModelSpecNames.js';

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
  side: z.enum(['front', 'double']).default('front'),
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

// The environment/render-profile half of the contract lives in its own
// dependency-free module so the client suite can import it to assert parity —
// this file imports zod, which the client CI job does not install.
const environmentSchema = z.object({
  preset: z.enum(THREEJS_ENVIRONMENT_PRESETS).default('none'),
  intensity: z.number().finite().min(0).max(4).default(1),
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

// How far an attachment's bounds may sit from its anchor's surface before the
// physical audit calls the relationship broken. A correctly worn hat overlaps
// the head it sits on, so the AABB gap is zero; a charm on a short chain is a
// fraction of a unit away. The default is deliberately tight — a provider that
// needs slack says so per attachment rather than the gate guessing generously,
// because the defects this catches (a hat at hip height, a charm below the
// ground plane) are off by whole model-heights, not by fractions.
export const DEFAULT_ATTACHMENT_MAX_OFFSET = 0.25;
const MAX_ATTACHMENT_OFFSET = 10;
const MAX_ATTACHMENTS = 40;

// An attachment is only meaningful relative to the thing it hangs from, so this
// entry carries that relationship: the part being carried, and EXACTLY ONE of
// the part or the socket it is carried by. Declaring an attachment without an
// anchor is still accepted through the older `attachmentPartIds` list, which is
// what every spec authored before this field existed uses — those read forward
// as anchor-less entries and the gates report them as unanchored rather than
// rejecting a stored record.
const attachmentSchema = z.object({
  partId: idSchema,
  anchorPartId: idSchema.nullable().default(null),
  anchorSocket: idSchema.nullable().default(null),
  maxOffset: z.number().finite().min(0).max(MAX_ATTACHMENT_OFFSET).default(DEFAULT_ATTACHMENT_MAX_OFFSET),
}).superRefine((attachment, ctx) => {
  const anchors = [attachment.anchorPartId, attachment.anchorSocket].filter((value) => value !== null);
  if (anchors.length !== 1) {
    ctx.addIssue({
      code: 'custom',
      message: `attachment ${attachment.partId} needs exactly one of anchorPartId or anchorSocket, found ${anchors.length}`,
      path: ['anchorPartId'],
    });
  }
});

const articulationSchema = z.object({
  joints: z.array(jointSchema).min(1).max(MAX_JOINTS),
  // Parts explicitly declared as carried attachments — a pack, a weapon, a hat.
  // They ride an articulated part rather than articulating, and saying so is the
  // point: without the declaration "not a joint" and "nobody classified it" are
  // the same silence.
  //
  // Kept unchanged and still accepted: this is the anchor-less form. `attachments`
  // below is additive, not a replacement, so a stored spec stays valid.
  attachmentPartIds: z.array(idSchema).max(MAX_ATTACHMENTS).default([]),
  // The same declaration plus the one thing the list above cannot say: what each
  // attachment is carried BY. Without it "declared as an attachment" and
  // "parented at the model root and related to nothing" are indistinguishable,
  // and every downstream gate credits the second as though it were the first.
  attachments: z.array(attachmentSchema).max(MAX_ATTACHMENTS).default([]),
});

const detailSchema = z.object({
  feature: z.string().trim().min(1).max(240),
  evidence: z.string().trim().min(1).max(500),
  implementationPartIds: z.array(idSchema).min(1).max(12),
  priority: z.enum(['identity', 'major', 'minor']).default('major'),
});

// Animation clips. PortOS still builds STATIC assemblies — nothing here is
// skinned, bound, or deformed, and no provider-authored JavaScript ever runs.
// A clip is a DECLARATION of transforms over time: named sequences that carry
// one part from one authored pose to another inside a bounded window, so a
// deployable can demonstrate assembly, retraction, or destruction and a
// timeline can scrub it deterministically.
//
// Absent `animation` means "static assembly", exactly the way absent
// `articulation` means "no declared joints" — a spec written before clips
// shipped keeps parsing, rendering, and exporting unchanged.
export const THREEJS_CLIP_EASINGS = ['linear', 'easeIn', 'easeOut', 'easeInOut'];
export const THREEJS_CLIP_ROLES = ['deploy', 'retract', 'assemble', 'destroy', 'idle', 'custom'];
// Cue KINDS, not sounds: PortOS ships no audio and loads none. A cue is a data
// identifier a host may map to its own sample, and the kind is the only hint
// about what it should sound like.
export const THREEJS_CUE_KINDS = ['mechanical', 'servo', 'latch', 'hydraulic', 'impact', 'electronic', 'ambient'];

const MAX_CLIP_SECONDS = 120;
const MIN_CLIP_SECONDS = 0.05;
const clipSeconds = z.number().finite().min(0).max(MAX_CLIP_SECONDS);
const unitInterval = z.number().finite().min(0).max(1);

// Every channel is a bounded pair of authored endpoints. There are no keyframe
// arrays and no provider-authored curves: an easing NAME picks one of four
// interpolations PortOS implements, which is what keeps playback deterministic
// and the contract small enough to validate exhaustively.
const rangeSchema = (valueSchema) => z.object({ from: valueSchema, to: valueSchema });

const cueSchema = z.object({
  id: idSchema,
  label: z.string().trim().min(1).max(120),
  kind: z.enum(THREEJS_CUE_KINDS).default('mechanical'),
});

// `visible` is a STEP, not an interpolation: the part holds `from` for the whole
// window and takes `to` the instant the sequence completes. A part that should
// appear part-way through a clip is authored as its own short sequence ending at
// that instant — which keeps the evaluator a pure function of time with no
// hidden fade semantics.
const CHANNEL_KEYS = ['position', 'rotationDegrees', 'scale', 'opacity', 'visible'];
// A sound cue synchronizes to MOVEMENT. A fade or a visibility flip has no
// mechanism behind it to hear, so it cannot be what a cue is attached to.
const MOTION_CHANNEL_KEYS = ['position', 'rotationDegrees', 'scale'];

const rangeChanges = (range) => {
  if (!range) return false;
  const { from, to } = range;
  if (Array.isArray(from) && Array.isArray(to)) return from.some((value, axis) => value !== to[axis]);
  return from !== to;
};

const makeSequenceSchema = (scaleSchema) => z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(120),
  partId: idSchema,
  startSeconds: clipSeconds,
  endSeconds: clipSeconds,
  easing: z.enum(THREEJS_CLIP_EASINGS).default('easeInOut'),
  channels: z.object({
    position: rangeSchema(vec3Schema).optional(),
    rotationDegrees: rangeSchema(vec3Schema).optional(),
    scale: rangeSchema(scaleSchema).optional(),
    opacity: rangeSchema(unitInterval).optional(),
    visible: rangeSchema(z.boolean()).optional(),
  }),
  // The cue this sequence fires when the playhead crosses its start during
  // PLAYBACK. Scrubbing never fires anything — that split is the whole reason
  // the cue is data rather than an embedded sound.
  cueId: idSchema.nullable().default(null),
}).superRefine((sequence, ctx) => {
  if (!(sequence.endSeconds > sequence.startSeconds)) {
    ctx.addIssue({ code: 'custom', message: 'a sequence must end after it starts', path: ['endSeconds'] });
  }
  const changed = CHANNEL_KEYS.filter((key) => rangeChanges(sequence.channels[key]));
  if (changed.length === 0) {
    // A sequence whose endpoints are equal occupies a window on the timeline and
    // moves nothing — indistinguishable from a modeling slip, and it would make
    // the overlap rule below reject a real sequence in the same window.
    ctx.addIssue({ code: 'custom', message: 'a sequence must change at least one channel', path: ['channels'] });
  }
  if (sequence.cueId && !changed.some((key) => MOTION_CHANNEL_KEYS.includes(key))) {
    ctx.addIssue({
      code: 'custom',
      message: `sequence ${sequence.id} fires cue ${sequence.cueId} without moving the part — attach a cue to a sequence that changes position, rotation, or scale`,
      path: ['cueId'],
    });
  }
});

const makeClipSchema = (scaleSchema) => z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(120),
  role: z.enum(THREEJS_CLIP_ROLES).default('custom'),
  durationSeconds: z.number().finite().min(MIN_CLIP_SECONDS).max(MAX_CLIP_SECONDS),
  loop: z.boolean().default(false),
  sequences: z.array(makeSequenceSchema(scaleSchema)).min(1).max(120),
}).superRefine((clip, ctx) => {
  const sequenceIds = new Set();
  // One window per part per channel. Two sequences driving the same channel of
  // the same part at the same time have no defined result — whichever the
  // evaluator happened to visit last would win, so the ambiguity is rejected at
  // authoring time instead of resolved by declaration order.
  const windows = new Map();
  clip.sequences.forEach((sequence, index) => {
    if (sequenceIds.has(sequence.id)) {
      ctx.addIssue({ code: 'custom', message: `duplicate sequence id: ${sequence.id}`, path: ['sequences', index, 'id'] });
    }
    sequenceIds.add(sequence.id);
    if (sequence.endSeconds > clip.durationSeconds) {
      ctx.addIssue({
        code: 'custom',
        message: `sequence ${sequence.id} ends at ${sequence.endSeconds}s, past the clip's ${clip.durationSeconds}s duration`,
        path: ['sequences', index, 'endSeconds'],
      });
    }
    for (const channel of CHANNEL_KEYS) {
      if (!sequence.channels[channel]) continue;
      const key = `${sequence.partId}|${channel}`;
      const claimed = windows.get(key) || [];
      const clash = claimed.find((other) => sequence.startSeconds < other.endSeconds && other.startSeconds < sequence.endSeconds);
      if (clash) {
        ctx.addIssue({
          code: 'custom',
          message: `sequences ${clash.id} and ${sequence.id} both drive ${channel} of part ${sequence.partId} at the same time`,
          path: ['sequences', index, 'channels', channel],
        });
      }
      claimed.push(sequence);
      windows.set(key, claimed);
    }
  });
});

const makeAnimationSchema = (scaleSchema) => z.object({
  clips: z.array(makeClipSchema(scaleSchema)).min(1).max(12),
  cues: z.array(cueSchema).max(24).default([]),
}).superRefine((animation, ctx) => {
  const cueIds = new Set();
  animation.cues.forEach((cue, index) => {
    if (cueIds.has(cue.id)) {
      ctx.addIssue({ code: 'custom', message: `duplicate cue id: ${cue.id}`, path: ['cues', index, 'id'] });
    }
    cueIds.add(cue.id);
  });
  const clipIds = new Set();
  animation.clips.forEach((clip, clipIndex) => {
    if (clipIds.has(clip.id)) {
      ctx.addIssue({ code: 'custom', message: `duplicate clip id: ${clip.id}`, path: ['clips', clipIndex, 'id'] });
    }
    clipIds.add(clip.id);
    clip.sequences.forEach((sequence, index) => {
      if (sequence.cueId && !cueIds.has(sequence.cueId)) {
        ctx.addIssue({
          code: 'custom',
          message: `unknown cue: ${sequence.cueId}`,
          path: ['clips', clipIndex, 'sequences', index, 'cueId'],
        });
      }
    });
  });
});

const makeSpecSchema = (scaleSchema) => z.object({
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
  // Optional and additive, same contract as `articulation` and `animation`: a
  // spec authored before image-based lighting shipped simply has no key, which
  // `resolveThreejsEnvironment` reads as the `none` it was actually rendered
  // with. A newly authored spec is asked for a real preset.
  environment: environmentSchema.optional(),
  parts: z.array(makePartSchema(scaleSchema)).min(1).max(40),
  sockets: z.array(socketSchema).max(40).default([]),
  // Optional and additive: a spec written before articulation shipped simply has
  // no key, which every consumer reads as "static assembly", never as "rigged".
  articulation: articulationSchema.optional(),
  // Same contract: absent means the model is a static assembly with nothing to
  // play, which is what every spec authored before clips shipped says.
  animation: makeAnimationSchema(scaleSchema).optional(),
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

    // The model root carries no relationship to any body part, so anchoring to
    // it is the literal defect this field exists to catch. PortOS has no scene
    // root PART — `parts` is an array — so the root is the sole top-level part
    // when there is exactly one: that part IS the whole assembly. A spec with
    // several top-level parts has no such container, and each of them is a real
    // component worth anchoring to.
    const rootPartId = spec.parts.length === 1 ? spec.parts[0].id : null;
    const socketParentByName = new Map(spec.sockets.map((socket) => [socket.name, socket.parentPartId]));
    const anchorPartByAttachment = new Map();
    const seenAttachmentPartIds = new Set();

    for (const [index, attachment] of spec.articulation.attachments.entries()) {
      const at = (key) => ['articulation', 'attachments', index, key];
      if (!partIds.has(attachment.partId)) {
        ctx.addIssue({ code: 'custom', message: `unknown attachment part: ${attachment.partId}`, path: at('partId') });
      } else if (jointPartIds.has(attachment.partId)) {
        ctx.addIssue({ code: 'custom', message: `part ${attachment.partId} is declared as an attachment and also driven by a joint`, path: at('partId') });
      }
      if (seenAttachmentPartIds.has(attachment.partId)) {
        ctx.addIssue({ code: 'custom', message: `duplicate attachment part: ${attachment.partId}`, path: at('partId') });
      }
      seenAttachmentPartIds.add(attachment.partId);

      // Resolve whichever anchor form was given down to the part it names, so
      // self-anchoring, root-anchoring, and cycles are one check apiece rather
      // than one per form.
      let anchorPartId = null;
      if (attachment.anchorPartId !== null) {
        if (!partIds.has(attachment.anchorPartId)) {
          ctx.addIssue({ code: 'custom', message: `unknown attachment anchor part: ${attachment.anchorPartId}`, path: at('anchorPartId') });
        } else {
          anchorPartId = attachment.anchorPartId;
        }
      } else if (attachment.anchorSocket !== null) {
        if (!socketNames.has(attachment.anchorSocket)) {
          ctx.addIssue({ code: 'custom', message: `unknown attachment anchor socket: ${attachment.anchorSocket}`, path: at('anchorSocket') });
        } else {
          anchorPartId = socketParentByName.get(attachment.anchorSocket) ?? null;
        }
      }

      if (anchorPartId !== null) {
        const anchorPath = attachment.anchorPartId !== null ? at('anchorPartId') : at('anchorSocket');
        if (anchorPartId === attachment.partId) {
          ctx.addIssue({ code: 'custom', message: `attachment ${attachment.partId} is anchored to itself`, path: anchorPath });
        } else if (anchorPartId === rootPartId) {
          ctx.addIssue({
            code: 'custom',
            message: `attachment ${attachment.partId} is anchored to the model root ${anchorPartId}, which names no body part to hang from`,
            path: anchorPath,
          });
        } else {
          anchorPartByAttachment.set(attachment.partId, { anchorPartId, path: anchorPath });
        }
      }
    }

    // An anchor chain that closes on itself describes no position: a pack on a
    // strap on the pack. Walk each chain to its end; every hop is an attachment
    // that was itself anchored, so the walk is bounded by the entry count.
    for (const [partId, entry] of anchorPartByAttachment) {
      const visited = new Set([partId]);
      let cursor = entry.anchorPartId;
      while (cursor && anchorPartByAttachment.has(cursor) && !visited.has(cursor)) {
        visited.add(cursor);
        cursor = anchorPartByAttachment.get(cursor).anchorPartId;
      }
      if (cursor && visited.has(cursor)) {
        ctx.addIssue({
          code: 'custom',
          message: `attachment ${partId} sits on an anchor chain that cycles back through ${cursor}`,
          path: entry.path,
        });
      }
    }
  }

  if (spec.animation) {
    for (const [clipIndex, clip] of spec.animation.clips.entries()) {
      for (const [index, sequence] of clip.sequences.entries()) {
        if (!partIds.has(sequence.partId)) {
          ctx.addIssue({
            code: 'custom',
            message: `unknown sequence part: ${sequence.partId}`,
            path: ['animation', 'clips', clipIndex, 'sequences', index, 'partId'],
          });
        }
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
export const threejsSculptSpecSchema = makeSpecSchema(scale3Schema);

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
export const storedThreejsSculptSpecSchema = makeSpecSchema(vec3Schema);

/**
 * One canonical attachment list from the two forms a spec may declare.
 *
 * `attachmentPartIds` (the original, anchor-less form) and `attachments` (the
 * anchored one) both mean "this part is carried", so every gate that reasons
 * about attachments reads them through here rather than each picking a form and
 * disagreeing with the next. An anchored entry wins over a bare id for the same
 * part — the richer declaration is the one the author meant.
 *
 * @param {object|null} articulation a spec's `articulation` object, or null
 * @returns {Array<{partId: string, anchorPartId: string|null, anchorSocket: string|null, maxOffset: number}>}
 */
export function resolveThreejsAttachments(articulation) {
  const entries = new Map();
  const bareIds = Array.isArray(articulation?.attachmentPartIds) ? articulation.attachmentPartIds : [];
  for (const partId of bareIds) {
    if (typeof partId !== 'string' || entries.has(partId)) continue;
    entries.set(partId, { partId, anchorPartId: null, anchorSocket: null, maxOffset: DEFAULT_ATTACHMENT_MAX_OFFSET });
  }
  const anchored = Array.isArray(articulation?.attachments) ? articulation.attachments : [];
  for (const attachment of anchored) {
    if (typeof attachment?.partId !== 'string') continue;
    entries.set(attachment.partId, {
      partId: attachment.partId,
      anchorPartId: attachment.anchorPartId ?? null,
      anchorSocket: attachment.anchorSocket ?? null,
      maxOffset: Number.isFinite(attachment.maxOffset) ? attachment.maxOffset : DEFAULT_ATTACHMENT_MAX_OFFSET,
    });
  }
  return [...entries.values()];
}

/**
 * Whether a resolved attachment names something to hang from at all.
 * @param {{anchorPartId: string|null, anchorSocket: string|null}} attachment
 * @returns {boolean}
 */
export const isThreejsAttachmentAnchored = (attachment) => (
  Boolean(attachment?.anchorPartId) || Boolean(attachment?.anchorSocket)
);

/** Validate a stored scene spec and export it as a standalone Three.js factory. */
export function buildThreejsFactorySource(input) {
  // Exporting reads a STORED spec, so it validates against the read contract —
  // an install's existing model stays downloadable even if it predates a bound.
  // The parse still has to happen (the emitted source must be well-formed), and
  // a raw ZodError would normalize to an opaque 500 saying nothing a user can act
  // on, so `failValidation` names the offending path in a 400 instead.
  const parsed = storedThreejsSculptSpecSchema.safeParse(input);
  if (!parsed.success) failValidation(parsed);
  return buildThreejsFactorySourceFromSpec(parsed.data);
}

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
import {
  resolveThreejsEnvironment,
  THREEJS_ENVIRONMENT_PRESETS,
  THREEJS_RENDER_PROFILE,
} from './threejsModelEnvironment.js';
import { THREEJS_PLAYER_SOURCE } from './threejsModelPlayerSource.js';

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

// An extrude can represent a membrane only when its sweep is negligible at the
// scale of its outline. Keep this relative so the declaration works for both a
// small fin and a large cape, while a positive-depth plate remains a solid slab.
const OPEN_SHELL_DEPTH_RATIO = 1e-3;

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

// Three.js composes a part's local transform as rotation * scale, then applies
// each ancestor's transform from the outside. Keeping the linear part here is
// enough for the relative thickness check and avoids making the server-side gate
// depend on Three.js just to answer a geometry question.
const IDENTITY_LINEAR = [1, 0, 0, 0, 1, 0, 0, 0, 1];

const multiplyLinear = (a, b) => [
  (a[0] * b[0]) + (a[1] * b[3]) + (a[2] * b[6]),
  (a[0] * b[1]) + (a[1] * b[4]) + (a[2] * b[7]),
  (a[0] * b[2]) + (a[1] * b[5]) + (a[2] * b[8]),
  (a[3] * b[0]) + (a[4] * b[3]) + (a[5] * b[6]),
  (a[3] * b[1]) + (a[4] * b[4]) + (a[5] * b[7]),
  (a[3] * b[2]) + (a[4] * b[5]) + (a[5] * b[8]),
  (a[6] * b[0]) + (a[7] * b[3]) + (a[8] * b[6]),
  (a[6] * b[1]) + (a[7] * b[4]) + (a[8] * b[7]),
  (a[6] * b[2]) + (a[7] * b[5]) + (a[8] * b[8]),
];

const rotationLinear = (degrees = [0, 0, 0]) => {
  const [x = 0, y = 0, z = 0] = degrees;
  const ax = (Number.isFinite(x) ? x : 0) * (Math.PI / 180);
  const ay = (Number.isFinite(y) ? y : 0) * (Math.PI / 180);
  const az = (Number.isFinite(z) ? z : 0) * (Math.PI / 180);
  const a = Math.cos(ax);
  const b = Math.sin(ax);
  const c = Math.cos(ay);
  const d = Math.sin(ay);
  const e = Math.cos(az);
  const f = Math.sin(az);
  // Row-major equivalent of THREE.Euler's default XYZ matrix.
  return [
    c * e, -c * f, d,
    (b * d * e) + (a * f), (-b * d * f) + (a * e), -b * c,
    (-a * d * e) + (b * f), (a * d * f) + (b * e), a * c,
  ];
};

const scaleLinear = (scale = [1, 1, 1]) => [
  Number.isFinite(scale[0]) ? scale[0] : 1, 0, 0,
  0, Number.isFinite(scale[1]) ? scale[1] : 1, 0,
  0, 0, Number.isFinite(scale[2]) ? scale[2] : 1,
];

const partLinear = (part) => multiplyLinear(
  rotationLinear(part.rotationDegrees),
  scaleLinear(part.scale),
);

const applyLinear = (matrix, vector) => [
  (matrix[0] * vector[0]) + (matrix[1] * vector[1]) + (matrix[2] * vector[2]),
  (matrix[3] * vector[0]) + (matrix[4] * vector[1]) + (matrix[5] * vector[2]),
  (matrix[6] * vector[0]) + (matrix[7] * vector[1]) + (matrix[8] * vector[2]),
];

const vectorLength = (vector) => Math.hypot(...vector);

const transformVertices = (vertices, matrix) => {
  const transformed = [];
  for (let index = 0; index + 2 < vertices.length; index += 3) {
    transformed.push(...applyLinear(matrix, vertices.slice(index, index + 3)));
  }
  return transformed;
};

const isZeroThicknessGeometry = (geometry, worldLinear = IDENTITY_LINEAR) => {
  if (!geometry) return false;
  if (geometry.type === 'custom') {
    const vertices = Array.isArray(geometry.vertices) ? geometry.vertices : [];
    return vertices.length >= 9 && isCoplanarCloud(transformVertices(vertices, worldLinear));
  }
  if (geometry.type !== 'extrude') return false;
  const outline = Array.isArray(geometry.outline) ? geometry.outline : [];
  if (outline.length < 3 || !(geometry.depth > 0)) return false;
  const xs = outline.map(([x]) => x);
  const ys = outline.map(([, y]) => y);
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys);
  const xSpan = spanX * vectorLength(applyLinear(worldLinear, [1, 0, 0]));
  const ySpan = spanY * vectorLength(applyLinear(worldLinear, [0, 1, 0]));
  const span = Math.max(xSpan, ySpan);
  const thickness = geometry.depth * vectorLength(applyLinear(worldLinear, [0, 0, 1]));
  return span > 0 && thickness > 0 && thickness / span <= OPEN_SHELL_DEPTH_RATIO;
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
  const worldLinearById = new Map();
  const indexPart = (part, parentLinear = IDENTITY_LINEAR) => {
    byId.set(part.id, part);
    const worldLinear = multiplyLinear(parentLinear, partLinear(part));
    worldLinearById.set(part.id, worldLinear);
    for (const child of part.children || []) indexPart(child, worldLinear);
  };
  for (const part of spec?.parts || []) indexPart(part);

  const details = Array.isArray(spec?.detailInventory) ? spec.detailInventory : [];
  const slabPartIds = new Set();
  const flatDetails = [];
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
    flatDetails.push({
      feature: detail.feature,
      partIds: implementing.map((mesh) => mesh.id),
      isIntentionalMembrane: implementing.every((mesh) => (
        spec?.materials?.[mesh.material]?.side === 'double'
        && isZeroThicknessGeometry(mesh.geometry, worldLinearById.get(mesh.id))
      )),
    });
    for (const mesh of implementing) slabPartIds.add(mesh.id);
  }

  // `null`, not 0: a spec with no buildable identity feature was not measured
  // flat, it was not measured at all, and a 0 would read as a clean result.
  const flatFeatures = flatDetails.map(({ feature }) => feature);
  const intentionalMembraneDetails = flatDetails.filter(({ isIntentionalMembrane }) => isIntentionalMembrane);
  const intentionalMembraneFeatures = intentionalMembraneDetails.map(({ feature }) => feature);
  const unintentionalDetails = flatDetails.filter(({ isIntentionalMembrane }) => !isIntentionalMembrane);
  const unintentionalFeatures = unintentionalDetails.map(({ feature }) => feature);
  const intentionalMembranePartIds = new Set(intentionalMembraneDetails.flatMap(({ partIds }) => partIds));
  const flatRatio = evaluated === 0 ? null : flatFeatures.length / evaluated;
  const findings = [];
  if (flatRatio !== null && flatRatio > FLAT_IDENTITY_RATIO_THRESHOLD) {
    const nonMembraneFeatureCount = evaluated - intentionalMembraneDetails.length;
    const nonMembraneFlatRatio = nonMembraneFeatureCount === 0
      ? 0
      : unintentionalFeatures.length / nonMembraneFeatureCount;
    if (intentionalMembraneFeatures.length > 0) {
      findings.push({
        code: 'flat-identity-parts',
        severity: 'note',
        partIds: [...intentionalMembranePartIds],
        features: intentionalMembraneFeatures,
        message: `${intentionalMembraneFeatures.length} of ${evaluated} identity-defining features are intentional membrane surfaces (zero-thickness open shells: ${listSpecNames(intentionalMembraneFeatures)}). Their materials are double-sided (side "double"), so they remain visible from both sides.`,
      });
    }
    if (nonMembraneFlatRatio > FLAT_IDENTITY_RATIO_THRESHOLD) {
      const offenders = [...new Set(unintentionalDetails.flatMap(({ partIds }) => partIds))];
      findings.push({
        code: 'flat-identity-parts',
        severity: 'warning',
        partIds: offenders,
        features: unintentionalFeatures,
        message: `${unintentionalFeatures.length} of ${nonMembraneFeatureCount} identity-defining features are built only from flat parts (${listSpecNames(offenders.map((id) => byId.get(id)?.name || id))}). The model will read as a projection the moment it is orbited — give the parts the subject's identity rides on a real cross-section instead of stacking unbevelled extrusions and planar triangle fans. If a part is genuinely a zero-thickness membrane, make its material double-sided (side "double") instead; do not use that declaration to avoid giving a solid part real depth.`,
      });
    }
  }

  const warningCount = findings.filter((finding) => finding.severity === 'warning').length;
  const noteCount = findings.filter((finding) => finding.severity === 'note').length;

  return {
    findings,
    errorCount: 0,
    warningCount,
    noteCount,
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
    'Rebuild those parts with genuine depth: compose them from primitives, or give an extrude a bevel, so the model holds up from any orbit angle. If a part is genuinely a zero-thickness membrane — such as a cape, leaf, fin, or wing — make its material double-sided (side "double") instead, but never use that declaration to avoid giving a solid part real depth.',
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

// A keyword claimed by two families would silently resolve to whichever entry
// is declared last, which is exactly the confident-nonsense the ambiguity rule
// above exists to prevent — so a collision fails at import rather than at
// review time.
const MATERIAL_KEYWORD_FAMILIES = MATERIAL_FAMILY_PRIORS.reduce((map, prior) => {
  for (const keyword of prior.keywords) {
    const owner = map.get(keyword);
    if (owner) throw new Error(`material family keyword "${keyword}" is claimed by both ${owner.family} and ${prior.family}`);
    map.set(keyword, prior);
  }
  return map;
}, new Map());

// `basic` is unlit, so none of these channels reach the renderer at all; the
// physical-only ones are parsed for every type but only forwarded by
// `type: 'physical'` (see `createMaterial`). Reporting a channel that cannot
// affect the render would be a finding the user can do nothing useful with.
const MATERIAL_CHANNELS_BY_TYPE = {
  basic: [],
  standard: ['metalness', 'roughness'],
  physical: ['metalness', 'roughness', 'clearcoat', 'ior', 'transmission', 'sheen'],
};

// The channels that read off an ENVIRONMENT rather than off the punctual lights:
// with nothing to reflect, a conductor renders near-black and transmission,
// clearcoat and iridescence do essentially nothing. Same type filter as above —
// `basic` is unlit and the physical-only channels are forwarded only by
// `type: 'physical'` — so the note never names a channel that could not have
// rendered anyway. The metalness threshold is the metal family's own floor: a
// dielectric with a little metalness has almost nothing to lose here.
const REFLECTIVE_METALNESS_FLOOR = 0.6;
const REFLECTIVE_CHANNELS_BY_TYPE = {
  basic: [],
  standard: ['metalness'],
  physical: ['metalness', 'transmission', 'clearcoat', 'iridescence'],
};

// A channel counts as authored when it is above the floor its own absence would
// sit at: metalness has a real threshold, the rest are opt-in from zero.
const reflectiveChannelFloor = (channel) => (channel === 'metalness' ? REFLECTIVE_METALNESS_FLOOR : 0);

/**
 * Split a spec identifier — a material id, a part name, a feature phrase — into
 * lowercase word tokens, breaking on separators AND on camelCase boundaries so
 * `oakTrim` and `oak_trim` tokenize the same. A trailing
 * plural is folded in as an extra candidate token rather than replacing the
 * original, so `planks` matches `plank` without `abs` losing its own keyword.
 */
const tokenizeSpecIdentifier = (id) => {
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
  for (const token of tokenizeSpecIdentifier(id)) {
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
 *   materialCount: number, matchedMaterialCount: number}}
 */
export function evaluateThreejsMaterialPlausibility(spec) {
  const materials = (spec?.materials && typeof spec.materials === 'object') ? spec.materials : {};
  const findings = [];
  const unlitReflective = [];
  const environment = resolveThreejsEnvironment(spec);
  let matched = 0;

  for (const [id, material] of Object.entries(materials)) {
    if (environment.preset === 'none') {
      const reflective = (REFLECTIVE_CHANNELS_BY_TYPE[material?.type] || REFLECTIVE_CHANNELS_BY_TYPE.standard)
        .filter((channel) => {
          const value = material?.[channel];
          return typeof value === 'number' && Number.isFinite(value) && value > reflectiveChannelFloor(channel);
        });
      if (reflective.length > 0) unlitReflective.push({ id, channels: reflective });
    }
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

  // One finding per implausible material, so the warning tally is also the count
  // of materials that failed — no separate tally that could disagree with it.
  const warningCount = findings.length;

  // One note for the whole spec rather than one per material: the remedy is a
  // single spec-level choice, and repeating it per material would bury the
  // substance warnings above it.
  if (unlitReflective.length > 0) {
    findings.push({
      code: 'reflective-material-without-environment',
      severity: 'note',
      materialIds: unlitReflective.map((entry) => entry.id),
      channels: unlitReflective,
      message: `${listSpecNames(unlitReflective.map((entry) => entry.id))} author reflective channels (${listSpecNames([...new Set(unlitReflective.flatMap((entry) => entry.channels))])}) while "environment.preset" is "none". Those channels read off an environment, so in this scene a conductor renders near-black and transmission, clearcoat and iridescence do essentially nothing — the values cannot be judged as authored. Give the spec an environment ("neutral" or "studio") to see them.`,
    });
  }

  return {
    findings,
    errorCount: 0,
    warningCount,
    noteCount: findings.length - warningCount,
    materialCount: Object.keys(materials).length,
    matchedMaterialCount: matched,
  };
}

/**
 * Default refinement feedback derived from a stored material-plausibility
 * result: the substance warnings, then the unlit-reflective note if the spec
 * authored reflective channels with no environment. Returns '' when there is
 * neither, so the caller falls through to whatever other feedback it has.
 */
export function buildThreejsMaterialFeedback(plausibility) {
  const findings = plausibility?.findings || [];
  const warnings = findings.filter((finding) => finding.severity === 'warning');
  const substance = warnings.length === 0 ? [] : [
    'The previous pass gave some materials values that do not match the substance they are named for:',
    ...warnings.map((finding, index) => `${index + 1}. ${finding.message}`),
    'Set each channel from what the surface actually is — bare metal is metallic and fairly smooth, wood and stone are rough dielectrics, glass transmits — and keep any deliberate stylization you still want.',
  ];
  // The unlit-reflective note is fed back as well as displayed: choosing an
  // environment preset is a change the next pass can actually make, and leaving
  // it out is what lets a refinement "fix" a black conductor by dropping its
  // metalness instead.
  const unlit = findings.filter((finding) => finding.code === 'reflective-material-without-environment');
  return [...substance, ...unlit.map((finding) => finding.message)].join('\n');
}

// Swept-arc curvature gate. A generated spec routinely DECLARES a curved feature
// — a horn, a tail, a hook, a bent conduit — and then implements it with a
// straight run of control points. Every bounds-based check is blind to that: the
// bounding box of a straight tube is a perfectly reasonable box, nothing
// penetrates anything, the part touches its parent, and the silhouette from the
// generated camera can even be right. Only the SHAPE of the swept path says the
// horn does not curve.
//
// Two different measurements, because the two sweep geometries carry their
// curvature in different places:
//
//  * `tube` sweeps a circle along an explicit list of control points, so the
//    curvature lives in that polyline. The points are fitted to their best-fit
//    plane and then to a circle within it, and the path counts as curved when it
//    rides that circle — a fit its points really lie on, spanning a minimum
//    angle, with the centre a bounded distance from the path — or, for a bend
//    that rides no single circle at all, when its excursion from its own
//    best-fit line is large enough to see. Each bound below rejects a different
//    degenerate fit.
//  * `extrude` sweeps a closed outline along a STRAIGHT axis, so there is no
//    sweep path to fit an arc to — and a closed ring is useless as one, since it
//    has no endpoints and always turns a full 360°. Its curvature is in the
//    outline's silhouette instead: a curved form (crescent, hook, claw) has a
//    concave side, while a straight tapered spike is convex however finely it is
//    subdivided. So the outline is measured by how much of its turning is
//    concave.
//
// Both gates fire only on a part the spec itself declares curved — by name, or
// through a `detailInventory` feature that names it. `tube` and `extrude` are
// the right answer for plenty of straight parts (a rail, a plate, a strut), so a
// straight sweep is evidence of nothing until something says it was meant to
// bend.

// How far a path has to turn to read as a curve rather than as authoring slack.
// The travel is accumulated as an ABSOLUTE sum per segment rather than as the
// signed range about the fitted centre: an S-curved tail sweeps one way and then
// back, and a signed range would cancel those halves and report a genuinely
// curved path as straight.
export const SWEPT_ARC_MIN_SPAN_DEGREES = 25;

// Absolute accumulation means authoring noise ADDS UP instead of cancelling, so
// a jittered straight run reaches the span threshold without ever bending. A
// span is therefore only credited when the points actually LIE on the circle
// that was fitted to them, measured as RMS radial error against its radius.
const SWEPT_ARC_MAX_RADIAL_ERROR_RATIO = 0.05;

// And the fitted circle has to sit alongside the path rather than out at
// infinity: an arc riding one circle puts its centre about a radius away, which
// at 25° of span is 2.25 times the path's own extent. For a clean fit this
// agrees with the span bound by construction — it is the bound that still holds
// when the fit is only approximate, and the span it produced cannot be trusted
// on its own.
const SWEPT_ARC_MAX_CENTER_DISTANCE_RATIO = 3;

// An arc fit answers "does this ride ONE circle", which an S-curved tail and a
// sharply kinked hook both fail while being obviously not straight. So bending
// is also measured directly, as the path's largest excursion from its own
// best-fit line relative to its extent — the one measure that survives a path
// with no single centre at all.
const SWEPT_PATH_MIN_SAGITTA_RATIO = 0.05;

// A crescent's concave (inner) boundary turns back through about the same angle
// its outer boundary sweeps, so the outline threshold is the arc threshold.
export const CURVED_OUTLINE_MIN_CONCAVE_TURN_DEGREES = 25;

// Concavity has to be SUSTAINED, not merely present. Summed over the whole ring,
// a single deep V-notch at the base of an otherwise straight spike buys hundreds
// of degrees, and serrated, stepped, and slotted silhouettes are common — so the
// gate would pass exactly the straight claw it exists to catch. A run of concave
// vertices only counts when the boundary it governs is a real stretch of the
// outline rather than a nick in it.
const CONCAVE_RUN_MIN_LENGTH_RATIO = 0.25;

// Tokens that declare a form which has to bend to read as itself. Deliberately
// narrow, because this text is fed back into the next refinement pass: a false
// positive does not merely add noise, it TELLS the provider to bend a part that
// was right to be straight.
//
// So a noun earns a bare place here only when a straight version of the part
// would be wrong. "pipe", "rod", "trunk", "tail", "whisker", "bow", and "barb"
// are all absent — a tail boom runs down a fuselage, a tail fin is a flat plate,
// and a whisker is a straight bristle — and they declare a curve only through a
// modifier that is itself on the list, which is why "curved tail" and "coiled
// tail" still match. Bare "arc" and "hoop" are absent for a different reason: an
// "arcReactor" is a disc, and a hoop authored as an extruded ring has a convex
// outline with the curve in its HOLE, so both would report a correct build as
// the defect.
const CURVED_FORM_TOKENS = new Set([
  'horn', 'antler', 'tusk', 'fang', 'claw', 'talon', 'pincer', 'mandible',
  'tentacle', 'hook', 'crook',
  'curve', 'curved', 'curving', 'curl', 'curled', 'coil', 'coiled', 'spiral',
  'bend', 'bent', 'arced', 'arch', 'arched', 'bowed',
  'crescent', 'scythe', 'sickle', 'elbow',
]);

/**
 * True when an identifier names a form that has to bend. Reuses the material
 * tokenizer so `hornLeft`, `horn_left`, and `Horns` all match.
 */
const namesCurvedForm = (identifier) => tokenizeSpecIdentifier(identifier)
  .some((token) => CURVED_FORM_TOKENS.has(token));

const crossProduct = (a, b) => [
  (a[1] * b[2]) - (a[2] * b[1]),
  (a[2] * b[0]) - (a[0] * b[2]),
  (a[0] * b[1]) - (a[1] * b[0]),
];

/**
 * The eigenvector of the smallest eigenvalue of a symmetric 3x3 covariance —
 * the best-fit plane's normal. Closed-form rather than iterative: a path carries
 * at most 96 points and the audit runs on every refinement pass.
 *
 * @param {number[]} covariance `[xx, yy, zz, xy, xz, yz]`
 */
const smallestEigenvector = ([xx, yy, zz, xy, xz, yz]) => {
  const offDiagonal = (xy * xy) + (xz * xz) + (yz * yz);
  const mean = (xx + yy + zz) / 3;
  let smallest;
  if (offDiagonal <= 0) {
    smallest = Math.min(xx, yy, zz);
  } else {
    const spread = ((xx - mean) ** 2) + ((yy - mean) ** 2) + ((zz - mean) ** 2) + (2 * offDiagonal);
    const scale = Math.sqrt(spread / 6);
    const b = [
      (xx - mean) / scale, xy / scale, xz / scale,
      xy / scale, (yy - mean) / scale, yz / scale,
      xz / scale, yz / scale, (zz - mean) / scale,
    ];
    const determinant = (b[0] * ((b[4] * b[8]) - (b[5] * b[7])))
      - (b[1] * ((b[3] * b[8]) - (b[5] * b[6])))
      + (b[2] * ((b[3] * b[7]) - (b[4] * b[6])));
    const phi = Math.acos(Math.min(1, Math.max(-1, determinant / 2))) / 3;
    const first = mean + (2 * scale * Math.cos(phi));
    const third = mean + (2 * scale * Math.cos(phi + ((2 * Math.PI) / 3)));
    smallest = Math.min(first, third, (3 * mean) - first - third);
  }
  // The null space of (covariance - smallest * I): every pair of its rows spans
  // the plane, so their cross product is the normal. The longest one is taken
  // because a near-degenerate pair produces numerical dust.
  const rows = [
    [xx - smallest, xy, xz],
    [xy, yy - smallest, yz],
    [xz, yz, zz - smallest],
  ];
  let normal = null;
  let longest = 0;
  for (let i = 0; i < 3; i += 1) {
    for (let j = i + 1; j < 3; j += 1) {
      const candidate = crossProduct(rows[i], rows[j]);
      const length = vectorLength(candidate);
      if (length > longest) {
        longest = length;
        normal = candidate;
      }
    }
  }
  return longest > 0 ? normal.map((value) => value / longest) : [0, 0, 1];
};

/**
 * Least-squares circle through 2D points (Kasa). Returns `null` when the points
 * are collinear, where the normal equations are singular and any "circle"
 * through them is an artifact of float noise.
 */
const fitCircle2D = (points) => {
  const count = points.length;
  const meanX = points.reduce((total, [x]) => total + x, 0) / count;
  const meanY = points.reduce((total, [, y]) => total + y, 0) / count;
  let suu = 0; let svv = 0; let suv = 0; let suuu = 0; let svvv = 0; let suvv = 0; let svuu = 0;
  for (const [x, y] of points) {
    const u = x - meanX;
    const v = y - meanY;
    suu += u * u; svv += v * v; suv += u * v;
    suuu += u * u * u; svvv += v * v * v;
    suvv += u * v * v; svuu += v * u * u;
  }
  const determinant = (suu * svv) - (suv * suv);
  // Relative, not absolute: the same collinear path authored in millimetres and
  // in metres must both read as collinear.
  if (Math.abs(determinant) <= ((suu + svv) ** 2) * 1e-12) return null;
  const rhsU = (suuu + suvv) / 2;
  const rhsV = (svvv + svuu) / 2;
  const centerU = ((rhsU * svv) - (rhsV * suv)) / determinant;
  const centerV = ((rhsV * suu) - (rhsU * suv)) / determinant;
  return {
    center: [meanX + centerU, meanY + centerV],
    radius: Math.sqrt((centerU * centerU) + (centerV * centerV) + ((suu + svv) / count)),
    centroid: [meanX, meanY],
  };
};

/**
 * The largest perpendicular excursion of 2D points from their own best-fit
 * line. Straightness measured directly, so a path that bends without riding any
 * single circle still reads as bent.
 */
const maxDeviationFromBestFitLine = (points) => {
  const meanX = points.reduce((total, [x]) => total + x, 0) / points.length;
  const meanY = points.reduce((total, [, y]) => total + y, 0) / points.length;
  let sxx = 0; let syy = 0; let sxy = 0;
  for (const [x, y] of points) {
    sxx += (x - meanX) ** 2;
    syy += (y - meanY) ** 2;
    sxy += (x - meanX) * (y - meanY);
  }
  // The principal direction of a symmetric 2x2 scatter, in closed form.
  const angle = Math.atan2(2 * sxy, sxx - syy) / 2;
  const normal = [-Math.sin(angle), Math.cos(angle)];
  return points.reduce((widest, [x, y]) => Math.max(
    widest,
    Math.abs(((x - meanX) * normal[0]) + ((y - meanY) * normal[1])),
  ), 0);
};

/**
 * Measure how far a swept path actually bends.
 *
 * The points are projected onto their own best-fit plane and fitted to a circle
 * there. The path is credited as curved when it rides that circle — a fit its
 * points really lie on, spanning a minimum angle, with the centre a bounded
 * distance from the path — OR, for a bend that rides no single circle, when its
 * excursion from its own best-fit line is large enough to see.
 *
 * @param {Array<number[]>} points ordered `[x, y, z]` control points
 * @returns {{straight: boolean, collinear: boolean, arcSpanDegrees: number,
 *   radius: number|null, centerDistanceRatio: number|null,
 *   radialErrorRatio: number|null, sagittaRatio: number, extent: number}}
 */
export function evaluateSweptArcCurvature(points) {
  const usable = (Array.isArray(points) ? points : [])
    .filter((point) => Array.isArray(point) && point.length === 3 && point.every(Number.isFinite));
  const straightResult = (extent) => ({
    straight: true,
    collinear: true,
    arcSpanDegrees: 0,
    radius: null,
    centerDistanceRatio: null,
    radialErrorRatio: null,
    sagittaRatio: 0,
    extent,
  });
  const separation = (a, b) => vectorLength(b.map((value, axis) => value - a[axis]));
  // Two points ARE a straight segment, and an exactly collinear run of any
  // length sweeps one too — no fit is needed, and none would be meaningful.
  if (usable.length < 3) return straightResult(usable.length === 2 ? separation(usable[0], usable[1]) : 0);
  if (isCollinearPath(usable)) return straightResult(separation(usable[0], usable[usable.length - 1]));

  const centroid = [0, 1, 2].map((axis) => usable.reduce((total, point) => total + point[axis], 0) / usable.length);
  const offsets = usable.map((point) => point.map((value, axis) => value - centroid[axis]));
  const covariance = [0, 0, 0, 0, 0, 0];
  for (const [x, y, z] of offsets) {
    covariance[0] += (x * x) / offsets.length;
    covariance[1] += (y * y) / offsets.length;
    covariance[2] += (z * z) / offsets.length;
    covariance[3] += (x * y) / offsets.length;
    covariance[4] += (x * z) / offsets.length;
    covariance[5] += (y * z) / offsets.length;
  }
  const normal = smallestEigenvector(covariance);
  // Any seed not parallel to the normal spans the plane with it; the axis with
  // the smallest component is the one guaranteed not to be.
  const seed = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const uAxis = crossProduct(normal, seed);
  const uLength = vectorLength(uAxis);
  const u = uLength > 0 ? uAxis.map((value) => value / uLength) : [1, 0, 0];
  const v = crossProduct(normal, u);
  const projected = offsets.map((offset) => [
    (offset[0] * u[0]) + (offset[1] * u[1]) + (offset[2] * u[2]),
    (offset[0] * v[0]) + (offset[1] * v[1]) + (offset[2] * v[2]),
  ]);

  let extent = 0;
  for (let i = 0; i < projected.length; i += 1) {
    for (let j = i + 1; j < projected.length; j += 1) {
      extent = Math.max(extent, Math.hypot(projected[i][0] - projected[j][0], projected[i][1] - projected[j][1]));
    }
  }
  if (!(extent > 0)) return straightResult(extent);
  const sagittaRatio = maxDeviationFromBestFitLine(projected) / extent;

  const circle = fitCircle2D(projected);
  if (!circle) {
    return {
      straight: sagittaRatio < SWEPT_PATH_MIN_SAGITTA_RATIO,
      collinear: false,
      arcSpanDegrees: 0,
      radius: null,
      centerDistanceRatio: null,
      radialErrorRatio: null,
      sagittaRatio,
      extent,
    };
  }

  // Per-segment and absolute, so an S-curve accumulates its two opposing bends
  // instead of cancelling them. Safe to sum unsigned only because the radial
  // error below refuses to credit a span the points did not trace.
  let arcSpanRadians = 0;
  for (let index = 1; index < projected.length; index += 1) {
    const previous = Math.atan2(projected[index - 1][1] - circle.center[1], projected[index - 1][0] - circle.center[0]);
    const current = Math.atan2(projected[index][1] - circle.center[1], projected[index][0] - circle.center[0]);
    let step = current - previous;
    while (step > Math.PI) step -= 2 * Math.PI;
    while (step < -Math.PI) step += 2 * Math.PI;
    arcSpanRadians += Math.abs(step);
  }
  const arcSpanDegrees = (arcSpanRadians * 180) / Math.PI;
  const squaredRadialError = projected.reduce((total, [x, y]) => {
    const deviation = Math.hypot(x - circle.center[0], y - circle.center[1]) - circle.radius;
    return total + ((deviation * deviation) / projected.length);
  }, 0);
  const radialErrorRatio = Math.sqrt(squaredRadialError) / circle.radius;
  const centerDistanceRatio = Math.hypot(
    circle.center[0] - circle.centroid[0],
    circle.center[1] - circle.centroid[1],
  ) / extent;

  const ridesArc = radialErrorRatio <= SWEPT_ARC_MAX_RADIAL_ERROR_RATIO
    && arcSpanDegrees >= SWEPT_ARC_MIN_SPAN_DEGREES
    && centerDistanceRatio <= SWEPT_ARC_MAX_CENTER_DISTANCE_RATIO;

  return {
    straight: !ridesArc && sagittaRatio < SWEPT_PATH_MIN_SAGITTA_RATIO,
    collinear: false,
    arcSpanDegrees,
    radius: circle.radius,
    centerDistanceRatio,
    radialErrorRatio,
    sagittaRatio,
    extent,
  };
}

/**
 * The largest SUSTAINED concave turn in a closed outline, in degrees: the
 * longest unbroken run of concave vertices whose stretch of boundary is a real
 * fraction of the outline's own size. A convex ring returns 0; a crescent
 * returns roughly the arc its inner boundary sweeps; a notch or a serration in
 * an otherwise straight silhouette returns 0 however deep it is cut.
 *
 * @param {Array<number[]>} ring ordered `[x, y]` outline points
 */
export function measureOutlineConcaveTurn(ring) {
  const points = (Array.isArray(ring) ? ring : [])
    .filter((point) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite));
  if (points.length < 3) return 0;
  const segmentLength = (index) => {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    return Math.hypot(next[0] - current[0], next[1] - current[1]);
  };
  const turns = points.map((current, index) => {
    const previous = points[(index - 1 + points.length) % points.length];
    const next = points[(index + 1) % points.length];
    const incoming = [current[0] - previous[0], current[1] - previous[1]];
    const outgoing = [next[0] - current[0], next[1] - current[1]];
    return Math.atan2(
      (incoming[0] * outgoing[1]) - (incoming[1] * outgoing[0]),
      (incoming[0] * outgoing[0]) + (incoming[1] * outgoing[1]),
    );
  });
  // A simple ring turns through a full circle exactly once, so the sign of the
  // total is its winding — measured from the turns themselves rather than from a
  // signed area, so the two can never disagree about which side is concave.
  const winding = turns.reduce((total, turn) => total + turn, 0) >= 0 ? 1 : -1;
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const extent = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  if (!(extent > 0)) return 0;

  // Walked over two laps so a run straddling the start of the array is measured
  // whole rather than split into two short ones.
  let runTurn = 0;
  let runLength = 0;
  let widest = 0;
  for (let step = 0; step < points.length * 2; step += 1) {
    const index = step % points.length;
    const concave = -turns[index] * winding;
    if (concave > 0) {
      // The boundary a concave vertex governs runs from the segment arriving at
      // it to the segment leaving it, so a run picks up its leading segment once.
      if (runTurn === 0) runLength += segmentLength((index - 1 + points.length) % points.length);
      runTurn += concave;
      runLength += segmentLength(index);
      if (runLength >= extent * CONCAVE_RUN_MIN_LENGTH_RATIO) {
        widest = Math.max(widest, runTurn);
      }
    } else {
      runTurn = 0;
      runLength = 0;
    }
  }
  return (widest * 180) / Math.PI;
}

/**
 * Measure whichever sweep geometry this is, using the measure that geometry
 * carries its curvature in. Returns `null` for anything this gate cannot speak
 * about — a straight `box` rail named "elbowBracket", a closed tube, an extrude
 * whose curve may live in a hole — so a caller can tell "measured and straight"
 * from "not measurable".
 */
export function evaluateSweptGeometryCurvature(geometry) {
  if (geometry?.type === 'tube') {
    // A closed tube is a loop: the schema already refuses a collinear one, and a
    // loop has no endpoints for an arc span to mean anything between.
    if (geometry.closed === true) return null;
    const curvature = evaluateSweptArcCurvature(geometry.path);
    return { kind: 'tube', straight: curvature.straight, arcSpanDegrees: curvature.arcSpanDegrees };
  }
  if (geometry?.type === 'extrude') {
    // A ring, an arch, and a slotted plate all put their curve in a HOLE, and a
    // hole leaves the outline convex, so an outline measurement would report the
    // canonical build as the defect. There is no measurement here that separates
    // those from a straight spike with a cutout, so the gate declines to speak.
    if ((geometry.holes || []).length > 0) return null;
    const concaveTurnDegrees = measureOutlineConcaveTurn(geometry.outline);
    return {
      kind: 'extrude',
      straight: concaveTurnDegrees < CURVED_OUTLINE_MIN_CONCAVE_TURN_DEGREES,
      concaveTurnDegrees,
    };
  }
  return null;
}

/**
 * Parts the spec declares as curved forms, keyed by part id, with the name or
 * feature phrase that declared it. A `detailInventory` feature counts as a
 * declaration, which is how a part called `part_17` still gets measured when the
 * feature it builds is "curved brass horn".
 *
 * Only declarations that name ONE sweep are returned. A curved form built from
 * several parts — a tail of five tapered segments, a horn split into a base and
 * a tip — curves by ARRANGEMENT, and every piece of it is legitimately straight,
 * so measuring the pieces would report the correct build as the defect. That is
 * why a segment nested under an already-declared part is skipped, why a part
 * that owns sweep-carrying children is skipped even when it carries a sweep of
 * its own (its geometry is the base of an assembly, not the whole curve), and
 * why a feature implementing itself with more than one sweep is skipped too.
 */
export function collectDeclaredCurvedParts(spec) {
  const declared = new Map();
  const byId = new Map();
  const declare = (partId, declaredBy) => {
    if (!declared.has(partId)) declared.set(partId, declaredBy);
  };
  const hasSweepDescendant = (part) => (part.children || []).some((child) => (
    evaluateSweptGeometryCurvature(child.geometry) || hasSweepDescendant(child)
  ));
  const walk = (parts, ancestorDeclared) => {
    for (const part of parts || []) {
      byId.set(part.id, part);
      const name = part.name || part.id;
      const isDeclared = namesCurvedForm(name);
      if (isDeclared && !ancestorDeclared && !hasSweepDescendant(part)) declare(part.id, name);
      walk(part.children, ancestorDeclared || isDeclared);
    }
  };
  walk(spec?.parts, false);
  for (const detail of spec?.detailInventory || []) {
    if (!namesCurvedForm(detail.feature)) continue;
    const sweeps = (detail.implementationPartIds || [])
      .filter((partId) => evaluateSweptGeometryCurvature(byId.get(partId)?.geometry));
    if (sweeps.length !== 1) continue;
    declare(sweeps[0], detail.feature);
  }
  return declared;
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
  // The renderer contract the spec was composed against. Serialized rather than
  // derived in the emitted source, because the colour-management half of it is
  // PortOS's viewer contract and is not in the spec at all.
  const renderProfile = JSON.stringify(
    { ...THREEJS_RENDER_PROFILE, environment: resolveThreejsEnvironment(spec) },
    null,
    2
  );

  return `// Generated by PortOS Three.js Models.
// Procedural image-to-Three.js workflow inspired by https://github.com/hoainho/img2threejs
import * as THREE from 'three';

const spec = ${serialized};

// The renderer settings this model was authored against. Configure your own
// WebGLRenderer and scene to match, or it will not reproduce: without the
// environment its metals have nothing to reflect, and a different tone map or
// exposure changes every value on screen. Data only — this module builds no
// renderer, and the environment preset is yours to construct.
const renderProfile = ${renderProfile};

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
  const doubleSided = definition.side === 'double' ? { side: THREE.DoubleSide } : {};
  const unlit = {
    color: definition.color,
    opacity: definition.opacity,
    transparent: definition.transparent,
    wireframe: definition.wireframe,
    ...doubleSided,
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
    // The spec's environment intensity, so the reflective channels below read at
    // the strength they were authored at once you assign the environment.
    envMapIntensity: renderProfile.environment.intensity,
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
    // Declared clips, or null for a static assembly. Data only: the parse above
    // proves every sequence names a real part, stays inside its clip, and never
    // fights another sequence for the same channel, so createSculptAnimationPlayer
    // below can drive the nodes above from it — PortOS-authored playback over
    // provider-authored DATA, never anything the provider wrote as code.
    animation: spec.animation || null,
    detailInventory: spec.detailInventory,
    limitations: spec.limitations,
    // The renderer contract above, carried on the model so a consumer that only
    // ever sees the Group still knows what it has to match to reproduce it.
    render: renderProfile,
  };
  return root;
}
${THREEJS_PLAYER_SOURCE}
export { spec, renderProfile };
`;
}

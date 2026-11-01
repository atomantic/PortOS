/**
 * Greybox layout contract for a Place (catalog type `place`, shown as
 * Environments). A greybox is a coarse, untextured 3D layout of a location that
 * keeps object and figure placement consistent across the shots of a music
 * video: named landmarks, floor anchors for people and props, and saved cameras
 * whose captures become reference images.
 *
 * Declarative only. Parts are allowlisted primitives the client maps to Three.js
 * (same trust boundary as `threejsModel.js`); nothing here is executed.
 * Units are meters, Y up, floor at y=0. Stored on the place as
 * `payload.greybox` — an additive optional field, so absent means "no greybox".
 *
 * Dependency-light on purpose: zod only, no other PortOS module.
 */

import { z } from 'zod';
import { GREYBOX_ASPECTS, GREYBOX_SHOT_ROLE_PREFIX } from './greyboxVocabulary.js';

export const GREYBOX_SCHEMA_VERSION = 1;

export const GREYBOX_LIMITS = Object.freeze({
  PARTS: 400,
  ZONES: 24,
  LANDMARKS: 80,
  ANCHORS: 80,
  SHOTS: 60,
  SHOT_FIGURES: 24,
  OUTLINE_POINTS: 96,
  COORD: 1000,
});

const idSchema = z.string().trim().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const labelSchema = z.string().trim().min(1).max(120);
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const coord = z.number().finite().min(-GREYBOX_LIMITS.COORD).max(GREYBOX_LIMITS.COORD);
const extent = z.number().finite().positive().max(GREYBOX_LIMITS.COORD);
const vec3 = z.tuple([coord, coord, coord]);

const boxPart = z.object({
  type: z.literal('box'),
  size: z.tuple([extent, extent, extent]),
});
const cylinderPart = z.object({
  type: z.literal('cylinder'),
  radius: extent,
  height: extent,
});
// A flat floor/wall panel: width along X, depth along Z before rotation.
const planePart = z.object({
  type: z.literal('plane'),
  size: z.tuple([extent, extent]),
});
// A closed XZ outline swept up `height` from y=0 (rink floor, oval track).
const extrudePart = z.object({
  type: z.literal('extrude'),
  outline: z.array(z.tuple([coord, coord])).min(3).max(GREYBOX_LIMITS.OUTLINE_POINTS),
  height: extent,
});

const partShape = z.discriminatedUnion('type', [boxPart, cylinderPart, planePart, extrudePart]);

const partSchema = z.intersection(
  partShape,
  z.object({
    id: idSchema,
    label: labelSchema.optional(),
    zone: idSchema.optional(),
    position: vec3.default([0, 0, 0]),
    rotationDegrees: vec3.default([0, 0, 0]),
  }),
);

const zoneSchema = z.object({ id: idSchema, label: labelSchema, color: colorSchema });

const landmarkSchema = z.object({
  id: idSchema,
  label: labelSchema,
  position: vec3,
  note: z.string().trim().max(300).optional(),
});

// A floor position with a facing, for a person or prop.
const anchorSchema = z.object({
  id: idSchema,
  label: labelSchema,
  kind: z.enum(['figure', 'prop']),
  position: vec3,
  facingDegrees: z.number().finite().min(-360).max(360).default(0),
  heightMeters: z.number().finite().positive().max(50).default(1.7),
});

const shotFigureSchema = z.object({
  anchorId: idSchema,
  pose: z.string().trim().max(120).optional(),
});

// A shot's capture carries `greybox-shot:<id>` as its media role (VARCHAR(64)),
// so the id has to leave room for the prefix.
const shotIdSchema = idSchema.max(64 - GREYBOX_SHOT_ROLE_PREFIX.length);

const shotSchema = z.object({
  id: shotIdSchema,
  label: labelSchema,
  position: vec3,
  target: vec3,
  // Lens as 35mm-equivalent focal length; the viewer derives vertical fov.
  focalLengthMm: z.number().finite().min(8).max(300).default(35),
  aspect: z.enum(GREYBOX_ASPECTS).default('16:9'),
  figures: z.array(shotFigureSchema).max(GREYBOX_LIMITS.SHOT_FIGURES).default([]),
  note: z.string().trim().max(300).optional(),
  // A finished photo of the place from this camera (one of its reference
  // images); shots that pick this camera send it instead of the flat capture.
  plate: z.string().trim().max(200).regex(/^[^/\\]+\.(png|jpe?g|webp)$/i).optional(),
});

const duplicateIds = (items) => {
  const seen = new Set();
  const dupes = new Set();
  for (const { id } of items) (seen.has(id) ? dupes : seen).add(id);
  return [...dupes];
};

export const greyboxSceneSchema = z.object({
  version: z.literal(GREYBOX_SCHEMA_VERSION).default(GREYBOX_SCHEMA_VERSION),
  // `spec` renders `parts`; `glb` renders the catalog `model` media attached to
  // the place and uses the rest (landmarks, anchors, shots) unchanged.
  source: z.enum(['spec', 'glb']).default('spec'),
  parts: z.array(partSchema).max(GREYBOX_LIMITS.PARTS).default([]),
  zones: z.array(zoneSchema).max(GREYBOX_LIMITS.ZONES).default([]),
  landmarks: z.array(landmarkSchema).max(GREYBOX_LIMITS.LANDMARKS).default([]),
  anchors: z.array(anchorSchema).max(GREYBOX_LIMITS.ANCHORS).default([]),
  shots: z.array(shotSchema).max(GREYBOX_LIMITS.SHOTS).default([]),
}).superRefine((scene, ctx) => {
  for (const key of ['parts', 'zones', 'landmarks', 'anchors', 'shots']) {
    for (const id of duplicateIds(scene[key])) {
      ctx.addIssue({ code: 'custom', message: `duplicate ${key} id "${id}"`, path: [key] });
    }
  }
  if (scene.source === 'spec' && scene.parts.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'a spec greybox needs at least one part', path: ['parts'] });
  }
  const zoneIds = new Set(scene.zones.map((z2) => z2.id));
  scene.parts.forEach((part, index) => {
    if (part.zone && !zoneIds.has(part.zone)) {
      ctx.addIssue({ code: 'custom', message: `part "${part.id}" names unknown zone "${part.zone}"`, path: ['parts', index, 'zone'] });
    }
  });
  const anchorIds = new Set(scene.anchors.map((a) => a.id));
  scene.shots.forEach((shot, index) => {
    if (shot.position.every((v, i) => v === shot.target[i])) {
      ctx.addIssue({ code: 'custom', message: `shot "${shot.id}" camera sits on its target`, path: ['shots', index, 'target'] });
    }
    shot.figures.forEach((figure, figureIndex) => {
      if (!anchorIds.has(figure.anchorId)) {
        ctx.addIssue({ code: 'custom', message: `shot "${shot.id}" names unknown anchor "${figure.anchorId}"`, path: ['shots', index, 'figures', figureIndex, 'anchorId'] });
      }
    });
  });
});

/**
 * The place payload's greybox, validated. `null` when the place has none OR the
 * stored value no longer parses — a stale or hand-edited blob must not take the
 * whole place offline, and a missing greybox is the honest reading of one that
 * cannot be used. Callers that need to tell the two apart use
 * `greyboxSceneSchema.safeParse` directly.
 */
export function resolveGreybox(payload) {
  const raw = payload?.greybox;
  if (raw == null) return null;
  const parsed = greyboxSceneSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

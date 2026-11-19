/**
 * Creative Commission generation spec — a pure, dependency-free leaf (#6816).
 *
 * The generation-param spec (`GENERATION_KEY_DEFS`, `ABILITY_GENERATION_SPEC`, `resolvedDefault` and the
 * quality / aspect-ratio / image-mode / video-mode enums) that `creativeCommissionValidation.js` builds
 * its Zod schema from, the ability adapters sanitize against, and the client commission form derives
 * its fields/bounds/defaults from.
 *
 * Zod-free and Node-builtin-free by contract (like `creativeBriefLimits.js`): the browser bundle
 * imports this module directly, so anything added here must stay browser-importable.
 */

import { QUEUEABLE_IMAGE_MODES, VIDEO_GEN_MODES } from './generationModes.js';
import { RENDER_TARGET_BACKEND_AUTO } from './renderTargets.js';

export const CREATIVE_COMMISSION_QUALITIES = Object.freeze(['draft', 'standard', 'high']);
export const CREATIVE_COMMISSION_ASPECT_RATIOS = Object.freeze(['16:9', '9:16', '1:1']);

// `AUTO` is the default and the no-op: resolve at fire time the way this install
// already would. Re-exported from the render-target leaf so the two "no pin"
// protocol values can never diverge.
export const COMMISSION_RENDER_BACKEND_AUTO = RENDER_TARGET_BACKEND_AUTO;

// Image backends a commission may pin: the queueable image modes (`external` never
// queues) plus the auto sentinel. A new backend needs no edit here but does need a
// wire-version bump in every sync category that stores it (creativeCommissions,
// fableLoom) — see schemaVersions.test.js.
export const CREATIVE_COMMISSION_IMAGE_MODES = Object.freeze([
  COMMISSION_RENDER_BACKEND_AUTO, ...QUEUEABLE_IMAGE_MODES,
]);

// Video backends a commission may pin, plus auto (same wire-version bump rule).
export const CREATIVE_COMMISSION_VIDEO_MODES = Object.freeze([
  COMMISSION_RENDER_BACKEND_AUTO, ...VIDEO_GEN_MODES,
]);

// Free string: the media-models registry is user-editable, so an enum would reject installed models.
export const COMMISSION_RENDER_MODEL_MAX = 64;

// Per-KEY generation descriptor — the single source of truth for a param's type,
// bounds and default, consumed by the server Zod schema, the ability adapters'
// sanitizer and the client form.
//
// `default` seeds a brand-new commission/form. `legacyAbsent` is what an EXISTING
// stored record with the key missing entirely means, when that differs from
// `default`: `durationMode` seeds to `'auto'` for new commissions, but a record
// written before the key existed rendered a fixed length, so absent must resolve
// to `'manual'`. Use `resolvedDefault()` for any absent/invalid stored value;
// reserve a bare `.default` read for seeding a blank record.
//
// `type: 'id'` is a nullable free-string model id: absent/blank normalizes to
// `null` (the install's default model).
export const GENERATION_KEY_DEFS = Object.freeze({
  quality: { type: 'enum', values: CREATIVE_COMMISSION_QUALITIES, default: 'standard' },
  aspectRatio: { type: 'enum', values: CREATIVE_COMMISSION_ASPECT_RATIOS, default: '16:9' },
  targetDurationSeconds: { type: 'int', min: 5, max: 600, default: 10 },
  durationMode: {
    type: 'enum', values: ['auto', 'manual'], default: 'auto', legacyAbsent: 'manual',
  },
  imageCount: { type: 'int', min: 1, max: 6, default: 1 },
  lengthSeconds: { type: 'int', min: 5, max: 600, default: 30 },
  episodeCount: { type: 'int', min: 1, max: 6, default: 1 },
  imageMode: { type: 'enum', values: CREATIVE_COMMISSION_IMAGE_MODES, default: COMMISSION_RENDER_BACKEND_AUTO },
  videoMode: { type: 'enum', values: CREATIVE_COMMISSION_VIDEO_MODES, default: COMMISSION_RENDER_BACKEND_AUTO },
  // Only meaningful for backends with a model knob (local runtimes; cloud CLIs pick their own).
  imageModelId: { type: 'id', max: COMMISSION_RENDER_MODEL_MAX, default: null },
  videoModelId: { type: 'id', max: COMMISSION_RENDER_MODEL_MAX, default: null },
});

// Fallback for an absent or invalid stored value: `legacyAbsent` when present, else
// `default`. Store-side coercion and client projections of a REAL record must use
// this, never `.default`, so the two readings can't drift apart.
export function resolvedDefault(def) {
  return def.legacyAbsent ?? def.default;
}

// Which keys each output type carries (the universal `model` is added separately
// by the schema). Backend pins are scoped to abilities that enqueue that render
// kind; `music-video` takes both, `music` and `series` neither (a series' renders
// are pinned on the pipeline series/stage records).
const ABILITY_GENERATION_KEYS = Object.freeze({
  video: ['quality', 'aspectRatio', 'targetDurationSeconds', 'durationMode', 'videoMode', 'videoModelId'],
  image: ['quality', 'aspectRatio', 'imageCount', 'imageMode', 'imageModelId'],
  music: ['lengthSeconds'],
  'music-video': ['quality', 'aspectRatio', 'targetDurationSeconds', 'durationMode', 'videoMode', 'videoModelId', 'imageMode', 'imageModelId'],
  series: ['episodeCount'],
});

// Per-ability { keys, defaults }; `defaults` use the legacy-aware `resolvedDefault`.
export const ABILITY_GENERATION_SPEC = Object.freeze(
  Object.fromEntries(Object.entries(ABILITY_GENERATION_KEYS).map(([ability, keys]) => [ability, {
    keys,
    defaults: Object.fromEntries(keys.map((k) => [k, resolvedDefault(GENERATION_KEY_DEFS[k])])),
  }])),
);

export const CREATIVE_COMMISSION_ABILITIES = Object.freeze(['video', 'image', 'music', 'music-video', 'series']);
export const CREATIVE_COMMISSION_SCHEDULE_KINDS = Object.freeze(['DAILY', 'WEEKLY', 'CUSTOM', 'RECURRENCE']);
export const COMMISSION_MUSIC_TASTE_ANCHOR_MAX = 5;
export const COMMISSION_MUSIC_TASTE_PERCENT_MAX = 100;
export const COMMISSION_MUSIC_TASTE_ENGINE_MAX = 64;
export const CREATIVE_COMMISSION_MUSIC_TASTE_WINDOWS = Object.freeze(['week', 'month']);

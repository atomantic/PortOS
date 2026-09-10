/**
 * Creative Commission generation spec — a pure, dependency-free leaf (#6816).
 *
 * The per-generation-key descriptors (type/bounds/values/default) and their
 * per-ability grouping used to live inside `creativeCommissionValidation.js`,
 * which pulls `zod` — so the browser form could only mirror them by hand.
 * That hand-copy already drifted three ways before this split: the
 * `durationMode` default (client `'auto'` vs server `'manual'`), the video
 * backend enum (client missing fal/reactor, #6213/#6214), and the image
 * backend enum (client missing agy, #4901). Splitting the DATA out from the
 * Zod SCHEMA BUILDER lets the server schema, the ability adapters, and the
 * client form all derive from this one object — the way `creativeBriefLimits.js`
 * already does for the brief field caps.
 *
 * Zod-free and Node-builtin-free by contract, like `creativeBriefLimits.js`:
 * `commissionForm.js` imports this module directly, so anything added here
 * must stay importable by the browser bundle.
 */

import { QUEUEABLE_IMAGE_MODES, VIDEO_GEN_MODES } from './generationModes.js';
import { RENDER_TARGET_BACKEND_AUTO } from './renderTargets.js';

export const CREATIVE_COMMISSION_QUALITIES = Object.freeze(['draft', 'standard', 'high']);
export const CREATIVE_COMMISSION_ASPECT_RATIOS = Object.freeze(['16:9', '9:16', '1:1']);

// `AUTO` is the default and the no-op: it means "resolve at fire time the way
// this install already would" (settings.imageGen.mode / the local video
// default), so an existing commission that never sets the field behaves
// exactly as before. Re-exported from the render-target leaf (#3231) so the
// two "no pin" protocol values can never diverge.
export const COMMISSION_RENDER_BACKEND_AUTO = RENDER_TARGET_BACKEND_AUTO;

// Image backends a commission may pin: the queueable image modes (local /
// codex / grok / agy — `external` never queues) plus the auto sentinel.
// Derived from QUEUEABLE_IMAGE_MODES so a new backend needs no edit here.
export const CREATIVE_COMMISSION_IMAGE_MODES = Object.freeze([
  COMMISSION_RENDER_BACKEND_AUTO, ...QUEUEABLE_IMAGE_MODES,
]);

// Video backends a commission may pin: local (MLX runtimes), grok, fal, or
// reactor, plus auto. Derived from VIDEO_GEN_MODES so a new backend needs no
// edit here — this enum is exactly what drifted client-side when fal (#6213)
// and reactor (#6214) shipped with no matching form edit.
export const CREATIVE_COMMISSION_VIDEO_MODES = Object.freeze([
  COMMISSION_RENDER_BACKEND_AUTO, ...VIDEO_GEN_MODES,
]);

// A model id is a free string (the media-models registry is user-editable, so
// an enum here would reject a legitimately-installed model). Bounded like the
// existing `generation.model`.
export const COMMISSION_RENDER_MODEL_MAX = 64;

// Per-KEY generation descriptor — the SINGLE SOURCE OF TRUTH for a generation
// param's type, bounds, and default, consumed by the server's Zod schema
// (`creativeCommissionValidation.js`), the ability adapters' data-driven
// sanitizer (`services/creativeCommissions/abilityAdapters.js`), AND the
// client form (`commissionForm.js`) — no more hand-copying any of it.
//
// `default` seeds a BRAND-NEW commission/form (a product/UX choice). A
// descriptor may additionally carry `legacyAbsent`: what an EXISTING stored
// record with the key missing ENTIRELY means, when that differs from
// `default`. `durationMode` is the one key where they diverge — the form
// seeds a fresh commission to `'auto'` (#4494), but a record written before
// this key existed always rendered a fixed length, so an absent key on a real
// record must still resolve to `'manual'`. Use `resolvedDefault()` below
// wherever an ABSENT OR INVALID stored value needs a fallback; reserve a bare
// `.default` read for seeding a genuinely new/blank record.
//
// `type: 'id'` is a nullable free-string model id: absent/blank normalizes to
// `null` (= "the install's default model"), which is why its `default` is
// null rather than a string. Distinct from the `enum`/`int` numeric-or-member
// kinds so the Zod builder and the adapter coercion both stay data-driven.
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
  // Render-backend pin (#3135) — `auto` = no pin (today's behavior).
  imageMode: { type: 'enum', values: CREATIVE_COMMISSION_IMAGE_MODES, default: COMMISSION_RENDER_BACKEND_AUTO },
  videoMode: { type: 'enum', values: CREATIVE_COMMISSION_VIDEO_MODES, default: COMMISSION_RENDER_BACKEND_AUTO },
  // Optional model id, only meaningful when the matching mode is pinned to a
  // backend that HAS a model knob (local diffusion / local video runtimes; the
  // cloud CLIs pick their own model). null = the install default.
  imageModelId: { type: 'id', max: COMMISSION_RENDER_MODEL_MAX, default: null },
  videoModelId: { type: 'id', max: COMMISSION_RENDER_MODEL_MAX, default: null },
});

// The fallback for an ABSENT or INVALID stored value: a descriptor's
// `legacyAbsent` when it has one (a compatibility reading only `durationMode`
// needs today), else its `default`. Every store-side coercion (the ability
// adapters' sanitizer) and every client-side projection of a REAL record must
// resolve an absent/invalid value through this — never `.default` directly —
// so the two readings can't drift back apart. Seeding a brand-new blank form
// is the one exception: it reads `.default` directly, because there is no
// record yet for `legacyAbsent` to describe.
export function resolvedDefault(def) {
  return def.legacyAbsent ?? def.default;
}

// Which keys each output type carries (the universal `model` is added
// separately by the schema — every type accepts an optional engine/model
// override). The backend pins (#3135) are scoped to the abilities that
// actually enqueue that kind of render: `imageMode` on `image`, `videoMode` on
// `video`, and BOTH on `music-video` (its plan renders a video, and the
// planner may render stills for it too). `music` and `series` carry neither —
// a series' per-issue renders are pinned on the pipeline series/stage
// records, not here.
const ABILITY_GENERATION_KEYS = Object.freeze({
  video: ['quality', 'aspectRatio', 'targetDurationSeconds', 'durationMode', 'videoMode', 'videoModelId'],
  image: ['quality', 'aspectRatio', 'imageCount', 'imageMode', 'imageModelId'],
  music: ['lengthSeconds'],
  'music-video': ['quality', 'aspectRatio', 'targetDurationSeconds', 'durationMode', 'videoMode', 'videoModelId', 'imageMode', 'imageModelId'],
  series: ['episodeCount'],
});

// Derived per-ability { keys, defaults } view — the shape the store sanitizer,
// the client form, and tests consume. `defaults` is the LEGACY-AWARE
// resolution (`resolvedDefault`, not a bare `.default`): it's what an
// ability's sanitizer resolves an absent/invalid raw generation object to,
// and what the client projects a real (possibly pre-existing) record's
// missing key as.
export const ABILITY_GENERATION_SPEC = Object.freeze(
  Object.fromEntries(Object.entries(ABILITY_GENERATION_KEYS).map(([ability, keys]) => [ability, {
    keys,
    defaults: Object.fromEntries(keys.map((k) => [k, resolvedDefault(GENERATION_KEY_DEFS[k])])),
  }])),
);

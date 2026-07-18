/**
 * Creative Commission — ability adapters (#2769).
 *
 * A commission's `targetAbility` picks the kind of thing it makes each fire:
 * `video`, `image`, `music`, `music-video`, or `series`. Historically every
 * commission was a video (the generic "Create a video piece" directive + the
 * video-only generation params), which handed the Creative Director planner the
 * WHOLE tool menu (declare a series, an image, …) and left it to infer intent
 * from free text. Instead, each output type gets an adapter that owns three
 * things, so every layer keys off `targetAbility` rather than assuming video:
 *
 *   - `sanitizeGeneration(raw)` — fill this type's generation defaults and keep
 *     only this type's keys (the store sanitizer calls it; it is the record-shape
 *     source of truth, mirroring ABILITY_GENERATION_SPEC in the validation leaf).
 *   - `buildDirective(commission)` — a PRESCRIPTIVE CD directive that tells the
 *     planner exactly what deliverable to produce and which registry tools to use
 *     (an image directive says "produce a still image, don't plan a video"), so
 *     the planner isn't guessing. Replaces the old generic directive.
 *   - `buildProjectParams(commission, ctx)` — the arg map handed to
 *     `createProject`. The CD project always carries video "locked render
 *     settings" (the planner only forces that geometry onto media_enqueueVideoJob
 *     steps), so non-video types pass harmless defaults for the geometry and let
 *     their directive drive the non-video tools.
 *
 * Pure leaf, like directive.js: it imports only the pure directive helpers and
 * the validation spec — no service graph — so it's trivially unit-testable and
 * safe to pull into a mocked suite. It depends on directive.js one-way (directive
 * stays ability-agnostic and never imports back).
 */

import { renderFeedbackDigest, composeDirectiveGoal } from './directive.js';
import { ABILITY_GENERATION_SPEC, CREATIVE_COMMISSION_ABILITIES } from '../../lib/creativeCommissionValidation.js';

const isStr = (v) => typeof v === 'string';

// The optional per-type engine/model override, universal across abilities. Kept
// separate from the spec's typed keys because it's a free string, not a bounded
// enum/number.
function pickModel(raw) {
  return isStr(raw?.model) && raw.model.trim() ? raw.model.trim() : null;
}

// Shared: sanitize a numeric generation key against its bounds, falling back to
// the ability default when absent/invalid (absent-vs-empty: a non-number or an
// out-of-range value falls back rather than corrupting the record).
function pickInt(raw, key, def, min, max) {
  const v = raw?.[key];
  if (Number.isInteger(v) && v >= min && v <= max) return v;
  return def;
}

function pickEnum(raw, key, allowed, def) {
  const v = raw?.[key];
  return allowed.includes(v) ? v : def;
}

const QUALITIES = ['draft', 'standard', 'high'];
const ASPECTS = ['16:9', '9:16', '1:1'];

// Build the common brief lines (intent + genre/category/style) shared by every
// adapter's directive, with a type-specific lead sentence prepended by the
// caller. Returns { lines, digest, constraints } — the adapter assembles the
// goal via composeDirectiveGoal.
function briefContext(commission, leadSentence) {
  const brief = commission?.brief || {};
  const lines = [`${leadSentence} ${String(brief.intent || '').trim()}`.trim()];
  if (brief.genre) lines.push(`Genre: ${brief.genre}.`);
  if (brief.category) lines.push(`Category: ${brief.category}.`);
  if (brief.styleSpec) lines.push(`Style: ${brief.styleSpec}.`);
  const digest = renderFeedbackDigest(commission?.feedback, commission?.feedbackWindow ?? 5);
  const constraints = {};
  if (brief.constraints?.universeId) constraints.universeId = brief.constraints.universeId;
  if (brief.constraints?.seriesId) constraints.seriesId = brief.constraints.seriesId;
  return { lines, digest, constraints };
}

// Video geometry the CD project always carries. For non-video types the planner
// ignores it (no media_enqueueVideoJob steps), so these are harmless defaults.
function videoGeometry(gen, { defaultVideoModelId } = {}) {
  return {
    aspectRatio: gen?.aspectRatio || '16:9',
    quality: gen?.quality || 'standard',
    modelId: gen?.model || (typeof defaultVideoModelId === 'function' ? defaultVideoModelId() : undefined),
    targetDurationSeconds: gen?.targetDurationSeconds || 10,
  };
}

const videoAdapter = {
  id: 'video',
  label: 'Video',
  sanitizeGeneration(raw) {
    const d = ABILITY_GENERATION_SPEC.video.defaults;
    return {
      model: pickModel(raw),
      quality: pickEnum(raw, 'quality', QUALITIES, d.quality),
      aspectRatio: pickEnum(raw, 'aspectRatio', ASPECTS, d.aspectRatio),
      targetDurationSeconds: pickInt(raw, 'targetDurationSeconds', d.targetDurationSeconds, 5, 600),
    };
  },
  buildDirective(commission) {
    const { lines, digest, constraints } = briefContext(commission, 'Create a short-form video piece.');
    return {
      goal: composeDirectiveGoal(lines, digest),
      deliverables: ['One rendered video matching the brief'],
      constraints,
    };
  },
  buildProjectParams(commission, ctx) {
    return videoGeometry(commission?.generation, ctx);
  },
};

const imageAdapter = {
  id: 'image',
  label: 'Image',
  sanitizeGeneration(raw) {
    const d = ABILITY_GENERATION_SPEC.image.defaults;
    return {
      model: pickModel(raw),
      quality: pickEnum(raw, 'quality', QUALITIES, d.quality),
      aspectRatio: pickEnum(raw, 'aspectRatio', ASPECTS, d.aspectRatio),
      imageCount: pickInt(raw, 'imageCount', d.imageCount, 1, 6),
    };
  },
  buildDirective(commission) {
    const count = pickInt(commission?.generation, 'imageCount', ABILITY_GENERATION_SPEC.image.defaults.imageCount, 1, 6);
    const noun = count === 1 ? 'a single still image' : `${count} still images`;
    const lead = `Produce ${noun}. Use the image / catalog generation tools; do NOT plan a video or music render.`;
    const { lines, digest, constraints } = briefContext(commission, lead);
    return {
      goal: composeDirectiveGoal(lines, digest),
      deliverables: [count === 1 ? 'One still image matching the brief' : `${count} still images matching the brief`],
      constraints,
    };
  },
  buildProjectParams(commission, ctx) {
    // Image render carries an aspect ratio + quality; duration is irrelevant, so
    // the geometry default (10s) rides along unused.
    return videoGeometry(commission?.generation, ctx);
  },
};

const musicAdapter = {
  id: 'music',
  label: 'Music',
  sanitizeGeneration(raw) {
    const d = ABILITY_GENERATION_SPEC.music.defaults;
    return {
      model: pickModel(raw),
      lengthSeconds: pickInt(raw, 'lengthSeconds', d.lengthSeconds, 5, 600),
    };
  },
  buildDirective(commission) {
    const secs = pickInt(commission?.generation, 'lengthSeconds', ABILITY_GENERATION_SPEC.music.defaults.lengthSeconds, 5, 600);
    const lead = `Compose an original ~${secs}s music / audio piece. Use the music generation tools; do NOT plan a video or image render.`;
    const { lines, digest, constraints } = briefContext(commission, lead);
    return {
      goal: composeDirectiveGoal(lines, digest),
      deliverables: [`One ~${secs}s music track matching the brief`],
      constraints,
    };
  },
  buildProjectParams(commission, ctx) {
    // No video render — pass geometry defaults so the project record is
    // well-formed; the directive steers the planner to the music tools.
    return videoGeometry(commission?.generation, ctx);
  },
};

const musicVideoAdapter = {
  id: 'music-video',
  label: 'Music video',
  sanitizeGeneration(raw) {
    const d = ABILITY_GENERATION_SPEC['music-video'].defaults;
    return {
      model: pickModel(raw),
      quality: pickEnum(raw, 'quality', QUALITIES, d.quality),
      aspectRatio: pickEnum(raw, 'aspectRatio', ASPECTS, d.aspectRatio),
      targetDurationSeconds: pickInt(raw, 'targetDurationSeconds', d.targetDurationSeconds, 5, 600),
    };
  },
  buildDirective(commission) {
    const lead = 'Create a short-form music video: generate an original music bed AND a matching video scored to it.';
    const { lines, digest, constraints } = briefContext(commission, lead);
    return {
      goal: composeDirectiveGoal(lines, digest),
      deliverables: ['One original music bed', 'One video matching the brief, scored to the music bed'],
      constraints,
    };
  },
  buildProjectParams(commission, ctx) {
    return videoGeometry(commission?.generation, ctx);
  },
};

const seriesAdapter = {
  id: 'series',
  label: 'Series',
  sanitizeGeneration(raw) {
    const d = ABILITY_GENERATION_SPEC.series.defaults;
    return {
      model: pickModel(raw),
      episodeCount: pickInt(raw, 'episodeCount', d.episodeCount, 1, 6),
    };
  },
  buildDirective(commission) {
    const count = pickInt(commission?.generation, 'episodeCount', ABILITY_GENERATION_SPEC.series.defaults.episodeCount, 1, 6);
    const hasUniverse = !!commission?.brief?.constraints?.universeId;
    const scope = hasUniverse
      ? 'Create the series within the provided universe (see constraints).'
      : 'Invent a fitting universe context for the series.';
    const noun = count === 1 ? 'its opening issue/episode' : `its first ${count} issues/episodes`;
    const lead = `Create a new episodic series and generate ${noun}. ${scope} Use the pipeline series tools.`;
    const { lines, digest, constraints } = briefContext(commission, lead);
    return {
      goal: composeDirectiveGoal(lines, digest),
      deliverables: [count === 1 ? 'A new series with its opening issue/episode started' : `A new series with its first ${count} issues/episodes started`],
      constraints,
    };
  },
  buildProjectParams(commission, ctx) {
    // Series output is comic/prose, not a locked video render — geometry
    // defaults ride along unused; the directive drives the series tools.
    return videoGeometry(commission?.generation, ctx);
  },
};

export const ABILITY_ADAPTERS = Object.freeze({
  video: videoAdapter,
  image: imageAdapter,
  music: musicAdapter,
  'music-video': musicVideoAdapter,
  series: seriesAdapter,
});

export const ABILITY_IDS = Object.freeze([...CREATIVE_COMMISSION_ABILITIES]);

/**
 * Resolve the adapter for an ability, or null when unknown. Callers decide the
 * fallback: the store sanitizer clamps an unknown ability to `video`; the
 * scheduler skips an unknown-ability fire rather than silently mis-generating.
 */
export function getAbilityAdapter(ability) {
  return ABILITY_ADAPTERS[ability] || null;
}

/**
 * Build the CD directive for a commission's next fire, dispatched by output type
 * (#2769). Unknown ability falls back to the video adapter so a hand-edited or
 * forward-version record still yields a well-formed directive (the scheduler
 * separately refuses to FIRE an unknown ability — see scheduler.js). Shape matches
 * `creativeDirectorDirectiveSchema` (goal/deliverables/constraints) so it
 * round-trips straight into `createProject({ directive })`.
 */
export function buildCommissionDirective(commission) {
  const adapter = getAbilityAdapter(commission?.targetAbility) || videoAdapter;
  return adapter.buildDirective(commission);
}

/**
 * Creative Commission — ability adapters (#2769).
 *
 * A commission's `targetAbility` picks the kind of thing it makes each fire:
 * `video`, `image`, `music`, `music-video`, or `series`. Historically every
 * commission was a video (the generic "Create a video piece" directive + the
 * video-only generation params), which handed the Creative Director planner the
 * WHOLE tool menu (declare a series, an image, …) and left it to infer intent
 * from free text. Instead, each output type gets an adapter that owns:
 *
 *   - `sanitizeGeneration(raw)` — fill this type's generation defaults and keep
 *     only this type's keys (the store sanitizer calls it). Data-driven from the
 *     validation leaf's GENERATION_KEY_DEFS / ABILITY_GENERATION_SPEC, so the
 *     keys/bounds/defaults live in exactly one place.
 *   - `buildDirective(commission)` — a PRESCRIPTIVE CD directive that tells the
 *     planner exactly what deliverable to produce and which registry tools to use
 *     (an image directive says "produce a still image, don't plan a video"), so
 *     the planner isn't guessing. Replaces the old generic directive.
 *   - `buildProjectParams(commission, ctx)` — the arg map handed to
 *     `createProject`. The CD project always carries video "locked render
 *     settings" (the planner only forces that geometry onto media_enqueueVideoJob
 *     steps), so non-video types pass harmless defaults and let their directive
 *     drive the non-video tools. Shared across every type today; kept as a
 *     per-adapter slot so a type whose geometry genuinely diverges can override.
 *
 * Pure leaf, like directive.js: it imports only the pure directive helpers and
 * the validation spec — no service graph — so it's trivially unit-testable and
 * safe to pull into a mocked suite. It depends on directive.js one-way (directive
 * stays ability-agnostic and never imports back).
 */

import { renderFeedbackDigest, composeDirectiveGoal } from './directive.js';
import {
  ABILITY_GENERATION_SPEC, GENERATION_KEY_DEFS, CREATIVE_COMMISSION_ABILITIES,
} from '../../lib/creativeCommissionValidation.js';

const isStr = (v) => typeof v === 'string';

// The optional per-type engine/model override, universal across abilities. A free
// string, so it's handled separately from the typed/bounded spec keys.
function pickModel(raw) {
  return isStr(raw?.model) && raw.model.trim() ? raw.model.trim() : null;
}

// Coerce one generation value against its GENERATION_KEY_DEFS descriptor, falling
// back to the default when absent/invalid (absent-vs-empty: a wrong-type or
// out-of-range value falls back rather than corrupting the record).
function coerceGenerationValue(key, raw) {
  const def = GENERATION_KEY_DEFS[key];
  const v = raw?.[key];
  if (def.type === 'enum') return def.values.includes(v) ? v : def.default;
  return Number.isInteger(v) && v >= def.min && v <= def.max ? v : def.default;
}

// Fill an ability's generation defaults and keep ONLY that ability's keys (+ the
// universal model). Data-driven from the spec — no per-type hand-written pick
// scaffolding.
function sanitizeGenerationFor(ability, raw) {
  const spec = ABILITY_GENERATION_SPEC[ability];
  const out = { model: pickModel(raw) };
  for (const key of spec.keys) out[key] = coerceGenerationValue(key, raw);
  return out;
}

// Build the common brief lines (intent + genre/category/style) shared by every
// adapter's directive, with a type-specific lead sentence prepended by the
// caller. Returns { lines, digest, constraints } — the adapter assembles the goal
// via composeDirectiveGoal.
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

// Read a clamped generation value for directive text, using the same coercion the
// sanitizer applies (so the goal never quotes an out-of-range count).
function genValue(commission, key) {
  return coerceGenerationValue(key, commission?.generation);
}

// Video geometry the CD project always carries. For non-video types the planner
// ignores it (no media_enqueueVideoJob steps), so these are harmless defaults.
// Shared by every adapter's buildProjectParams today.
function buildVideoGeometryParams(commission, { defaultVideoModelId } = {}) {
  const gen = commission?.generation;
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
  sanitizeGeneration: (raw) => sanitizeGenerationFor('video', raw),
  buildProjectParams: buildVideoGeometryParams,
  buildDirective(commission) {
    const { lines, digest, constraints } = briefContext(commission, 'Create a short-form video piece.');
    return { goal: composeDirectiveGoal(lines, digest), deliverables: ['One rendered video matching the brief'], constraints };
  },
};

const imageAdapter = {
  id: 'image',
  label: 'Image',
  sanitizeGeneration: (raw) => sanitizeGenerationFor('image', raw),
  buildProjectParams: buildVideoGeometryParams,
  buildDirective(commission) {
    const count = genValue(commission, 'imageCount');
    const noun = count === 1 ? 'a single still image' : `${count} still images`;
    const lead = `Produce ${noun}. Use the image / catalog generation tools; do NOT plan a video or music render.`;
    const { lines, digest, constraints } = briefContext(commission, lead);
    return {
      goal: composeDirectiveGoal(lines, digest),
      deliverables: [count === 1 ? 'One still image matching the brief' : `${count} still images matching the brief`],
      constraints,
    };
  },
};

const musicAdapter = {
  id: 'music',
  label: 'Music',
  sanitizeGeneration: (raw) => sanitizeGenerationFor('music', raw),
  buildProjectParams: buildVideoGeometryParams,
  buildDirective(commission) {
    const secs = genValue(commission, 'lengthSeconds');
    const lead = `Compose an original ~${secs}s music / audio piece. Use the music generation tools; do NOT plan a video or image render.`;
    const { lines, digest, constraints } = briefContext(commission, lead);
    return { goal: composeDirectiveGoal(lines, digest), deliverables: [`One ~${secs}s music track matching the brief`], constraints };
  },
};

const musicVideoAdapter = {
  id: 'music-video',
  label: 'Music video',
  sanitizeGeneration: (raw) => sanitizeGenerationFor('music-video', raw),
  buildProjectParams: buildVideoGeometryParams,
  buildDirective(commission) {
    const lead = 'Create a short-form music video: generate an original music bed AND a matching video scored to it.';
    const { lines, digest, constraints } = briefContext(commission, lead);
    return {
      goal: composeDirectiveGoal(lines, digest),
      deliverables: ['One original music bed', 'One video matching the brief, scored to the music bed'],
      constraints,
    };
  },
};

const seriesAdapter = {
  id: 'series',
  label: 'Series',
  sanitizeGeneration: (raw) => sanitizeGenerationFor('series', raw),
  buildProjectParams: buildVideoGeometryParams,
  buildDirective(commission) {
    const count = genValue(commission, 'episodeCount');
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
};

export const ABILITY_ADAPTERS = Object.freeze({
  video: videoAdapter,
  image: imageAdapter,
  music: musicAdapter,
  'music-video': musicVideoAdapter,
  series: seriesAdapter,
});

// Fail fast if the registry and the enum ever drift (a new ability added to the
// enum with no adapter, or vice versa) — boot-time, not a runtime surprise.
{
  const missing = CREATIVE_COMMISSION_ABILITIES.filter((a) => !ABILITY_ADAPTERS[a]);
  const extra = Object.keys(ABILITY_ADAPTERS).filter((a) => !CREATIVE_COMMISSION_ABILITIES.includes(a));
  if (missing.length || extra.length) {
    throw new Error(`ability adapter registry out of sync with CREATIVE_COMMISSION_ABILITIES (missing: ${missing}, extra: ${extra})`);
  }
}

/**
 * Resolve the adapter for an ability, or null when unknown. Callers decide the
 * fallback: the store sanitizer PRESERVES an unknown ability (forward-compat — a
 * newer peer's output type round-trips untouched) and the scheduler skips it
 * rather than mis-generating, so the two agree that unknown = inert-but-preserved.
 */
export function getAbilityAdapter(ability) {
  return ABILITY_ADAPTERS[ability] || null;
}

/**
 * Build the CD directive for a commission's next fire, dispatched by output type
 * (#2769). Unknown ability falls back to the video adapter so a direct call still
 * yields a well-formed directive; in practice the scheduler skips an unknown
 * ability BEFORE reaching here (see scheduler.js), so the fallback is purely
 * defensive. Shape matches `creativeDirectorDirectiveSchema`
 * (goal/deliverables/constraints) so it round-trips into `createProject`.
 */
export function buildCommissionDirective(commission) {
  const adapter = getAbilityAdapter(commission?.targetAbility) || videoAdapter;
  return adapter.buildDirective(commission);
}

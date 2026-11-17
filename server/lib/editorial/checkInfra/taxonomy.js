/**
 * Editorial check taxonomy — the declarative vocabulary every check entry is validated
 * against: scopes, kinds, severities, the staleness `sources` allow-list, and UI field types.
 */

export const CHECK_SCOPES = Object.freeze(['series', 'issue', 'scene', 'noun']);

// `scope` may be one string or an array (a dual-scope check is declared once, not split).
// `normalizeCheckScopes` dedupes into canonical CHECK_SCOPES order ([] for unknown/empty);
// `primaryCheckScope` is the first, for consumers that bucket by a single value.
export function normalizeCheckScopes(scope) {
  const raw = Array.isArray(scope) ? scope : (scope == null ? [] : [scope]);
  return CHECK_SCOPES.filter((s) => raw.includes(s));
}

export const primaryCheckScope = (scope) => normalizeCheckScopes(scope)[0] || null;

export const CHECK_KINDS = Object.freeze(['deterministic', 'llm']);
export const CHECK_SEVERITIES = Object.freeze(['high', 'medium', 'low']);
export const SEVERITIES = CHECK_SEVERITIES;

// Inputs a check can read, declared via `sources`. The staleness runner
// (server/services/pipeline/editorial/checkRunner.js) fingerprints EXACTLY a check's
// declared sources, so a finding goes stale only when content it analyzed drifts. Every
// token needs a resolver in that runner's `SOURCE_RESOLVERS` (a load-time guard enforces it).
// Narrow tokens are split deliberately so unrelated edits do not stale findings.
// Runner-injected ctx fields (fetched only when the source is declared): continuityBible
// -> ctx.continuityBible (facts ledger), reverseOutline -> ctx.reverseOutline (scenes),
// reverseOutline.plotlines -> ctx.reverseOutlinePlotlines, editorialArcs -> ctx.editorialArcs
// (DETECTED arc directions, vs the AUTHORED series.characterArcs), storyboard.shots ->
// ctx.storyboardScenes. The comicScript family reads the same parsed pages from ctx.issues:
// 'comicScript' fingerprints lettering fields only, '.pacing' adds panel descriptions, and
// '.layout' is per-page panel COUNT only (a text-only edit must not stale a rhythm finding).
// 'series.characterArcs.evolution' is the optional evolution lens, split from the whole
// arcs token so checks that read only the lens do not stale on want/need edits.
export const EDITORIAL_SOURCES = Object.freeze([
  'manuscript',
  'canon',
  'continuityBible',
  'series.styleGuide',
  'series.arc.tickingClock',
  'series.arc.readerMap',
  // Authored foreshadowing ledger the Chekhov check reconciles against.
  'series.arc.foreshadowing',
  'series.arc.themes',
  // Author-supplied fact reference for the opt-in research.fact-accuracy check.
  'series.factReference',
  'reverseOutline',
  'reverseOutline.plotlines',
  'editorialArcs',
  'series.characterArcs',
  'series.characterArcs.evolution',
  'storyboard.shots',
  'comicScript',
  'comicScript.pacing',
  'comicScript.layout',
  // Each issue's PROSE-stage text specifically, not the default manuscript precedence
  // (comicScript > teleplay > prose); lets comic<->prose sync findings stale independently.
  'prose',
]);

// Default per-run finding cap for user-defined checks; mirrors the built-in LLM default.
export const CUSTOM_CHECK_MAX_FINDINGS_DEFAULT = 12;

// Serializable config-field types for the Editorial Checks UI form (`configSchema` stays
// the validation authority). Advertise only types EditorialCheckCard's ConfigField can draw.
export const CHECK_FIELD_TYPES = Object.freeze(['number', 'boolean', 'text']);


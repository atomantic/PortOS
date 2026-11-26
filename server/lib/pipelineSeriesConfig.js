// Shared vocabulary and bounds for series records, story planning, and Autopilot requests.

export const SERIES_NAME_MAX = 200;

// Author-supplied real-world fact reference (#1588) — the ground-truth facts the
// opt-in `research.fact-accuracy` editorial check reconciles the prose against
// (e.g. "Paris is the capital of France"; physiological limits). Generous cap so
// a grounded historical/SFF series can paste a sizable fact sheet.
export const FACT_REFERENCE_MAX = 8000;

export const STYLE_PROMPT_OVERRIDE_MAX = 1000;

// How `stylePromptOverride` composes with the universe's style influences:
//   'prepend'  — override leads, universe trails (the historical default
//                — slight deviation, universe still visible)
//   'append'   — universe leads, override trails (universe-dominant)
//   'override' — universe style is dropped entirely (full spinoff look)
// Default 'prepend' so existing series migrate forward without a writer
// pass and the field can be absent in JSON.
export const STYLE_PROMPT_OVERRIDE_MODES = Object.freeze(['prepend', 'append', 'override']);
export const STYLE_PROMPT_OVERRIDE_MODE_DEFAULT = 'prepend';

export const AUTHOR_MAX = 120;

// FK to an Author persona (auth-<uuid>). The `author` string above stays as a
// denormalized byline so a federated series renders the cover correctly even
// when the peer lacks the local author record. Empty/cleared → null.
export const AUTHOR_ID_MAX = 64;

export const UNIVERSE_ID_MAX = 64;
export const WRITERS_ROOM_WORK_ID_MAX = 64;
export const TARGET_FORMATS = Object.freeze(['comic', 'tv', 'comic+tv']);
export const ISSUE_COUNT_TARGET_MAX = 999;

// The manuscript format the series is authored/finalized in first — the source
// of truth the other two formats are generated from. Stored as the stage id so
// it maps straight onto the issue stages. `null` = not chosen yet; the
// manuscript editor falls back to auto-detecting the dominant drafted stage.
// Mirrors MANUSCRIPT_STAGES in the arc planner.
export const MANUSCRIPT_TYPES = Object.freeze(['comicScript', 'teleplay', 'prose']);

export const LOCKABLE_STAGES = Object.freeze(['arc']);

// Per-field arc lock targets. Each field can be individually frozen so
// `resolveVerifyIssues` / `commitSeasonsWithRemap` rewrite unlocked fields
// while preserving locked ones verbatim. Sibling to the binary `locked.arc`
// (which freezes everything); the two stack — `locked.arc: true` always wins.
export const ARC_LOCKABLE_FIELDS = Object.freeze([
  'logline', 'summary', 'protagonistArc', 'themes', 'shape', 'readerMap', 'tickingClock', 'foreshadowing',
]);

export const AUTOPILOT_LLM_STAGE_KINDS = Object.freeze([
  'characterFoundation',
  'generateArc',
  'repairArcStructure',
  'verifyArcSpine',
  'generateEpisodes',
  'foundationGate',
  'verifyArc',
  'beatSheet',
  'beatContinuity',
  'textStages',
  'pilotDraft',
  'pilotReview',
  'scriptVerify',
  'editorialReview',
  'reverseOutline',
  'editorialChecks',
  'revisionCycle',
  'produceTeaser',
]);

// How many candidate concepts to generate. Default 5 (mid of the issue's 4–6);
// clamped so a stray option can't spawn a wall of concepts or a single one.
export const CANDIDATE_COUNT_DEFAULT = 5;
export const CANDIDATE_COUNT_MIN = 2;
export const CANDIDATE_COUNT_MAX = 8;

export const VOLUME_BEATS_MODES = Object.freeze(['skip-existing', 'regenerate-all']);

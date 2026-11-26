// Shared vocabulary and bounds for issue records, stage artifacts, and render requests.

export const ISSUE_TITLE_MAX = 300;
export const SEASON_ID_MAX = 64;

// Issues fall back to position 0 when un-numbered; the cap keeps a runaway
// LLM payload from inflating the field unbounded.
export const ARC_POSITION_MAX = 9999;

export const STAGE_INPUT_MAX = 200_000;   // ~200kB — fits a long prose draft
export const STAGE_OUTPUT_MAX = 400_000;  // ~400kB — fits a long comic script
export const STAGE_NOTES_MAX = 4000;

export const STAGE_STATUSES = Object.freeze(['empty', 'generating', 'ready', 'edited', 'needs-review', 'error']);

export const ISSUE_STATUSES = Object.freeze(['draft', 'running', 'needs-review', 'shipped']);

export const AUDIO_FILENAME_MAX = 500;

// Which strategy drives the episode's non-dialogue audio (issue #863):
//   per-clip       — keep each stitched clip's own soundtrack (today's default)
//   silent         — strip any bed
//   generated      — assemble the arc-driven cues[] onto the timeline
//   uploaded-track — loop the single `music` pointer under the whole episode
export const AUDIO_MODES = Object.freeze(['per-clip', 'silent', 'generated', 'uploaded-track']);

// Per-cue field caps. Exported so the route's light Zod arm references the
// same numbers as the issue sanitizer.
export const AUDIO_CUE_ID_MAX = 80;
export const AUDIO_CUE_LABEL_MAX = 200;
export const AUDIO_CUE_PROMPT_MAX = 8000;
export const AUDIO_CUE_ENGINE_MAX = 80;
export const AUDIO_CUES_MAX = 200;

// Upper bound on how many image-prompt candidates a single fan-out request
// may ask for. Each candidate is an independent LLM call, so the cap keeps a
// runaway `count` from spawning dozens of provider hits in one click.
export const IMAGE_PROMPT_CANDIDATE_MAX = 6;

// Comic-pages owners encode (issue, target, variant). `variant` distinguishes
// the proof render from the high-resolution final; legacy owners without a
// variant suffix parse as proof so in-flight jobs at upgrade time still land.
export const COMIC_PAGE_VARIANTS = /** @type {const} */ (['proof', 'final']);

export const SOURCE_KIND = Object.freeze({ PROSE: 'prose', TELEPLAY: 'teleplay' });

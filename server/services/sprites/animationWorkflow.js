/**
 * Shared animation-render plumbing: per-record write serialization, chroma-key
 * precedence, the grok-TUI invocation, the i2v task wrapper, and the render-lane
 * vocabulary both lanes and the request schemas share (#4876).
 *
 * Everything here is a fact about "how PortOS renders a sprite animation" rather
 * than about any one track, so both animation services (`walk.js`'s bespoke
 * pipeline and the generic `animationTrackWorkflow.js`) read it from here. The
 * two used to hold independent copies of the TUI thresholds, the provider
 * literal, and the task text — and the task text had already drifted by a clause.
 */

import { createKeyCachedQueue } from '../../lib/createKeyCachedQueue.js';
import { GROK_TUI_ID } from '../../lib/grok.js';
import { ServerError } from '../../lib/errorHandler.js';

const animationWriteTail = createKeyCachedQueue();

// Walk and every named action mutate adjacent records under one sprite. Keep
// their write tail shared so a scanner approval cannot race a walk revision.
export const withAnimationWriteTail = (recordId, fn) => animationWriteTail(recordId, fn);

// manifest → record is the frozen chroma-key precedence for every animation
// track. A run's own key is the strongest provenance rung while packaging.
export const resolveChromaKey = ({ manifest, record, run } = {}) => (
  run?.chromaKey || manifest?.chromaKey || record?.chromaKey || null
);

/**
 * The locked directional anchor for one facing, or null.
 *
 * Fourth copy of this `.find` + locked/path pair when it was hoisted here (walk's
 * generate, walk's approve, its regenerability probe, and now every non-walk
 * track's render gate all ask the same question). The definition of "usable
 * anchor" drifting between them is how a gate ends up promising a render the
 * render path then refuses.
 */
export const lockedAnchorFor = (manifest, direction) => {
  const anchor = manifest?.anchors?.find((a) => a.direction === direction);
  return anchor?.status === 'locked' && anchor.path ? anchor : null;
};

/** The locked main reference, or null — the non-directional counterpart. */
export const lockedMainFor = (manifest) => {
  const main = manifest?.mainReference;
  return main?.locked && main.path ? main : null;
};

// Every sprite animation renders as an OBSERVABLE grok TUI session (the user
// wants to watch/course-correct grok in the Shell) rather than a headless
// mediaJobQueue spawn. The idle threshold must be long enough that grok's
// narration lulls during the multi-minute image_to_video render aren't mistaken
// for completion; the hard cap mirrors the old headless GROK_VIDEO_TIMEOUT_MS.
// Shared so raising the lull tolerance can't fix one track and leave the others
// reaping at 90s.
export const GROK_TUI_IDLE_MS = 90_000;
export const GROK_TUI_TIMEOUT_MS = 30 * 60_000;

/**
 * The grok-TUI provider descriptor for an animation render.
 *
 * `args: []` is intentional — buildTuiInvocation → applyCommandDefaults routes a
 * grok command through ensureGrokTuiArgs (which adds
 * `--permission-mode bypassPermissions`).
 */
export const grokTuiProvider = (grokPath) => ({
  id: GROK_TUI_ID, type: 'tui', command: grokPath || 'grok', args: [],
});

/**
 * The single-turn TUI task: the track's own motion/matte prompt, then the
 * concrete input path and the exact MP4 output path.
 *
 * `executeTuiRun` wraps this with its "write your final response to the response
 * file when done" instruction, so grok saves the MP4 first and its completion
 * signal is the response file (with the long idle threshold as a backstop).
 */
export const buildGrokI2vTask = ({ prompt, inputAbs, videoAbs, duration }) => (
  `${prompt}\n\n`
  + `Use your built-in image_to_video tool to animate the image at this exact path for ${duration} seconds:\n${inputAbs}\n\n`
  + `Save the resulting animation as an MP4 file at exactly this path:\n${videoAbs}\n\n`
  + 'Do not create or modify any other files, and do not run any tools beyond what is needed to render and save that MP4.'
);

// ── Render lanes ────────────────────────────────────────────────────────────
// Which engine produces a track's source clip. Grok's observable TUI session was
// the only answer until #4876 added the local MiniMax H3 lane; the pipeline
// downstream of the MP4 is identical either way, so the choice is a request
// field and a run-record field, never a second pipeline.
//
// These four live HERE rather than beside the local lane's implementation
// because `lib/spriteValidation.js` needs the id list to build its request
// enum, and this module is dependency-light by design — importing the local
// lane (which reaches the media-job queue and the model catalog) into the
// validation layer would drag both into every route's import graph.

/** The run record's `provider` for a locally-rendered clip. */
export const LOCAL_VIDEO_PROVIDER_ID = 'minimax-h3-local';

/** The provider ids a generate REQUEST may carry. */
// Moved to lib/spriteVocabulary.js in #4901; re-exported for existing callers.
export { ANIMATION_PROVIDER_IDS } from '../../lib/spriteVocabulary.js';
import { ANIMATION_PROVIDER_IDS } from '../../lib/spriteVocabulary.js';

/**
 * Absent → grok, so every pre-existing client, persisted retry, and test
 * renders exactly where it did before the local lane existed.
 */
export const DEFAULT_ANIMATION_PROVIDER = 'grok';

/**
 * Normalize a request's `provider` to one of ANIMATION_PROVIDER_IDS.
 *
 * An unknown value is REFUSED rather than silently defaulted: a typo'd provider
 * quietly rendering on the paid cloud lane is the one outcome nobody wants. The
 * Zod enum already rejects it at the route, so this is the service-level
 * backstop for a direct or internal caller.
 */
export const resolveAnimationProvider = (value) => {
  if (value === undefined || value === null || value === '') return DEFAULT_ANIMATION_PROVIDER;
  if (!ANIMATION_PROVIDER_IDS.includes(value)) {
    throw new ServerError(
      `Unknown animation provider "${value}" — expected one of ${ANIMATION_PROVIDER_IDS.join(', ')}`,
      { status: 400, code: 'ANIMATION_PROVIDER_INVALID' },
    );
  }
  return value;
};

/** Whether a run record was produced by the local lane. */
export const isLocalProviderRun = (run) => run?.provider === LOCAL_VIDEO_PROVIDER_ID;

/**
 * A run record's creation instant in ms, comparable across both record flavors.
 *
 * PortOS stamps `createdAt` as an ISO string (Date.parse handles it); imported
 * source-pipeline run records (#2895) stamp a Python `time.time()` epoch-seconds
 * FLOAT instead — `.localeCompare` on that threw and 500'd the whole detail
 * endpoint. Unparseable stays 0 so the ordering is total.
 */
export function runCreatedAtMs(createdAt) {
  if (typeof createdAt === 'number') return createdAt * 1000;
  const ms = Date.parse(createdAt);
  return Number.isNaN(ms) ? 0 : ms;
}

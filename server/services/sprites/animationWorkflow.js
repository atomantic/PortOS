/**
 * Shared animation-render plumbing: per-record write serialization, chroma-key
 * precedence, the grok-TUI invocation, the i2v task wrapper, and the render-lane
 * vocabulary both lanes and the request schemas share (#4876). Track-independent,
 * so `walk.js` and `animationTrackWorkflow.js` both read it from here.
 */

import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { createKeyCachedQueue } from '../../lib/createKeyCachedQueue.js';
import { GROK_TUI_ID } from '../../lib/grok.js';
import { ServerError } from '../../lib/errorHandler.js';

const animationWriteTail = createKeyCachedQueue();

// Walk and every named action mutate adjacent records, so they share one write
// tail; admitted before the queue even for callers that never update a DB row.
export const withAnimationWriteTail = (recordId, fn) => withBackupAssetPublication(() => animationWriteTail(recordId, fn));

// run → manifest → record: the frozen chroma-key precedence for every track.
export const resolveChromaKey = ({ manifest, record, run } = {}) => (
  run?.chromaKey || manifest?.chromaKey || record?.chromaKey || null
);

/**
 * The locked directional anchor for one facing, or null. One definition of
 * "usable anchor" shared by every gate, so a gate never promises a render the
 * render path refuses.
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

// Grok TUI sessions are observable in the Shell; the idle threshold must outlast
// narration lulls during the multi-minute image_to_video render.
export const GROK_TUI_IDLE_MS = 90_000;
export const GROK_TUI_TIMEOUT_MS = 30 * 60_000;

/**
 * The grok-TUI provider descriptor. `args: []` is intentional: applyCommandDefaults
 * routes grok through ensureGrokTuiArgs, which adds `--permission-mode bypassPermissions`.
 */
export const grokTuiProvider = (grokPath) => ({
  id: GROK_TUI_ID, type: 'tui', command: grokPath || 'grok', args: [],
});

/**
 * The single-turn TUI task: the track's prompt, the input path and the exact MP4
 * output path. `executeTuiRun` adds the response-file instruction, so grok saves
 * the MP4 first and completion is the response file (idle threshold is the backstop).
 */
export const buildGrokI2vTask = ({ prompt, inputAbs, videoAbs, duration }) => (
  `${prompt}\n\n`
  + `Use your built-in image_to_video tool to animate the image at this exact path for ${duration} seconds:\n${inputAbs}\n\n`
  + `Save the resulting animation as an MP4 file at exactly this path:\n${videoAbs}\n\n`
  + 'Do not create or modify any other files, and do not run any tools beyond what is needed to render and save that MP4.'
);

// ── Render lanes (#4876): grok TUI or local MiniMax H3; the pipeline after the
// MP4 is identical. Defined HERE because `lib/spriteValidation.js` needs the id
// list and importing the local lane would drag the media-job queue into every route.

/** The run record's `provider` for a locally-rendered clip. */
export const LOCAL_VIDEO_PROVIDER_ID = 'minimax-h3-local';

/** The provider ids a generate REQUEST may carry. */
// Moved to lib/spriteVocabulary.js in #4901; re-exported for existing callers.
import { ANIMATION_PROVIDER_IDS } from '../../lib/spriteVocabulary.js';

/** Absent → grok, so pre-existing clients and persisted retries render where they always did. */
export const DEFAULT_ANIMATION_PROVIDER = 'grok';

/**
 * Normalize a request's `provider` to one of ANIMATION_PROVIDER_IDS. An unknown
 * value is REFUSED, not defaulted (a typo silently rendering on the paid cloud
 * lane); the Zod enum rejects it at the route, this backstops internal callers.
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
 * A run record's creation instant in ms. PortOS stamps an ISO string; imported
 * source-pipeline runs (#2895) stamp a Python epoch-seconds FLOAT. Unparseable
 * stays 0 so ordering is total.
 */
export function runCreatedAtMs(createdAt) {
  if (typeof createdAt === 'number') return createdAt * 1000;
  const ms = Date.parse(createdAt);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Video render phase → named progress step (#5872).
 *
 * A local video render spends most of its wall clock somewhere other than the
 * sampler: resolving a cache, streaming tens of gigabytes of weights onto the
 * GPU, encoding the prompt, decoding latents, muxing audio. The runners already
 * announce which of those they are in — every helper under `scripts/` emits
 * `STAGE:<phase>` markers, and the server now forwards that id on its status and
 * progress frames — but the page had nowhere to put it, so a FastH3 render (an
 * ~89 GB INT4 DiT, no per-step progress until denoising starts) showed a
 * motionless "0%" and the word "Starting render…" for many minutes.
 *
 * This maps the runner's fine-grained phase vocabulary onto a short, ordered
 * list of steps a person can actually read, so the UI can say "Loading model —
 * step 2 of 5" instead of nothing. Pure: the caller owns every input.
 *
 * The step list is deliberately coarse. Runners disagree on how finely they
 * subdivide their work (`load-transformer` / `load-text-encoder` /
 * `from-pretrained` / `move-to-device` are all one wait as far as the user is
 * concerned), and a list that grew a row per marker would be a changelog of the
 * Python scripts rather than a description of the render.
 */

/** Ordered coarse steps. `id` is stable; `label` is what the user reads. */
export const VIDEO_RENDER_STEPS = Object.freeze([
  { id: 'queued', label: 'Queued' },
  { id: 'download', label: 'Downloading weights' },
  { id: 'load', label: 'Loading model' },
  { id: 'encode', label: 'Encoding prompt' },
  { id: 'render', label: 'Rendering' },
  { id: 'finalize', label: 'Decoding and saving' },
].map(Object.freeze));

const STEP_INDEX = Object.fromEntries(VIDEO_RENDER_STEPS.map((step, index) => [step.id, index]));

// Exact runner `STAGE:` id → coarse step, for the markers that carry no useful
// family prefix. Keys are what the helpers under `scripts/` actually emit (grep
// `STAGE:` there); anything unmatched falls through to `null`, which the caller
// must treat as "unknown phase", never as step 0 — reporting "Queued" for an
// unrecognized marker would read as the render having gone backwards.
const PHASE_STEP = Object.freeze(Object.assign(Object.create(null), {
  // The bare marker, which is what a `DOWNLOAD:` line sets and what
  // hf_download_repo.py emits as `STAGE:download:<n>/<total>:<file>`. It does
  // NOT match the `download-` prefix below, so without this entry the step
  // this list exists for never activates and a multi-GB first-run download
  // reads as "Rendering".
  download: 'download',
  // The download helper's own preamble, not separate user-visible work.
  'resolve-cache': 'download',
  verify: 'download',
  list: 'download',
  bytes: 'download',

  // Getting the pipeline resident. The single longest phase on a large
  // quantized checkpoint, and the one that used to show nothing at all.
  'from-pretrained': 'load',
  'move-to-device': 'load',
  'apply-loras': 'load',
  starting: 'load',

  // Conditioning.
  'encode-prompt': 'encode',
  conditioning: 'encode',
  'precompute-latents': 'encode',
  // …and its END marker, which means the OPPOSITE of the one above. It is the
  // last STAGE line generate_ltx2.py emits before denoising, and the server
  // pins it as the phase on every progress frame that follows, so mapping it
  // back to `encode` (as its `encode-prompt` prefix otherwise would) leaves
  // LTX-2 — the primary local runtime — reading "Encoding prompt" for the
  // whole sampler run. Exact entries win over prefixes, which is what makes
  // this correction possible.
  'encode-prompt-done': 'render',

  // The sampler itself.
  inference: 'render',
  sampling: 'render',
  generate: 'render',
  render: 'render',
  fastvideo: 'render',
  'minimax-h3': 'render',
  'ref2va-window': 'render',

  // Everything after the last denoise step.
  mux: 'finalize',
  complete: 'finalize',

  // The queue's own state, so a caller has one vocabulary rather than a
  // separate "is it queued" flag alongside the phase.
  queued: 'queued',
}));

// Prefix families, longest-prefix-first. The runners name their markers by
// family (`download-text-encoder`, `load-transformer`, `swap-video-decoder`,
// `wan-i2v`, `ref2va-mux`), and each family already ends up in one step — so
// matching the prefix absorbs the markers a future runner adds instead of
// silently degrading them to "unknown phase".
const PHASE_PREFIX_STEP = Object.freeze([
  ['download-', 'download'],
  ['load-', 'load'],
  ['swap-', 'load'],
  ['encode-prompt', 'encode'],
  ['ref2va-', 'render'],
  ['wan-', 'render'],
]);

/**
 * The coarse step a runner phase belongs to, or `null` when the phase is
 * unrecognized. Case-insensitive because BYOV helpers are not required to agree
 * on capitalization (the server normalizes STAGE tags the same way).
 */
export function videoRenderStepFor(phase) {
  if (typeof phase !== 'string' || !phase) return null;
  // Null-prototype lookup (see PHASE_STEP): a runner is free to emit
  // `STAGE:constructor`, and on a plain object literal that would resolve to
  // `Object` and hand the caller a step id no list contains.
  const id = phase.toLowerCase();
  if (PHASE_STEP[id]) return PHASE_STEP[id];
  return PHASE_PREFIX_STEP.find(([prefix]) => id.startsWith(prefix))?.[1] || null;
}

// One frozen step list per possible active step, plus the all-pending list.
// `resolveVideoRenderSteps` is called on every render of a page that re-renders
// on each keystroke and each SSE frame, and there are only seven answers — so
// they are built once at import and shared, which also gives callers a stable
// identity to memo on.
const STEPS_BY_ACTIVE_ID = Object.freeze(Object.fromEntries(
  [null, ...VIDEO_RENDER_STEPS.map((step) => step.id)].map((activeId) => [
    String(activeId),
    Object.freeze(VIDEO_RENDER_STEPS.map((step, index) => Object.freeze({
      ...step,
      state: index === STEP_INDEX[activeId] ? 'active'
        : index < STEP_INDEX[activeId] ? 'done' : 'pending',
    }))),
  ]),
));

/**
 * Project a render's live state onto the step list.
 *
 * `phase` is the runner's marker (absent until the first status frame, and set
 * to `'queued'` by the page while the job is still in line), and `progressPct`
 * is only used to decide whether the sampler has demonstrably started — a
 * runner that reports numeric progress is rendering even if its phase marker
 * never arrived.
 *
 * Returns `{ steps, activeId }` where each step carries `state`:
 * `'done' | 'active' | 'pending'`. `activeId` is `null` only when there is
 * nothing to show (not generating).
 */
export function resolveVideoRenderSteps({ generating = false, phase = null, progressPct = null } = {}) {
  // Order of preference: an explicit phase, then "the sampler is visibly
  // running", then the honest default for a render that has started but told us
  // nothing yet — which is loading, not rendering.
  const activeId = !generating ? null
    : videoRenderStepFor(phase)
      || (Number.isFinite(progressPct) && progressPct > 0 ? 'render' : 'load');
  // `?? STEPS_BY_ACTIVE_ID.null` so an id outside the step list can never hand
  // the caller `undefined` to map over.
  return { activeId, steps: STEPS_BY_ACTIVE_ID[String(activeId)] ?? STEPS_BY_ACTIVE_ID.null };
}

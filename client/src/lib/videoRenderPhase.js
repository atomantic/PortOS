/**
 * Video render phase → named progress step.
 *
 * A local video render spends most of its wall clock outside the sampler
 * (resolving a cache, streaming weights onto the GPU, encoding the prompt,
 * decoding latents, muxing audio). Runners announce their phase with
 * `STAGE:<phase>` markers (every helper under `scripts/`) and the server forwards
 * that id on status/progress frames. This maps the fine-grained vocabulary onto a
 * short ordered list a person can read ("Loading model — step 2 of 5"). Pure: the
 * caller owns every input.
 *
 * External provider backends (Grok, fal.ai, reactor.inc) get a shorter ladder
 * (REMOTE_VIDEO_RENDER_STEPS): they render on someone else's hardware, so local
 * markers never arrive and the card would pin "Loading model" until completion.
 *
 * The list is deliberately coarse: runners subdivide differently
 * (`load-transformer` / `load-text-encoder` / `from-pretrained` /
 * `move-to-device` are one wait to the user), and a row per marker would be a
 * changelog of the Python scripts, not a description of the render.
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

/**
 * Ordered coarse steps for a render this machine does not run (an external
 * provider API). The provider owns the weights, sampler and encode, so what a
 * caller CAN observe is the round trip: hand the job over, wait, pull the file back.
 */
export const REMOTE_VIDEO_RENDER_STEPS = Object.freeze([
  { id: 'queued', label: 'Queued' },
  { id: 'submit', label: 'Submitting' },
  { id: 'render', label: 'Rendering' },
  { id: 'fetch', label: 'Downloading result' },
].map(Object.freeze));

// Exact runner `STAGE:` id → coarse step, for markers with no useful family
// prefix (keys are what the helpers under `scripts/` emit). Unmatched → `null`,
// which the caller must treat as "unknown phase", never step 0: "Queued" for an
// unrecognized marker would read as the render going backwards.
const PHASE_STEP = Object.freeze(Object.assign(Object.create(null), {
  // The bare marker a `DOWNLOAD:` line sets and hf_download_repo.py emits as
  // `STAGE:download:<n>/<total>:<file>`. It doesn't match the `download-` prefix
  // below, so without this a multi-GB first-run download reads as "Rendering".
  download: 'download',
  // The download helper's own preamble, not separate user-visible work.
  'resolve-cache': 'download',
  verify: 'download',
  list: 'download',
  bytes: 'download',

  // Getting the pipeline resident: the longest phase on a large quantized checkpoint.
  'from-pretrained': 'load',
  'move-to-device': 'load',
  'apply-loras': 'load',
  starting: 'load',

  // Conditioning.
  'encode-prompt': 'encode',
  conditioning: 'encode',
  'precompute-latents': 'encode',
  // The END marker, the OPPOSITE of the one above: the last STAGE line
  // generate_ltx2.py emits before denoising, pinned as the phase on every later
  // progress frame. Mapped to `encode` via its prefix it would leave LTX-2 (the
  // primary local runtime) reading "Encoding prompt" for the whole sampler run.
  // Exact entries win over prefixes.
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

  // The queue's own state, so callers have one vocabulary.
  queued: 'queued',
}));

// Prefix families, longest-prefix-first. Runners name markers by family
// (`download-text-encoder`, `load-transformer`, `wan-i2v`), each ending up in one
// step, so prefix matching absorbs a future runner's markers instead of degrading
// them to "unknown phase".
const PHASE_PREFIX_STEP = Object.freeze([
  ['download-', 'download'],
  ['load-', 'load'],
  ['swap-', 'load'],
  ['encode-prompt', 'encode'],
  ['ref2va-', 'render'],
  ['wan-', 'render'],
]);

// Provider phase → remote step. The cloud lanes in server/services/videoGen/ emit
// `submit` / `render` / `fetch` (CLOUD_RENDER_PHASE) plus the queue's `queued`;
// the one-word synonyms spare a future lane an exact match. NOT merged into
// PHASE_STEP: `download` means "streaming weights onto this GPU" there and
// "pulling the finished clip back" here.
const REMOTE_PHASE_STEP = Object.freeze(Object.assign(Object.create(null), {
  queued: 'queued',
  submit: 'submit',
  submitting: 'submit',
  render: 'render',
  rendering: 'render',
  fetch: 'fetch',
  download: 'fetch',
}));

/**
 * The coarse step a runner phase belongs to, or `null` when unrecognized.
 * Case-insensitive (BYOV helpers needn't agree on capitalization). `remote: true`
 * resolves against the provider ladder.
 */
export function videoRenderStepFor(phase, { remote = false } = {}) {
  if (typeof phase !== 'string' || !phase) return null;
  // Null-prototype lookup (see PHASE_STEP): `STAGE:constructor` on a plain object
  // literal would resolve to `Object` and hand back a step id no list contains.
  const id = phase.toLowerCase();
  if (remote) return REMOTE_PHASE_STEP[id] || null;
  if (PHASE_STEP[id]) return PHASE_STEP[id];
  return PHASE_PREFIX_STEP.find(([prefix]) => id.startsWith(prefix))?.[1] || null;
}

// One frozen step list per possible active step, plus the all-pending list,
// built once: `resolveVideoRenderSteps` runs on every keystroke and SSE frame,
// and sharing gives callers a stable identity to memo on.
const stepsByActiveId = (steps) => {
  const stepIndex = Object.fromEntries(steps.map((step, index) => [step.id, index]));
  return Object.freeze(Object.fromEntries(
    [null, ...steps.map((step) => step.id)].map((activeId) => [
      String(activeId),
      Object.freeze(steps.map((step, index) => Object.freeze({
        ...step,
        state: index === stepIndex[activeId] ? 'active'
          : index < stepIndex[activeId] ? 'done' : 'pending',
      }))),
    ]),
  ));
};
const STEPS_BY_ACTIVE_ID = stepsByActiveId(VIDEO_RENDER_STEPS);
const REMOTE_STEPS_BY_ACTIVE_ID = stepsByActiveId(REMOTE_VIDEO_RENDER_STEPS);

/**
 * Project a render's live state onto the step list. `phase` is the runner's marker
 * (absent until the first status frame; set to `'queued'` by the page while in
 * line). `progressPct` only decides whether the sampler has demonstrably started:
 * numeric progress means rendering even if the phase marker never arrived.
 * `remote` selects the provider ladder; its silent default is `submit`, not `load`,
 * since nothing loads here and the job has been handed over.
 *
 * Returns `{ steps, activeId }`, each step carrying `state`:
 * `'done' | 'active' | 'pending'`. `activeId` is `null` only when not generating.
 */
export function resolveVideoRenderSteps({ generating = false, phase = null, progressPct = null, remote = false } = {}) {
  const byActiveId = remote ? REMOTE_STEPS_BY_ACTIVE_ID : STEPS_BY_ACTIVE_ID;
  // Preference: an explicit phase, then "sampler visibly running", then the honest
  // default for a started render that told us nothing (loading / submitting).
  const activeId = !generating ? null
    : videoRenderStepFor(phase, { remote })
      || (Number.isFinite(progressPct) && progressPct > 0 ? 'render' : (remote ? 'submit' : 'load'));
  // `?? byActiveId.null` so an id outside the list never yields `undefined`.
  return { activeId, steps: byActiveId[String(activeId)] ?? byActiveId.null };
}

/**
 * Measured local-model assessments — the run + durable store.
 * One bounded generation per context length through the SAME provider seam the Local LLM
 * playground uses (`localLlmPlayground.runLocalLlmTest`), recording throughput, time-to-first-token,
 * resident footprint and environment. This is evidence where `huggingFaceCatalog.js#classifyFit`
 * only estimates; `lib/localModelAssessment.js` turns it into a verdict and ranking.
 *
 * ## AI Provider Usage Policy (root AGENTS.md) — read before editing
 *
 * Assessments call an LLM, so they are STRICTLY user-triggered. This module
 * mirrors the `initDrillCache` / `requestCacheFill` split from
 * `meatspacePostDrillCache.js`:
 *
 *   - `loadAssessments()` / `getAssessmentReport()` read ONLY what is already on
 *     disk. Zero LLM calls. Safe from boot, from a poll, from anywhere.
 *   - `runAssessment()` is the only function that touches a provider, and it is
 *     reachable only from `POST /api/local-llm/assessments/run` — a deliberate
 *     user action whose UI names the backend, the model, and the number of runs
 *     before it fires.
 *
 * There is NO scheduler and NO boot hook. Do not add one.
 *
 * `localModelAssessmentSweep.js` is not an exception: it runs only from a button press behind a
 * consent gate naming the model and generation count.
 *
 * The durable store, environment capture and privacy/storage contract live in
 * `localModelAssessmentStore.js`, which has no path to a provider, so read-only consumers can
 * import it without an import cycle through `localLlm.js`.
 */

import {
  ASSESSMENT_INTENTS,
  BENCHMARK_PROFILE,
  benchmarkContexts,
  buildThroughputReport,
  classifyFitVerdict,
  classifySampleFailure,
  rankByIntent,
  sampleHidesReasoning,
  summarizePerformance,
  summarizeSweepScopes,
} from '../lib/localModelAssessment.js';
import {
  assessmentKey,
  captureEnvironment,
  captureLiveEnvironments,
  deleteAssessment,
  loadAssessments,
  loadStore,
  saveAssessment,
  withStaleness,
} from './localModelAssessmentStore.js';
import {
  ASSESSABLE_RUNTIMES,
  LOCAL_RUNTIMES,
  MANAGED_ASSESSMENT_BACKENDS,
  isEndpointRuntime,
} from '../lib/localProviderRuntime.js';
import {
  compareTunings,
  describeTuning,
  launchArgs,
  launchConfig,
  launchEnv,
  launchTuning,
  normalizeTuning,
  requestBody,
  tuningGridFor,
  tuningSignature,
  tuningSpecsFor,
} from '../lib/localModelTuning.js';
import { claimHeavyLocalJob } from '../lib/heavyJobClaim.js';
import { isEmbeddingModel } from '../lib/localModelHeuristics.js';
import { ServerError } from '../lib/errorHandler.js';
import { runEndpointLlmTest, runLocalLlmTest } from './localLlmPlayground.js';
import {
  captureLlamaServerConfig,
  relaunchLlamaServerWithTuning,
  restoreLlamaServerConfig,
} from './llamaServerManager.js';
import { relaunchMtplxServerWithTuning } from './mtplxServerManager.js';
import { MANAGED_RUNTIME_APPS } from '../lib/managedRuntimeApps.js';
import { readProcessTreeResidentBytes } from '../lib/processTreeMemory.js';
import { getAppStatus } from './pm2.js';
import { durableRuntimeModels, listRuntimeModels, runtimeApiKey, runtimeEndpoint } from './localRuntimeEndpoints.js';
import {
  getLoadedModels as getLoadedOllamaModels,
  restartWithEnv as restartOllamaWithEnv,
} from './ollamaManager.js';
import { loadModelWithArgs as loadLmStudioModelWithArgs } from './lmStudioManager.js';

// Re-exported so the store split stays invisible to callers.
export { captureEnvironment, deleteAssessment, loadAssessments };

const GB = 2 ** 30;

// Nominal context sizes, in approximate tokens. Three points is the minimum that shows a trend.
// The route caps per-run overrides.
export const DEFAULT_CONTEXT_TOKENS = [512, 4096, 16384];

// Chars-per-token ratio used ONLY to size filler. No tokenizer exists, so nothing reports a token
// measurement (see lib/localModelAssessment.js).
const CHARS_PER_TOKEN = 4;

// Fixed output budget: the point is prefill + decode at a context, comparable across models. Long
// enough that a thinking model's reasoning and a multi-token-prediction runtime's draft acceptance
// average over many decode steps rather than a handful (#17430).
const SAMPLE_MAX_TOKENS = BENCHMARK_PROFILE.maxTokens;

// One short generation before the measured samples. A runtime's first request pays one-off costs
// (weights paging in, kernel compilation, a speculative-decoding draft head warming up) that are not
// its steady-state speed; averaging them into sample 1 ranked a faster runtime below a slower one.
// Its time is recorded separately as `warmup`, never folded into `performance`.
const WARMUP_MAX_TOKENS = 16;
const WARMUP_PROMPT = 'Reply with the single word: ready.';
// A cold runtime can spend longer than a measured sample's budget loading weights and compiling kernels.
const WARMUP_TIMEOUT_MS = 300000;

// Per-sample ceiling; a timeout is recorded as a resource failure.
const SAMPLE_TIMEOUT_MS = 120000;

const SAMPLE_SYSTEM_PROMPT =
  'You are being benchmarked. Answer the final question in one short sentence. Do not summarize the reference text.';

// Generated filler. Distinct numbered lines keep a prefix cache from making a long prompt look cheap.
function buildFillerPrompt(contextTokens) {
  const targetChars = Math.max(0, Math.round(contextTokens * CHARS_PER_TOKEN));
  const lines = [];
  let length = 0;
  for (let n = 1; length < targetChars; n += 1) {
    const line = `Reference item ${n}: a placeholder record used only to occupy context during measurement.\n`;
    lines.push(line);
    length += line.length;
  }
  return lines.join('');
}

/** The prompt for one sample: filler to fill the context, then a trivial question. */
export function buildSamplePrompt(contextTokens) {
  const filler = buildFillerPrompt(contextTokens);
  return `${filler}\nIgnoring every reference item above, what is 2 + 2? Answer with the number only.`;
}

// Runtime endpoint/key/model resolution lives in `localRuntimeEndpoints.js`; re-exported so existing importers keep one path.
export { durableRuntimeModels, listRuntimeModels, runtimeApiKey, runtimeEndpoint };

// ---- measurement ------------------------------------------------------------

/**
 * Turn one `runLocalLlmTest` result into a recorded sample. A run that produced no text is a
 * FAILURE even when it resolved without an `error` (timeouts resolve), else a fabricated zero
 * enters the speed average.
 */
export function toSample(contextTokens, result) {
  const timings = result?.timings || {};
  const ok = !result?.error && typeof result?.text === 'string' && result.text.trim().length > 0;
  const measured = (value) => (ok && Number.isFinite(value) ? value : null);
  return {
    contextTokens,
    ok,
    // Every timing is null-or-measured; nothing is defaulted to 0.
    charsPerSecond: measured(timings.charsPerSecond),
    ttftMs: measured(timings.ttftMs),
    totalMs: Number.isFinite(timings.totalMs) ? timings.totalMs : null,
    chars: Number.isFinite(timings.chars) ? timings.chars : null,
    // Token throughput when the daemon reported counts; `null` = none reported, never zero.
    completionTokens: measured(timings.completionTokens),
    promptTokens: measured(timings.promptTokens),
    tokensPerSecond: measured(timings.tokensPerSecond),
    promptTokensPerSecond: measured(timings.promptTokensPerSecond),
    decodeMs: measured(timings.decodeMs),
    promptMs: measured(timings.promptMs),
    timingSource: ok && typeof timings.timingSource === 'string' ? timings.timingSource : null,
    // `true` = the count came from counting streamed frames rather than the
    // daemon's tokenizer, and every figure derived from it must be labelled.
    tokensEstimated: ok && typeof timings.tokensEstimated === 'boolean' ? timings.tokensEstimated : null,
    error: result?.error || (ok ? null : 'model produced no output'),
  };
}

// PM2 app per runtime PortOS runs as a managed daemon. Their footprint is the process's own: each
// serves the model it was launched with, so the whole process is what that model costs to hold.
const MANAGED_DAEMON_APPS = Object.fromEntries(Object.entries(MANAGED_RUNTIME_APPS).map(([id, row]) => [id, row.app]));

// A reading that rounds to 0.00 GB (a wrapper-only tree) is not a measured footprint of the model;
// stored as `0` it would score the memory axis as free.
const toGb = (bytes) => {
  const gb = Number.isFinite(bytes) && bytes > 0 ? Number((bytes / GB).toFixed(2)) : 0;
  return gb > 0 ? gb : null;
};

/**
 * A measured model's resident footprint and where it came from, `{ residentGb: null, residentSource: null }`
 * when unknown. Ollama reports per-model size in `/api/ps`; a PM2-managed daemon is read from its process
 * tree (`lib/processTreeMemory.js`). An external daemon PortOS does not run, LM Studio and vLLM report
 * nothing, and are left `null` rather than given a weight-file estimate.
 */
async function residentMemoryFor(backend, modelId) {
  const unknown = { residentGb: null, residentSource: null };
  if (backend === 'ollama') {
    const loaded = await getLoadedOllamaModels().catch(() => []);
    const match = loaded.find((m) => m?.id === modelId || m?.name === modelId);
    const residentGb = toGb(match?.size);
    return residentGb === null ? unknown : { residentGb, residentSource: 'ollama' };
  }
  const app = MANAGED_DAEMON_APPS[backend];
  if (!app) return unknown;
  const status = await getAppStatus(app).catch(() => null);
  // A daemon PM2 does not show online is not the one that answered the samples (an external
  // server on the same port, or it exited), so its pid says nothing about this model.
  if (status?.status !== 'online' || !Number.isSafeInteger(status?.pid) || status.pid <= 0) return unknown;
  const reading = await readProcessTreeResidentBytes(status.pid).catch(() => null);
  const residentGb = toGb(reading?.bytes);
  return residentGb === null ? unknown : { residentGb, residentSource: `process-${reading.source}` };
}

// Tokens/s first: a thinking model's visible answer is a character or two, so its chars/s is ~0
// and is never shown as its speed.
function sampleRateText(sample) {
  if (Number.isFinite(sample.tokensPerSecond)) return `${sample.tokensPerSecond} tok/s`;
  if (sampleHidesReasoning(sample)) return 'speed n/a (reasoning hidden from the answer)';
  return `${sample.charsPerSecond ?? '?'} chars/s`;
}

// Human-readable reason behind a non-`fits` verdict; quotes the backend's own error.
function describeVerdict(verdict, samples) {
  if (verdict === 'fits') return null;
  const backendError = samples.find((s) => s?.error)?.error || null;
  if (verdict === 'unknown') return backendError || 'no sample produced a usable measurement';
  if (verdict === 'incompatible') return backendError || 'the backend refused this model';
  return backendError || 'every context length tested exhausted this machine';
}

/**
 * Run one model's assessment. **The only LLM-calling entry point in this module.**
 *
 * Samples run smallest context first. A resource or `incompatible` failure stops the larger ones,
 * which cannot succeed after a smaller one exhausted memory.
 *
 * @param {object} options
 * @param {'ollama'|'lmstudio'|'llama'|'mtplx'|'vllm'} options.backend
 * @param {string} options.modelId
 * @param {number[]} [options.contextTokens] nominal context sizes to sample
 * @param {'benchmark'|null} [options.profile] `'benchmark'` runs `BENCHMARK_PROFILE` instead
 *   (repeated warm runs at one context) and ignores `contextTokens`
 * @param {object} [options.tuning] launch/runtime knobs (`lib/localModelTuning.js`). Launch knobs apply
 *   where PortOS starts the daemon (llama.cpp); the rest are recorded. The tuning is part of the
 *   record's identity: a second tuning is a NEW record.
 * @param {number} [options.claimTimeoutMs] how long to WAIT for the machine-wide accelerator claim.
 *   0 refuses immediately (interactive click); the sweep waits.
 * @param {AbortSignal} [options.signal] client disconnect
 * @param {(frame: object) => void} [options.onProgress] per-sample progress.
 *   Frames carry `backend` + `modelId` to tell this run from unrelated installs on the same event.
 * @returns {Promise<object>} the persisted assessment record
 */
export async function runAssessment({ backend, modelId, contextTokens = DEFAULT_CONTEXT_TOKENS, profile = null, tuning, resetTuning = false, signal, onProgress, claimTimeoutMs = 0 } = {}) {
  // Refused before the heavy-job claim: an embedding-only model answers every sample with a 400
  // and each one raises an investigation task. Covers the direct run route.
  if (isEmbeddingModel(modelId)) {
    throw new ServerError(
      `${modelId} is an embedding model — it has no chat/generation to measure`,
      { status: 400, code: 'MODEL_NOT_ASSESSABLE', context: { backend, modelId } },
    );
  }
  // A benchmark repeats ONE context on purpose (warm runs to average); a context sweep samples
  // each size once, so its list is deduped.
  const benchmark = profile === 'benchmark';
  const contexts = benchmark
    ? benchmarkContexts()
    : [...new Set(contextTokens)].filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  // A broken progress consumer must never abort a measurement.
  const emit = (frame) => {
    if (typeof onProgress !== 'function') return;
    try { onProgress({ scope: 'assessment', backend, modelId, ...frame }); }
    catch (err) { console.error(`❌ Local LLM: assessment progress listener failed: ${err.message}`); }
  };
  // Same machine-wide claim as image/video/3D rendering: a contending job silently changes the
  // number being recorded, so refuse rather than record a corrupt reading.
  const claim = await claimHeavyLocalJob({ kind: 'local-model assessment', id: `${backend}/${modelId}`, timeoutMs: claimTimeoutMs });
  if (!claim.ok) {
    throw new ServerError(claim.message, { status: 409, code: 'HEAVY_LOCAL_JOB_BUSY', context: { holder: claim.holder } });
  }
  try {
    // The claim wait ignores the abort signal; a cancel during it must not become a measurement.
    if (signal?.aborted) {
      console.log(`📏 Local LLM: ${backend}/${modelId} cancelled while waiting for the accelerator — not measured`);
      emit({ event: 'complete', cancelled: true, message: `${modelId}: cancelled before it started — nothing recorded` });
      // Same record shape as the mid-run cancel; `unknown` = no evidence.
      return {
        backend, modelId, cancelled: true, verdict: 'unknown', samples: [],
        performance: summarizePerformance([]),
      };
    }
    return await measureModel({ backend, modelId, contexts, benchmark, tuning, resetTuning, signal, emit });
  } finally {
    await claim.release();
  }
}

// Normalizes manager results (`applied` vs `success`) to {took effect, reason, running now}.
// `null` = nothing needed to change, which is not a refusal and carries no reason.
const toApplication = (ok, error, fallbackReason) => ({
  applied: ok === null ? null : ok === true,
  reason: ok === true || ok === null ? null : (error || fallbackReason),
  config: null,
});

/**
 * Put a runtime's launch knobs into effect, each by the only transport that
 * reaches it: llama.cpp relaunches with a new command line, Ollama restarts
 * carrying new environment, LM Studio reloads the model through `lms load`,
 * MTPLX relaunches `mtplx serve` with the flags on its command line.
 *
 * Keyed by BACKEND rather than by transport because the applier is "who owns
 * this daemon" — the manager that knows how to stop it, what to put back if the
 * new configuration will not start, and whether the user registered it to launch
 * at login. A runtime with no entry has no launch path, which is why
 * `lib/localModelTuning.js` declares no launch knob for one; this refusal is the
 * backstop for a knob added without one, so the reading is filed as "not
 * applied" instead of silently attributed to a tuning that never ran.
 *
 * Each entry also names the ONE knob transport its path can carry. That is the
 * sharper trap than a missing applier: add an `env:` knob to MTPLX and the
 * applier still runs, the assessment still records `tuningApplied: true`, and
 * the flag is silently dropped on the way to a launch line that renders only
 * `cli`. Nothing fails at runtime, so `LAUNCH_TRANSPORTS` below is exported and
 * `localModelAssessments.test.js` asserts the catalog against it.
 *
 * ## `sweepable` — which runtimes a TUNING SWEEP may drive
 *
 * A sweep needs two things an ordinary measurement does not, and a manager that
 * cannot do BOTH must not be swept:
 *
 *   1. **A complete tuning.** Each variant's launch line has to be exactly that
 *      variant's knobs, and the baseline's has to be none of them — otherwise
 *      variants accumulate and `deltaPercent` credits an accumulated line to a
 *      single change. That is the `reset` a sweep passes through.
 *   2. **A configuration that can be put back.** A sweep relaunches the daemon
 *      once per variant, and the running process is the only record of the
 *      launch flags the user chose. Without `capture`/`restore` a sweep would
 *      silently replace them with its last variant's.
 *
 * Only llama.cpp offers both today. Ollama's environment is written into the
 * user's launchd domain / a systemd drop-in and survives a restart, LM Studio's
 * load settings survive a reload, and MTPLX has the reset but no capture pair —
 * so on those a sweep would leave its knobs set forever AND measure every later
 * "backend defaults" reading under them. #4763 is the work that makes them
 * sweepable; until it lands the button and the route refuse rather than
 * producing a comparison that reads as valid.
 */
const LAUNCH_APPLIERS = {
  llama: {
    transport: 'config',
    sweepable: true,
    resetsOnEmpty: true,
    apply: ({ launch, reset }) => relaunchLlamaServerWithTuning(launchConfig('llama', launch), { reset }),
    capture: captureLlamaServerConfig,
    restore: restoreLlamaServerConfig,
  },
  ollama: {
    transport: 'env',
    sweepable: false,
    resetsOnEmpty: true,
    apply: ({ launch }) => restartOllamaWithEnv(launchEnv('ollama', launch))
      .then((r) => toApplication(r.applied, r.error, `Ollama could not be restarted with that tuning (${r.reason})`)),
  },
  lmstudio: {
    transport: 'cli',
    sweepable: false,
    resetsOnEmpty: true,
    apply: ({ modelId, launch }) => loadLmStudioModelWithArgs(modelId, launchArgs('lmstudio', launch))
      .then((r) => toApplication(r.unchanged ? null : r.success, r.error, 'LM Studio could not reload the model with that tuning')),
  },
  mtplx: {
    transport: 'cli',
    sweepable: false,
    // `relaunchMtplxServerWithTuning` refuses an empty knob set rather than
    // relaunching without flags, so PortOS cannot put this daemon back on its
    // defaults and an untuned run must not claim it did.
    resetsOnEmpty: false,
    // Takes the knob set as-is rather than rendered flags: `mtplxServerManager`
    // renders it with the same catalog on the way to the launch line, and keeps
    // the ids so it can report back which tuning the daemon came up under.
    apply: ({ launch }) => relaunchMtplxServerWithTuning(launch),
  },
};

/**
 * Runtime id → the knob transport its applier carries. Derived rather than
 * written twice, so an applier added without declaring one lands here as
 * `undefined` and fails the guard instead of quietly opting out of it.
 */
export const LAUNCH_TRANSPORTS = Object.freeze(Object.fromEntries(
  Object.entries(LAUNCH_APPLIERS).map(([runtime, { transport }]) => [runtime, transport])
));

/** Whether a TUNING SWEEP may drive this runtime — see `sweepable` above. */
export const isTuningSweepable = (backend) => LAUNCH_APPLIERS[backend]?.sweepable === true;

/**
 * Whether an EMPTY knob set is a real "run at backend defaults" instruction this
 * manager honours, rather than a request for nothing.
 *
 * This is what makes an UNTUNED assessment honest. Such a run records
 * `tuningKey: ''` and renders as **Backend defaults**, so the daemon has to
 * actually BE at them — but if the previous run tuned it, it is still serving
 * under that tuning and the reading is filed under a configuration that never
 * ran. `compareTunings` then ranks every real tuning against it, making the one
 * row a user reads as the baseline the least trustworthy row in the table
 * (#4759, and the same failure #4763 describes for a sweep's baseline variant).
 *
 * Distinct from `sweepable`: this is only the RESET half. A sweep additionally
 * needs `capture`/`restore` so it can put the user's own launch flags back after
 * driving the daemon through a grid — which llama.cpp alone has today.
 */
const resetsOnEmpty = (backend) => LAUNCH_APPLIERS[backend]?.resetsOnEmpty === true;

/**
 * Remember a runtime's launch configuration so a sweep can put it back.
 * `null` for a runtime with nothing to capture — restoring it is then a no-op.
 */
export const captureLaunchState = (backend) => LAUNCH_APPLIERS[backend]?.capture?.() ?? Promise.resolve(null);

/** Put back what `captureLaunchState` returned. Safe to call with `null`. */
export const restoreLaunchState = (backend, state) =>
  (state ? LAUNCH_APPLIERS[backend]?.restore?.(state) : null) ?? Promise.resolve({ restored: false, reason: 'nothing to restore' });

async function applyLaunchTuning({ backend, modelId, launch, reset }) {
  const applier = LAUNCH_APPLIERS[backend];
  if (!applier) {
    // No launch path at all. A requested tuning is genuinely not applied; an
    // empty set has nothing to undo, because PortOS never put a tuning on this
    // daemon in the first place.
    return Object.keys(launch).length > 0
      ? { applied: false, reason: `PortOS does not start the ${backend} runtime, so it cannot apply launch tuning`, config: null }
      : { applied: null, reason: null, config: null };
  }
  return applier.apply({ backend, modelId, launch, reset })
    .catch((err) => ({ applied: false, reason: err?.message || 'relaunch failed', config: null }));
}

// The measurement itself, with the accelerator already claimed by the caller
// above. Split out so the claim's release is one `finally` around one call
// rather than wrapped around a 100-line body.
async function measureModel({ backend, modelId, contexts, benchmark = false, tuning, resetTuning, signal, emit }) {
  const normalizedTuning = normalizeTuning(backend, tuning);
  const tuningKey = tuningSignature(normalizedTuning);
  const tuningLabel = describeTuning(backend, normalizedTuning);

  // Launch knobs reach the daemon BEFORE the first sample, or the measurement
  // would describe the previous configuration while claiming the new one.
  // `applied: false` is recorded rather than swallowed — a reading taken under a
  // tuning PortOS could not apply must not be filed as evidence for that tuning.
  const launch = launchTuning(backend, normalizedTuning);
  const request = requestBody(backend, normalizedTuning);
  // An empty launch tuning is a real instruction — "run at backend defaults" —
  // wherever the runtime can honour it (`resetsOnEmpty`). A sweep needs that for
  // its baseline variant, and so does an ORDINARY untuned Measure: it records
  // `tuningKey: ''` and renders as "Backend defaults", so a daemon the previous
  // run tuned has to be put back or the reading describes a configuration that
  // never ran (#4759 / #4763).
  //
  // This costs a plain measurement nothing when the daemon is already at
  // defaults — every applier compares against what is running and relaunches
  // only on a real difference. A runtime that CANNOT reset keeps the old
  // behaviour: nothing was asked for, nothing is touched, and `tuningApplied`
  // stays `null` rather than becoming a `false` that would drop every untuned
  // reading out of the recommendations.
  const clearing = Object.keys(launch).length === 0;
  const resetting = clearing && (resetTuning || resetsOnEmpty(backend));
  let tuningApplication;
  if (!clearing || resetting) {
    // Announced BEFORE the await, because applying a launch tuning stops and
    // restarts a daemon — and a cold MLX or GGUF checkpoint can take minutes to
    // load again. Without this the progress stream is silent for that whole
    // stretch, on a run the user just started, which reads as a hang.
    emit({
      event: 'start',
      sampleIndex: 0,
      sampleCount: contexts.length,
      // A sweep's baseline variant has no label, and "restarting with null" is
      // not a sentence. It is a real configuration — say which one.
      message: `Restarting ${backend} with ${tuningLabel || 'backend defaults'} before measuring…`,
    });
    // `reset` stays SWEEP-only. It renders the cleared launch line, which wipes
    // sweepable knobs the USER may have set on the LLMs page — safe only for a
    // caller that captured them and will put them back. An ordinary untuned run
    // asks its manager to undo what PORTOS applied and nothing else.
    const application = await applyLaunchTuning({ backend, modelId, launch, reset: resetTuning });
    // A tuning made only of request-body knobs rides on each sample and needs no
    // daemon restart, so the applier's "nothing to apply" is `true` there — it
    // did take effect, just not through the launch line.
    tuningApplication = application.applied === null && Object.keys(request).length > 0
      ? { ...application, applied: true }
      : application;
  } else {
    // `null`, NOT `true`, when nothing was tuned. `true` when the only knobs set
    // ride on the request body, which needs no daemon restart to take effect.
    tuningApplication = { applied: Object.keys(request).length > 0 ? true : null, reason: null, config: null };
  }

  const endpoint = isEndpointRuntime(backend) ? await runtimeEndpoint(backend) : null;
  if (isEndpointRuntime(backend) && !endpoint) {
    throw new Error(`No endpoint is configured for the ${backend} runtime`);
  }
  // Same key the listing probe used — a key-gated vLLM 401s every sample
  // otherwise, and the run would record "does-not-fit" for an auth failure.
  const apiKey = endpoint ? await runtimeApiKey(backend) : '';

  const environment = await captureEnvironment({ backend });
  const { models: installed } = await listRuntimeModels(backend);
  const card = (installed || []).find((m) => m?.id === modelId) || null;

  console.log(`📏 Local LLM: assessing ${backend}/${modelId}${tuningKey ? ` [${tuningKey}]` : ''} across ${contexts.length} context sizes`);
  emit({
    event: 'start',
    sampleIndex: 0,
    sampleCount: contexts.length,
    message: `Measuring ${modelId} — ${contexts.length} generation${contexts.length === 1 ? '' : 's'}…`,
  });

  // Both runners take the same shape, including the request-applied knobs —
  // the ONLY difference is whether the model is reached through a configured
  // provider or straight at a loopback endpoint. runLocalLlmTest resolves
  // (never throws) for in-stream failures, but can still throw before the
  // stream opens — an unconfigured provider. Catch that into the same result
  // shape so one bad backend records a failed sample instead of aborting the
  // whole assessment with no evidence at all.
  const generate = (prompt, maxTokens, timeoutMs) => {
    const shared = {
      modelId,
      prompt,
      systemPrompt: SAMPLE_SYSTEM_PROMPT,
      temperature: 0,
      maxTokens,
      timeoutMs,
      extraBody: request,
      signal,
      // Ollama's OpenAI-compatible shim frequently omits usage even though the
      // native `/api/chat` final frame reports exact tokenizer counts and
      // eval/prefill durations. Use that transport only for Performance-page
      // evidence; OpenCode remains on its normal provider endpoint.
      nativeOllamaUsage: backend === 'ollama',
    };
    return (endpoint
      ? runEndpointLlmTest({ ...shared, runtime: backend, endpoint, apiKey })
      : runLocalLlmTest({ ...shared, backend })
    ).catch((err) => ({ backend, modelId, text: '', error: err?.message || 'assessment run failed' }));
  };

  let warmup = null;
  if (!signal?.aborted) {
    emit({ event: 'start', sampleIndex: 0, sampleCount: contexts.length, message: `${modelId}: warming up (not measured)…` });
    const result = await generate(WARMUP_PROMPT, WARMUP_MAX_TOKENS, WARMUP_TIMEOUT_MS);
    const timing = (value) => (Number.isFinite(value) ? value : null);
    // A failed warm-up is recorded, not fatal: the measured samples below carry their own errors.
    warmup = { ok: !result?.error, ttftMs: timing(result?.timings?.ttftMs), totalMs: timing(result?.timings?.totalMs), error: result?.error || null };
  }

  const samples = [];
  for (const context of contexts) {
    if (signal?.aborted) break;
    emit({
      event: 'start',
      sampleIndex: samples.length,
      sampleCount: contexts.length,
      contextTokens: context,
      message: `${modelId}: sample ${samples.length + 1}/${contexts.length} at ${context.toLocaleString('en-US')} tokens of context…`,
    });
    const result = await generate(buildSamplePrompt(context), SAMPLE_MAX_TOKENS, SAMPLE_TIMEOUT_MS);

    const sample = toSample(context, result);
    samples.push(sample);
    // Report what the sample actually measured, not just that it finished — a
    // multi-minute run should show throughput accumulating rather than a bar
    // that only moves between contexts.
    emit({
      event: 'start',
      sampleIndex: samples.length,
      sampleCount: contexts.length,
      contextTokens: context,
      sample,
      message: sample.ok
        ? `${modelId}: ${context.toLocaleString('en-US')} tokens → ${sampleRateText(sample)}`
        : `${modelId}: ${context.toLocaleString('en-US')} tokens → failed (${sample.error})`,
    });
    if (!sample.ok && classifySampleFailure(sample)) break;
  }

  const verdict = classifyFitVerdict(samples);
  const assessment = {
    backend,
    modelId,
    // The configuration this reading describes. `{}` / `''` / `null` mean
    // "backend defaults", which is a real answer — the daemon ran with whatever
    // it ships with, and a later default-run compares against it directly.
    tuning: normalizedTuning,
    tuningKey,
    tuningLabel,
    // Whether the tuning actually reached the daemon. `false` with a reason
    // means the numbers below describe SOME OTHER configuration, and the UI has
    // to say so rather than filing them under the requested tuning. `null` means
    // there was nothing for PortOS to apply — backend defaults, or a tuning made
    // entirely of knobs the user set outside PortOS.
    tuningApplied: tuningApplication.applied,
    tuningNotApplied: tuningApplication.applied === false ? tuningApplication.reason : null,
    endpoint,
    params: card?.params ?? null,
    // LM Studio serves one quant per install but reports a repo-level id, so the
    // quant has to be recorded separately for a catalog badge to know WHICH
    // build was measured. `null` on Ollama (its id already carries the tag) and
    // whenever the backend reported none.
    quantization: card?.quantization ?? null,
    // `null` = never measured; LM Studio, vLLM and external daemons legitimately report null.
    // `residentSource` names the reading: 'ollama', 'process-footprint' or 'process-rss'.
    ...(verdict === 'fits' ? await residentMemoryFor(backend, modelId) : { residentGb: null, residentSource: null }),
    // The discarded first request's time (load and warm-up costs), kept apart from `performance`.
    warmup,
    // `benchmark` = the fixed side-by-side profile (repeated warm runs at one context);
    // `context-sweep` = one sample per context size. Both feed the comparison axes.
    profile: benchmark ? 'benchmark' : 'context-sweep',
    benchmark: benchmark ? { ...BENCHMARK_PROFILE } : null,
    assessedAt: new Date().toISOString(),
    environment,
    verdict,
    verdictReason: describeVerdict(verdict, samples),
    samples,
    performance: summarizePerformance(samples),
  };

  // A cancelled run is NOT evidence. `runLocalLlmTest` converts a client
  // disconnect into the same "Timed out after Nms" result a genuine resource
  // failure produces, so persisting here would record a user closing the tab as
  // `does-not-fit` — or, if they cancelled before the first sample landed, as an
  // `unknown` that silently removes the model from the "not yet measured" list.
  // Return the partial record so the caller can show what was gathered, but
  // leave the store untouched.
  if (signal?.aborted) {
    console.log(`📏 Local LLM: ${backend}/${modelId} assessment cancelled — not recorded`);
    // A terminal frame either way, or a listener's banner sits on the last
    // sample forever. `cancelled` is NOT `error` — nothing failed.
    emit({ event: 'complete', cancelled: true, message: `${modelId}: assessment cancelled — nothing recorded` });
    return { ...assessment, cancelled: true };
  }

  console.log(`📏 Local LLM: ${backend}/${modelId} → ${verdict} (${assessment.performance.samplesOk}/${samples.length} samples ok)`);
  emit({
    event: 'complete',
    verdict,
    message: `${modelId}: ${verdict} (${assessment.performance.samplesOk}/${samples.length} samples ok)`,
  });
  return saveAssessment(assessment);
}

/**
 * Everything the UI needs to explain local-model choice, read from disk only.
 *
 * `assessed` / `unassessed` split installed models by whether evidence exists —
 * an unassessed model is NOT ranked and NOT presented as a poor choice; it is
 * presented as unknown, with a button to measure it.
 *
 * @param {{ intent?: string }} [options]
 */
export async function getAssessmentReport({ intent = 'balanced' } = {}) {
  const { assessments: stored, readError } = await loadStore();
  const resolvedIntent = ASSESSMENT_INTENTS.includes(intent) ? intent : 'balanced';

  // Every stored record is compared against the machine as it is NOW. A reading
  // taken before a RAM upgrade or a backend update describes hardware that no
  // longer exists, and nothing else on this page would ever say so — the user
  // would have to remember. This path can afford the backend-version probe (it
  // already lists models from every runtime); the catalog badge path cannot, and
  // uses the free durable-fields comparison instead.
  const liveEnvironments = await captureLiveEnvironments();
  const assessments = stored.map((a) => withStaleness(a, liveEnvironments[a?.backend] || null));

  // One listing per assessable runtime. `models: null` is a FAILED read, never
  // an empty catalog — see `listRuntimeModels`.
  const listed = Object.fromEntries(await Promise.all(
    ASSESSABLE_RUNTIMES.map(async (runtime) => [runtime, await listRuntimeModels(runtime, { durable: false, respectDisabled: true })])
  ));

  const runtimes = ASSESSABLE_RUNTIMES.map((id) => ({
    id,
    label: LOCAL_RUNTIMES[id]?.label || id,
    managed: MANAGED_ASSESSMENT_BACKENDS.includes(id),
    // `null` = the listing failed, so the count is unknown. `0` = it was read
    // and this runtime genuinely serves nothing.
    modelCount: Array.isArray(listed[id].models) ? listed[id].models.length : null,
    error: listed[id].error,
    inactive: listed[id].inactive === true,
    tuningSpecs: tuningSpecsFor(id),
    // The tuning grid a sweep of this runtime would run — literally the same
    // call `localModelAssessmentSweep.js` makes when one starts, so the count
    // and labels the consent gate names cannot differ from what executes. There
    // is deliberately no wire knob that resizes it (see the sweep schema).
    //
    // EMPTY for a runtime a sweep may not drive, so the page offers the action
    // exactly where the server would accept it. Shipping a grid for a runtime
    // PortOS cannot reset and put back would advertise a comparison that reads
    // as valid and is not — see `sweepable` on LAUNCH_APPLIERS and #4763.
    tuningGrid: isTuningSweepable(id) ? tuningGridFor(id) : [],
  }));

  const listErrors = ASSESSABLE_RUNTIMES.filter((id) => listed[id].error && !listed[id].inactive);
  const installedKeys = new Set(
    ASSESSABLE_RUNTIMES.flatMap((runtime) => (listed[runtime].models || []).map((m) => assessmentKey(runtime, m?.id)))
  );

  // A model the user has since deleted must not keep showing up as a
  // recommendation — it cannot run. But only drop it when the runtime's list is
  // TRUSTWORTHY: an unreadable list would otherwise wipe every recommendation
  // for that runtime, which is the same "failed read read as empty" mistake.
  const trusted = new Set(ASSESSABLE_RUNTIMES.filter((id) => Array.isArray(listed[id].models) && !listed[id].error));
  const isStillInstalled = (a) =>
    !trusted.has(a?.backend) || installedKeys.has(assessmentKey(a?.backend, a?.modelId));
  const stillInstalled = assessments.filter(isStillInstalled);
  const uninstalled = assessments
    .filter((a) => !isStillInstalled(a))
    .map((a) => ({ backend: a?.backend || null, modelId: a?.modelId || null, tuningLabel: a?.tuningLabel || null }));

  // A reading taken under a tuning PortOS could NOT apply describes some other
  // configuration entirely. It is kept on disk (the run cost real minutes, and
  // the failed attempt plus its reason is what tells the user why) but it must
  // never be scored AS that tuning: ranking it would recommend a configuration
  // nobody measured, and comparing it would credit the previous config's
  // throughput to the knobs that never reached the daemon.
  const unappliedTuning = stillInstalled.filter((a) => a?.tuningApplied === false);
  const scorable = stillInstalled.filter((a) => a?.tuningApplied !== false);

  const { ranked, excluded } = rankByIntent(scorable, resolvedIntent);
  for (const a of unappliedTuning) {
    excluded.push({
      backend: a?.backend || null,
      modelId: a?.modelId || null,
      tuningKey: a?.tuningKey || '',
      tuningLabel: a?.tuningLabel || null,
      verdict: a?.verdict || 'unknown',
      // `tuningApplied: false` covers two opposite failures, and the row shows a
      // configuration chip beside this sentence. An UNTUNED run's chip already
      // reads "backend defaults", so "the requested tuning was not applied"
      // contradicts it — that run's failure is that the daemon could not be put
      // BACK on defaults. Mirrors `tuningNoticeChip` on the client.
      reason: a?.tuningKey
        ? `measured, but the requested tuning was not applied — ${a?.tuningNotApplied || 'reason not recorded'}`
        : `measured, but the daemon still carried an earlier tuning — ${a?.tuningNotApplied || 'reason not recorded'}`,
    });
  }

  // "Not yet measured" is keyed on the model, NOT on the model+tuning: once one
  // tuning has been measured the model is no longer an unanswered question, and
  // listing it again under every un-run tuning would make the section unbounded.
  const assessedModels = new Set(assessments.map((a) => assessmentKey(a?.backend, a?.modelId)));
  const unassessed = [];
  for (const runtime of ASSESSABLE_RUNTIMES) {
    // An OFFLINE listing came off disk, not from the daemon. Those models are
    // installed but cannot be measured until the runtime is running, so they are
    // not offered here — a Measure button that can only fail is worse than no
    // row. The capability matrix lists them instead, with the fix attached.
    if (listed[runtime].offline) continue;
    for (const model of listed[runtime].models || []) {
      // Embedding-only models are excluded from the MEASURABLE list, not from
      // the runtime's catalog above: they serve `/api/embed`, never
      // `/api/chat`, so the sample this module runs comes back
      // `400 "<model>" does not support chat`. Listing one here would offer a
      // Measure button that cannot produce a measurement, and put it in every
      // sweep scope — where the failed run also fires the provider-failure hook
      // and files a CoS investigation about a model that was never going to
      // generate text (run b361be1a, nomic-embed-text:latest).
      //
      // The model CARD is passed, not the bare id, so a backend that reports
      // what a model can do (Ollama capabilities, LM Studio types) decides it
      // rather than the name heuristic — which is how `all-minilm:latest`, an
      // embedding model naming no `embed` marker at all, got through the
      // id-only form and burned a second measurement.
      if (isEmbeddingModel(model)) continue;
      if (model?.id && !assessedModels.has(assessmentKey(runtime, model.id))) {
        unassessed.push({ backend: runtime, modelId: model.id, params: model.params ?? null });
      }
    }
  }

  return {
    intent: resolvedIntent,
    intents: ASSESSMENT_INTENTS,
    defaultContextTokens: DEFAULT_CONTEXT_TOKENS,
    // The fixed side-by-side benchmark, so its consent gate names the generations that run.
    benchmarkProfile: BENCHMARK_PROFILE,
    assessments,
    unassessed,
    // Every assessable runtime with its label, reachability, and knob catalog —
    // so the UI renders one source of truth instead of a hardcoded backend list.
    runtimes,
    // Which tuning won, per model, for models measured under two or more.
    tuningComparison: compareTunings(scorable),
    // Every measurement as a tokens-per-second table, fastest first, with the
    // per-context readings intact. Unlike `ranked` this is not a recommendation
    // — it is the raw speed answer, which is what you read the morning after a
    // sweep. Built from still-installed records only: a table row for a model
    // that can no longer run is noise.
    throughputReport: buildThroughputReport(stillInstalled),
    // How many measurements each sweep scope would run right now, so the
    // "Measure all" consent gate can name a real number rather than an estimate.
    // Derived from the same selector the sweep uses, so the two cannot disagree.
    sweepScopes: summarizeSweepScopes({ assessments: stillInstalled, unassessed }),
    // Unexpected listing failures. An inactive runtime is not a warning.
    listErrors,
    // Measurements for models that are no longer installed. Kept on disk (a
    // re-install should not cost another run) but excluded from the ranking.
    uninstalled,
    readError,
    ranked,
    excluded,
    // The machine as it is now, so the panel can name the difference rather than
    // just flagging "stale". Keyed by runtime because the backend version is
    // part of what makes a reading stale.
    liveEnvironments,
  };
}

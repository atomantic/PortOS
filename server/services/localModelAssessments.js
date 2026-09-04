/**
 * Measured local-model assessments — the run + durable store.
 *
 * PortOS's existing "does it fit" answer is a size estimate: weight bytes × 1.2
 * against total RAM minus a reserve (`huggingFaceCatalog.js#classifyFit`). It
 * never runs the model, so it cannot distinguish a model that loads and streams
 * comfortably from one that loads, thrashes, and crawls — and it says nothing
 * about how either behaves once the prompt is long.
 *
 * This service closes that gap by actually running the model: one bounded
 * generation per context length, through the SAME provider seam the Local LLM
 * playground uses (`localLlmPlayground.runLocalLlmTest`), recording throughput,
 * time-to-first-token, resident footprint, and the environment the measurement
 * was taken in. `lib/localModelAssessment.js` turns that evidence into a verdict
 * and an intent-specific ranking.
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
 * There is NO scheduler and NO boot hook. Do not add one: a fresh install must be
 * silent on the LLM front until the user asks.
 *
 * `localModelAssessmentSweep.js` measures every installed model in one pass, and
 * is not an exception to that — it runs only from a button press behind a consent
 * gate that names the model and generation count, which is the user asking. What
 * stays forbidden is anything that starts it WITHOUT that press.
 *
 * ## Where the pieces live
 *
 * The durable store, the environment capture, and the privacy/storage contract
 * moved to `localModelAssessmentStore.js` — that module has no path to a
 * provider, so read-only consumers (the catalog fit badge, `localLlm.getStatus`)
 * can import it without importing this one, and without an import cycle through
 * `localLlm.js`.
 */

import {
  ASSESSMENT_INTENTS,
  buildThroughputReport,
  classifyFitVerdict,
  classifySampleFailure,
  rankByIntent,
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
  localRuntimeKind,
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
import { probeOpenAiModels } from '../lib/openAiModelsProbe.js';
import { listProviders } from './providers.js';
import { runEndpointLlmTest, runLocalLlmTest } from './localLlmPlayground.js';
import {
  captureLlamaServerConfig,
  getLlamaServerEndpoint,
  relaunchLlamaServerWithTuning,
  restoreLlamaServerConfig,
} from './llamaServerManager.js';
import { getMtplxServerEndpoint, getMtplxServerStatus, relaunchMtplxServerWithTuning } from './mtplxServerManager.js';
import { getSlotstreamServerEndpoint } from './slotstreamServerManager.js';
import { getSpecDecodePresetStatus } from './specDecodeModels.js';
import { listManagedBackendModels } from './localLlm.js';
import {
  getLoadedModels as getLoadedOllamaModels,
  restartWithEnv as restartOllamaWithEnv,
} from './ollamaManager.js';
import { loadModelWithArgs as loadLmStudioModelWithArgs } from './lmStudioManager.js';

// Re-exported so the store split stays an implementation detail for callers that
// only ever wanted "the assessments feature".
export { captureEnvironment, deleteAssessment, loadAssessments };

const GB = 2 ** 30;

// Nominal context sizes to sample, in approximate tokens. Three points is the
// minimum that shows a TREND rather than a single data point, and the top of
// the range is where a local model typically starts paging. Users can override
// per run; the route caps the list so one request can't turn into a 20-run job.
export const DEFAULT_CONTEXT_TOKENS = [512, 4096, 16384];

// Conventional English chars-per-token ratio, used ONLY to size the filler
// prompt for a requested nominal context. PortOS has no tokenizer, so nothing
// downstream reports a token *measurement* — see the throughput unit note in
// lib/localModelAssessment.js.
const CHARS_PER_TOKEN = 4;

// Each sample generates a short answer: the point is measuring prefill + decode
// at a given context, not producing text. Small and fixed so throughput is
// comparable across models and across context lengths.
const SAMPLE_MAX_TOKENS = 96;

// Per-sample ceiling. A model that cannot answer a trivial question within two
// minutes at this context has, for assessment purposes, failed at it — the
// timeout is recorded as a resource failure and the run moves on to the next
// context rather than hanging the request.
const SAMPLE_TIMEOUT_MS = 120000;

const SAMPLE_SYSTEM_PROMPT =
  'You are being benchmarked. Answer the final question in one short sentence. Do not summarize the reference text.';

// Deterministic filler, generated rather than stored, so a long context costs no
// repository bytes. Distinct numbered lines (not one repeated line) keep a
// backend's prefix cache from making a long prompt look artificially cheap.
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

// ---- runtimes ---------------------------------------------------------------

/**
 * Where this runtime's OpenAI-compatible API actually is right now.
 *
 * The two PM2-managed daemons are the ones that move: PortOS starts llama.cpp
 * and MTPLX, and a user who picked a different port on the LLMs page is serving
 * somewhere the shipped default no longer names. Ask the manager rather than
 * re-deriving the port here — probing the stale default would report a working
 * server as unreachable.
 */
export async function runtimeEndpoint(runtime) {
  // The endpoint-only accessors, NOT the `get*Status` calls — those pay for a
  // network probe and an `execPm2 logs` subprocess, and this path runs on every
  // Performance page load only to learn a port number.
  const resolver = { llama: getLlamaServerEndpoint, mtplx: getMtplxServerEndpoint, slotstream: getSlotstreamServerEndpoint }[runtime];
  if (resolver) {
    const endpoint = await resolver().catch(() => null);
    if (endpoint) return endpoint;
  }
  return LOCAL_RUNTIMES[runtime]?.defaultBaseUrl || null;
}

/**
 * The API key a bare endpoint runtime is served behind, or `''` for the usual
 * unauthenticated loopback daemon.
 *
 * A vLLM container started from the shipped compose stack sets `VLLM_API_KEY`
 * and answers 401 to an unauthenticated request — which `probeOpenAiModels`
 * correctly reports as "reachable, listing unreadable" and a measurement would
 * hit on every sample. `providerReadiness.js` already solves this by reading the
 * key off the matching provider record; this resolves it the same way, keyed on
 * the same `localRuntimeKind` classifier so the two can't disagree about which
 * provider backs which runtime.
 */
export async function runtimeApiKey(runtime) {
  // `listProviders`, not `getAllProviders`: the latter resolves an ENVELOPE
  // (`{ activeProvider, providers }`), so the `Array.isArray` guard this used to
  // carry was never true and every runtime silently resolved to no key — a vLLM
  // behind VLLM_API_KEY then 401'd on every sample.
  const match = (await listProviders())
    .find((p) => localRuntimeKind(p) === runtime && typeof p?.apiKey === 'string' && p.apiKey !== '');
  return match?.apiKey || '';
}

/**
 * Models this runtime can be measured against, plus why the list failed when it
 * did.
 *
 * The two paths differ in what "installed" even means. A managed backend has a
 * durable catalog on disk (`listManagedBackendModels`), so its list survives the daemon being
 * down. An endpoint runtime has no catalog at all — its models are whatever the
 * running process reports from `GET /v1/models`, so a stopped daemon means "no
 * models listable", which is an ERROR, never an empty catalog. Collapsing those
 * would silently hide every model behind a daemon the user just needs to start.
 *
 * @returns {Promise<{models: Array<object>|null, error: string|null}>}
 *   `models: null` means the list could not be read; `[]` means it was read and
 *   is genuinely empty.
 */
/**
 * What PortOS knows is installed for a runtime WITHOUT asking the daemon.
 *
 * An endpoint runtime that is not running reports nothing over HTTP, but the
 * weights are still on disk and PortOS already lists them elsewhere (Models →
 * LLMs). Showing "could not list models" and an empty table hides installed
 * models behind a daemon the user just needs to start.
 *
 * Only consulted when the live probe FAILED, so a healthy install never pays
 * for it. Every other runtime returns `[]` — vLLM and SGLang are containers the
 * user runs themselves, and PortOS holds no catalog for them, which is a real
 * answer rather than a gap to paper over.
 */
export async function durableRuntimeModels(runtime) {
  if (runtime === 'llama') {
    // A preset whose target GGUF is on disk is a model llama.cpp can serve, and
    // the preset id IS the alias PortOS starts it under — so this is the same
    // id a running server would report from /v1/models.
    const presets = await getSpecDecodePresetStatus().catch(() => []);
    return presets
      .filter((preset) => preset?.model?.exists)
      .map((preset) => ({ id: preset.id, params: null, quantization: preset.model.quant ?? null }));
  }
  if (runtime === 'mtplx') {
    const status = await getMtplxServerStatus().catch(() => null);
    return (status?.cachedModels || []).map((id) => ({ id, params: null, quantization: null }));
  }
  return [];
}

export async function listRuntimeModels(runtime) {
  // `listManagedBackendModels` carries the "empty vs unreadable" sentinel for
  // these two backends (both managers cache `[]` on a failed read), so this
  // path and every other consumer of that distinction agree.
  if (MANAGED_ASSESSMENT_BACKENDS.includes(runtime)) return listManagedBackendModels(runtime);

  const endpoint = await runtimeEndpoint(runtime);
  if (!endpoint) return { models: null, error: 'no endpoint is configured for this runtime', offline: true };

  // A daemon that is down is the common case here, and it is FIXABLE — so fall
  // back to what is on disk and mark the listing `offline`, rather than
  // reporting a bare failure that hides installed models. `offline` is what
  // tells a consumer these came from disk: they are installed, but nothing can
  // be run against them until the runtime is started.
  const offlineListing = async (error) => {
    const models = await durableRuntimeModels(runtime).catch(() => []);
    return { models: models.length ? models : null, error, offline: true };
  };

  const probe = await probeOpenAiModels(endpoint, { timeoutMs: 2500, apiKey: await runtimeApiKey(runtime) });
  if (!probe.reachable) return offlineListing(`not reachable at ${endpoint} (${probe.error})`);
  if (!probe.models) return offlineListing(probe.error || 'model listing was not readable');
  // An endpoint runtime reports ids only — no params, no quantization. `null`
  // there is honest: the capability axis simply goes unscored rather than being
  // guessed from the id.
  return { models: probe.models.map((id) => ({ id, params: null, quantization: null })), error: null };
}

// ---- measurement ------------------------------------------------------------

/**
 * Turn one `runLocalLlmTest` result into a recorded sample.
 *
 * The distinction that matters: a run that produced no text is a FAILURE even
 * when `runLocalLlmTest` resolved without an `error` (it resolves rather than
 * throws on timeout). Recording it as a success with `charsPerSecond: 0` would
 * feed a fabricated zero into the speed average.
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
    // Token-denominated throughput, when the daemon reported token counts (see
    // `summarizeTimings`). `null` = the daemon reported none — NOT zero, and not
    // a chars/s figure divided by a guessed chars-per-token ratio, which would
    // dress arithmetic up as a measurement.
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

/** Resident bytes for a model, from Ollama's `/api/ps`. `null` when unknown. */
async function residentGbFor(backend, modelId) {
  // Only Ollama reports a resident size (`/api/ps` → `size`). LM Studio's
  // loaded-model listing carries no footprint, so the honest answer there is
  // `null` — not a size copied from the weight file, which would silently
  // re-introduce the estimate this feature exists to replace.
  if (backend !== 'ollama') return null;
  const loaded = await getLoadedOllamaModels().catch(() => []);
  const match = loaded.find((m) => m?.id === modelId || m?.name === modelId);
  const bytes = match?.size;
  return Number.isFinite(bytes) && bytes > 0 ? Number((bytes / GB).toFixed(2)) : null;
}

// Human-readable reason behind a non-`fits` verdict, or `null` for `fits`.
// Quotes the backend's own error where there is one — a verbatim OOM message is
// far more actionable than a paraphrase.
function describeVerdict(verdict, samples) {
  if (verdict === 'fits') return null;
  const backendError = samples.find((s) => s?.error)?.error || null;
  if (verdict === 'unknown') return backendError || 'no sample produced a usable measurement';
  if (verdict === 'incompatible') return backendError || 'the backend refused this model';
  return backendError || 'every context length tested exhausted this machine';
}

/**
 * Run one model's assessment. **The only LLM-calling entry point in this
 * module** — see the AI Provider Usage Policy note at the top.
 *
 * Samples run sequentially, smallest context first, so a model that dies at the
 * largest size has already recorded its working sizes. A resource failure stops
 * the remaining (larger) contexts: they cannot succeed once a smaller one has
 * exhausted memory, and running them would only burn minutes. An `incompatible`
 * failure stops immediately for the same reason.
 *
 * @param {object} options
 * @param {'ollama'|'lmstudio'|'llama'|'mtplx'|'vllm'} options.backend
 * @param {string} options.modelId
 * @param {number[]} [options.contextTokens] nominal context sizes to sample
 * @param {object} [options.tuning] launch/runtime knobs (`lib/localModelTuning.js`).
 *   Launch knobs are applied where PortOS starts the daemon (llama.cpp); the
 *   rest are recorded so two readings of one model stay comparable. The tuning
 *   is part of the record's identity, so a second tuning of the same model is a
 *   NEW record rather than an overwrite.
 * @param {number} [options.claimTimeoutMs] how long to WAIT for the machine-wide
 *   accelerator claim before giving up. 0 (the default) refuses immediately,
 *   which is right for an interactive click; the sweep waits, so one image
 *   render slipping in between two models does not kill an overnight queue.
 * @param {AbortSignal} [options.signal] client disconnect
 * @param {(frame: object) => void} [options.onProgress] per-sample progress.
 *   A run is minutes long on a large model, so the caller (the route) forwards
 *   these to the `localLlm:progress` socket event the pull/migrate paths already
 *   use. Frames carry `backend` + `modelId` so a listener can tell a frame from
 *   THIS run apart from an unrelated model install streaming on the same event.
 * @returns {Promise<object>} the persisted assessment record
 */
export async function runAssessment({ backend, modelId, contextTokens = DEFAULT_CONTEXT_TOKENS, tuning, resetTuning = false, signal, onProgress, claimTimeoutMs = 0 } = {}) {
  // Refused BEFORE the heavy-job claim and before any provider call: every
  // sample of an embedding-only model comes back `400 "<model>" does not
  // support chat`, and each one raises an AI-provider investigation task for a
  // failure that is fully determined by the model id. `selectSweepTargets`
  // already keeps these out of a sweep; this covers the direct
  // `POST /api/local-llm/assessments/run` route, which never goes through it.
  if (isEmbeddingModel(modelId)) {
    throw new ServerError(
      `${modelId} is an embedding model — it has no chat/generation to measure`,
      { status: 400, code: 'MODEL_NOT_ASSESSABLE', context: { backend, modelId } },
    );
  }
  const contexts = [...new Set(contextTokens)].filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  // The listener runs outside the request lifecycle's error path in some callers
  // (a socket emit can throw on a closed io), and a broken progress consumer must
  // never abort a measurement the user is paying minutes for.
  const emit = (frame) => {
    if (typeof onProgress !== 'function') return;
    try { onProgress({ scope: 'assessment', backend, modelId, ...frame }); }
    catch (err) { console.error(`❌ Local LLM: assessment progress listener failed: ${err.message}`); }
  };
  // Refuse an embedding-only model before anything is claimed or spawned. The
  // report already keeps them out of `unassessed`, so reaching here means a
  // direct API call (or a stale page) — and every path below would spend the
  // accelerator claim on a sample the backend answers with
  // `400 "<model>" does not support chat`. Failing fast with a reason beats
  // recording that as a verdict about the machine.
  if (isEmbeddingModel(modelId)) {
    throw new ServerError(
      `${modelId} is an embedding-only model — it has no chat endpoint to benchmark. Measure a generation model instead.`,
      { status: 400, code: 'MODEL_NOT_ASSESSABLE', context: { backend, modelId } },
    );
  }
  // A measurement is only valid if it had the machine to itself. This is the
  // SAME machine-wide claim local image/video/3D rendering and LoRA training
  // take (`lib/heavyJobClaim.js`), for a stronger reason than theirs: a
  // contending job does not merely slow this run down, it silently changes the
  // number being recorded. It also makes the "one at a time" rule real for every
  // caller — a second browser tab, ⌘K, or curl — rather than resting on a
  // disabled button. Refusing is far better than recording a corrupt reading.
  const claim = await claimHeavyLocalJob({ kind: 'local-model assessment', id: `${backend}/${modelId}`, timeoutMs: claimTimeoutMs });
  if (!claim.ok) {
    throw new ServerError(claim.message, { status: 409, code: 'HEAVY_LOCAL_JOB_BUSY', context: { holder: claim.holder } });
  }
  try {
    // The claim wait is bounded but can be minutes long, and it does not observe
    // the abort signal. A cancel that landed while we waited must not turn into a
    // measurement now that the machine is free — that would relaunch llama-server
    // under the cancelled run's tuning and hold the claim against the sweep that
    // replaced it. Nothing was measured, so nothing is recorded.
    if (signal?.aborted) {
      console.log(`📏 Local LLM: ${backend}/${modelId} cancelled while waiting for the accelerator — not measured`);
      emit({ event: 'complete', cancelled: true, message: `${modelId}: cancelled before it started — nothing recorded` });
      // Same record SHAPE as the mid-run cancel below, so a consumer reads one
      // contract either way — just with nothing in it, because nothing ran.
      // `unknown` is the verdict for "no evidence", which is exactly the case.
      return {
        backend, modelId, cancelled: true, verdict: 'unknown', samples: [],
        performance: summarizePerformance([]),
      };
    }
    return await measureModel({ backend, modelId, contexts, tuning, resetTuning, signal, emit });
  } finally {
    await claim.release();
  }
}

// Every applier reports the same three things — did it take effect, why not,
// and what the daemon is running now — out of a manager result that spells
// success differently (`applied` vs `success`). Normalizing here keeps each
// entry below to the one line that is actually runtime-specific.
//
// `null` is the third state and means "nothing needed to change": the daemon
// already serves the requested configuration. That is NOT a refusal, so it
// carries no reason — recording one would put a "tuning not applied" warning on
// a reading that is perfectly accurate.
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
async function measureModel({ backend, modelId, contexts, tuning, resetTuning, signal, emit }) {
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
    // runLocalLlmTest resolves (never throws) for in-stream failures, but can
    // still throw before the stream opens — an unconfigured provider. Catch that
    // into the same result shape so one bad backend records a failed sample
    // instead of aborting the whole assessment with no evidence at all.
    // Both runners take the same shape, including the request-applied knobs —
    // the ONLY difference is whether the model is reached through a configured
    // provider or straight at a loopback endpoint.
    const shared = {
      modelId,
      prompt: buildSamplePrompt(context),
      systemPrompt: SAMPLE_SYSTEM_PROMPT,
      temperature: 0,
      maxTokens: SAMPLE_MAX_TOKENS,
      timeoutMs: SAMPLE_TIMEOUT_MS,
      extraBody: request,
      signal,
      // Ollama's OpenAI-compatible shim frequently omits usage even though the
      // native `/api/chat` final frame reports exact tokenizer counts and
      // eval/prefill durations. Use that transport only for Performance-page
      // evidence; OpenCode remains on its normal provider endpoint.
      nativeOllamaUsage: backend === 'ollama',
    };
    const result = await (endpoint
      ? runEndpointLlmTest({ ...shared, runtime: backend, endpoint, apiKey })
      : runLocalLlmTest({ ...shared, backend })
    ).catch((err) => ({ backend, modelId, text: '', error: err?.message || 'assessment run failed' }));

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
        ? `${modelId}: ${context.toLocaleString('en-US')} tokens → ${sample.charsPerSecond ?? '?'} chars/s`
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
    // `null` = never measured; the LM Studio path legitimately reports null.
    residentGb: verdict === 'fits' ? await residentGbFor(backend, modelId) : null,
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
    ASSESSABLE_RUNTIMES.map(async (runtime) => [runtime, await listRuntimeModels(runtime)])
  ));

  const runtimes = ASSESSABLE_RUNTIMES.map((id) => ({
    id,
    label: LOCAL_RUNTIMES[id]?.label || id,
    managed: MANAGED_ASSESSMENT_BACKENDS.includes(id),
    // `null` = the listing failed, so the count is unknown. `0` = it was read
    // and this runtime genuinely serves nothing.
    modelCount: Array.isArray(listed[id].models) ? listed[id].models.length : null,
    error: listed[id].error,
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

  const listErrors = ASSESSABLE_RUNTIMES.filter((id) => listed[id].error);
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
    // Runtimes whose model list could not be trusted — distinct from "listed,
    // and legitimately empty".
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

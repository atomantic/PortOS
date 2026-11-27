/**
 * One-click "make this local runtime work" for the provider readiness checklist: install the daemon, start it and
 * confirm the endpoint answers, from the button next to the failing check (`providerReadiness.js` answers WHAT is missing).
 *
 * Every command comes from the fixed table below. No package, URL, port or argument directly from the request reaches a shell word.
 *
 * Three deliberate limits:
 *
 *   - **Weights are never downloaded behind a start.** llama.cpp cannot start without a GGUF path the user chooses, and
 *     no runtime's *model* check is auto-fixed by a start: a multi-gigabyte download is a decision (the Models → Runtimes
 *     page owns it with a picker). `start` runs MTPLX on a checkpoint ALREADY in its cache (`lib/mtplxModels.js`); an
 *     empty or half-pulled cache is a SEPARATE, named action (`pull-start`, "Download the default model & start MTPLX").
 *     Splash and mkserve package a checkpoint with the runtime, so their Install & start buttons name that download.
 *   - **MTPLX's privileged paths are never touched.** The optional `mtplx max --install` fan-control helper (sudo) stays
 *     an operator action outside PortOS. Install and start are delegated to `mtplxServerManager.js`, so a server started
 *     here is the same PM2 process (`portos-mtplx`) the Models → Runtimes page can stop, log and persist.
 *   - **Neither CUDA container is ever provisioned by a Start.** Both start rows bring up an already-prepared compose
 *     project only: no image build/pull, no weight download, no docker/WSL2/NVIDIA-toolkit install. An unprepared project
 *     is refused; for vLLM the checklist then offers the separate "Clone, build & prepare … (~30 GB), then start" action
 *     (same name-the-payload consent as `pull-start`). `install()` still refuses for both: Docker Desktop, the NVIDIA
 *     Container Toolkit and WSL2 are host-level operator decisions. SGLang has no provisioner and also refuses, before
 *     docker, on a card the cookbook publishes no recipe for.
 */

import { LOCAL_RUNTIMES, localEndpointPort } from '../lib/localProviderRuntime.js';
import { expandPageToken } from '../lib/navManifest.js';
import { describeMtplxCache, listMtplxCachedModels } from '../lib/mtplxModels.js';
import { describeMtplxRuntime, resolveMtplxBinary } from '../lib/mtplxRuntime.js';
import { listSlotstreamCachedModels } from '../lib/slotstreamModels.js';
import { probeOpenAiModels } from '../lib/openAiModelsProbe.js';
import { inspectSglangQwenProject, sglangStartBlockedReason } from '../lib/sglangQwenProject.js';
import { ensureSglangProjectDir } from './sglangQwenManager.js';
import { sglangUnsupportedReason } from '../lib/sglangQwenRecipe.js';
import { getCudaCapability } from '../lib/cudaCapability.js';
import { findCommandOnPath } from '../lib/processEnv.js';
import { runStreamingCommand } from '../lib/streamingSpawn.js';
import { installLlamaServer } from './llamaServerManager.js';
import { installMtplx, startMtplxServer, MTPLX_UNSUPPORTED_REASON } from './mtplxServerManager.js';
import { installSlotstream, startSlotstreamServer, SLOTSTREAM_UNSUPPORTED_REASON } from './slotstreamServerManager.js';
import { isMtplxRepoId, previewMtplxPull, registerMtplxDownload } from './mtplxModelManager.js';
import { MANAGED_RUNTIME_APPS } from '../lib/managedRuntimeApps.js';
import { syncRuntimeProviderModels } from './localRuntimeProviderSync.js';
import { assertDownloadFits } from '../lib/downloadPreflight.js';
import { controlOllamaServer, installBackend } from './localLlm.js';
import { detectRuntimeInstallation } from './localRuntimeInstallation.js';
import { provisionVllmQwenProject, readVllmQwenSetupState, startVllmQwenProject } from './vllmQwenManager.js';

/** A short command that only asks a running daemon to do something. */
const CONTROL_TIMEOUT_MS = 60 * 1000;

/** A model pull moves tens of gigabytes: sized for a slow line, since a bound that kills a download at 90% is worse than none. */
const WEIGHTS_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/** Split downloader output on bare `\r` too so a tqdm-style redrawing bar surfaces each redraw (`lib/streamLines.js`). */
const PROGRESS_SPLIT_RE = /[\r\n]+/;

/** How long a start step waits for a just-started daemon to answer; sized for a cold multi-gigabyte model load. */
const START_TIMEOUT_MS = 3 * 60 * 1000;

/** Bound on `GET /v1/models` probes: loopback answers in ms; the wider bound is for the FINAL confirmation, where a daemon
 * that just finished loading a model can be slow to answer its first request. */
const PROBE_TIMEOUT_MS = 2_000;
const CONFIRM_TIMEOUT_MS = 5_000;

/**
 * Why an installed MTPLX still cannot be started: weights stay the user's decision (`docs/features/local-llm-runtimes.md`), so a plain
 * Start names the button that fetches them plus the in-app card for a non-default checkpoint.
 */
const MTPLX_NO_MODEL_ERROR = expandPageToken('no model weights are cached, so its server exits before it binds a port. Close this window — the checklist now offers “Download the default model & start MTPLX”, which fetches MTPLX\'s own verified checkpoint (a multi-gigabyte download) and then starts the server. To use a different MTP checkpoint instead, search for one on the MTPLX card in {page}, download it there, then click Start MTPLX again.', LOCAL_RUNTIMES.mtplx);

/** The same dead end, reached from a cache holding only interrupted pulls. */
const mtplxPartialCacheError = (count) =>
  expandPageToken(`its cache holds ${count} model${count === 1 ? '' : 's'}, but none passed its own file check — an interrupted download leaves a partial pack behind. Use “Download the default model & start MTPLX” on the checklist to re-fetch it, or pick another checkpoint on the MTPLX card in {page}.`, LOCAL_RUNTIMES.mtplx);

/**
 * MTPLX's cache state, read WITHOUT invoking `mtplx`'s Homebrew wrapper before its Python runtime exists: spawning it then
 * IS a several-hundred-megabyte pip install (`lib/mtplxRuntime.js`), and the checklist polls this. A runtime that is not
 * bootstrapped reports `unknown` (not `empty`: the cache could not be read); a start attempted anyway is refused by
 * `startMtplxServer` with `MTPLX_RUNTIME_NOT_BOOTSTRAPPED`.
 */
async function readMtplxCacheState() {
  const runtime = await describeMtplxRuntime(resolveMtplxBinary());
  if (!runtime.ready) {
    return { state: 'unknown', model: null, count: 0, error: 'MTPLX\'s Python runtime has not been downloaded yet' };
  }
  return describeMtplxCache(await listMtplxCachedModels());
}

/** The static `platforms` gate's refusal is read from the recipe module so it cannot drift from the runtime refusal. */
const SGLANG_PLATFORM_UNSUPPORTED_REASON = sglangUnsupportedReason({ platform: 'darwin' });

/**
 * The provisioning actions: those whose click IS the consent, because each spends gigabytes of bandwidth. A row owns at
 * most ONE, declared as `row.provision = { action, run }`, offered by `describeRuntimeSetup` only when that runtime's own
 * offline read proves a plain Start cannot work. One entry holds everything reported so label and progress lines agree.
 */
const PROVISION_STEPS = Object.freeze({
  'pull-start': Object.freeze({
    // Names the download so the click IS the consent.
    label: (label) => `Download the default model & start ${label}`,
    begun: (label) => `${label} is already installed — downloading its default checkpoint before starting it.`,
    refused: (label) => `PortOS cannot download model weights for ${label}.`,
    failed: (label, error) => `${label} model download failed: ${error}`,
    done: (label) => `${label}'s default checkpoint is cached.`,
    cancelled: 'Cancelled after the download — the weights are cached, but nothing was started.',
  }),
  'provision-start': Object.freeze({
    // Payload named before the click: a ~9.5 GB image built on this host plus ~20 GB of weights. `install()` still refuses.
    label: (label) => `Clone, build & prepare ${label} (~30 GB), then start`,
    begun: (label) => `Docker is installed — preparing ${label}'s compose project before starting it.`,
    refused: (label) => `PortOS cannot provision a compose project for ${label}.`,
    failed: (label, error) => `${label} provisioning failed: ${error}`,
    done: (label) => `${label}'s compose project is built and prepared.`,
    cancelled: 'Cancelled after the prepare step — the project is ready, but nothing was started.',
  }),
});

/**
 * What each action DOES and what it is called on the button. Capabilities are declared rather than inferred from the
 * action name (a substring check broke on `provision-start`), so a new action must answer the three axes and
 * `describeRuntimeSetup` can hand the client `provisions` instead of the client re-deriving it.
 */
const ACTION_CAPABILITIES = Object.freeze({
  install: Object.freeze({ label: (label) => `Install ${label}`, installs: true, starts: false, provisions: false }),
  start: Object.freeze({ label: (label) => `Start ${label}`, installs: false, starts: true, provisions: false }),
  'install-start': Object.freeze({ label: (label) => `Install & start ${label}`, installs: true, starts: true, provisions: false }),
  ...Object.fromEntries(Object.entries(PROVISION_STEPS).map(([action, step]) => [
    action,
    Object.freeze({ label: step.label, installs: false, starts: true, provisions: true }),
  ])),
});

/** Every action `runLocalRuntimeSetup` accepts — route validation reads this. */
export const SETUP_ACTIONS = Object.freeze(Object.keys(ACTION_CAPABILITIES));

/** Does this action cover `installs` / `starts` / `provisions`? Exported so `providerReadiness.js` points each unmet check at the fixing button by asking THIS table. */
export const actionCovers = (action, capability) => ACTION_CAPABILITIES[action]?.[capability] === true;

/**
 * The provisioning action a row owns, or `null`. A row declares BOTH halves or neither: an implicit `pull-start` default
 * would mislabel a non-download step as "Download the default model & start X".
 */
const rowProvisionAction = (row) => row?.provision?.action || null;

/** Fetch MTPLX's OWN default verified checkpoint (no repo id from the request, so it cannot be pointed at an arbitrary download); runs only for `pull-start`. */
async function pullMtplxDefaultCheckpoint({ emit, isCancelled }) {
  const binary = resolveMtplxBinary();
  if (!binary) return { success: false, error: 'MTPLX was not found. Install it from the Local Runtime Servers card, then try again.' };
  // Same disk-space guard as the Models → Runtimes MTPLX card (shared previewMtplxPull cache path). A refusal throws; the
  // SSE route treats a throw from this step as a clean `{success:false}`.
  assertDownloadFits(await previewMtplxPull({}));
  emit('Downloading MTPLX\'s default verified checkpoint. This is a multi-gigabyte download and can take a long while — leave this window open to watch it.');
  // `mtplx pull` redraws one line with a bare `\r`, so split on it. `isCancelled` is load-bearing: this step can run for HOURS
  // while the route holds its single-setup lock, so closing the modal must stop the download.
  let checkpoint = null;
  const result = await runStreamingCommand(binary, ['pull'], (line) => {
    // MTPLX's plain-text pull summary names the resolved Hugging Face repo.
    const repoId = line.startsWith('model: ') ? line.slice(7) : null;
    if (isMtplxRepoId(repoId)) checkpoint = repoId;
    emit(line);
  }, { timeoutMs: WEIGHTS_TIMEOUT_MS, splitRe: PROGRESS_SPLIT_RE, isCancelled });
  if (result.success) await registerMtplxDownload(checkpoint);
  return result;
}

async function runManagedStep(run, { emit, isCancelled }, onProgress = emit) {
  if (isCancelled()) return { success: false, error: 'Setup was cancelled.' };
  try {
    return await run({ onProgress });
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * One row per local runtime PortOS can set up. `platforms` is the HARD gate (empty/absent = every platform). `install` and
 * `start` are async steps taking `({ emit, endpoint, isCancelled })` returning `{ success, error?, note? }`; `start: null`
 * means PortOS cannot start it unattended. `provision: { action, run }` is the optional gigabyte-spending step (`action`
 * names its PROVISION_STEPS entry; `run` takes `({ emit, isCancelled })`). Multi-step work belongs in a manager module.
 */
const SETUP_ROWS = Object.freeze({
  mtplx: Object.freeze({
    platforms: ['darwin'],
    unsupportedReason: MTPLX_UNSUPPORTED_REASON,
    async install({ emit }) {
      // Same install `mtplxServerManager` runs from the Models → Runtimes card:
      // the private hash-locked native Python runtime. It never runs the
      // optional privileged fan-control helper.
      const result = await installMtplx({ onProgress: (p) => { if (p?.message) emit(p.message); } })
        .catch((err) => ({ success: false, error: err.message }));
      return result;
    },
    /** MTPLX's own cache contents WITHOUT starting it (`mtplx models --json` is a local directory listing); read by `providerReadiness.js` via `readRuntimeWeights`. */
    async weights() {
      return (await readMtplxCacheState()).state;
    },
    provision: Object.freeze({
      action: 'pull-start',
      async run({ emit, isCancelled }) {
        return pullMtplxDefaultCheckpoint({ emit, isCancelled });
      },
    }),
    async start({ emit, endpoint, isCancelled }) {
      // `mtplx serve` defaults `--model` to ONE hard-coded checkpoint and exits 1 before binding when it is not cached, even if
      // another MTP model is. Ask the cache first and name what is there; read HERE (not in the manager) because refusals differ by
      // surface: this checklist can offer `pull-start`, the Models → Runtimes launcher names `mtplx pull`.
      const cache = await readMtplxCacheState();
      if (cache.state === 'unknown') {
        // The cache could not be READ (not "read, and empty"): fall through to MTPLX's own default.
        emit(`Could not read MTPLX's model cache (${cache.error}) — starting with its default model.`);
      }
      if (cache.state === 'empty') return { success: false, error: MTPLX_NO_MODEL_ERROR };
      if (cache.state === 'partial') return { success: false, error: mtplxPartialCacheError(cache.count) };
      // The manager emits "Serving the cached MTPLX model …" itself. The cache lookup is an awaited subprocess and the modal can
      // close while it runs, so re-check cancellation here or a cancelled setup still starts an unwanted server.
      if (isCancelled()) return { success: false, error: 'Cancelled before the server was started.' };
      // Delegated to the PM2-backed manager so the server is the SAME managed process the LLMs page can stop/log/persist; the
      // resolved checkpoint rides along so the manager does not walk the cache twice.
      const port = Number(localEndpointPort(endpoint)) || undefined;
      // The contract is "the endpoint answers when the button finishes", so this buys the full cold-model-load budget.
      return startMtplxServer({ port, model: cache.model, waitMs: START_TIMEOUT_MS, onProgress: emit })
        .then(() => ({ success: true }))
        .catch((err) => ({ success: false, error: err.message }));
    },
  }),

  slotstream: Object.freeze({
    platforms: ['darwin'],
    unsupportedReason: SLOTSTREAM_UNSUPPORTED_REASON,
    async install({ emit }) {
      return installSlotstream({ onProgress: (p) => { if (p?.message) emit(p.message); } })
        .catch((err) => ({ success: false, error: err.message }));
    },
    /**
     * Slotstream's cache contents WITHOUT starting it (a directory walk). No `provision` row: PortOS does not fetch weights for
     * it, so an empty cache is reported, not offered a download. Without this row `readRuntimeWeights('slotstream')` says
     * `'unknown'` and a stopped Slotstream reads as a valid idle state, pointing at a start that cannot succeed.
     */
    async weights() {
      const cache = await listSlotstreamCachedModels();
      if (cache.models === null) return 'unknown';
      return cache.models.length > 0 ? 'ready' : 'empty';
    },
    async start({ emit, endpoint, isCancelled }) {
      if (isCancelled()) return { success: false, error: 'Cancelled before the server was started.' };
      const port = Number(localEndpointPort(endpoint)) || undefined;
      return startSlotstreamServer({ port, waitMs: START_TIMEOUT_MS, onProgress: emit })
        .then(() => ({ success: true }))
        .catch((err) => ({ success: false, error: err.message }));
    },
  }),

  splash: Object.freeze({
    installDownload: 'Inkling 2 Mini (~17 GB)',
    async hostBlock() {
      const { supportsManagedSplash, SPLASH_UNSUPPORTED_REASON } = await import('./splashManagedRuntime.js');
      return await supportsManagedSplash() ? null : SPLASH_UNSUPPORTED_REASON;
    },
    async install(ctx) {
      const { installSplashRuntime } = await import('./splashServerManager.js');
      return runManagedStep(installSplashRuntime, ctx);
    },
    async start(ctx) {
      const { startSplashServer } = await import('./splashServerManager.js');
      return runManagedStep(startSplashServer, ctx);
    },
  }),

  mkserve: Object.freeze({
    installDownload: 'Inkling 2 Mini (~19 GiB)',
    async hostBlock() {
      const { supportsMkserve, MKSERVE_UNSUPPORTED_REASON } = await import('./mkserveRuntimeManager.js');
      return supportsMkserve() ? null : MKSERVE_UNSUPPORTED_REASON;
    },
    async install(ctx) {
      const { installMkserve } = await import('./mkserveRuntimeManager.js');
      return runManagedStep(installMkserve, ctx, ({ message }) => ctx.emit(message));
    },
    async start(ctx) {
      const { startMkserveServer } = await import('./mkserveRuntimeManager.js');
      return runManagedStep(startMkserveServer, ctx, ({ message }) => ctx.emit(message));
    },
  }),

  vllm: Object.freeze({
    // CUDA + Marlin + FlashInfer in a Linux container; macOS has no card and DFlash 2 on Apple Silicon is unproven here.
    platforms: ['linux', 'win32'],
    unsupportedReason: 'The vLLM Qwen3.8-27B stack needs an NVIDIA GPU (RTX 3090) and a Linux container runtime. On Apple Silicon use the MTPLX or llama.cpp DSpark presets instead.',
    async install() {
      // Never installs: Docker Desktop / NVIDIA toolkit / WSL2 are host-level operator decisions and the payload is ~9.5 GB.
      return {
        success: false,
        error: 'PortOS does not install this stack. On the RTX 3090 host, set up WSL2 (or Linux) with Docker and the NVIDIA Container Toolkit — then the checklist can clone, build and prepare the compose project for you (see docs/features/local-llm-runtimes.md#vllm-on-rtx-3090).',
      };
    },
    // On-disk state in the four-state vocabulary; `'empty'` makes the checklist offer `provision-start`, which `vllmProjectSetupState` reports only where cloning/building IS the fix.
    weights: readVllmQwenSetupState,
    // This row's gigabyte-spending step is a compose provisioning run, not a
    // model download — hence its own PROVISION_STEPS entry.
    provision: Object.freeze({ action: 'provision-start', run: provisionVllmQwenProject }),
    start: startVllmQwenProject,
  }),

  sglang: Object.freeze({
    // Same posture as vLLM, but the hardware gate is narrower: the cookbook has single-GPU cells for Hopper and Blackwell only (an
    // Ampere 24 GB card keeps the vLLM stack). `sglangUnsupportedReason` says which case, never collapsing a wedged `nvidia-smi` into "no GPU".
    platforms: ['linux', 'win32'],
    unsupportedReason: SGLANG_PLATFORM_UNSUPPORTED_REASON,
    async install() {
      // Never installs, same reasons as vLLM (host-level operator decisions).
      return {
        success: false,
        error: 'PortOS does not install this stack. On the Hopper or Blackwell host, set up Docker with the NVIDIA Container Toolkit, then follow docs/features/local-llm-runtimes.md#sglang-on-hopper-or-blackwell — it carries the compose file (with the verified launch line) and the one-time weight download.',
      };
    },
    async start({ emit, isCancelled }) {
      // Refuse before docker on a card with no recipe so it never reaches a `docker compose up` that pulls the image.
      const cuda = await getCudaCapability().catch(() => null);
      const unsupported = sglangUnsupportedReason({ status: cuda?.status, gpus: cuda?.gpus });
      if (unsupported) return { success: false, error: unsupported };
      // Before the inspection: on Windows this decides WHICH directory is inspected (the project is prepared inside a WSL2
      // distro; the default `%USERPROFILE%\sglang-qwen38` would be found empty).
      const misplaced = await ensureSglangProjectDir({ emit });
      if (misplaced) return { success: false, error: misplaced };
      // Only ever brings up an ALREADY-prepared project — see
      // `lib/sglangQwenProject.js` for why each refusal exists.
      const project = await inspectSglangQwenProject();
      const blocked = sglangStartBlockedReason(project);
      if (blocked) return { success: false, error: blocked };
      if (isCancelled()) return { success: false, error: 'Cancelled before the container was started.' };
      emit(`Starting the SGLang container from ${project.dir} (${project.composeFile}).`);
      emit('The image and weights are already on disk — this only brings the service up.');
      return runStreamingCommand(
        'docker',
        ['compose', 'up', '-d'],
        emit,
        { timeoutMs: CONTROL_TIMEOUT_MS, cwd: project.dir },
      );
    },
  }),

  ollama: Object.freeze({
    async install({ emit }) {
      // `installBackend` registers the Homebrew service / runs the vendor script on Linux and starts the daemon, covering both steps.
      const result = await installBackend('ollama', (p) => { if (p?.message) emit(p.message); });
      return result.success ? { success: true, note: result.note } : result;
    },
    async start({ emit }) {
      emit('Starting the Ollama server…');
      const result = await controlOllamaServer('start');
      return result?.success ? { success: true } : { success: false, error: result?.error || 'Ollama did not start.' };
    },
  }),

  lmstudio: Object.freeze({
    async install({ emit }) {
      const result = await installBackend('lmstudio', (p) => { if (p?.message) emit(p.message); });
      return result.success ? { success: true, note: result.note } : result;
    },
    async start({ emit }) {
      // `lms` is the CLI shim installed by `lms bootstrap` from the app; without it there is no headless start.
      if (!findCommandOnPath('lms')) {
        return { success: false, error: 'LM Studio\'s `lms` CLI is not on PortOS\'s PATH. Open LM Studio once and run `lms bootstrap`, or start its local server from the app\'s Developer tab.' };
      }
      emit('Starting the LM Studio local server…');
      return runStreamingCommand('lms', ['server', 'start'], emit, { timeoutMs: CONTROL_TIMEOUT_MS });
    },
  }),

  llama: Object.freeze({
    async install({ emit }) {
      const result = await installLlamaServer({ onProgress: (p) => { if (p?.message) emit(p.message); } })
        .catch((err) => ({ success: false, error: err.message }));
      return result.success
        ? { success: true, note: expandPageToken('Choose a GGUF model on {page} to start llama-server — PortOS does not pick weights for you.', LOCAL_RUNTIMES.llama) }
        : result;
    },
    // llama-server needs a model path and weights are a separate multi-gigabyte download, so the Models → Runtimes page keeps that step.
    start: null,
  }),
});

/**
 * What a runtime's own model cache holds, without starting it; `'unknown'` when PortOS cannot read one offline (never `'empty'`,
 * which would claim a fact it lacks). Exported so `providerReadiness.js` and `describeRuntimeSetup` share one reader table.
 *
 * @returns {Promise<'unknown'|'empty'|'partial'|'ready'>}
 */
export async function readRuntimeWeights(kind) {
  const row = SETUP_ROWS[kind];
  // A platform that cannot run the runtime discards this answer, and the read is not free (vLLM's walks candidate cache roots,
  // ~a dozen syscalls over a 9p share on Windows); without this gate a Mac would sweep for an RTX 3090 project every minute.
  if (!row?.weights || !platformSupported(row)) return 'unknown';
  return row.weights();
}

/** The cache states that make a start impossible. */
export const weightsBlockStart = (weights) => weights === 'empty' || weights === 'partial';

/** True when this host can run the runtime's setup at all. */
function platformSupported(row) {
  return !row.platforms || row.platforms.includes(process.platform);
}

/** Managed Splash and mkserve always bind the shipped loopback endpoint. */
export async function runtimeSetupBlockedReason(runtime) {
  const row = SETUP_ROWS[runtime.kind];
  if (!row?.hostBlock) return null;
  const endpoint = runtime.endpoint.replace('http://localhost:', 'http://127.0.0.1:');
  if (endpoint !== runtime.defaultBaseUrl) {
    return `The managed ${runtime.label} server listens at ${runtime.defaultBaseUrl}. Use that endpoint to start it here.`;
  }
  return row.hostBlock();
}

/**
 * What (if anything) a "set this up for me" button should offer for one runtime. Pure: the client renders it straight from
 * the readiness payload. Returns `null` when there is nothing to offer (unknown runtime, unsupported platform, already
 * installed and running, or installable-but-not-startable and already installed).
 *
 * `weights` is what the caller learned about the local model cache; only `'empty'`/`'partial'` change the answer (a Start
 * CANNOT work, so the button becomes the download). `'unknown'` keeps the default: an unreadable cache is not an empty one.
 *
 * @param {string} kind - a key in SETUP_ROWS
 * @param {{installed: boolean, running: boolean, weights?: 'unknown'|'empty'|'partial'|'ready', blockedReason?: string|null}} state
 */
export function describeRuntimeSetup(kind, { installed, running, weights = 'unknown', blockedReason = null }) {
  const row = SETUP_ROWS[kind];
  const runtime = LOCAL_RUNTIMES[kind];
  if (!row || !runtime) return null;

  const needsInstall = !installed;
  const needsStart = !running && Boolean(row.start);
  if (!needsInstall && !needsStart) return null;

  blockedReason ||= platformSupported(row) ? null : row.unsupportedReason;
  if (blockedReason) {
    return { runtime: kind, label: runtime.label, action: null, actionLabel: null, provisions: false, blockedReason };
  }

  // Only offered once the binary is here: the cache cannot be read without it, so `install-start` stays the first step.
  const provision = rowProvisionAction(row);
  const needsWeights = Boolean(provision) && !needsInstall && needsStart && weightsBlockStart(weights);
  const action = needsWeights ? provision
    : needsInstall && needsStart ? 'install-start'
      : needsInstall ? 'install' : 'start';
  const download = needsInstall && row.installDownload;
  const actionLabel = download
    ? `Install & start ${runtime.label} with ${download}`
    : ACTION_CAPABILITIES[action].label(runtime.label);
  return {
    runtime: kind,
    label: runtime.label,
    action,
    actionLabel,
    // Whether this click spends gigabytes, answered HERE so the client needn't mirror it by action name.
    provisions: Boolean(download) || actionCovers(action, 'provisions'),
    blockedReason: null,
  };
}

/**
 * Install and/or start one local runtime, reporting progress line by line. Re-probes the endpoint first (the user may have
 * started the daemon since the last poll; an install over a working setup is the outcome to avoid). Never throws: the caller
 * is an SSE route with headers already flushed, so failures return as a value.
 *
 * @param {string} kind
 * @param {{endpoint: string, emit: (line: string) => void, isCancelled?: () => boolean, action?: string}} ctx
 *   `isCancelled` is checked between steps so a closed modal doesn't start a daemon nobody watches. `action` is the one the
 *   button named. `io` lets the post-start provider-model refresh announce `providers:changed`. A PROVISION_STEPS action
 *   adds a separate provisioning step. Splash and mkserve require an explicit install action for their bundled checkpoint.
 *   Omit the action (`null`) to resolve other steps from the current state.
 * @returns {Promise<{success: boolean, error?: string, message?: string}>}
 */
export async function runLocalRuntimeSetup(kind, { endpoint, emit = () => {}, isCancelled = () => false, action = null, io = null }) {
  const row = SETUP_ROWS[kind];
  const runtime = LOCAL_RUNTIMES[kind];
  if (!row || !runtime) return { success: false, error: `PortOS has no automatic setup for \`${String(kind)}\`.` };

  // Probe BEFORE the platform gate: an already-answering daemon is running whatever the platform, and the gate is about what
  // PortOS may INSTALL.
  const target = endpoint || runtime.defaultBaseUrl;
  const probe = await probeOpenAiModels(target, { timeoutMs: PROBE_TIMEOUT_MS });
  if (probe.reachable) {
    return { success: true, message: `${runtime.label} is already running at ${target} — nothing to do.` };
  }
  if (!platformSupported(row)) return { success: false, error: row.unsupportedReason };
  const blockedReason = await runtimeSetupBlockedReason({ ...runtime, kind, endpoint: target });
  if (blockedReason) return { success: false, error: blockedReason };

  const provision = rowProvisionAction(row);

  // Refuse a step this runtime lacks BEFORE installing (a `pull-start` at Ollama would run its install first; llama.cpp `start: null`
  // would report install success without refusing). Compared by ACTION: vLLM owns `provision-start`, so `pull-start` is wrong for it too.
  if (actionCovers(action, 'provisions') && action !== provision) {
    return { success: false, error: PROVISION_STEPS[action].refused(runtime.label) };
  }

  const installed = Boolean(await detectRuntimeInstallation(kind));
  if (!installed && row.installDownload && !actionCovers(action, 'installs')) {
    return { success: false, error: `Choose Install & start ${runtime.label} to download ${row.installDownload}.` };
  }

  // For runtimes with a separate provisioning step, a request naming NO action can come from a stale client (`client/dist` not rebuilt, or a tab open across an upgrade) that still
  // renders this server's `setup.actionLabel`; defaulting to a plain start would hit the "no model weights are cached" dead end
  // for a click on "Download the default model & start MTPLX". So resolve what the checklist offers. `installed &&` mirrors
  // `describeRuntimeSetup`: an uninstalled runtime never resolves to a download or spends a cache read.
  const resolved = action || (provision && installed && weightsBlockStart(await row.weights()) ? provision : 'install-start');

  if (!installed) {
    const result = await row.install({ emit, endpoint: target, isCancelled });
    if (!result.success) return { success: false, error: `${runtime.label} install failed: ${result.error}` };
    emit(`${runtime.label} is installed.`);
    if (result.note) emit(result.note);
  } else {
    // A plain "already installed — starting it" would misreport a provisioning click, making later clone/download lines read as start failures.
    emit(resolved === provision
      ? PROVISION_STEPS[provision].begun(runtime.label)
      : `${runtime.label} is already installed — starting it.`);
  }

  if (!row.start) {
    return { success: true, message: expandPageToken(`${runtime.label} is installed. Pick a model on {page} to start it.`, runtime) };
  }
  if (isCancelled()) return { success: false, error: 'Cancelled after the install — nothing was started.' };

  // Explicit opt-in for a separate provisioning step. The offline read offers it when a plain Start would exit before binding.
  if (resolved === provision) {
    const step = PROVISION_STEPS[provision];
    const pulled = await row.provision.run({ emit, isCancelled });
    if (!pulled.success) return { success: false, error: step.failed(runtime.label, pulled.error) };
    emit(step.done(runtime.label));
    if (isCancelled()) return { success: false, error: step.cancelled };
  }

  // The install step may have started it (Ollama's Homebrew service does), so
  // re-probe rather than launching a second copy onto the same port.
  const afterInstall = await probeOpenAiModels(target, { timeoutMs: PROBE_TIMEOUT_MS });
  if (!afterInstall.reachable) {
    const started = await row.start({ emit, endpoint: target, isCancelled });
    if (!started.success) return { success: false, error: `${runtime.label} did not start: ${started.error}` };
  }

  const final = await probeOpenAiModels(target, { timeoutMs: CONFIRM_TIMEOUT_MS });
  if (!final.reachable) {
    return { success: false, error: `${runtime.label} was set up, but ${target} still does not answer${final.error ? ` (${final.error})` : ''}.` };
  }
  // The one-click start is the same user action as the Runtimes card's Start: presets fronting a managed runtime pick up what it now serves.
  // Never awaited; the endpoint answered, so no readiness wait. Ollama/LM Studio refresh through their own install/delete sync.
  if (kind in MANAGED_RUNTIME_APPS) void syncRuntimeProviderModels({ kind, io });
  const served = Array.isArray(final.models) && final.models.length > 0
    ? ` It is serving ${final.models.slice(0, 3).join(', ')}${final.models.length > 3 ? ` +${final.models.length - 3} more` : ''}.`
    : '';
  return { success: true, message: `${runtime.label} is running at ${target}.${served}` };
}

/** The runtime kinds this module can set up — used by route validation and tests. */
export const SETUP_RUNTIME_KINDS = Object.freeze(Object.keys(SETUP_ROWS));

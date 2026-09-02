/**
 * One-click "make this local runtime work" for the provider readiness checklist.
 *
 * `providerReadiness.js` answers WHAT is missing (the daemon isn't installed,
 * isn't running, isn't serving the right model). Until this module existed, the
 * answer to "so fix it" was a link — to the Models → LLMs page for the two
 * backends PortOS manages, and to the vendor's README for MTPLX, which is a
 * dead end inside PortOS: the user leaves the app, reads a setup doc, runs two
 * commands in a terminal, comes back and reloads. This module makes the
 * checklist actionable in place: install the daemon, start it, and confirm the
 * endpoint answers — from the button next to the failing check.
 *
 * Every command here comes from the fixed table below. A request names a
 * runtime *kind* (`mtplx` / `llama` / `ollama` / `lmstudio` / `vllm` / `sglang`)
 * and nothing else —
 * no package, URL, port, or argument from the request ever reaches a shell
 * word, which keeps this as narrow as `providerRuntimeInstaller.js`'s CLI
 * install surface while removing the docs dead end.
 *
 * Three deliberate limits, because guessing here would be worse than a link:
 *
 *   - **Weights are never downloaded behind a start.** llama.cpp cannot be
 *     started without a GGUF path the user chooses, and no runtime's *model*
 *     check is auto-fixed by a start — a multi-gigabyte download is a decision,
 *     and the Models → LLMs page already owns that flow with a picker. `start`
 *     runs MTPLX on a checkpoint ALREADY in its cache (`lib/mtplxModels.js`).
 *     A cache that is empty (or holds only a half-finished pull) is a SEPARATE
 *     action the user clicks by name — `pull-start`, "Download the default
 *     model & start MTPLX" — never something a Start button does silently.
 *     Before that action existed the checklist offered only Start, which then
 *     failed with "no model weights are cached": the one fact that mattered was
 *     reachable only by clicking the button it made impossible.
 *   - **MTPLX's privileged paths are never touched.** Upstream ships an
 *     optional `mtplx max --install` fan-control helper behind a sudo prompt.
 *     PortOS installs the package and starts the loopback API server; that
 *     helper stays an explicit operator action outside PortOS, exactly as
 *     `docs/features/mtplx.md` promised before this button existed. Both of
 *     those steps are delegated to `mtplxServerManager.js`, so a server started
 *     here is the same PM2 process (`portos-mtplx`) the Models → LLMs page can
 *     stop, log, and persist across a reboot — the two surfaces cannot drift
 *     onto different install commands or a daemon only one of them can see.
 *   - **Neither CUDA container is ever provisioned by a Start.** Both start rows
 *     bring up an already-prepared compose project and nothing else: no image
 *     build or pull, no weight download, no docker/WSL2/NVIDIA-toolkit install.
 *     A project that is not demonstrably prepared is refused — and, for vLLM
 *     since #4767, the checklist then offers the separate action that DOES
 *     provision it, "Clone, build & prepare … (~30 GB), then start", which is
 *     the same name-the-payload consent shape as MTPLX's `pull-start`.
 *     `install()` still refuses for both: Docker Desktop, the NVIDIA Container
 *     Toolkit and WSL2 are host-level operator decisions with driver
 *     requirements PortOS cannot judge, and that action provisions the PROJECT
 *     on a host already capable of running it. SGLang has no such action — it
 *     ships no provisioner of its own yet — and additionally refuses on a card
 *     the cookbook publishes no recipe for, BEFORE it would reach docker.
 */

import { LOCAL_RUNTIMES, localEndpointPort } from '../lib/localProviderRuntime.js';
import { describeMtplxCache, listMtplxCachedModels } from '../lib/mtplxModels.js';
import { describeMtplxRuntime } from '../lib/mtplxRuntime.js';
import { listSlotstreamCachedModels } from '../lib/slotstreamModels.js';
import { probeOpenAiModels } from '../lib/openAiModelsProbe.js';
import { inspectSglangQwenProject, sglangStartBlockedReason } from '../lib/sglangQwenProject.js';
import { sglangUnsupportedReason } from '../lib/sglangQwenRecipe.js';
import { getCudaCapability } from '../lib/cudaCapability.js';
import { findCommandOnPath } from '../lib/processEnv.js';
import { runStreamingCommand } from '../lib/streamingSpawn.js';
import { installLlamaServer } from './llamaServerManager.js';
import { installMtplx, startMtplxServer, MTPLX_UNSUPPORTED_REASON } from './mtplxServerManager.js';
import { installSlotstream, startSlotstreamServer, SLOTSTREAM_UNSUPPORTED_REASON } from './slotstreamServerManager.js';
import { previewMtplxPull } from './mtplxModelManager.js';
import { assertDownloadFits } from '../lib/downloadPreflight.js';
import { controlOllamaServer, installBackend } from './localLlm.js';
import { isAppInstalled as isLmStudioAppInstalled } from './lmStudioManager.js';
import { provisionVllmQwenProject, readVllmQwenSetupState, startVllmQwenProject } from './vllmQwenManager.js';

/** A short command that only asks a running daemon to do something. */
const CONTROL_TIMEOUT_MS = 60 * 1000;

/**
 * A model pull moves tens of gigabytes. Sized for a slow domestic line rather
 * than for a fast one — a bound that kills a download at 90% is worse than no
 * bound at all, and the user can close the modal to stop watching at any point.
 */
const WEIGHTS_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/**
 * Split a downloader's output on bare `\r` too, so a tqdm-style progress bar
 * that redraws one line surfaces each redraw instead of buffering silently for
 * the length of the download (`lib/streamLines.js`).
 */
const PROGRESS_SPLIT_RE = /[\r\n]+/;

/**
 * How long a start step waits for a just-started daemon to answer. Sized for a
 * cold multi-gigabyte model load, not for a socket coming up.
 */
const START_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Bound on the `GET /v1/models` reachability probes. Loopback answers (or
 * refuses) in single-digit milliseconds; the wider bound is for the FINAL
 * confirmation, where a daemon that just finished loading a model can be slow
 * to answer its first request and reporting it as down would be wrong.
 */
const PROBE_TIMEOUT_MS = 2_000;
const CONFIRM_TIMEOUT_MS = 5_000;

/**
 * Why an installed MTPLX still cannot be started. Weights stay the user's
 * decision (`docs/features/mtplx.md`), so a plain Start never fetches them —
 * it names the button that does, plus the in-app card that searches for and
 * downloads a checkpoint other than MTPLX's own default.
 */
const MTPLX_NO_MODEL_ERROR = 'no model weights are cached, so its server exits before it binds a port. Close this window — the checklist now offers “Download the default model & start MTPLX”, which fetches MTPLX\'s own verified checkpoint (a multi-gigabyte download) and then starts the server. To use a different MTP checkpoint instead, search for one on the MTPLX card in Models → LLMs, download it there, then click Start MTPLX again.';

/** The same dead end, reached from a cache holding only interrupted pulls. */
const mtplxPartialCacheError = (count) =>
  `its cache holds ${count} model${count === 1 ? '' : 's'}, but none passed its own file check — an interrupted download leaves a partial pack behind. Use “Download the default model & start MTPLX” on the checklist to re-fetch it, or pick another checkpoint on the MTPLX card in Models → LLMs.`;

/**
 * MTPLX's cache state, read WITHOUT invoking `mtplx`'s Homebrew wrapper before
 * its Python runtime exists.
 *
 * `mtplx models --json` touches no network — but on a host where the wrapper
 * has not bootstrapped its version-keyed venv yet, spawning it IS a
 * several-hundred-megabyte pip install (`lib/mtplxRuntime.js`). The readiness
 * checklist polls this, so without the gate a checklist refresh would kick off
 * that download unannounced and then time out on it.
 *
 * A runtime that is not bootstrapped reports `unknown` — the cache genuinely
 * could not be read, which is deliberately NOT `empty` — so the checklist does
 * not claim MTPLX has no weights. A start attempted anyway is refused by
 * `startMtplxServer` with `MTPLX_RUNTIME_NOT_BOOTSTRAPPED`, which names the
 * download step rather than the checkpoint one.
 */
async function readMtplxCacheState() {
  const runtime = await describeMtplxRuntime(findCommandOnPath('mtplx'));
  if (!runtime.ready) {
    return { state: 'unknown', model: null, count: 0, error: 'MTPLX\'s Python runtime has not been downloaded yet' };
  }
  return describeMtplxCache(await listMtplxCachedModels());
}

/**
 * The `platforms` gate below is a static list, so its refusal has to be static
 * too — read from the recipe module rather than re-typed, so the platform
 * refusal and the runtime refusal cannot drift into telling an Apple Silicon
 * operator two different things.
 */
const SGLANG_PLATFORM_UNSUPPORTED_REASON = sglangUnsupportedReason({ platform: 'darwin' });

/**
 * The provisioning actions: the ones whose click IS the consent, because each
 * spends bandwidth measured in gigabytes.
 *
 * A row owns at most ONE of them, declared as `row.provision = { action, run }`
 * — and `describeRuntimeSetup` offers it only when that runtime's own offline
 * read proves a plain Start cannot work. Everything
 * needed to report the step lives in one entry so the button label and the
 * progress lines cannot drift into describing different amounts of bandwidth.
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
    // The payload named before the click: a ~9.5 GB image built on this host
    // plus ~20 GB of weights. `install()` still refuses — this provisions the
    // PROJECT on a host whose docker / NVIDIA / WSL2 setup is already the
    // operator's own decision.
    label: (label) => `Clone, build & prepare ${label} (~30 GB), then start`,
    begun: (label) => `Docker is installed — preparing ${label}'s compose project before starting it.`,
    refused: (label) => `PortOS cannot provision a compose project for ${label}.`,
    failed: (label, error) => `${label} provisioning failed: ${error}`,
    done: (label) => `${label}'s compose project is built and prepared.`,
    cancelled: 'Cancelled after the prepare step — the project is ready, but nothing was started.',
  }),
});

/**
 * What each action actually DOES, and what it is called on the button.
 *
 * The capabilities are declared rather than spelled: `setupHint` used to ask
 * whether an action name *contained* `install` or `start`, which worked only
 * because every name happened to. `provision-start` broke the coincidence
 * (it covers the download that `pull` used to stand for), and the next action
 * named `bootstrap` or `prepare` would break it again — silently, since a
 * missing hint fails no test. Declaring the three axes means a new action must
 * answer them, and `describeRuntimeSetup` can hand the client `provisions`
 * instead of the client re-deriving it from the name.
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

/**
 * Does this action cover `installs` / `starts` / `provisions`?
 *
 * Exported so `providerReadiness.js` points each unmet check at the button that
 * fixes it by asking THIS table, rather than matching substrings of the name.
 */
export const actionCovers = (action, capability) => ACTION_CAPABILITIES[action]?.[capability] === true;

/**
 * The provisioning action a row owns, or `null` when it has no such step.
 *
 * A row declares BOTH halves or neither — there is no default. An implicit
 * `pull-start` fallback would hand a new row "Download the default model &
 * start X" and `X model download failed:` for a step that is not a download,
 * which is the exact mislabeling PROVISION_STEPS exists to end.
 */
const rowProvisionAction = (row) => row?.provision?.action || null;

/**
 * Fetch MTPLX's OWN default verified checkpoint — no repo id from the request,
 * so this cannot be pointed at an arbitrary download. Runs only for the
 * `pull-start` action, which the user clicks by its full name.
 */
async function pullMtplxDefaultCheckpoint({ emit, isCancelled }) {
  const binary = findCommandOnPath('mtplx');
  if (!binary) return { success: false, error: '`mtplx` was not found on PortOS\'s PATH. Restart PortOS so it picks up the new bin directory, then try again.' };
  // Same disk-space guard the Models → LLMs MTPLX card runs before its own
  // pull — this readiness-checklist button reaches the same `mtplx pull`
  // with no repo id, so it shares previewMtplxPull's cache path and its
  // (unknown-size, so effectively best-effort) preflight. A refusal throws;
  // the SSE route above already treats an unexpected throw from this step as
  // a clean `{success:false}` termination, not a 500.
  assertDownloadFits(await previewMtplxPull({}));
  emit('Downloading MTPLX\'s default verified checkpoint. This is a multi-gigabyte download and can take a long while — leave this window open to watch it.');
  // `mtplx pull` redraws one progress line with a bare `\r`; splitting on
  // newlines alone would leave the stream silent for the whole download.
  // `isCancelled` is load-bearing here, not decoration: this is the one step
  // that can run for HOURS, and the route holds its single-setup lock until this
  // promise settles. Without it, closing the modal leaves the download running
  // and every other runtime's setup button refused for the rest of it.
  return runStreamingCommand(binary, ['pull'], emit, { timeoutMs: WEIGHTS_TIMEOUT_MS, splitRe: PROGRESS_SPLIT_RE, isCancelled });
}

/**
 * One row per local runtime PortOS can set up on its own.
 *
 * `platforms` is the HARD gate (an empty/absent list means every platform).
 * `install` and `start` are async steps taking `({ emit, endpoint, isCancelled })`
 * and returning `{ success, error?, note? }`; `start: null` means PortOS cannot
 * start this runtime unattended and the checklist keeps its existing link.
 *
 * `provision: { action, run }` is the optional gigabyte-spending step: `action`
 * names its PROVISION_STEPS entry (which supplies every string reported about
 * it) and `run` takes `({ emit, isCancelled })`. Multi-step work belongs in a
 * manager module — this table stays a table.
 */
const SETUP_ROWS = Object.freeze({
  mtplx: Object.freeze({
    platforms: ['darwin'],
    unsupportedReason: MTPLX_UNSUPPORTED_REASON,
    async install({ emit }) {
      // Same install `mtplxServerManager` runs from the Models → LLMs card:
      // upstream's Homebrew tap, with pip as the documented fallback for a host
      // without Homebrew. Neither runs the optional privileged fan-control helper.
      const result = await installMtplx({ onProgress: (p) => { if (p?.message) emit(p.message); } })
        .catch((err) => ({ success: false, error: err.message }));
      return result;
    },
    /**
     * What MTPLX's own cache holds, WITHOUT starting it — `mtplx models --json`
     * is a local directory listing. Sits next to the `pull` step it gates so
     * the two cannot drift, and `providerReadiness.js` reads it through
     * `readRuntimeWeights` to put the same fact on the checklist.
     */
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
      // `mtplx serve` defaults `--model` to ONE hard-coded checkpoint and exits
      // 1 before binding when that repo is not in its cache — even on a machine
      // holding a different MTP model that would have served fine. Ask the
      // cache first and name what is actually there. Read HERE rather than
      // leaving it to the manager because the refusals differ by surface: this
      // checklist can offer the `pull-start` download button, and the messages
      // above say so; the Models → LLMs launcher has no such button and names
      // `mtplx pull` instead.
      const cache = await readMtplxCacheState();
      if (cache.state === 'unknown') {
        // The cache could not be READ — which is not "read, and empty". Fall
        // through to MTPLX's own default rather than blocking a start that may
        // well work.
        emit(`Could not read MTPLX's model cache (${cache.error}) — starting with its default model.`);
      }
      if (cache.state === 'empty') return { success: false, error: MTPLX_NO_MODEL_ERROR };
      if (cache.state === 'partial') return { success: false, error: mtplxPartialCacheError(cache.count) };
      // The manager emits "Serving the cached MTPLX model …" once it has the
      // checkpoint, so don't announce it here too — both go to the same modal.
      // The cache lookup is an awaited subprocess — the modal can close while it
      // runs, and the caller's cancellation check happened BEFORE it. Without
      // this, a cancelled setup still starts a server nobody asked to keep.
      if (isCancelled()) return { success: false, error: 'Cancelled before the server was started.' };
      // Delegated to the PM2-backed manager so a server started from this
      // checklist is the SAME managed process the LLMs page can stop, log, and
      // persist with `pm2 save` — a detached spawn here would be invisible there.
      // The resolved checkpoint rides along so the manager does not walk the
      // cache a second time for one start.
      const port = Number(localEndpointPort(endpoint)) || undefined;
      // This flow's contract is "the endpoint answers when the button finishes",
      // so it buys the full cold-model-load budget rather than the launcher's
      // short beat — MTPLX loads a multi-gigabyte MLX checkpoint before it binds.
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
     * What Slotstream's cache holds, WITHOUT starting it — a local directory
     * walk. There is deliberately no `provision` row beside it: PortOS does not
     * fetch weights for this runtime, so the checklist reports an empty cache
     * rather than offering a download button.
     *
     * This row is what keeps `standbyWhenStopped` honest. Without it
     * `readRuntimeWeights('slotstream')` answers `'unknown'`, and a stopped
     * Slotstream with an empty cache reads as "a valid idle state" — pointing
     * the user at a start that cannot succeed.
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

  vllm: Object.freeze({
    // CUDA + Marlin + FlashInfer in a Linux container. On macOS there is no card
    // to give it, and DFlash 2 on Apple Silicon is unproven in this project —
    // the analogous local-daemon path there already ships as MTPLX / DSpark.
    platforms: ['linux', 'win32'],
    unsupportedReason: 'The vLLM Qwen3.8-27B stack needs an NVIDIA GPU (RTX 3090) and a Linux container runtime. On Apple Silicon use the MTPLX or llama.cpp DSpark presets instead.',
    async install() {
      // Deliberately never installs anything. Docker Desktop / the NVIDIA
      // container toolkit / WSL2 are host-level operator decisions with driver
      // requirements PortOS cannot judge, and the payload is a ~9.5 GB image.
      return {
        success: false,
        error: 'PortOS does not install this stack. On the RTX 3090 host, set up WSL2 (or Linux) with Docker and the NVIDIA Container Toolkit — then the checklist can clone, build and prepare the compose project for you (see docs/features/qwen38-rtx3090.md).',
      };
    },
    // What is on disk, in the checklist's four-state vocabulary — a directory
    // read, exactly like MTPLX's cache read above. `'empty'` is what makes the
    // checklist offer `provision-start`, and `vllmProjectSetupState` is careful
    // to report it only where cloning/building/preparing IS the fix.
    weights: readVllmQwenSetupState,
    // This row's gigabyte-spending step is a compose provisioning run, not a
    // model download — hence its own PROVISION_STEPS entry.
    provision: Object.freeze({ action: 'provision-start', run: provisionVllmQwenProject }),
    start: startVllmQwenProject,
  }),

  sglang: Object.freeze({
    // Same posture as vLLM: CUDA in a Linux container. The hardware gate is
    // narrower, though — the cookbook publishes single-GPU cells for Hopper and
    // Blackwell only, and an Ampere 24 GB card keeps the vLLM stack (the SGLang
    // cookbook has no 3090 cell). `sglangUnsupportedReason` reads the probe and
    // says which of those it is, never collapsing a wedged `nvidia-smi` into
    // "no GPU".
    platforms: ['linux', 'win32'],
    unsupportedReason: SGLANG_PLATFORM_UNSUPPORTED_REASON,
    async install() {
      // Deliberately never installs anything, for the same reasons as vLLM:
      // Docker / the NVIDIA Container Toolkit / WSL2 are host-level operator
      // decisions with driver requirements PortOS cannot judge.
      return {
        success: false,
        error: 'PortOS does not install this stack. On the Hopper or Blackwell host, set up Docker with the NVIDIA Container Toolkit, then follow docs/features/sglang-qwen38.md — it carries the compose file (with the verified launch line) and the one-time weight download.',
      };
    },
    async start({ emit, isCancelled }) {
      // Refuse before docker on a card with no recipe, so a wrong-hardware host
      // never reaches a `docker compose up` that would pull the image.
      const cuda = await getCudaCapability().catch(() => null);
      const unsupported = sglangUnsupportedReason({ status: cuda?.status, gpus: cuda?.gpus });
      if (unsupported) return { success: false, error: unsupported };
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
      // `installBackend` already registers the Homebrew service / runs the
      // vendor script on Linux and starts the daemon afterwards, so it covers
      // both steps for this runtime.
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
      // `lms` is LM Studio's own CLI shim, installed by `lms bootstrap` from the
      // app. Without it there is no headless way to start the server, and
      // pretending otherwise would report a success the user cannot see.
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
        ? { success: true, note: 'Choose a GGUF model on Models → LLMs to start llama-server — PortOS does not pick weights for you.' }
        : result;
    },
    // llama-server takes a required model path, and the weights are a separate
    // multi-gigabyte download. Starting it unattended would mean guessing which
    // checkpoint the user meant, so the Models → LLMs page keeps that step.
    start: null,
  }),
});

/**
 * What a runtime's own model cache holds, without starting it. `'unknown'` for
 * every runtime with no cache PortOS can read offline — never `'empty'`, which
 * would claim a fact PortOS does not have.
 *
 * Exported so `providerReadiness.js` reports the checklist from the SAME fact
 * `describeRuntimeSetup` picks a button from; a second copy of the reader table
 * over there is how the two would drift into disagreeing about one cache.
 *
 * @returns {Promise<'unknown'|'empty'|'partial'|'ready'>}
 */
export async function readRuntimeWeights(kind) {
  const row = SETUP_ROWS[kind];
  // A platform that cannot run the runtime discards this answer anyway
  // (`describeRuntimeSetup` returns `blockedReason` and ignores `weights`), and
  // the read is not free: vLLM's walks the compose project's candidate cache
  // roots, which on the documented Windows shape is a dozen syscalls across a
  // 9p share. Docker is on PATH almost everywhere, so without this gate a Mac
  // would sweep for an RTX 3090 project once a minute, forever.
  if (!row?.weights || !platformSupported(row)) return 'unknown';
  return row.weights();
}

/** The cache states that make a start impossible. */
export const weightsBlockStart = (weights) => weights === 'empty' || weights === 'partial';

/** True when this host can run the runtime's setup at all. */
function platformSupported(row) {
  return !row.platforms || row.platforms.includes(process.platform);
}

/**
 * What (if anything) a "set this up for me" button should offer for one
 * runtime, given what its readiness checks found. Pure — the client renders it
 * straight from the readiness payload, so it must not probe anything.
 *
 * Returns `null` when there is nothing to offer: an unknown runtime, a platform
 * that cannot run it, a runtime already installed and running (the remaining
 * unmet check is the model, which PortOS will not choose), or a runtime PortOS
 * can install but not start when the install is already done.
 *
 * `weights` is what the caller already learned about the runtime's local model
 * cache (`lib/mtplxModels.js`'s `describeMtplxCache`), and only `'empty'` /
 * `'partial'` change the answer: those are the states where a Start CANNOT
 * work, so the button becomes the download that makes it possible instead of
 * the start that is guaranteed to fail. `'unknown'` — the default, and what
 * every runtime with no cache to read reports — deliberately keeps the old
 * behavior; a cache PortOS could not read must not be treated as an empty one.
 *
 * @param {string} kind - `mtplx` | `llama` | `ollama` | `lmstudio` | `vllm` | `sglang`
 * @param {{installed: boolean, running: boolean, weights?: 'unknown'|'empty'|'partial'|'ready'}} state
 */
export function describeRuntimeSetup(kind, { installed, running, weights = 'unknown' }) {
  const row = SETUP_ROWS[kind];
  const runtime = LOCAL_RUNTIMES[kind];
  if (!row || !runtime) return null;

  const needsInstall = !installed;
  const needsStart = !running && Boolean(row.start);
  if (!needsInstall && !needsStart) return null;

  if (!platformSupported(row)) {
    return { runtime: kind, label: runtime.label, action: null, actionLabel: null, provisions: false, blockedReason: row.unsupportedReason };
  }

  // Only offered once the binary is here: the cache cannot be read without it,
  // so an uninstalled runtime's `weights` says nothing and `install-start`
  // stays the honest first step.
  const provision = rowProvisionAction(row);
  const needsWeights = Boolean(provision) && !needsInstall && needsStart && weightsBlockStart(weights);
  const action = needsWeights ? provision
    : needsInstall && needsStart ? 'install-start'
      : needsInstall ? 'install' : 'start';
  return {
    runtime: kind,
    label: runtime.label,
    action,
    actionLabel: ACTION_CAPABILITIES[action].label(runtime.label),
    // Whether this click spends gigabytes, answered HERE rather than re-derived
    // from the action name in the client — a hand-kept mirror over there would
    // silently downgrade the next provisioning button to an ordinary one.
    provisions: actionCovers(action, 'provisions'),
    blockedReason: null,
  };
}

/**
 * Install and/or start one local runtime, reporting progress line by line.
 *
 * Re-probes the endpoint first: the user may have started the daemon in a
 * terminal since the page last polled, and re-running an install over a working
 * setup is the one outcome a "fix it" button must not produce.
 *
 * Never throws — the caller is an SSE route whose headers are already flushed,
 * so a failure has to come back as a value it can turn into a terminal frame.
 *
 * @param {string} kind
 * @param {{endpoint: string, emit: (line: string) => void, isCancelled?: () => boolean, action?: string}} ctx
 *   `isCancelled` is checked between steps so a closed modal does not go on to
 *   start a daemon nobody is watching for. `action` is the one the checklist's
 *   button named; only a PROVISION_STEPS action adds a step (MTPLX's model
 *   download, vLLM's clone/build/prepare), and each is opt-in precisely so no
 *   other action can spend gigabytes of bandwidth. Omit
 *   it (`null`) and this resolves the action the checklist would offer right
 *   now — see the resolution comment below.
 * @returns {Promise<{success: boolean, error?: string, message?: string}>}
 */
export async function runLocalRuntimeSetup(kind, { endpoint, emit = () => {}, isCancelled = () => false, action = null }) {
  const row = SETUP_ROWS[kind];
  const runtime = LOCAL_RUNTIMES[kind];
  if (!row || !runtime) return { success: false, error: `PortOS has no automatic setup for \`${String(kind)}\`.` };

  // The reachability probe comes BEFORE the platform gate on purpose: a daemon
  // that is already answering is running whatever this host's platform is, and
  // "MTPLX runs only on macOS" is a false report about a server the user can
  // see working. The gate is about what PortOS may INSTALL, not about what is
  // already up.
  const target = endpoint || runtime.defaultBaseUrl;
  const probe = await probeOpenAiModels(target, { timeoutMs: PROBE_TIMEOUT_MS });
  if (probe.reachable) {
    return { success: true, message: `${runtime.label} is already running at ${target} — nothing to do.` };
  }
  if (!platformSupported(row)) return { success: false, error: row.unsupportedReason };

  const provision = rowProvisionAction(row);

  // Refuse a step this runtime does not have BEFORE anything is installed. A
  // `pull-start` aimed at Ollama would otherwise run Ollama's install on its way
  // to being refused, and llama.cpp (`start: null`) would return the
  // install-succeeded message without ever refusing at all. The mismatch check
  // is by ACTION, not merely by "has a pull": vLLM owns `provision-start`, so a
  // `pull-start` aimed at it is just as wrong as one aimed at Ollama.
  if (actionCovers(action, 'provisions') && action !== provision) {
    return { success: false, error: PROVISION_STEPS[action].refused(runtime.label) };
  }

  // Same two signals `providerReadiness.js` uses: the binary on PATH, plus LM
  // Studio's macOS app bundle, which serves without ever putting `lms` there.
  const installed = Boolean(runtime.command && findCommandOnPath(runtime.command)) ||
    (kind === 'lmstudio' && isLmStudioAppInstalled());

  // A request that names NO action came from a client built before `pull-start`
  // existed — a stale `client/dist` (`pm2 restart` does not rebuild it) or a tab
  // open across an upgrade. That client still renders THIS server's
  // `setup.actionLabel`, so the user clicked a button reading “Download the
  // default model & start MTPLX”; defaulting to a plain start would answer that
  // click with the very "no model weights are cached" dead end this action
  // exists to remove. Resolve what the checklist is offering instead, which is
  // by construction the label they clicked.
  // `installed &&` mirrors `describeRuntimeSetup`'s own gate: the cache cannot
  // be read without the binary, so an uninstalled runtime never resolves to a
  // download — and never spends a cache read to learn that.
  const resolved = action || (provision && installed && weightsBlockStart(await row.weights()) ? provision : 'install-start');

  if (!installed) {
    const result = await row.install({ emit, endpoint: target, isCancelled });
    if (!result.success) return { success: false, error: `${runtime.label} install failed: ${result.error}` };
    emit(`${runtime.label} is installed.`);
    if (result.note) emit(result.note);
  } else {
    // "already installed — starting it" was a lie whenever the click was a
    // provisioning one: the next thing to happen is a clone or a multi-gigabyte
    // download, and reporting a start makes every line after it read as a
    // failure of the start. Each provisioning step says what it is about to do.
    emit(resolved === provision
      ? PROVISION_STEPS[provision].begun(runtime.label)
      : `${runtime.label} is already installed — starting it.`);
  }

  if (!row.start) {
    return { success: true, message: `${runtime.label} is installed. Pick a model on Models → LLMs to start it.` };
  }
  if (isCancelled()) return { success: false, error: 'Cancelled after the install — nothing was started.' };

  // The ONLY path that spends gigabytes, and it runs only because the user
  // clicked a button that says so. `describeRuntimeSetup` offers it exactly
  // when the runtime's own offline read is provably unusable, which is the
  // state where a plain Start would exit before binding a port.
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
  const served = Array.isArray(final.models) && final.models.length > 0
    ? ` It is serving ${final.models.slice(0, 3).join(', ')}${final.models.length > 3 ? ` +${final.models.length - 3} more` : ''}.`
    : '';
  return { success: true, message: `${runtime.label} is running at ${target}.${served}` };
}

/** The runtime kinds this module can set up — used by route validation and tests. */
export const SETUP_RUNTIME_KINDS = Object.freeze(Object.keys(SETUP_ROWS));

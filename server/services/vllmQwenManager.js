/**
 * Everything PortOS does TO the vLLM Qwen3.8-27B compose project.
 *
 * `lib/vllmQwenProject.js` reads what is on disk and `lib/vllmQwenProvision.js`
 * decides what the `.env` must say; this module is the side of it that runs
 * commands — the same split `mtplxServerManager.js` and `llamaServerManager.js`
 * have from `localRuntimeSetup.js`, whose registry stays a table of rows rather
 * than growing one runtime's orchestration inline.
 *
 * Two things it does and nothing else does:
 *
 *   - **Provision** (`provisionVllmQwenProject`) — clone, write `.env`, build,
 *     prepare. This is the ~30 GB, and it runs ONLY behind the checklist's
 *     `provision-start` action, whose button names the payload before the click.
 *     `install()` in the registry still refuses: Docker Desktop, the NVIDIA
 *     Container Toolkit and WSL2 are host-level operator decisions with driver
 *     requirements PortOS cannot judge. This provisions the PROJECT on a host
 *     that is already capable of running it.
 *   - **Start** (`startVllmQwenProject`) — `docker compose up` on a project that
 *     is demonstrably prepared, and a refusal naming the fix on anything else.
 *
 * Neither ever throws: both run from an SSE route whose headers are already
 * flushed, so every failure comes back as a value the caller turns into a
 * terminal frame.
 */

import { totalmem } from 'os';
import { join } from 'path';

import { atomicWrite, formatBytes, tryReadFile } from '../lib/fileUtils.js';
import { runStreamingCommand } from '../lib/streamingSpawn.js';
import { findCommandOnPath } from '../lib/processEnv.js';
import { localEndpointPort } from '../lib/localProviderRuntime.js';
import { PORTS } from '../lib/ports.js';
import {
  inspectVllmQwenProject,
  recordVllmProjectDir,
  vllmProjectDirIsSettled,
  vllmProjectSetupState,
  vllmStartBlockedReason,
  VLLM_PROJECT_DIR_ENV,
  VLLM_PROJECT_LEAF,
} from '../lib/vllmQwenProject.js';
import { detectWslProjectDir, WSL_UNC_PREFIX } from '../lib/wslDistro.js';
import {
  generateVllmApiKey,
  isWsl2Engine,
  mergeEnvFileContents,
  vllmEnvDefaults,
  VLLM_API_KEY_VAR,
  WSL2_PREPARE_CONFIG_HINT,
  WSL2_PREPARE_MIN_BYTES,
} from '../lib/vllmQwenProvision.js';
import { getAllProviders, updateProvider } from './providers.js';

/** Upstream's frozen packaging of patched vLLM + the requantized checkpoint. */
export const VLLM_UPSTREAM_REPO = 'https://github.com/syv-ai/qwen38-27b-rtx3090';

/** A daemon question, and a compose `up` on an image that is already built. */
const CONTROL_TIMEOUT_MS = 60 * 1000;

/**
 * Bound on the clone. Generous, but nothing like the build/prepare budget — the
 * checkout is source and a compose file; the 30 GB arrives in the two steps
 * after it.
 */
const CLONE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * The image build and the weights prepare. Sized for a slow domestic line rather
 * than a fast one — a bound that kills a 20 GB download at 90% is worse than no
 * bound at all, and closing the modal cancels between steps anyway.
 */
const PROVISION_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/**
 * Split docker's output on bare `\r` too, so a layer-pull or tqdm progress bar
 * that redraws one line surfaces each redraw instead of going silent for the
 * length of the download (`lib/streamLines.js`).
 */
const PROGRESS_SPLIT_RE = /[\r\n]+/;

/**
 * What is on disk, in the four-state vocabulary the readiness checklist speaks
 * (`localRuntimeSetup.js`'s `readRuntimeWeights`). A directory read — it never
 * runs docker or contacts a registry.
 */
export async function readVllmQwenSetupState() {
  return vllmProjectSetupState(await inspectVllmQwenProject());
}

/** The real distros to offer, when there are any. */
const nameDistros = (distros) => (distros?.length
  ? ` PortOS can see ${distros.join(', ')} — \`wsl --set-default <name>\` picks one; otherwise`
  : ' Install one with');

/**
 * The lead sentence for each way the WSL question can go unanswered.
 *
 * A table rather than four returns so the tail below is appended exactly once.
 * That tail is the part that must never go missing — a fifth reason added to
 * `detectWslProjectDir` would otherwise ship a refusal that neither rules out
 * `C:\` nor names the override.
 */
const PLACEMENT_REFUSALS = Object.freeze({
  'internal-distro': (f) => `the default WSL distro is \`${f.distro}\`, which is a container engine's own plumbing — it is recreated from scratch on a reset, so ~20 GB of weights must not live there.${nameDistros(f.distros)} \`wsl --install -d Ubuntu\`.`,
  'unreadable-share': (f, detail) => `the \`${f.distro}\` distro answered, but Windows cannot read ${f.home} — the ${WSL_UNC_PREFIX} share is not responding${detail}. \`wsl --shutdown\` restarts it (that takes the whole VM down, so stop your containers first).`,
  'no-distro': (f, detail) => `WSL is present but no distro answered${detail}, so there is no Linux filesystem to put this project on.${nameDistros(f.distros)} \`wsl --install -d Ubuntu\`.`,
  'no-wsl': (_f, detail) => `this stack runs inside WSL2 — Docker Desktop's own engine IS a WSL2 VM — and \`wsl.exe\` did not run on this host${detail}. Install a distro with \`wsl --install -d Ubuntu\`, then click this again and PortOS will place the project inside it for you.`,
});

/**
 * Why PortOS could not find a Linux-side home for this project on a Windows
 * host — prose the checklist renders verbatim, one fix per case.
 *
 * There is no case for "the operator did not configure a directory" any more.
 * That was the old refusal, and it asked a person to look up two values
 * (`<distro>`, `<user>`) that WSL will state on request. What survives is the
 * set of answers PortOS genuinely cannot supply for itself: a machine with no
 * WSL, a default distro that belongs to a container engine, and a share Windows
 * cannot read.
 *
 * @param {{reason?: string, distro?: string, home?: string, error?: string, distros?: string[]}} found
 * @returns {string}
 */
export function wslPlacementRefusal(found) {
  const lead = PLACEMENT_REFUSALS[found?.reason] || PLACEMENT_REFUSALS['no-wsl'];
  return `${lead(found || {}, found?.error ? ` (${found.error})` : '')} PortOS will not fall back to the Windows filesystem, where every one of those weight reads would cross a 9p share. To place the project somewhere of your own choosing instead, set ${VLLM_PROJECT_DIR_ENV} and click this again.`;
}

/**
 * Settle where this project goes before anything is written to it.
 *
 * On Windows the answer is never the default `%USERPROFILE%\qwen-serving`:
 * Docker Desktop's engine is a WSL2 VM, so a project on the Windows filesystem
 * is reached from inside that VM over a 9p share, and the ~20 GB of weights
 * would be written across it once and paged back across it forever. PortOS used
 * to refuse and hand the operator a UNC template to fill in by hand; it now asks
 * WSL for the same two values (`lib/wslDistro.js`) and records the answer, so
 * the readiness poll, the Start button, and the next server boot all resolve the
 * directory this run actually used.
 *
 * Detection runs ONLY when nothing already answers the question — an exported
 * `VLLM_QWEN_PROJECT_DIR` or an earlier recording both win, and neither costs a
 * subprocess. Off Windows there is nothing to detect: the default home is a
 * Linux filesystem already.
 *
 * @param {{emit?: (line: string) => void}} [ctx]
 * @returns {Promise<string|null>} the refusal, or `null` once the directory is
 *   settled — the same shape as `vllmStartBlockedReason`, and read back the same
 *   way, through `inspectVllmQwenProject()`.
 */
export async function ensureVllmProjectDir({ emit = () => {} } = {}) {
  if (process.platform !== 'win32') return null;
  if (vllmProjectDirIsSettled()) return null;

  emit('Windows host — asking WSL where this project belongs, so its ~20 GB of weights land on the distro filesystem rather than on the Windows one.');
  const found = await detectWslProjectDir(VLLM_PROJECT_LEAF);
  if (!found.dir) return wslPlacementRefusal(found);

  emit(`Placing it in the \`${found.distro}\` distro, at ${found.dir}.`);
  // This process FIRST, the file second. `resolveVllmProjectDir` reads the env
  // ahead of the record, so every later read in this run — the re-inspection
  // below, the readiness poll, the Start button — resolves the detected
  // directory even when the write fails. Without it, a failed write silently
  // sends the very next inspection back to `%USERPROFILE%\qwen-serving`: the
  // C:\ placement this whole path exists to refuse.
  process.env[VLLM_PROJECT_DIR_ENV] = found.dir;
  // Recording is only what makes the choice outlive this run, so a failed write
  // costs exactly that — not a ~30 GB provision.
  const recordedOk = await recordVllmProjectDir(found.dir).then(() => true, (err) => {
    emit(`Could not record ${VLLM_PROJECT_DIR_ENV} in PortOS's .env (${err.message}) — this run still uses that directory, but set it there yourself or the next restart will look on the Windows filesystem again.`);
    return false;
  });
  if (recordedOk) emit(`Recorded ${VLLM_PROJECT_DIR_ENV} in PortOS's .env, so the readiness check and the Start button find it too.`);
  return null;
}

/**
 * Make the project's `.env` say everything the container needs, without
 * overruling a single thing the operator already wrote there.
 *
 * The generated API key is a fallback: `mergeEnvFileContents` reports the value
 * that ended up IN EFFECT, so a file that already carried a key keeps it and the
 * caller propagates that one.
 *
 * Only key NAMES are ever emitted — the returned `effective` holds the token.
 */
async function ensureVllmEnvFile(dir, emit) {
  const envPath = join(dir, '.env');
  const existing = (await tryReadFile(envPath)) || '';
  // The feature doc's snippet tests `/proc/version`; `isWsl2Engine` also counts
  // win32, where Docker Desktop's engine IS a WSL2 VM and there is no
  // `/proc/version` for PortOS to read — see that module for why omitting the
  // two WSL2 variables there produces a silent crash-loop rather than an error.
  // So the file is only opened where it can exist.
  const wsl2 = isWsl2Engine({ procVersion: process.platform === 'linux' ? await tryReadFile('/proc/version') : null });
  const merged = mergeEnvFileContents(existing, vllmEnvDefaults({ apiKey: generateVllmApiKey(), wsl2 }));

  if (merged.added.length > 0) {
    // Atomic, and mode-preserving: this file holds the container's bearer token,
    // and a truncate-in-place is readable half-written by a concurrent
    // `docker compose`.
    await atomicWrite(envPath, merged.contents);
    emit(`Wrote ${merged.added.length} missing setting${merged.added.length === 1 ? '' : 's'} to .env: ${merged.added.join(', ')}.`);
  }
  if (merged.kept.length > 0) {
    emit(`Left the .env values already set for ${merged.kept.join(', ')} exactly as they were.`);
  }
  return { ...merged, wsl2 };
}

/**
 * Name the WSL2 memory ceiling right before the step it kills.
 *
 * Raising it is an operator decision PortOS never takes: it means editing
 * `%UserProfile%\.wslconfig` and running `wsl --shutdown`, which takes the whole
 * VM down — including a PostgreSQL container this install may be using. So:
 * detect, name the values, and let them decide.
 */
function warnAboutWsl2PrepareMemory(emit) {
  const vmBytes = totalmem();
  // `formatBytes` is 1024-based, like WSL2_PREPARE_MIN_BYTES and like the "~24 GB"
  // named in the hint — a 1000-based number here would read as 25 GB for a VM
  // sitting exactly on the floor.
  emit(process.platform === 'linux' && vmBytes < WSL2_PREPARE_MIN_BYTES
    ? `Warning: this WSL2 VM sees only ${formatBytes(vmBytes)} of RAM. The prepare step is CPU-side and memory-hungry, and under ~24 GB it is SIGKILLed with a bare "Killed" (exit 137) that names nothing about WSL. ${WSL2_PREPARE_CONFIG_HINT}`
    : `WSL2 backs this engine. If the prepare step dies with a bare "Killed" (exit 137), its VM memory ceiling is the cause. ${WSL2_PREPARE_CONFIG_HINT}`);
}

/**
 * Put the container's key on the seeded vLLM providers so the operator never
 * copies it by hand — the one manual step left in `docs/features/qwen38-rtx3090.md`.
 *
 * The key is a secret: it is stored and never emitted. Providers already
 * carrying this exact key are skipped, so a re-run writes nothing.
 */
async function applyVllmApiKeyToProviders(apiKey, emit) {
  if (!apiKey) return 0;
  const data = await getAllProviders().catch((err) => {
    emit(`Could not read the provider list to store the container's API key (${err.message}) — paste it from .env onto the vLLM providers yourself.`);
    return null;
  });
  const all = Array.isArray(data?.providers) ? data.providers : [];
  const targets = all.filter((p) => p?.vllmBacked === true && p.apiKey !== apiKey);
  let stored = 0;
  for (const provider of targets) {
    // A failed provider write must not undo a successful 30 GB provision — this
    // is a convenience (the key is in `.env` either way), so it reports and
    // carries on rather than throwing out of the whole run.
    // eslint-disable-next-line no-await-in-loop -- two seeded records, each a serialized file write
    const written = await updateProvider(provider.id, { apiKey }).then(() => true, (err) => {
      emit(`Could not store the API key on ${provider.id} (${err.message}) — paste it from .env onto that provider yourself.`);
      return false;
    });
    if (written) stored += 1;
  }
  if (stored > 0) {
    emit(`Stored the container's API key on ${stored} vLLM provider${stored === 1 ? '' : 's'} — it is never printed here.`);
  }
  return stored;
}

/**
 * Clone / build / prepare the upstream compose project, streaming every step.
 *
 * Each step is skipped when it has already landed, which is what makes a re-run
 * cheap: upstream's `prepare` is itself idempotent and its download resumes, so
 * a cancelled run costs minutes rather than the 20 GB.
 *
 * `isCancelled` is checked BETWEEN steps and never handed to the build or the
 * prepare. Killing those mid-flight is how a half-written image layer or a
 * partial checkout gets left behind, and the wait is exactly what the operator
 * signed up for when they clicked a button reading "~30 GB".
 *
 * @param {{emit: (line: string) => void, isCancelled: () => boolean}} ctx
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function provisionVllmQwenProject({ emit, isCancelled }) {
  // Docker must ANSWER, not merely be on PATH: a stopped Docker Desktop leaves
  // the binary there, and every step below would then fail one at a time with a
  // message about compose rather than about the daemon.
  const docker = await runStreamingCommand('docker', ['version', '--format', '{{.Server.Version}}'], undefined, { timeoutMs: CONTROL_TIMEOUT_MS });
  if (!docker.success) {
    return { success: false, error: `the Docker daemon is not answering (${docker.error}). Start Docker Desktop (or dockerd) and try again — PortOS does not install it.` };
  }

  // Before the first inspection, because on Windows this is what decides which
  // directory gets inspected at all.
  const misplaced = await ensureVllmProjectDir({ emit });
  if (misplaced) return { success: false, error: misplaced };

  let project = await inspectVllmQwenProject();
  const dir = project.dir;
  const alreadyPrepared = vllmProjectSetupState(project) === 'ready';

  if (!project.hasProject) {
    const git = findCommandOnPath('git');
    if (!git) return { success: false, error: '`git` was not found on PortOS\'s PATH, so the compose project cannot be cloned.' };
    emit(`Cloning ${VLLM_UPSTREAM_REPO} into ${dir}…`);
    const cloned = await runStreamingCommand(git, ['clone', VLLM_UPSTREAM_REPO, dir], emit, { timeoutMs: CLONE_TIMEOUT_MS, splitRe: PROGRESS_SPLIT_RE });
    if (!cloned.success) return { success: false, error: `cloning ${VLLM_UPSTREAM_REPO} failed: ${cloned.error}` };
    project = await inspectVllmQwenProject();
  } else {
    emit(alreadyPrepared
      ? `The project at ${dir} is already built and prepared — checking its .env, then starting it.`
      : `Reusing the existing checkout at ${dir}.`);
  }

  if (!project.composeFile) {
    return { success: false, error: `${dir} holds no docker-compose file, so there is nothing to build. Point ${VLLM_PROJECT_DIR_ENV} at a syv-ai/qwen38-27b-rtx3090 checkout.` };
  }

  // Before the build, so the image and `prepare` both see the final settings.
  // Runs on the already-prepared path too: `EXTRA_ARGS` is exactly the setting a
  // project prepared before this existed is most likely to be missing, and
  // without it every agent turn is rejected.
  const env = await ensureVllmEnvFile(dir, emit);
  await applyVllmApiKeyToProviders(env.effective[VLLM_API_KEY_VAR], emit);

  if (alreadyPrepared) return { success: true };
  if (isCancelled()) return { success: false, error: 'cancelled before the image was built' };

  emit('Building the vLLM image (~9.5 GB, built here — there is no registry to pull it from).');
  const built = await runStreamingCommand('docker', ['compose', 'build'], emit, { timeoutMs: PROVISION_TIMEOUT_MS, cwd: dir, splitRe: PROGRESS_SPLIT_RE });
  if (!built.success) return { success: false, error: `docker compose build failed: ${built.error}` };

  if (isCancelled()) return { success: false, error: 'cancelled after the image build — the image is kept, and re-running resumes from here' };

  if (env.wsl2) warnAboutWsl2PrepareMemory(emit);
  emit('Downloading and requantizing the weights (~20 GB). This step is idempotent and its download resumes, so it is safe to leave running.');
  const prepared = await runStreamingCommand('docker', ['compose', 'run', '--rm', 'prepare'], emit, { timeoutMs: PROVISION_TIMEOUT_MS, cwd: dir, splitRe: PROGRESS_SPLIT_RE });
  if (!prepared.success) return { success: false, error: `docker compose run --rm prepare failed: ${prepared.error}` };

  return { success: true };
}

/**
 * Bring up an ALREADY-prepared project, and nothing else — see
 * `lib/vllmQwenProject.js` for why each refusal exists. No image build, no
 * weight download: those are `provisionVllmQwenProject`, behind their own button.
 *
 * The compose file maps `"${PORT:-18020}:${PORT:-18020}"` and its healthcheck
 * probes `http://127.0.0.1:${PORT:-18020}/health` — both resolved by `docker
 * compose` from ITS OWN caller's environment, not from the project's `.env`
 * (shell env wins over `.env` in compose's variable-substitution precedence).
 * `runStreamingCommand` spawns `docker` inheriting the full PortOS server
 * environment by default, and PortOS's own `PORT` (its API server's port,
 * 5555) collides with the SAME variable name — so an unset `env` here silently
 * remaps the container onto PortOS's own port instead of vLLM's 18020, and the
 * readiness probe (hardcoded to 18020) then reports ECONNREFUSED forever, even
 * though the container is up and healthy. Confirmed on a real RTX 3090 run
 * (#4821) — `docker inspect` showed the resulting bind as literally invalid
 * (`{invalid IP 5555}`) rather than a working mapping on the wrong port.
 * Passing `PORT` explicitly, derived from the endpoint this checklist actually
 * probes, is what keeps compose's substitution aligned with it regardless of
 * whatever `PORT` PortOS's own process happens to be running under.
 *
 * @param {{emit: (line: string) => void, endpoint?: string, isCancelled: () => boolean}} ctx
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function startVllmQwenProject({ emit, endpoint, isCancelled }) {
  // A Windows host whose project was prepared inside WSL — by an earlier
  // provisioning run on another install, or by hand from the feature doc — has
  // it at a UNC path this PortOS has never been told about. Resolving that here
  // as well as in provisioning is what turns "cannot read a models directory"
  // into a start that works.
  const misplaced = await ensureVllmProjectDir({ emit });
  if (misplaced) return { success: false, error: misplaced };

  const project = await inspectVllmQwenProject();
  const blocked = vllmStartBlockedReason(project);
  if (blocked) return { success: false, error: blocked };
  if (isCancelled()) return { success: false, error: 'Cancelled before the container was started.' };
  const port = localEndpointPort(endpoint) || PORTS.VLLM_QWEN;
  emit(`Starting the vLLM container from ${project.dir} (${project.composeFile}).`);
  emit('The image and weights are already on disk — this only brings the service up.');
  return runStreamingCommand(
    'docker',
    ['compose', '--profile', 'single', 'up', '-d'],
    emit,
    { timeoutMs: CONTROL_TIMEOUT_MS, cwd: project.dir, env: { PORT: String(port) } },
  );
}

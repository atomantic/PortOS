/**
 * Everything PortOS does TO the vLLM Qwen3.8-27B compose project.
 *
 * `lib/vllmQwenProject.js` reads what is on disk and `lib/vllmQwenProvision.js` decides what
 * the `.env` must say; this module runs the commands (same split `mtplxServerManager.js` and
 * `llamaServerManager.js` have from `localRuntimeSetup.js`).
 *
 *   - **Provision** (`provisionVllmQwenProject`) — verify source, write `.env`, build, prepare. This
 *     is the ~30 GB and runs ONLY behind the checklist's `provision-start` action, whose
 *     button names the payload. `install()` in the registry still refuses: Docker Desktop, the
 *     NVIDIA Container Toolkit and WSL2 are host-level operator decisions.
 *   - **Start** (`startVllmQwenProject`) — `docker compose up` on a demonstrably prepared
 *     project, and a refusal naming the fix on anything else.
 *
 * Neither ever throws: both run from an SSE route whose headers are already flushed, so every
 * failure comes back as a value the caller turns into a terminal frame.
 */

import { createHash } from 'crypto';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'fs/promises';
import { totalmem } from 'os';
import { dirname, join } from 'path';

import { bufferedSpawnOrThrow } from '../lib/bufferedSpawn.js';
import { atomicWrite, formatBytes, tryReadFile } from '../lib/fileUtils.js';
import { runStreamingCommand } from '../lib/streamingSpawn.js';
import { findCommandOnPath } from '../lib/processEnv.js';
import { localEndpointPort, localRuntimeForProvider } from '../lib/localProviderRuntime.js';
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
import {
  generateVllmApiKey,
  isWsl2Engine,
  mergeEnvFileContents,
  vllmEnvDefaults,
  VLLM_API_KEY_VAR,
  WSL2_PREPARE_CONFIG_HINT,
  WSL2_PREPARE_MIN_BYTES,
} from '../lib/vllmQwenProvision.js';
import { getAllProviders, updateProvider } from './provider/providers.js';
import { ensureWslProjectDir } from './wslProjectPlacement.js';

/** Upstream's frozen packaging of patched vLLM + the requantized checkpoint. */
export const VLLM_UPSTREAM_REPO = 'https://github.com/syv-ai/qwen38-27b-rtx3090';
// This revision builds vLLM 0.27.1 locally and documents the WSL2 settings PortOS supplies.
export const VLLM_UPSTREAM_REVISION = '18db5cb3b56e63e30f64eee7901f0e97e632ab32';

// Compose's image namespace is shared with other checkouts on the same daemon.
// Start and prepare must resolve the same local build, even across a retry.
function vllmComposeOverride(tag) {
  return `services:
  prepare: &built
    image: portos-vllm-qwen:${tag}
    pull_policy: never
  single: &local
    <<: *built
    ports: !override
      - "127.0.0.1:\${PORT:-${PORTS.VLLM_QWEN}}:\${PORT:-${PORTS.VLLM_QWEN}}"
  batch: *local
`;
}

/** A daemon question, and a compose `up` on an image that is already built. */
const CONTROL_TIMEOUT_MS = 60 * 1000;

/** Bound on fetching source; the 30 GB arrives in the two later steps. */
const SOURCE_FETCH_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * The image build and the weights prepare. Sized for a slow line: a bound that kills a 20 GB
 * download at 90% is worse than none, and closing the modal cancels between steps anyway.
 */
const PROVISION_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/**
 * Split docker's output on bare `\r` too, so a layer-pull or tqdm bar that redraws one line
 * surfaces each redraw (`lib/streamLines.js`).
 */
const PROGRESS_SPLIT_RE = /[\r\n]+/;

/**
 * What is on disk, in the four-state vocabulary the readiness checklist speaks
 * (`localRuntimeSetup.js`'s `readRuntimeWeights`). A directory read; never runs docker.
 */
export async function readVllmQwenSetupState() {
  return vllmProjectSetupState(await inspectVllmQwenProject());
}

/**
 * What the shared placement loop (`services/wslProjectPlacement.js`) needs for this stack.
 * `afterInstall` cannot be shared with SGLang: PortOS provisions this stack, so once a distro
 * exists the next click places the project inside it.
 */
const VLLM_PLACEMENT = Object.freeze({
  envVar: VLLM_PROJECT_DIR_ENV,
  leaf: VLLM_PROJECT_LEAF,
  sizeHint: '~20 GB',
  afterInstall: 'click this again and PortOS will place the project inside it for you',
});

/**
 * Settle where this project goes before anything is written to it.
 *
 * On Windows never the default `%USERPROFILE%\qwen-serving`: Docker Desktop's engine is a WSL2
 * VM, so a project on the Windows filesystem is reached over a 9p share and ~20 GB of weights
 * would cross it forever. See `services/wslProjectPlacement.js`.
 *
 * @param {{emit?: (line: string) => void}} [ctx]
 * @returns {Promise<string|null>} the refusal, or `null` once settled (same shape as
 *   `vllmStartBlockedReason`, read back through `inspectVllmQwenProject()`).
 */
export async function ensureVllmProjectDir({ emit } = {}) {
  return ensureWslProjectDir({
    ...VLLM_PLACEMENT,
    emit,
    isSettled: () => vllmProjectDirIsSettled(),
    record: (dir) => recordVllmProjectDir(dir),
  });
}

/**
 * Make the project's `.env` say everything the container needs without overruling anything the
 * operator wrote. The generated API key is a fallback: `mergeEnvFileContents` reports the value
 * IN EFFECT, so an existing key is kept and propagated. Only key NAMES are emitted; the
 * returned `effective` holds the token.
 */
async function ensureVllmEnvFile(dir, emit) {
  const envPath = join(dir, '.env');
  const existing = (await tryReadFile(envPath)) || '';
  // The doc's snippet tests `/proc/version`; `isWsl2Engine` also counts win32, where Docker
  // Desktop's engine IS a WSL2 VM with no `/proc/version` to read (omitting the two WSL2
  // variables there causes a silent crash-loop). So only open the file where it can exist.
  const wsl2 = isWsl2Engine({ procVersion: process.platform === 'linux' ? await tryReadFile('/proc/version') : null });
  const merged = mergeEnvFileContents(existing, vllmEnvDefaults({ apiKey: generateVllmApiKey(), wsl2 }));

  if (merged.added.length > 0) {
    // Atomic and mode-preserving: the file holds the container's bearer token and a truncate in
    // place is readable half-written by a concurrent `docker compose`.
    await atomicWrite(envPath, merged.contents);
    await chmod(envPath, 0o600).catch((err) => {
      if (err?.code !== 'ENOENT') console.log(`⚠️ Could not set permissions on vLLM .env (${err?.code || 'error'})`);
    });
    emit(`Wrote ${merged.added.length} missing setting${merged.added.length === 1 ? '' : 's'} to .env: ${merged.added.join(', ')}.`);
  }
  if (merged.kept.length > 0) {
    emit(`Left the .env values already set for ${merged.kept.join(', ')} exactly as they were.`);
  }
  return { ...merged, wsl2 };
}

/**
 * Name the WSL2 memory ceiling right before the step it kills. Raising it is an operator
 * decision (editing `%UserProfile%\.wslconfig` and `wsl --shutdown` takes the whole VM down,
 * including a PostgreSQL container): detect, name the values, let them decide.
 */
function warnAboutWsl2PrepareMemory(emit) {
  const vmBytes = totalmem();
  // `formatBytes` is 1024-based like WSL2_PREPARE_MIN_BYTES and the hint's "~24 GB"; a
  // 1000-based number would read 25 GB for a VM exactly on the floor.
  emit(process.platform === 'linux' && vmBytes < WSL2_PREPARE_MIN_BYTES
    ? `Warning: this WSL2 VM sees only ${formatBytes(vmBytes)} of RAM. The prepare step is CPU-side and memory-hungry, and under ~24 GB it is SIGKILLed with a bare "Killed" (exit 137) that names nothing about WSL. ${WSL2_PREPARE_CONFIG_HINT}`
    : `WSL2 backs this engine. If the prepare step dies with a bare "Killed" (exit 137), its VM memory ceiling is the cause. ${WSL2_PREPARE_CONFIG_HINT}`);
}

/**
 * Put the container's key on the seeded vLLM providers so the operator never copies it by
 * hand. The key is a secret: stored, never emitted. Providers already carrying it are skipped.
 */
async function applyVllmApiKeyToProviders(apiKey, emit) {
  if (!apiKey) return 0;
  const data = await getAllProviders().catch((err) => {
    emit(`Could not read the provider list to store the container's API key (${err.message}) — paste it from .env onto the vLLM providers yourself.`);
    return null;
  });
  const all = Array.isArray(data?.providers) ? data.providers : [];
  const targets = all.filter((p) => p?.vllmBacked === true && localRuntimeForProvider(p)?.kind === 'vllm' && p.apiKey !== apiKey);
  let stored = 0;
  for (const provider of targets) {
    // A failed provider write must not undo a successful 30 GB provision (the key is in `.env`
    // either way): report and carry on.
    // two seeded records, each a serialized file write
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

// Stage every build input before publishing. A retry after a bad bundle must
// never find an apparently reusable, unpatched checkout.
async function installVllmArtifacts(staging, git) {
  const bundle = new URL('../../docker/vllm-qwen/', import.meta.url);
  const manifest = await readFile(new URL('manifest.sha256', bundle), 'utf8');
  const [revision, ...checksums] = manifest.split(/\r?\n/);
  if (revision !== `# HyperQwen ${VLLM_UPSTREAM_REVISION}`) {
    throw new Error('vLLM artifact manifest does not match the pinned source revision.');
  }
  const destination = join(staging, 'docker', 'portos');
  await mkdir(destination);
  for (const name of ['provision.patch', 'install-apt.sh', 'cuda-packages.sha256', 'requirements.lock']) {
    const bytes = await readFile(new URL(name, bundle));
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (!checksums.includes(`${digest}  ${name}`)) {
      throw new Error(`vLLM artifact checksum mismatch for ${name}.`);
    }
    await writeFile(join(destination, name), bytes, { flag: 'wx' });
  }
  await bufferedSpawnOrThrow(git, ['-C', staging, 'apply', '--index', 'docker/portos/provision.patch'], { timeoutMs: CONTROL_TIMEOUT_MS });
  return createHash('sha256').update(manifest).digest('hex');
}

async function checkoutVllmSource(dir, emit) {
  const git = findCommandOnPath('git');
  if (!git) return { success: false, error: '`git` was not found on PortOS\'s PATH, so the compose project cannot be checked out.' };

  let staging;
  try {
    const parent = dirname(dir);
    await mkdir(parent, { recursive: true });
    // Inspection treats any existing project directory as operator-managed. Publish only a
    // verified checkout so a failed provision cannot enter the reuse branch on retry.
    staging = await mkdtemp(join(parent, '.portos-vllm-'));
    emit(`Fetching vLLM source revision ${VLLM_UPSTREAM_REVISION} from ${VLLM_UPSTREAM_REPO} for ${dir}…`);
    const steps = [
      ['initialize source checkout', ['init', staging], CONTROL_TIMEOUT_MS],
      ['fetch pinned source revision', ['-C', staging, 'fetch', '--no-tags', '--depth', '1', VLLM_UPSTREAM_REPO, VLLM_UPSTREAM_REVISION], SOURCE_FETCH_TIMEOUT_MS],
      ['check out pinned source revision', ['-C', staging, 'checkout', '--detach', 'FETCH_HEAD'], CONTROL_TIMEOUT_MS],
    ];
    for (const [step, args, timeoutMs] of steps) {
      const result = await runStreamingCommand(git, args, emit, { timeoutMs, splitRe: PROGRESS_SPLIT_RE });
      if (!result.success) return { success: false, error: `Could not ${step}: ${result.error}` };
    }
    const { stdout } = await bufferedSpawnOrThrow(git, ['-C', staging, 'rev-parse', 'HEAD'], { timeoutMs: CONTROL_TIMEOUT_MS });
    if (stdout.trim() !== VLLM_UPSTREAM_REVISION) {
      return { success: false, error: `vLLM source revision mismatch: expected ${VLLM_UPSTREAM_REVISION}.` };
    }
    const imageTag = await installVllmArtifacts(staging, git);
    await writeFile(join(staging, 'compose.override.yaml'), vllmComposeOverride(imageTag), { flag: 'wx' });
    await rename(staging, dir);
    return { success: true };
  } catch (err) {
    return { success: false, error: `Could not install verified vLLM source: ${err.message}` };
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true }).catch((err) => {
      emit(`Could not remove the temporary vLLM source checkout at ${staging}: ${err.message}`);
    });
  }
}

/**
 * Check out / build / prepare the upstream compose project, streaming every step. Each step is
 * skipped once landed (upstream's `prepare` is idempotent and resumes), so a cancelled run
 * costs minutes rather than 20 GB.
 *
 * `isCancelled` is checked BETWEEN steps and never handed to build/prepare: killing those
 * mid-flight leaves half-written layers or checkouts.
 *
 * @param {{emit: (line: string) => void, isCancelled: () => boolean}} ctx
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function provisionVllmQwenProject({ emit, isCancelled }) {
  // Docker must ANSWER, not merely be on PATH: a stopped Docker Desktop leaves the binary, and
  // every later step would fail with a compose message rather than a daemon one.
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
    const checkout = await checkoutVllmSource(dir, emit);
    if (!checkout.success) return checkout;
    project = await inspectVllmQwenProject();
  } else {
    emit(alreadyPrepared
      ? `The project at ${dir} is already built and prepared — checking its .env, then starting it.`
      : `Reusing the existing checkout at ${dir}.`);
  }

  if (!project.composeFile) {
    return { success: false, error: `${dir} holds no docker-compose file, so there is nothing to build. Point ${VLLM_PROJECT_DIR_ENV} at a syv-ai/qwen38-27b-rtx3090 checkout.` };
  }

  // Before the build so image and `prepare` see the final settings. Also runs on the
  // already-prepared path: `EXTRA_ARGS` is what an older project is likeliest to lack, and
  // without it every agent turn is rejected.
  const env = await ensureVllmEnvFile(dir, emit);
  await applyVllmApiKeyToProviders(env.effective[VLLM_API_KEY_VAR], emit);

  if (alreadyPrepared) return { success: true };
  if (isCancelled()) return { success: false, error: 'cancelled before the image was built' };

  emit('Building the vLLM image locally (~9.5 GB).');
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
 * Bring up an ALREADY-prepared project, and nothing else (see `lib/vllmQwenProject.js` for why
 * each refusal exists). No image build, no weight download.
 *
 * The compose file maps `"${PORT:-18020}:${PORT:-18020}"` and its healthcheck probes
 * `127.0.0.1:${PORT:-18020}/health`, both resolved from `docker compose`'s OWN caller
 * environment (shell env beats `.env`). `runStreamingCommand` inherits the PortOS server
 * environment, whose `PORT` (5555) collides with that name: unset `env` would remap the
 * container onto 5555 (an invalid bind) while the readiness probe, hardcoded to 18020, reports
 * ECONNREFUSED forever (#4821). So `PORT` is passed explicitly, derived from the endpoint the
 * checklist probes.
 *
 * @param {{emit: (line: string) => void, endpoint?: string, isCancelled: () => boolean}} ctx
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function startVllmQwenProject({ emit, endpoint, isCancelled }) {
  // A Windows host whose project was prepared inside WSL (another install, or by hand) has it at
  // a UNC path this PortOS was never told about; resolving it here as well as in provisioning
  // turns "cannot read a models directory" into a working start.
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

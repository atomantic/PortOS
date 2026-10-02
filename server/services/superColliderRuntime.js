/**
 * Managed SuperCollider runtime I/O (#9412): Docker discovery, the PortOS image
 * build, the contained `sclang` runner, the synthetic readiness probe and its
 * cached evidence. The contract it applies — image naming, containment args,
 * readiness states — is `lib/superColliderRuntime.js`.
 *
 * Nothing here runs on server boot or calls an AI provider. Status reads the
 * Docker engine and image metadata plus the CACHED probe result; only an
 * explicit setup (`npm run setup:supercollider`, or a future setup route)
 * builds the image or renders the probe.
 *
 * Evidence lives in `data/supercollider/runtime-evidence.json`: machine-local,
 * re-derivable by re-running setup, and bound to the local image id — a copy
 * restored onto another machine reads as stale there rather than as ready.
 */

import { existsSync } from 'fs';
import { lstat, mkdir, readdir, readFile, rm, writeFile, chmod } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS } from '../lib/paths.js';
import { atomicWrite } from '../lib/fileCore.js';
import { readJSONFile } from '../lib/jsonIo.js';
import { bufferedSpawn, spawnFailureDetail } from '../lib/bufferedSpawn.js';
import { runStreamingCommand } from '../lib/streamingSpawn.js';
import { whichFirst } from '../lib/processEnv.js';
import { measureWavAudio } from '../lib/wavAudioFile.js';
import {
  SUPERCOLLIDER_CONTAINER_LIMITS,
  SUPERCOLLIDER_CONTAINER_PATHS,
  SUPERCOLLIDER_FALLBACK_USER,
  SUPERCOLLIDER_IMAGE,
  SUPERCOLLIDER_POLICY_FINGERPRINT,
  SUPERCOLLIDER_POLICY_VERSION,
  SUPERCOLLIDER_RECIPE_DIR,
  SUPERCOLLIDER_RENDER_FORMAT,
  SUPERCOLLIDER_RUNTIME_VERSION,
  SUPERCOLLIDER_SMOKE,
  SUPERCOLLIDER_SMOKE_SOURCE,
  buildSuperColliderBuildArgs,
  buildSuperColliderRunArgs,
  evaluateSuperColliderStatus,
  hashSuperColliderRecipe,
  parseDockerImage,
  parseDockerVersion,
  superColliderContainerUser,
  superColliderSmokeFailure,
} from '../lib/superColliderRuntime.js';

const DOCKER_PROBE_TIMEOUT_MS = 15_000;
const DOCKER_RM_TIMEOUT_MS = 30_000;
const BUILD_TIMEOUT_MS = 90 * 60_000;
const MAX_DIAGNOSTIC_CHARS = 600;
const EVIDENCE_SCHEMA = 1;

// Docker Desktop's CLI is not always on a PM2-launched server's PATH.
const DOCKER_FALLBACK_PATHS = [
  '/usr/local/bin/docker',
  '/opt/homebrew/bin/docker',
  '/Applications/Docker.app/Contents/Resources/bin/docker',
];

/** Keep diagnostics bounded: one line, at most MAX_DIAGNOSTIC_CHARS, tail-preferring. */
function clipDiagnostic(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > MAX_DIAGNOSTIC_CHARS ? `…${flat.slice(-MAX_DIAGNOSTIC_CHARS)}` : flat;
}

/**
 * The docker CLI adapter every function here talks through: `capture` runs a
 * short command and buffers its output; `stream` runs a long one line by line
 * with timeout/cancel. Tests pass a fake with the same two methods.
 */
function createDockerCli(bin) {
  return {
    bin,
    capture: (args, { timeoutMs = DOCKER_PROBE_TIMEOUT_MS } = {}) => bufferedSpawn(bin, args, { timeoutMs, killGraceMs: 2_000, shell: false }),
    stream: (args, onLine, options = {}) => runStreamingCommand(bin, args, onLine, options),
  };
}

/** The local docker CLI, or null when it is not installed. */
export async function resolveDockerCli() {
  const bin = await whichFirst('docker') || DOCKER_FALLBACK_PATHS.find((path) => existsSync(path)) || null;
  return bin ? createDockerCli(bin) : null;
}

function resolveDeps({ docker, dataDir = PATHS.data, codeRoot = PATHS.root } = {}) {
  return { docker, dataDir, codeRoot, evidencePath: join(dataDir, 'supercollider', 'runtime-evidence.json') };
}

async function dockerFor(deps) {
  return deps.docker === undefined ? resolveDockerCli() : deps.docker;
}

/** `{ installed, running, clientVersion, serverVersion, os, arch, error }` for a docker CLI (null = not installed). */
async function probeDocker(cli) {
  if (!cli) return { installed: false, running: false, clientVersion: null, serverVersion: null, os: null, arch: null, error: null };
  const result = await cli.capture(['version', '--format', '{{json .}}']);
  // The client prints its half even when the engine is down, so the server
  // version — not the exit code alone — is what proves the engine answered.
  const version = parseDockerVersion(result.stdout);
  const running = Boolean(version.serverVersion);
  return {
    installed: true,
    running,
    ...version,
    error: running ? null : clipDiagnostic(result.timedOut ? 'docker did not answer in time' : spawnFailureDetail(result, 'docker engine not reachable')),
  };
}

/** The managed image's metadata, or null when it is not built. */
async function inspectSuperColliderImage(cli, image = SUPERCOLLIDER_IMAGE) {
  const result = await cli.capture(['image', 'inspect', '--format', '{{json .}}', image]);
  return result.success ? parseDockerImage(result.stdout) : null;
}

/** Hash of the checked-in recipe directory (`docker/supercollider/`). */
async function readSuperColliderRecipeHash({ codeRoot = PATHS.root } = {}) {
  const dir = join(codeRoot, SUPERCOLLIDER_RECIPE_DIR);
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.filter((entry) => entry.isFile())
    .map(async (entry) => ({ name: entry.name, content: await readFile(join(dir, entry.name), 'utf8') })));
  return hashSuperColliderRecipe(files);
}

async function readSuperColliderEvidence(options = {}) {
  const { evidencePath } = resolveDeps(options);
  const evidence = await readJSONFile(evidencePath, null, { allowArray: false, logError: false });
  return evidence?.schema === EVIDENCE_SCHEMA ? evidence : null;
}

/**
 * The readiness verdict (`evaluateSuperColliderStatus`). Asks the Docker engine
 * and reads cached evidence; never builds, pulls or renders.
 */
export async function getSuperColliderStatus(options = {}) {
  const deps = resolveDeps(options);
  const cli = await dockerFor(deps);
  const docker = await probeDocker(cli);
  const [image, evidence, recipeHash] = await Promise.all([
    docker.running ? inspectSuperColliderImage(cli) : null,
    readSuperColliderEvidence(deps),
    readSuperColliderRecipeHash(deps),
  ]);
  return evaluateSuperColliderStatus({ docker, image, evidence, recipeHash });
}

/**
 * Read one file a contained run wrote into its output directory, refusing
 * anything but a regular file within `maxBytes` — the container controls that
 * directory, so a symlink there could otherwise point the host at its own files.
 * Null when absent or refused.
 */
export async function readContainedOutput(outputDir, name, { maxBytes = SUPERCOLLIDER_CONTAINER_LIMITS.maxFileBytes } = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return null;
  const path = join(outputDir, name);
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile() || info.size > maxBytes) return null;
  return readFile(path);
}

/**
 * Run `sclang` on `<inputDir>/<script>` inside one disposable container under
 * the shared containment policy. The container is force-removed afterwards
 * whatever happened — the docker CLI dying does not stop a container, so a
 * timeout or cancel that only killed the CLI would leave the render running.
 * Never rejects for a failed run: `{ ok, error, timedOut, cancelled, containerName }`.
 *
 * @param {object} params
 * @param {{capture: Function, stream: Function}} params.docker
 * @param {string} params.inputDir - host directory holding the frozen source (mounted read-only)
 * @param {string} params.outputDir - job-private host directory (the only writable mount)
 * @param {string} [params.script]
 * @param {Array<string|number>} [params.scriptArgs] - `thisProcess.argv` inside sclang
 * @param {string} [params.image] - tag or image id
 * @param {number} [params.timeoutMs]
 * @param {AbortSignal} [params.signal]
 * @param {(line: string) => void} [params.onLine]
 */
export async function runSuperColliderContainer({
  docker, inputDir, outputDir, script, scriptArgs = [], image = SUPERCOLLIDER_IMAGE,
  timeoutMs = SUPERCOLLIDER_CONTAINER_LIMITS.wallTimeoutMs, signal, onLine,
}) {
  const containerName = `portos-sc-${randomUUID()}`;
  const user = superColliderContainerUser({ uid: process.getuid?.(), gid: process.getgid?.() });
  // The `nobody` fallback does not own the host directory; let it write there.
  if (user === SUPERCOLLIDER_FALLBACK_USER) await chmod(outputDir, 0o777).catch(() => {});
  const args = buildSuperColliderRunArgs({ image, containerName, inputDir, outputDir, script, scriptArgs, user });
  const result = await docker.stream(args, onLine, { timeoutMs, isCancelled: () => Boolean(signal?.aborted) });
  const removal = await docker.capture(['rm', '--force', containerName], { timeoutMs: DOCKER_RM_TIMEOUT_MS });
  if (!removal.success && !/no such container/i.test(`${removal.stderr}`)) {
    console.error(`❌ SuperCollider container ${containerName} cleanup failed: ${clipDiagnostic(spawnFailureDetail(removal, 'docker rm failed'))}`);
  }
  const error = result.success ? null : clipDiagnostic(result.error);
  return {
    ok: result.success,
    error,
    timedOut: Boolean(error?.startsWith('timed out')),
    cancelled: error === 'cancelled',
    containerName,
  };
}

/**
 * Render the shipped synthetic probe through the production runner against
 * `image`, measure the WAV it wrote, and record the result as the readiness
 * evidence for this runtime/policy/image. The job directory is removed either
 * way. Resolves the evidence record.
 */
async function runSuperColliderSmoke({ docker, image, dockerInfo = null, ...options }) {
  const { dataDir, evidencePath } = resolveDeps(options);
  const jobDir = join(dataDir, 'supercollider', 'jobs', `smoke-${randomUUID()}`);
  const inputDir = join(jobDir, 'in');
  const outputDir = join(jobDir, 'out');
  let failure;
  let measurement = null;
  try {
    await mkdir(inputDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(inputDir, SUPERCOLLIDER_SMOKE.script), SUPERCOLLIDER_SMOKE_SOURCE);
    const run = await runSuperColliderContainer({
      docker,
      image: image.id,
      inputDir,
      outputDir,
      script: SUPERCOLLIDER_SMOKE.script,
      scriptArgs: [`${SUPERCOLLIDER_CONTAINER_PATHS.output}/${SUPERCOLLIDER_SMOKE.output}`, SUPERCOLLIDER_SMOKE.durationSec, SUPERCOLLIDER_RENDER_FORMAT.sampleRate],
      timeoutMs: SUPERCOLLIDER_SMOKE.timeoutMs,
    });
    if (run.ok) {
      measurement = measureWavAudio(await readContainedOutput(outputDir, SUPERCOLLIDER_SMOKE.output));
      failure = superColliderSmokeFailure(measurement);
    } else {
      failure = `the probe render failed: ${run.error}`;
    }
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
  const evidence = {
    schema: EVIDENCE_SCHEMA,
    ok: !failure,
    error: failure ? clipDiagnostic(failure) : null,
    checkedAt: new Date().toISOString(),
    runtimeVersion: SUPERCOLLIDER_RUNTIME_VERSION,
    policyVersion: SUPERCOLLIDER_POLICY_VERSION,
    policyFingerprint: SUPERCOLLIDER_POLICY_FINGERPRINT,
    imageId: image.id,
    platform: { os: dockerInfo?.os ?? image.os ?? null, arch: dockerInfo?.arch ?? image.arch ?? null, dockerVersion: dockerInfo?.serverVersion ?? null },
    measurement: measurement && {
      durationMs: measurement.durationMs,
      channels: measurement.channels,
      sampleRate: measurement.sampleRate,
      peak: Number(measurement.peak.toFixed(4)),
      rms: Number(measurement.rms.toFixed(4)),
    },
  };
  await atomicWrite(evidencePath, evidence);
  return evidence;
}

const DOCKER_UNAVAILABLE_STATES = new Set(['docker-missing', 'docker-stopped', 'docker-unsupported']);
let setupInFlight = null;

/**
 * Explicit, idempotent setup: build the image only when it is missing, stale
 * or `rebuild` is asked for (after `confirmBuild` agrees), then run the probe
 * only when the build changed something or no current passing evidence
 * exists. A second run against a ready runtime does neither. Concurrent calls
 * share one run.
 *
 * Resolves `{ outcome, built, probed, status, error }`, outcome one of
 * ready, docker-unavailable, declined, build-failed, smoke-failed.
 */
export function setupSuperColliderRuntime(options = {}) {
  setupInFlight ??= runSetup(options).finally(() => { setupInFlight = null; });
  return setupInFlight;
}

async function runSetup({ rebuild = false, confirmBuild = async () => true, onLine, ...options }) {
  const deps = resolveDeps(options);
  const docker = await dockerFor(deps);
  const statusDeps = { ...options, docker };
  let status = await getSuperColliderStatus(statusDeps);
  const done = (outcome, extra = {}) => ({ outcome, built: false, probed: false, status, error: null, ...extra });
  if (DOCKER_UNAVAILABLE_STATES.has(status.state)) return done('docker-unavailable');

  let built = false;
  if (rebuild || !status.image?.current) {
    if (!await confirmBuild(status)) return done('declined');
    const recipeHash = await readSuperColliderRecipeHash(deps);
    const args = buildSuperColliderBuildArgs({ recipeDir: join(deps.codeRoot, SUPERCOLLIDER_RECIPE_DIR), recipeHash, noCache: rebuild });
    const result = await docker.stream(args, onLine, { timeoutMs: BUILD_TIMEOUT_MS });
    status = await getSuperColliderStatus(statusDeps);
    if (!result.success) return done('build-failed', { error: clipDiagnostic(result.error) });
    if (!status.image?.current) return done('build-failed', { error: 'docker build finished but the expected image is not present' });
    built = true;
  }

  let probed = false;
  if (built || rebuild || !(status.smoke?.current && status.smoke.ok)) {
    await runSuperColliderSmoke({ docker, image: status.image, dockerInfo: status.docker, ...options });
    probed = true;
    status = await getSuperColliderStatus(statusDeps);
  }
  return done(status.ready ? 'ready' : 'smoke-failed', { built, probed, error: status.ready ? null : status.smoke?.error ?? status.message });
}

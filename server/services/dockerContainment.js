/**
 * Docker containment executor (#12844): runs one install or validate step
 * over a repository worktree inside the profile `lib/dockerContainment.js`
 * spells out, and keeps the Docker objects it owns reconciled with the
 * `docker-containment` instance feature.
 *
 * Never falls back to the host: when no local Linux engine is ready, or the
 * pinned image is not pulled, a run is REFUSED with the resolver's reason
 * (`code: 'CONTAINMENT_UNAVAILABLE'`). Callers decide what that means — the
 * autofixer blocks promotion, `contained-run.js` exits non-zero.
 *
 * Node builtins plus dependency-light modules, so the standalone autofixer
 * package can import it. Settings and the feature flag are the caller's input.
 */

import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, chmod, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { bufferedSpawn } from '../lib/bufferedSpawn.js';
import {
  DOCKER_CONTAINMENT_CACHE_VOLUME,
  DOCKER_CONTAINMENT_CREATED_LABEL,
  DOCKER_CONTAINMENT_EGRESS_NETWORK,
  DOCKER_CONTAINMENT_LABEL,
  DOCKER_CONTAINMENT_NODE_IMAGES,
  DOCKER_CONTAINMENT_PATCH_FILE,
  DOCKER_CONTAINMENT_POLICY_VERSION,
  DOCKER_CONTAINMENT_TRACKED_LIST,
  DOCKER_CONTAINMENT_VOLUME_TTL_MS,
  DOCKER_CONTAINMENT_WORKTREE_LABEL,
  assertDockerMountSource,
  buildDockerContainmentNetworkArgs,
  buildDockerContainmentRunArgs,
  buildDockerContainmentVolumeCreateArgs,
  buildDockerContainmentVolumeInitArgs,
  buildDockerEgressProxyCreateArgs,
  buildEgressAllowlist,
  dockerContainmentUser,
  dockerContainmentWorkVolume,
  dockerContainmentWorktreeKey,
  isDigestPinnedImage,
  isDockerContainmentPhase,
  parseNpmrcRegistryHosts,
  resolveDockerContainmentLimits,
  selectDockerContainmentNodeMajor,
} from '../lib/dockerContainment.js';
import { DOCKER_EGRESS_PROXY_READY, DOCKER_EGRESS_PROXY_SOURCE } from '../lib/dockerEgressProxy.js';
import { clipDiagnostic, resolveDockerEngine } from './dockerEngine.js';

export const CONTAINMENT_UNAVAILABLE = 'CONTAINMENT_UNAVAILABLE';
const SHARED = 'shared';
const DOCKER_SHORT_TIMEOUT_MS = 30_000;
const PROXY_READY_TIMEOUT_MS = 20_000;
const PULL_TIMEOUT_MS = 30 * 60_000;
const MAX_HINT_FILE_BYTES = 64 * 1024;

const activeRuns = new Map(); // runId → { abort, worktreeKey }
const worktreeTails = new Map(); // worktreeKey → Promise
let armedThisProcess = false;

const newRunId = () => `r${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;

const refusal = (reason, state = 'unavailable', extra = {}) => ({
  status: 'refused', code: CONTAINMENT_UNAVAILABLE, state, reason, contained: false, ...extra,
});

/** The configured image for a Node major: a digest-pinned operator override, else the shipped pin. */
export function dockerContainmentImages(settings = {}) {
  const overrides = settings?.imageOverrides && typeof settings.imageOverrides === 'object' ? settings.imageOverrides : {};
  const images = { ...DOCKER_CONTAINMENT_NODE_IMAGES };
  for (const [major, ref] of Object.entries(overrides)) {
    if (/^\d{1,3}$/.test(major) && isDigestPinnedImage(ref)) images[Number(major)] = ref;
  }
  return images;
}

async function imagePresent(cli, image) {
  const result = await cli.capture(['image', 'inspect', '--format', '{{.Id}}', image], { timeoutMs: DOCKER_SHORT_TIMEOUT_MS });
  return result.success && Boolean(String(result.stdout).trim());
}

/**
 * The feature card's status: the engine verdict plus which pinned images are
 * pulled. Disabled ⇒ answered without a single Docker call.
 */
export async function getDockerContainmentStatus({ enabled, settings = {}, engine: injected } = {}) {
  const base = { enabled: Boolean(enabled), policyVersion: DOCKER_CONTAINMENT_POLICY_VERSION };
  if (!enabled) return { ...base, state: 'disabled', ready: false, message: 'Docker containment is off. Turn it on to check for a local Docker engine.', engine: null, images: [] };
  const engine = injected ?? await resolveDockerEngine();
  const images = dockerContainmentImages(settings);
  const listed = await Promise.all(Object.entries(images).map(async ([major, ref]) => ({
    major: Number(major), ref, present: engine.ready ? await imagePresent(engine.cli, ref) : false,
  })));
  return { ...base, state: engine.state, ready: engine.ready, message: engine.message, engine: engine.engine, images: listed };
}

/** Explicit operator action: pull one pinned image (never automatic). */
export async function pullDockerContainmentImage({ major, settings = {}, engine: injected, onLine } = {}) {
  const image = dockerContainmentImages(settings)[Number(major)];
  if (!image) return { ok: false, error: `No image is pinned for Node ${major}.` };
  const engine = injected ?? await resolveDockerEngine();
  if (!engine.ready) return { ok: false, error: engine.message, state: engine.state };
  const result = await runDocker(engine.cli, ['pull', image], { timeoutMs: PULL_TIMEOUT_MS, onLine });
  return result.exitCode === 0 ? { ok: true, image } : { ok: false, image, error: clipDiagnostic(result.tail || 'docker pull failed') };
}

/**
 * Spawn one long docker command with line streaming, a bounded output tail and
 * a wall-time limit. `onTimeout` runs before the CLI is killed (the CLI dying
 * does not stop a container, so the caller force-removes it there).
 */
function runDocker(cli, args, { timeoutMs = 0, signal, onLine, onTerminate, maxBytes = 64 * 1024, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let tail = '';
    let truncated = false;
    let terminated = null;
    let settled = false;
    const child = spawnImpl(cli.bin, [...(cli.globalArgs ?? []), ...args], { env: cli.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const finish = (exitCode, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve({ exitCode, error, tail, truncated, terminated });
    };
    const append = (chunk) => {
      const text = chunk.toString();
      tail += text;
      if (tail.length > maxBytes) { tail = tail.slice(-maxBytes); truncated = true; }
      if (typeof onLine === 'function') {
        for (const line of text.split(/\r?\n/)) {
          if (!line) continue;
          try { onLine(line); } catch (err) { console.error(`⚠️ contained-run output hook failed: ${err.message}`); }
        }
      }
    };
    const terminate = (reason) => {
      if (terminated || settled) return;
      terminated = reason;
      Promise.resolve(onTerminate?.(reason))
        .catch((err) => console.error(`❌ Contained run cleanup on ${reason} failed: ${err.message}`))
        .finally(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } });
    };
    const onAbort = () => terminate('cancelled');
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (err) => finish(-1, err.message));
    child.on('close', (code) => finish(code ?? -1));
    const timer = timeoutMs > 0 ? setTimeout(() => terminate('timeout'), timeoutMs) : null;
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

async function readHint(worktree, name) {
  const path = join(worktree, name);
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile() || info.size > MAX_HINT_FILE_BYTES) return null;
  return readFile(path, 'utf8').catch(() => null);
}

/** The host-side read of what the repo declares: Node version and registries. */
async function readRepoHints(worktree) {
  const [nvmrc, nodeVersion, pkgText, npmrc] = await Promise.all(['.nvmrc', '.node-version', 'package.json', '.npmrc'].map((name) => readHint(worktree, name)));
  let enginesNode = null;
  try { enginesNode = JSON.parse(pkgText ?? 'null')?.engines?.node ?? null; } catch { enginesNode = null; }
  return { nvmrc, nodeVersion, enginesNode: typeof enginesNode === 'string' ? enginesNode : null, npmrcHosts: parseNpmrcRegistryHosts(npmrc) };
}

/** Tracked file names (git ls-files), the patch's scope. Empty when not a git checkout. */
async function trackedFiles(worktree) {
  const result = await bufferedSpawn('git', ['-C', worktree, 'ls-files', '-z'], { timeoutMs: DOCKER_SHORT_TIMEOUT_MS, shell: false });
  if (!result.success) return [];
  return String(result.stdout).split('\0').filter((name) => name && !/[\n\r]/.test(name));
}

/** Read the run's patch: a regular file within `maxBytes`, else null (the container controls /out). */
async function readPatch(outputDir, maxBytes) {
  const path = join(outputDir, DOCKER_CONTAINMENT_PATCH_FILE);
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile()) return { patch: null, patchTruncated: false };
  if (info.size > maxBytes) return { patch: null, patchTruncated: true };
  const text = await readFile(path, 'utf8');
  return { patch: text.trim() ? text : null, patchTruncated: false };
}

const capture = (cli, args) => cli.capture(args, { timeoutMs: DOCKER_SHORT_TIMEOUT_MS });
const forceRemoveContainer = (cli, name) => capture(cli, ['rm', '--force', name]);

async function ensureVolume(cli, name, { runId, worktreeKey = null, fresh = false, now }) {
  if (fresh) await capture(cli, ['volume', 'rm', '--force', name]);
  else if ((await capture(cli, ['volume', 'inspect', name])).success) return false;
  const created = await capture(cli, buildDockerContainmentVolumeCreateArgs({ name, runId: worktreeKey ? runId : SHARED, worktreeKey, createdAtMs: now() }));
  if (!created.success) throw new Error(`could not create volume ${name}: ${clipDiagnostic(created.stderr)}`);
  return true;
}

async function ensureEgressNetwork(cli) {
  if ((await capture(cli, ['network', 'inspect', DOCKER_CONTAINMENT_EGRESS_NETWORK])).success) return false;
  const created = await capture(cli, buildDockerContainmentNetworkArgs({ name: DOCKER_CONTAINMENT_EGRESS_NETWORK, runId: SHARED, internal: false }));
  if (!created.success && !/already exists/i.test(created.stderr)) throw new Error(`could not create the egress network: ${clipDiagnostic(created.stderr)}`);
  return created.success;
}

/** Start the run's egress proxy on its internal network and wait for it to listen. */
async function startEgressProxy(cli, { image, runId, network, allowlist, user, sleep }) {
  const name = `portos-contained-proxy-${runId}`;
  const steps = [
    buildDockerEgressProxyCreateArgs({ image, containerName: name, runId, network, allowlist, source: DOCKER_EGRESS_PROXY_SOURCE, user }),
    ['network', 'connect', DOCKER_CONTAINMENT_EGRESS_NETWORK, name],
    ['start', name],
  ];
  for (const args of steps) {
    const result = await capture(cli, args);
    if (!result.success) throw new Error(`egress proxy ${args[0]} failed: ${clipDiagnostic(result.stderr || result.stdout)}`);
  }
  const deadline = Date.now() + PROXY_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const logs = await capture(cli, ['logs', name]);
    if (`${logs.stdout}${logs.stderr}`.includes(DOCKER_EGRESS_PROXY_READY)) return name;
    await sleep(250);
  }
  throw new Error('the egress proxy did not start listening in time');
}

/**
 * Run one contained step.
 *
 * @param {object} p
 * @param {string} p.worktree - repository worktree (mounted read-only)
 * @param {'install'|'validate'} p.phase
 * @param {string} p.command - shell command run as `sh -c` inside the container
 * @param {object} [p.settings] - the `dockerContainment` settings slice
 * @param {string|null} [p.dataDir] - PortOS data directory (never mountable)
 * @param {string} [p.homeDir]
 * @param {number} [p.timeoutMs] - overrides the phase's wall limit
 * @param {AbortSignal} [p.signal]
 * @param {(line: string) => void} [p.onLine]
 * @param {object} [p.deps] - test seams: engine, spawnImpl, now, sleep, tmpRoot
 * @returns {Promise<object>} `{ status: 'completed'|'terminated'|'failed', exitCode, log, patch, contained: true, … }`
 *   or a `{ status: 'refused', code: 'CONTAINMENT_UNAVAILABLE', reason }` refusal.
 */
export async function runContained({
  worktree, phase, command, settings = {}, dataDir = null, homeDir = homedir(),
  timeoutMs, signal, onLine, deps = {},
}) {
  if (!isDockerContainmentPhase(phase)) return refusal('phase must be install or validate', 'invalid');
  if (typeof command !== 'string' || !command.trim()) return refusal('a command is required', 'invalid');
  const engine = deps.engine ?? await resolveDockerEngine();
  if (!engine.ready) return refusal(engine.message, engine.state);

  const realWorktree = await realpath(worktree).catch(() => null);
  if (!realWorktree || !(await lstat(realWorktree).then((info) => info.isDirectory(), () => false))) {
    return refusal('the worktree is not a readable directory', 'invalid');
  }
  const realHome = await realpath(homeDir).catch(() => homeDir);
  const realData = dataDir ? await realpath(dataDir).catch(() => dataDir) : null;
  try {
    assertDockerMountSource(realWorktree, { dataDir: realData, realHome });
  } catch (err) {
    return refusal(err.message, 'mount-refused');
  }

  const hints = await readRepoHints(realWorktree);
  const images = dockerContainmentImages(settings);
  const node = selectDockerContainmentNodeMajor({ ...hints, images });
  if (!node.supported) {
    return refusal(`The repository asks for Node ${node.major} (${node.source}); no image is pinned for it. Supported: ${Object.keys(images).join(', ')}, or add a digest-pinned image override in settings.`, 'unsupported-node');
  }
  if (!await imagePresent(engine.cli, node.image)) {
    return refusal(`The pinned Node ${node.major} image is not pulled on this machine. Use "Pull image" in Settings > Features > Docker containment.`, 'image-missing', { image: node.image });
  }

  const worktreeKey = dockerContainmentWorktreeKey(realWorktree);
  const run = () => executeRun({
    engine, worktree: realWorktree, worktreeKey, phase, command, settings, node, hints,
    dataDir: realData, realHome, timeoutMs, signal, onLine, deps,
  });
  const previous = worktreeTails.get(worktreeKey) ?? Promise.resolve();
  const next = previous.then(run, run);
  const tail = next.then(() => {}, () => {});
  worktreeTails.set(worktreeKey, tail);
  tail.then(() => { if (worktreeTails.get(worktreeKey) === tail) worktreeTails.delete(worktreeKey); });
  return next;
}

async function executeRun({ engine, worktree, worktreeKey, phase, command, settings, node, hints, dataDir, realHome, timeoutMs, signal, onLine, deps }) {
  const { cli } = engine;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
  if (signal?.aborted) return { status: 'terminated', reason: 'cancelled', exitCode: null, log: '', patch: null, contained: true };
  const limits = resolveDockerContainmentLimits(settings?.limits);
  const runId = newRunId();
  const user = dockerContainmentUser({ uid: process.getuid?.(), gid: process.getgid?.() });
  const workVolume = dockerContainmentWorkVolume(worktree);
  const containerName = `portos-contained-${runId}`;
  const network = phase === 'install' ? `portos-contained-net-${runId}` : null;
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener?.('abort', onOuterAbort, { once: true });
  activeRuns.set(runId, { abort: () => controller.abort(), worktreeKey });
  armedThisProcess = true;

  const started = now();
  const runDir = await realpath(await mkdtemp(join(deps.tmpRoot ?? tmpdir(), 'portos-contained-')));
  const inputDir = join(runDir, 'in');
  const outputDir = join(runDir, 'out');
  let proxyName = null;
  let result;
  try {
    await mkdir(inputDir);
    await mkdir(outputDir);
    // The container user may not be the host user (fallback uid); let it write here only.
    await chmod(outputDir, 0o777);
    await writeFile(join(inputDir, DOCKER_CONTAINMENT_TRACKED_LIST), `${(await trackedFiles(worktree)).join('\n')}\n`);
    await sweepDockerContainmentOrphans({ engine, now }).catch((err) => console.error(`❌ Contained-run sweep failed: ${err.message}`));

    const freshWork = await ensureVolume(cli, workVolume, { runId, worktreeKey, fresh: phase === 'install', now });
    const freshCache = await ensureVolume(cli, DOCKER_CONTAINMENT_CACHE_VOLUME, { runId, now });
    const toInit = [freshWork && workVolume, freshCache && DOCKER_CONTAINMENT_CACHE_VOLUME].filter(Boolean);
    if (toInit.length) {
      const init = await capture(cli, buildDockerContainmentVolumeInitArgs({ image: node.image, containerName: `portos-contained-init-${runId}`, runId, volumes: toInit, user }));
      if (!init.success) throw new Error(`could not prepare the run volumes: ${clipDiagnostic(init.stderr)}`);
    }

    if (phase === 'install') {
      await ensureEgressNetwork(cli);
      const created = await capture(cli, buildDockerContainmentNetworkArgs({ name: network, runId }));
      if (!created.success) throw new Error(`could not create the run network: ${clipDiagnostic(created.stderr)}`);
      const allowlist = buildEgressAllowlist({ extraHosts: settings?.extraEgressHosts ?? [], npmrcHosts: hints.npmrcHosts });
      proxyName = await startEgressProxy(cli, { image: node.image, runId, network, allowlist, user, sleep });
      onLine?.(`portos-contained: egress allowed to ${allowlist.join(', ')}`);
    }

    const args = buildDockerContainmentRunArgs({
      phase, image: node.image, containerName, runId, worktree, inputDir, outputDir, workVolume,
      network, command, user, limits, dataDir, realHome,
    });
    const wallMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : (phase === 'install' ? limits.installTimeoutMs : limits.validateTimeoutMs);
    const ran = await runDocker(cli, args, {
      timeoutMs: wallMs,
      signal: controller.signal,
      onLine,
      maxBytes: limits.maxLogBytes,
      spawnImpl: deps.spawnImpl,
      onTerminate: () => forceRemoveContainer(cli, containerName),
    });
    const { patch, patchTruncated } = ran.terminated ? { patch: null, patchTruncated: false } : await readPatch(outputDir, limits.maxPatchBytes);
    const status = ran.terminated ? 'terminated' : (ran.error || ran.exitCode === 125 ? 'failed' : 'completed');
    result = {
      status,
      ...(ran.terminated ? { reason: ran.terminated } : {}),
      ...(ran.error ? { error: ran.error } : {}),
      exitCode: ran.terminated ? null : ran.exitCode,
      log: ran.tail,
      logTruncated: ran.truncated,
      patch,
      patchTruncated,
      contained: true,
    };
  } catch (err) {
    result = { status: 'failed', error: clipDiagnostic(err.message), exitCode: null, log: '', patch: null, contained: true };
  } finally {
    signal?.removeEventListener?.('abort', onOuterAbort);
    await forceRemoveContainer(cli, containerName).catch(() => null);
    if (proxyName) await forceRemoveContainer(cli, proxyName).catch(() => null);
    if (network) await capture(cli, ['network', 'rm', network]).catch(() => null);
    // A killed run's volume may hold half-written state; drop it.
    if (result?.status === 'terminated') await capture(cli, ['volume', 'rm', '--force', workVolume]).catch(() => null);
    await rm(runDir, { recursive: true, force: true }).catch(() => {});
    activeRuns.delete(runId);
  }
  return {
    ...result,
    runId,
    phase,
    nodeMajor: node.major,
    image: node.image,
    engine: { kind: engine.engine?.kind ?? null, context: engine.engine?.context ?? null },
    durationMs: now() - started,
  };
}

const parseRows = (stdout) => String(stdout || '').split('\n').filter(Boolean).map((line) => line.split('\t'));

/**
 * Remove containers, networks and volumes a run left behind (a crash, a
 * restart mid-run). Live runs of this process are skipped; the shared egress
 * network and npm cache stay unless `all` (the feature was turned off).
 */
export async function sweepDockerContainmentOrphans({ engine, all = false, now = Date.now } = {}) {
  const { cli } = engine;
  const active = new Set(activeRuns.keys());
  const activeWorktrees = new Set([...activeRuns.values()].map((run) => run.worktreeKey));
  const label = DOCKER_CONTAINMENT_LABEL;
  const removed = { containers: 0, networks: 0, volumes: 0 };

  const containers = await capture(cli, ['ps', '--all', '--filter', `label=${label}`, '--format', `{{.Names}}\t{{.Label "${label}"}}`]);
  for (const [name, runId] of parseRows(containers.stdout)) {
    if (active.has(runId)) continue;
    if ((await forceRemoveContainer(cli, name)).success) removed.containers += 1;
  }
  const networks = await capture(cli, ['network', 'ls', '--filter', `label=${label}`, '--format', `{{.Name}}\t{{.Label "${label}"}}`]);
  for (const [name, runId] of parseRows(networks.stdout)) {
    if (active.has(runId) || (runId === SHARED && !all)) continue;
    if ((await capture(cli, ['network', 'rm', name])).success) removed.networks += 1;
  }
  const volumes = await capture(cli, ['volume', 'ls', '--filter', `label=${label}`, '--format',
    `{{.Name}}\t{{.Label "${label}"}}\t{{.Label "${DOCKER_CONTAINMENT_WORKTREE_LABEL}"}}\t{{.Label "${DOCKER_CONTAINMENT_CREATED_LABEL}"}}`]);
  for (const [name, runId, worktreeKey, created] of parseRows(volumes.stdout)) {
    if (activeWorktrees.has(worktreeKey) || active.has(runId)) continue;
    const stale = all || (runId !== SHARED && !(Number(created) > now() - DOCKER_CONTAINMENT_VOLUME_TTL_MS));
    if (!stale) continue;
    if ((await capture(cli, ['volume', 'rm', '--force', name])).success) removed.volumes += 1;
  }
  return removed;
}

let reconcileTail = Promise.resolve();

/**
 * Bring PortOS's Docker objects in line with the feature flag. On: verify the
 * engine, create the shared egress network, sweep orphans. Off: cancel live
 * runs and remove everything PortOS created — but only when this process
 * armed it or the user just toggled it, so a fresh install with the feature
 * off makes no Docker call at all. Serialized; logs transitions only.
 */
export function reconcileDockerContainment({ enabled, reason = 'unspecified', engine } = {}) {
  const run = () => reconcileOnce({ enabled, reason, engine });
  const next = reconcileTail.then(run, run);
  reconcileTail = next.then(() => {}, () => {});
  return next;
}

async function reconcileOnce({ enabled, reason, engine: injected }) {
  if (!enabled) {
    if (!armedThisProcess && reason !== 'feature-toggle') return { enabled: false, changed: false };
    for (const run of activeRuns.values()) run.abort();
    const engine = injected ?? await resolveDockerEngine();
    armedThisProcess = false;
    if (!engine.ready) return { enabled: false, changed: false, state: engine.state };
    const removed = await sweepDockerContainmentOrphans({ engine, all: true });
    const changed = Object.values(removed).some(Boolean);
    if (changed) console.log(`🐳 Docker containment disarmed (${reason}): removed ${removed.containers} container(s), ${removed.networks} network(s), ${removed.volumes} volume(s)`);
    return { enabled: false, changed, removed };
  }
  const engine = injected ?? await resolveDockerEngine();
  armedThisProcess = true;
  if (!engine.ready) {
    console.warn(`⚠️ Docker containment is on but not ready (${engine.state}): ${engine.message}`);
    return { enabled: true, changed: false, state: engine.state };
  }
  const networkCreated = await ensureEgressNetwork(engine.cli);
  const removed = await sweepDockerContainmentOrphans({ engine });
  const changed = networkCreated || Object.values(removed).some(Boolean);
  if (changed) console.log(`🐳 Docker containment armed (${reason}) on ${engine.engine?.label ?? 'Docker'}`);
  return { enabled: true, changed, state: engine.state, removed };
}

/** Test seam: forget process-level arming and queues. */
export function __resetDockerContainmentState() {
  activeRuns.clear();
  worktreeTails.clear();
  armedThisProcess = false;
  reconcileTail = Promise.resolve();
}

/**
 * The Node.js runtime PortOS runs on: what it is, whether a newer stable or
 * security release exists, and the in-place update through nvm.
 *
 * Node ships security releases often enough that "which Node is PortOS on?"
 * has to be answerable from the UI, and answering it from a terminal is
 * misleading: pm2 resolves `interpreter: 'node'` against the DAEMON's PATH, so
 * the running server can be on a different Node than `node -v` or nvm's
 * default. Everything here reads the running process (`process.version`) and
 * the daemon's own report rather than PATH.
 *
 * An update never mutates a live runtime. It installs the target with nvm,
 * aligns that Node's global pm2 CLI with the version PortOS ships, pins
 * `PORTOS_NODE_INTERPRETER` (lib/nodeInterpreterPin.js), and only then hands
 * off to the ordinary self-update lifecycle (`startPortosSelfUpdate`, mode
 * `refresh`). That lifecycle already owns everything a runtime switch needs:
 * the restart refusals, the update lock, rebuilding native modules on the new
 * Node (launchUpdate puts the pin first on PATH), the daemon reload
 * (pm2-daemon-refresh.js compares the daemon's Node with the pin), and the
 * `pm2 delete` + `pm2 start` that makes pm2 read the new interpreter.
 *
 * The boot script (`pm2 startup`) needs sudo, so it is reported with the exact
 * command to run, never run from here.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { homedir, userInfo } from 'os';
// nvm, launchd and systemd paths are POSIX-only; Windows never reaches an update.
import { posix } from 'path';
import { ServerError } from '../lib/errorHandler.js';
import { PATHS, atomicWrite } from '../lib/fileUtils.js';
import { runStreamingCommand } from '../lib/streamingSpawn.js';
import { withoutServerSecretsEnv } from '../lib/processEnv.js';
import {
  NODE_INTERPRETER_ENV_KEY,
  resolvePinnedNodeInterpreter,
  withNodeBinOnPath,
} from '../lib/nodeInterpreterPin.js';
import { readPortosEnvValue, upsertPortosEnvLine } from '../lib/portosEnv.js';
import { runtimeUpdateEvents } from './runtimeUpdateEvents.js';
import {
  SUPPORTED_NODE_RANGE,
  compareVersions,
  nodeSecurityBaseline,
  satisfiesVersionRequirement,
} from '../../scripts/checkNodeVersion.js';

const IS_WIN = process.platform === 'win32';
const { dirname, join } = posix;
const VERSION_RE = /^v\d+\.\d+\.\d+$/;
const NODE_INDEX_URL = 'https://nodejs.org/dist/index.json';
const PM2_LATEST_URL = 'https://registry.npmjs.org/pm2/latest';
const FETCH_TIMEOUT_MS = 10_000;
const LATEST_TTL_MS = 6 * 60 * 60 * 1000;
const LATEST_ERROR_TTL_MS = 10 * 60 * 1000;
const NVM_INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
const NPM_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

// Homebrew's nvm formula ships nvm.sh outside NVM_DIR, which then holds only
// versions/ and alias/.
const NVM_SCRIPT_CANDIDATES = [
  '/opt/homebrew/opt/nvm/nvm.sh',
  '/usr/local/opt/nvm/nvm.sh',
  '/home/linuxbrew/.linuxbrew/opt/nvm/nvm.sh',
];

/** nvm's directory and loader script, or null when nvm is not installed. */
function resolveNvm({ env = process.env, exists = existsSync, home = homedir() } = {}) {
  const dir = env.NVM_DIR || join(home, '.nvm');
  if (!exists(dir)) return null;
  const script = [join(dir, 'nvm.sh'), ...NVM_SCRIPT_CANDIDATES].find((candidate) => exists(candidate));
  return script ? { dir, script } : null;
}

const nvmNodeBinary = (dir, version) => join(dir, 'versions', 'node', version, 'bin', 'node');

function listNvmVersions(dir) {
  let entries = [];
  try {
    entries = readdirSync(join(dir, 'versions', 'node'));
  } catch {
    return [];
  }
  return entries.filter((name) => VERSION_RE.test(name)).sort((a, b) => compareVersions(b, a));
}

/** nvm's default alias when it names an exact version; `lts/*`-style aliases read as null. */
function readNvmDefault(dir) {
  let alias = '';
  try {
    alias = readFileSync(join(dir, 'alias', 'default'), 'utf8').trim();
  } catch {
    return null;
  }
  const version = alias.startsWith('v') ? alias : `v${alias}`;
  return VERSION_RE.test(version) ? version : null;
}

/** Where a node binary came from, for the label next to its version. */
function classifyNodeSource(execPath, nvmDir) {
  const path = String(execPath || '');
  if (nvmDir && path.startsWith(join(nvmDir, 'versions', 'node'))) return 'nvm';
  if (/\/(homebrew|linuxbrew|Cellar)\//.test(path)) return 'homebrew';
  return 'other';
}

/**
 * The update choices for a running version, from nodejs.org's release index.
 *
 * Offers the newest release on the running major line (the security patch),
 * the newest LTS, and the newest release overall, each only when it is newer
 * than what runs and inside PortOS's supported range. `securityUpdate` is true
 * when a release newer than the running one on its own line is flagged as a
 * security release.
 */
function summarizeNodeReleases(releases, runningVersion) {
  const supported = (Array.isArray(releases) ? releases : [])
    .filter((release) => VERSION_RE.test(release?.version || ''))
    .filter((release) => satisfiesVersionRequirement(release.version, SUPPORTED_NODE_RANGE) === true)
    .sort((a, b) => compareVersions(b.version, a.version));
  const major = (version) => Number(version.slice(1).split('.')[0]);
  const runningMajor = major(runningVersion);
  const newer = (release) => compareVersions(release.version, runningVersion) > 0;

  const latestInLine = supported.find((release) => major(release.version) === runningMajor) || null;
  const latestLts = supported.find((release) => release.lts) || null;
  const latestCurrent = supported[0] || null;
  const newerInLine = supported.filter((release) => newer(release) && major(release.version) === runningMajor);
  const latestSecurity = newerInLine.find((release) => release.security === true) || null;
  const securityUpdate = Boolean(latestSecurity);
  const securityVerified = newerInLine.every((release) => typeof release.security === 'boolean');

  const offers = [];
  const offer = (release, label) => {
    if (!release || !newer(release) || offers.some((entry) => entry.version === release.version)) return;
    offers.push({
      version: release.version,
      label,
      lts: release.lts ? String(release.lts) : null,
      date: release.date || null,
    });
  };
  offer(latestInLine, `Latest ${runningMajor}.x`);
  offer(latestLts, 'Latest LTS');
  offer(latestCurrent, 'Latest release');

  const pick = (release) => (release ? { version: release.version, lts: release.lts ? String(release.lts) : null, date: release.date || null } : null);
  return {
    latestInLine: pick(latestInLine),
    latestLts: pick(latestLts),
    latestCurrent: pick(latestCurrent),
    latestSecurity: pick(latestSecurity),
    securityUpdate,
    securityVerified,
    offers,
  };
}

// nodejs.org's index and npm's pm2 dist-tag, cached. `value: null` is the
// not-fetched sentinel; a failure backs off for the short TTL instead of
// poisoning the cache or refetching on every panel load.
const caches = { node: { value: null, fetchedAt: 0 }, pm2: { value: null, fetchedAt: 0 } };

function resetNodeRuntimeCaches() {
  caches.node = { value: null, fetchedAt: 0 };
  caches.pm2 = { value: null, fetchedAt: 0 };
}

async function cachedFetch(key, url, pickValue) {
  const entry = caches[key];
  const age = Date.now() - entry.fetchedAt;
  if (entry.value && age < LATEST_TTL_MS) return entry.value;
  if (!entry.value && entry.fetchedAt && age < LATEST_ERROR_TTL_MS) return null;
  const value = await fetch(url, {
    headers: { 'User-Agent': 'PortOS', Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  }).then((res) => (res.ok ? res.json() : null)).then((body) => (body ? pickValue(body) : null)).catch(() => null);
  caches[key] = { value, fetchedAt: Date.now() };
  return value;
}

const getNodeReleaseIndex = () => cachedFetch('node', NODE_INDEX_URL, (body) => (Array.isArray(body) ? body : null));
const getLatestPm2Version = () => cachedFetch('pm2', PM2_LATEST_URL, (body) => (typeof body?.version === 'string' ? body.version : null));

function readPackageVersion(packageJsonPath) {
  try {
    const version = JSON.parse(readFileSync(packageJsonPath, 'utf8')).version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

/** The pm2 PortOS ships (its pinned root dependency). */
const shippedPm2Version = () => readPackageVersion(join(PATHS.root, 'node_modules', 'pm2', 'package.json'));

/**
 * npm's global prefix for a node binary. Homebrew runs node from its Cellar
 * keg (`<brew>/Cellar/node/<v>/bin/node`) while globals live under `<brew>`;
 * nvm and official installs keep them beside the binary's own `bin/`.
 */
function nodeGlobalPrefix(nodeBinary) {
  const cellar = nodeBinary.indexOf('/Cellar/');
  return cellar > 0 ? nodeBinary.slice(0, cellar) : dirname(dirname(nodeBinary));
}

/** Distinguish a missing global CLI from an unreadable or unparseable one. */
function globalPm2Status(nodeBinary, { readText = readFileSync, isWindows = IS_WIN } = {}) {
  if (!nodeBinary || isWindows) return { version: null, state: 'unsupported' };
  try {
    const version = JSON.parse(readText(join(nodeGlobalPrefix(nodeBinary), 'lib', 'node_modules', 'pm2', 'package.json'), 'utf8')).version;
    return typeof version === 'string' && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)
      ? { version, state: 'available' }
      : { version: null, state: 'unverified' };
  } catch (error) {
    return { version: null, state: ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'missing' : 'unverified' };
  }
}

const NVM_BIN_SEGMENT = /(\/\.nvm\/versions\/node\/)v\d+\.\d+\.\d+(\/bin)/g;
const nvmVersionOf = (binDir) => binDir.match(/\/\.nvm\/versions\/node\/(v\d+\.\d+\.\d+)\/bin$/)?.[1] || null;

/**
 * A launchd agent's nvm Node paths moved to `binDir`'s version, or null when
 * there is nothing PortOS can safely rewrite: the target is not an nvm Node,
 * or the agent names no nvm Node at all (pm2 startup generated it elsewhere).
 */
function rewriteLaunchAgent(contents, binDir) {
  const version = nvmVersionOf(binDir);
  if (!version || typeof contents !== 'string' || !NVM_BIN_SEGMENT.test(contents)) return null;
  NVM_BIN_SEGMENT.lastIndex = 0;
  return contents.replace(NVM_BIN_SEGMENT, `$1${version}$2`);
}

function startupFileFor(system, home, user) {
  return system === 'launchd'
    ? join(home, 'Library', 'LaunchAgents', `pm2.${user}.plist`)
    : `/etc/systemd/system/pm2-${user}.service`;
}

/**
 * Whether the boot-time `pm2 resurrect` still runs from an older Node. A macOS
 * LaunchAgent lives in the user's own Library, so PortOS can repoint its nvm
 * paths itself (`fixable`); anything else gets the sudo command that
 * regenerates it. Null where PortOS can't tell (Windows, no supported init).
 */
function getStartupStatus({ nodeBinary, platform = process.platform, home = homedir(), user = safeUserName(), readText = readTextOrNull } = {}) {
  const system = platform === 'darwin' ? 'launchd' : platform === 'linux' ? 'systemd' : null;
  if (!system || !nodeBinary || !user) return null;
  const binDir = dirname(nodeBinary);
  const globalBin = join(nodeGlobalPrefix(nodeBinary), 'bin');
  const contents = readText(startupFileFor(system, home, user));
  const current = contents === null ? null : contents.includes(binDir) || contents.includes(globalBin);
  return {
    system,
    configured: contents !== null,
    current,
    fixable: system === 'launchd' && current === false && rewriteLaunchAgent(contents, binDir) !== null,
    command: `sudo env PATH=$PATH:${binDir} ${join(globalBin, 'pm2')} startup ${system} -u ${user} --hp ${home}`,
  };
}

/**
 * Repoint the LaunchAgent at `nodeBinary`'s nvm version. Takes effect at the
 * next login; nothing is restarted.
 * @returns {Promise<(() => Promise<void>)|null>} an undo that writes the
 *   previous agent back, or null when nothing was rewritten
 */
export async function repairStartup(nodeBinary = resolvePinnedNodeInterpreter() || process.execPath) {
  const user = safeUserName();
  const status = getStartupStatus({ nodeBinary, user });
  if (!status?.fixable) return null;
  const file = startupFileFor(status.system, homedir(), user);
  const previous = readTextOrNull(file);
  const next = rewriteLaunchAgent(previous, dirname(nodeBinary));
  if (next === null) return null;
  await atomicWrite(file, next);
  return () => atomicWrite(file, previous);
}

function safeUserName() {
  try {
    return userInfo().username;
  } catch {
    return null;
  }
}

function readTextOrNull(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

async function readDaemonIdentity() {
  const { getDaemonIdentity } = await import('./pm2.js');
  return getDaemonIdentity().catch(() => null);
}

/** Everything the Node runtime panel renders. */
export async function getNodeRuntimeStatus() {
  const nvm = IS_WIN ? null : resolveNvm();
  const running = process.version;
  const pinned = resolvePinnedNodeInterpreter();
  const [releases, latestPm2, daemon] = await Promise.all([
    getNodeReleaseIndex(),
    getLatestPm2Version(),
    readDaemonIdentity(),
  ]);
  const summary = releases ? summarizeNodeReleases(releases, running) : null;
  const shipped = shippedPm2Version();
  const cliNode = pinned || process.execPath;
  const cliStatus = globalPm2Status(cliNode);
  const cli = cliStatus.version;

  const blockedReason = IS_WIN
    ? 'Updating Node from PortOS needs nvm, which is not available on Windows. Update Node with your installer, then update PortOS.'
    : !nvm
      ? 'nvm is not installed. Install nvm (https://github.com/nvm-sh/nvm) to update Node from PortOS.'
      : null;

  // Behind, not merely different: a newer pm2 someone installed globally is not
  // worth a restart. The daemon follows the pin; an unpinned install never asked it to move.
  const older = (version) => Boolean(version && shipped && compareVersions(version, shipped) < 0);
  const daemonStale = Boolean(daemon && (
    older(daemon.pm2Version) || (pinned && daemon.nodeVersion && `v${daemon.nodeVersion}` !== running)
  ));

  return {
    node: {
      version: running,
      execPath: process.execPath,
      source: classifyNodeSource(process.execPath, nvm?.dir),
      pinned,
      supportedRange: SUPPORTED_NODE_RANGE,
      inSupportedRange: satisfiesVersionRequirement(running, SUPPORTED_NODE_RANGE) === true,
      securityBaseline: nodeSecurityBaseline(running),
    },
    nvm: nvm ? {
      dir: nvm.dir,
      defaultVersion: readNvmDefault(nvm.dir),
      installed: listNvmVersions(nvm.dir),
    } : null,
    releases: summary,
    releasesError: releases ? null : 'Could not reach nodejs.org for the release list.',
    pm2: {
      shipped,
      latest: latestPm2,
      daemon,
      cli,
      cliState: cliStatus.state,
      cliBehind: older(cli),
      daemonStale,
    },
    // The command runs that Node's global pm2, so offer it only where one exists.
    startup: cli === null ? null : getStartupStatus({ nodeBinary: cliNode }),
    canUpdate: blockedReason === null,
    blockedReason,
    job: currentJob ? { kind: currentJob.kind, startedAt: currentJob.startedAt } : null,
  };
}

// One runtime job at a time; the self-update lock takes over once it launches.
let currentJob = null;

/** Refuse unless nothing is running that a restart would kill. */
async function assertIdleForRestart() {
  const [{ getSystemActivity }, { describeActivityBlockers }, { checkPortosUpdatePreflight }] = await Promise.all([
    import('./activeProcessing.js'),
    import('../lib/systemIdle.js'),
    import('./updatePreflight.js'),
  ]);
  const processing = await getSystemActivity().catch(() => null);
  if (!processing?.activity) {
    throw new ServerError('Could not confirm PortOS is idle. Try again in a moment.', { status: 503, code: 'ACTIVITY_UNAVAILABLE' });
  }
  if (!processing.activity.idle) {
    throw new ServerError(
      `PortOS is busy (${describeActivityBlockers(processing.activity.blockers)}). Switching Node restarts PortOS, so it waits until that finishes.`,
      { status: 409, code: 'SYSTEM_BUSY' },
    );
  }
  // A fork's own main is what it runs; a runtime switch is not the moment to
  // demand a fork sync.
  await checkPortosUpdatePreflight({ acknowledgeFork: true });
}

const childEnvFor = (nodeBinary) => withNodeBinOnPath(withoutServerSecretsEnv(process.env), nodeBinary);

function nvmCommand(nvm, args) {
  // Arguments travel as positional parameters, never interpolated into the script.
  return ['bash', ['-c', 'export NVM_DIR="$1"; . "$2" --no-use; shift 2; nvm "$@"', 'portos-nvm', nvm.dir, nvm.script, ...args]];
}

async function runStep(emit, step, label, command, args, { timeoutMs, env }) {
  emit(step, 'running', label);
  let last = '';
  const run = await runStreamingCommand(command, args, (line) => {
    const text = String(line).trim();
    if (!text || text === last) return;
    last = text;
    emit(step, 'running', text.slice(0, 200));
  }, { timeoutMs, env });
  if (!run.success) {
    throw new ServerError(`${label} failed: ${run.error || 'unknown error'}`, { status: 502, code: 'NODE_RUNTIME_STEP_FAILED' });
  }
  emit(step, 'done', label.replace(/…$/, ''));
}

async function installGlobalPm2(emit, nodeBinary, version) {
  await runStep(emit, 'pm2-cli', `Installing pm2 ${version} for Node ${nodeVersionOf(nodeBinary)}…`,
    join(dirname(nodeBinary), 'npm'), ['install', '-g', `pm2@${version}`],
    { timeoutMs: NPM_INSTALL_TIMEOUT_MS, env: childEnvFor(nodeBinary) });
}

const nodeVersionOf = (nodeBinary) => nodeBinary.match(/(v\d+\.\d+\.\d+)/)?.[1] || 'current';

/**
 * Pin PortOS to `nodeBinary` and run the restart lifecycle on it. Restores the
 * previous pin when the launch is refused, so a later plain restart never picks
 * up a runtime whose native modules were not rebuilt.
 */
async function pinAndRestart({ io, emit, nodeBinary }) {
  await assertIdleForRestart();
  const previous = readPortosEnvValue(NODE_INTERPRETER_ENV_KEY);
  if (nodeBinary) {
    emit('node-pin', 'running', 'Pinning PortOS to the new Node…');
    await upsertPortosEnvLine(NODE_INTERPRETER_ENV_KEY, nodeBinary);
    emit('node-pin', 'done', `PortOS will run ${nodeBinary}`);
  }
  // Best effort: a stale boot script only matters at the next login, and the
  // panel still shows the command when this could not fix it.
  const undoStartup = nodeBinary
    ? await repairStartup(nodeBinary)
      .then((undo) => { if (undo) emit('pm2-startup', 'done', 'Start-on-boot now uses the new Node'); return undo; })
      .catch((error) => { console.warn(`⚠️ Could not update the pm2 LaunchAgent: ${error.message}`); return null; })
    : null;
  const { startPortosSelfUpdate } = await import('./portosSelfUpdate.js');
  // A refused launch puts the pin and the boot script back together, so boot
  // never starts a Node PortOS is not running on.
  await startPortosSelfUpdate({ io, acknowledgeFork: true, preflightAlreadyRun: true, mode: 'refresh' }).catch(async (error) => {
    if (nodeBinary) await upsertPortosEnvLine(NODE_INTERPRETER_ENV_KEY, previous ?? '');
    await undoStartup?.().catch((undoError) => console.warn(`⚠️ Could not restore the pm2 LaunchAgent: ${undoError.message}`));
    throw error;
  });
}

function launchJob(kind, io, work, { restart = true } = {}) {
  if (currentJob) {
    throw new ServerError('A Node or pm2 update is already running.', { status: 409, code: 'NODE_RUNTIME_BUSY' });
  }
  currentJob = { kind, startedAt: new Date().toISOString() };
  const emit = (step, status, message) => io?.emit('portos:update:step', { step, status, message, timestamp: Date.now() });
  // Runs past the response: nvm downloads take minutes, and the restart this
  // ends in outlives the request anyway. Progress and failure go out on the
  // same `portos:update:*` channel the Update tab already renders.
  Promise.resolve()
    .then(() => work(emit))
    .catch((error) => {
      console.error(`❌ ${kind} failed: ${error.message}`);
      io?.emit('portos:update:error', { message: error.message, step: kind });
    })
    .finally(() => { currentJob = null; runtimeUpdateEvents.emit('changed'); });
  // `restart: false` tells the Update tab not to wait for a restart.
  return { started: true, restart };
}

/**
 * Install `version` with nvm, make it nvm's default, give it the pm2 CLI
 * PortOS ships, then restart PortOS on it.
 */
export async function startNodeUpdate({ version, io }) {
  if (!VERSION_RE.test(version || '')) {
    throw new ServerError('version must look like v26.12.1', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const status = await getNodeRuntimeStatus();
  if (!status.canUpdate) throw new ServerError(status.blockedReason, { status: 409, code: 'NODE_UPDATE_UNAVAILABLE' });
  if (!status.releases?.offers.some((offer) => offer.version === version)) {
    throw new ServerError(`${version} is not an available update for Node ${status.node.version}.`, { status: 400, code: 'NODE_VERSION_NOT_OFFERED' });
  }
  // Refuse up front so a busy install isn't left with a download it can't use yet.
  await assertIdleForRestart();
  const nvm = resolveNvm();
  const nodeBinary = nvmNodeBinary(nvm.dir, version);

  return launchJob('node-update', io, async (emit) => {
    const [cmd, args] = nvmCommand(nvm, ['install', version]);
    await runStep(emit, 'node-install', `Installing Node ${version} with nvm…`, cmd, args,
      { timeoutMs: NVM_INSTALL_TIMEOUT_MS, env: withoutServerSecretsEnv(process.env) });
    if (!existsSync(nodeBinary)) {
      throw new ServerError(`nvm finished but ${nodeBinary} is missing.`, { status: 502, code: 'NODE_RUNTIME_STEP_FAILED' });
    }
    const [aliasCmd, aliasArgs] = nvmCommand(nvm, ['alias', 'default', version]);
    await runStep(emit, 'node-default', `Making ${version} nvm's default…`, aliasCmd, aliasArgs,
      { timeoutMs: 60_000, env: withoutServerSecretsEnv(process.env) });
    if (status.pm2.shipped) await installGlobalPm2(emit, nodeBinary, status.pm2.shipped);
    await pinAndRestart({ io, emit, nodeBinary });
  });
}

/**
 * Bring pm2 in line with the version PortOS ships: the terminal's global CLI
 * under PortOS's Node, and the daemon (reloaded by the restart lifecycle) when
 * it runs an older pm2 or Node. No restart when only the CLI was behind.
 */
export async function startPm2Update({ io }) {
  const status = await getNodeRuntimeStatus();
  const { shipped, cliBehind, daemonStale } = status.pm2;
  if (!shipped) throw new ServerError('PortOS\'s own pm2 is missing. Run the PortOS update first.', { status: 409, code: 'PM2_MISSING' });
  const cliNode = status.node.pinned || process.execPath;
  if (!cliBehind && !daemonStale) {
    throw new ServerError(`pm2 is already on ${shipped}.`, { status: 409, code: 'PM2_CURRENT' });
  }
  if (daemonStale) await assertIdleForRestart();

  return launchJob('pm2-update', io, async (emit) => {
    if (cliBehind) await installGlobalPm2(emit, cliNode, shipped);
    if (daemonStale) {
      await pinAndRestart({ io, emit, nodeBinary: null });
    } else {
      io?.emit('portos:node-runtime:changed', { reason: 'pm2-cli' });
    }
  }, { restart: daemonStale });
}

export const __testing = {
  globalPm2Status,
  getStartupStatus,
  resetNodeRuntimeCaches,
  resolveNvm,
  rewriteLaunchAgent,
  summarizeNodeReleases,
};

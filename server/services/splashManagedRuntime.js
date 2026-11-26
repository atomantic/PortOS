/** Installs the pinned Splash CLI and its model cache in a private per-PortOS runtime directory. */

// Storage: regenerable machine-local cache, not app data. `data/cache` is
// excluded from PortOS backups and these artifacts never federate.
import { constants } from 'fs';
import { spawn } from '../lib/childProcess.js';
import { artifactDownloadEnv } from '../lib/processEnv.js';
import { withSpawnCwdEnv } from '../lib/spawnCwd.js';
import { access, mkdir, mkdtemp, readFile, rename, rm } from 'fs/promises';
import { cpus } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { execFile } from '../lib/childProcess.js';
import { atomicWrite, dirSize } from '../lib/fileCore.js';
import { PATHS } from '../lib/paths.js';
import { ServerError } from '../lib/errorHandler.js';
import { assessDownloadPreflight, assertDownloadFits, streamResumableDownload } from '../lib/downloadPreflight.js';
import { SPLASH_MODEL, SPLASH_ORIGIN } from '../lib/splashRuntime.js';
import { runStreamingCommand } from '../lib/streamingSpawn.js';

export const SPLASH_VERSION = '1.7.2';
const FILE = `splash-${SPLASH_VERSION}-arm64-macos26`;
const ASSET_URL = `https://github.com/incoai/splash/releases/download/${SPLASH_VERSION}/${FILE}.tar.gz`;
const ASSET_SHA256 = '40a1e6d585ed8f51b2f2e17c331e7d9533a1b666e1e6e418ddd623bdd3a29e2b';
// Approximate Inkling 2 Mini plus drafter download, the figure Install quotes.
const MODEL_BYTES = 17e9;
const MODEL_ARGS = [
  '--model', 'unsloth/Inkling-2-Mini-GGUF:UD-Q4_K_M',
  '--revision', '8078d149286eec7193795413b9e0643da6d11fa1',
  '--language-only',
];

export const splashRoot = () => join(PATHS.data, 'cache', 'runtimes', 'splash');
const releaseDirectory = (version) => join(splashRoot(), `runtime-${version}`);
const activeFile = () => join(splashRoot(), 'active-version');
const python = (directory) => join(directory, 'python', 'bin', 'python3');
export const splashLauncher = (version) => join(releaseDirectory(version), 'install', 'launcher.py');
const VERSION = /^\d+\.\d+\.\d+$/;

export const SPLASH_UNSUPPORTED_REASON = 'Splash requires macOS 26.4 or later and an Apple M3 or newer.';

let productVersion;
function macProductVersion() {
  productVersion ??= promisify(execFile)('/usr/bin/sw_vers', ['-productVersion'], { timeout: 1500 })
    .then(({ stdout }) => stdout.trim()).catch(() => '');
  return productVersion;
}

export async function supportsManagedSplash({ platform = process.platform, arch = process.arch, macVersion, cpuModel } = {}) {
  if (platform !== 'darwin' || arch !== 'arm64') return false;
  const [major, minor] = (macVersion ?? await macProductVersion()).split('.').map(Number);
  if (!(major > 26 || (major === 26 && minor >= 4))) return false;
  // The vendor's device-check remains authoritative for future SoCs.
  return !/^Apple M[12]\b/.test(cpuModel ?? cpus()[0]?.model ?? '');
}

export async function readInstalledSplashVersion() {
  const version = (await readFile(activeFile(), 'utf8').catch(() => '')).trim();
  if (!VERSION.test(version)) return null;
  const directory = releaseDirectory(version);
  const usable = await Promise.all([
    access(python(directory), constants.X_OK),
    access(splashLauncher(version), constants.R_OK),
  ]).then(() => true).catch(() => false);
  return usable ? version : null;
}

// The release's Python subprocesses need a private HOME for Splash's model
// assemblies, cache and process locks. No operator tokens, Splash desktop
// keys, provider configuration or Python injection vars reach the runtime.
function cleanEnvironment() {
  const home = join(splashRoot(), 'home');
  return {
    HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HF_HOME: join(home, '.cache', 'huggingface'), HF_HUB_DISABLE_IMPLICIT_TOKEN: '1',
  };
}

export function splashLaunchPrefix(version) {
  const directory = releaseDirectory(version);
  const assignments = Object.entries(cleanEnvironment()).map(([key, value]) => `${key}=${value}`);
  return ['-i', ...assignments, python(directory), splashLauncher(version), 'serve'];
}

export function splashLaunchArgs(version, model, context, port) {
  return [
    ...splashLaunchPrefix(version), ...MODEL_ARGS,
    '--host', '127.0.0.1', '--port', String(port), '--served-model-name', model,
    '--announce-served-name', '--max-context', String(context), '--offline',
  ];
}

async function runInstallStep(command, args, { cwd, timeoutMs, onLine, label, signal, network = false }) {
  // Only model preparation needs network settings. Keeping them in env, not
  // argv, also keeps any proxy credentials out of process arguments.
  const env = withSpawnCwdEnv({ ...cleanEnvironment(), ...(network ? artifactDownloadEnv() : {}) }, cwd);
  const result = await runStreamingCommand(command, args, onLine, {
    cwd, timeoutMs, processGroup: true, signal,
    spawnImpl: (file, argv, options) => spawn(file, argv, { ...options, env }),
  });
  signal?.throwIfAborted();
  if (!result.success) throw new ServerError(label, { status: 502, code: 'SPLASH_INSTALL_FAILED' });
}

function downloadProgress(emit) {
  const seen = new Map();
  return (line) => {
    const frame = parseProgress(line);
    if (!frame || frame.event !== 'download' || !Number.isFinite(frame.total) || frame.total <= 0 || !Number.isFinite(frame.done)) return;
    const stage = frame.repo === 'incoai/Inkling-2-Mini-DFlash2' ? 'drafter' : 'model';
    const percent = Math.max(0, Math.min(100, Math.floor(frame.done * 10 / frame.total) * 10));
    if (percent <= (seen.get(stage) ?? -1)) return;
    seen.set(stage, percent);
    emit(`Downloading Inkling 2 Mini ${stage}: ${percent}%`);
  };
}

function parseProgress(line) {
  try { return JSON.parse(line); } catch { return null; }
}

export async function installPinnedSplash({ previousVersion, emit, signal }) {
  signal?.throwIfAborted();
  const root = splashRoot();
  const home = join(root, 'home');
  await mkdir(home, { recursive: true, mode: 0o700 });
  // Cached and resumable model bytes under the private HOME already occupy disk.
  assertDownloadFits(await assessDownloadPreflight({ destPath: home, expectedBytes: MODEL_BYTES - await dirSize(home) }));
  const staging = await mkdtemp(join(root, '.install-'));
  try {
    const directory = previousVersion === SPLASH_VERSION ? releaseDirectory(SPLASH_VERSION) : join(staging, FILE);
    if (previousVersion !== SPLASH_VERSION) {
      await stageRelease(staging, emit, signal);
    }
    emit('Checking Splash hardware compatibility.');
    await runInstallStep(join(directory, 'engine', 'splash'), ['device-check'], {
      cwd: directory, timeoutMs: 20_000, label: SPLASH_UNSUPPORTED_REASON, signal,
    });
    emit('Preparing Inkling 2 Mini and its DFlash drafter. This can download about 17 GB.');
    await runInstallStep(python(directory), ['-E', 'install/models.py', ...MODEL_ARGS, 'prepare', '--json-progress'], {
      cwd: directory, timeoutMs: 4 * 60 * 60_000, onLine: downloadProgress(emit), network: true, signal,
      label: 'Splash could not prepare Inkling 2 Mini. Check free disk space and access to Hugging Face, then retry Install or Update.',
    });
    if (previousVersion !== SPLASH_VERSION) await publishRelease(directory);
    if (previousVersion && previousVersion !== SPLASH_VERSION) {
      // An update is refused before reaching here if the previous release is running.
      await rm(releaseDirectory(previousVersion), { recursive: true, force: true }).catch(() => null);
    }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => null);
  }
}

async function stageRelease(staging, emit, signal) {
  // A persistent partial lets a retry resume the 103 MB asset. Only this
  // version's reviewed official SHA may pass the extraction boundary.
  const archive = join(splashRoot(), `${FILE}.tar.gz`);
  const idle = new AbortController();
  emit(`Downloading and verifying Splash ${SPLASH_VERSION}.`);
  await streamResumableDownload({
    url: ASSET_URL, destPath: archive, expectedSha256: ASSET_SHA256,
    signal: AbortSignal.any([AbortSignal.timeout(20 * 60_000), idle.signal, ...(signal ? [signal] : [])]),
    idleStallTimeoutMs: 60_000,
    onIdleStall: () => idle.abort(new ServerError(
      'The Splash release download stalled for one minute. Retry Install or Update to resume.',
      { status: 504, code: 'SPLASH_DOWNLOAD_STALLED' },
    )),
  });
  await runInstallStep('/usr/bin/tar', ['-xzf', archive, '-C', staging], {
    cwd: staging, timeoutMs: 120_000, label: 'Splash could not extract the verified release.', signal,
  });
  await rm(archive, { force: true });
}

async function publishRelease(directory) {
  const finalDirectory = releaseDirectory(SPLASH_VERSION);
  // A failed publication may have left this exact version unpacked without
  // selecting it. Do not overwrite any version actually selected by readers.
  await rm(finalDirectory, { recursive: true, force: true });
  await rename(directory, finalDirectory);
  await atomicWrite(activeFile(), `${SPLASH_VERSION}\n`);
}

export async function probeSplashEndpoint() {
  const probe = (path) => fetch(`${SPLASH_ORIGIN}${path}`, {
    redirect: 'error',
    signal: AbortSignal.timeout(1500),
  }).catch(() => null);

  // Do not infer readiness from a model listing alone: Splash exposes that
  // route even when its engine is recovering.
  const ready = await probe('/ready');
  const readiness = await ready?.json().catch(() => null);
  if (ready?.status === 503 && readiness?.status === 'unavailable') return { state: 'not-ready' };
  if (ready?.ok && readiness?.status === 'ready') {
    const listing = await probe('/v1/models');
    const body = listing?.ok ? await listing.json().catch(() => null) : null;
    if (listing && !listing.ok) await listing.body?.cancel().catch(() => null);
    const models = Array.isArray(body?.data)
      ? body.data.filter((item) => item?.owned_by === 'splash' && typeof item.id === 'string' && item.id)
      : [];
    const model = models.find((item) => item.id === SPLASH_MODEL) ?? models[0];
    if (model) {
      const window = [model.max_model_len, model.context_length].find((value) => Number.isSafeInteger(value) && value > 0);
      return { state: 'external', model: model.id, ...(window && { servedContextWindow: window }) };
    }
  }
  if (ready) return { state: 'unrecognized' };
  return { state: 'missing' };
}

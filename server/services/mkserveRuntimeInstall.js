// Pinned, resumable installation of mkserve and the official Inkling 2 Mini.
import { constants } from 'node:fs';
import { access, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { Agent as HttpsAgent, get as httpsGet } from 'node:https';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { spawn } from '../lib/childProcess.js';
import { atomicWrite, sha256File, sha256Text } from '../lib/fileCore.js';
import { assessDownloadPreflight, assertDownloadFits, etagPathFor, partialPathFor, streamResumableDownload } from '../lib/downloadPreflight.js';
import { MKSERVE_MODEL } from '../lib/mkserveRuntime.js';
import { PATHS } from '../lib/paths.js';
import { ServerError } from '../lib/errorHandler.js';
import { runStreamingCommand } from '../lib/streamingSpawn.js';
import { artifactDownloadEnv } from '../lib/processEnv.js';
import { withSpawnCwdEnv } from '../lib/spawnCwd.js';

export const MKSERVE_VERSION = '95e315c808a7d935c10ef924a8fc0d901bfc3b89';
export { MKSERVE_MODEL };
const MODEL_REVISION = 'c9d028302cd0f035fdf8e7e91f089a4ce94d2195';
const ARCHIVE_SHA256 = 'c72e99348f3ba301df71ae6bce755be959f1a3e8db8fafc8c4275d6db4f9f5f3';
// Patched uv is bootstrapped without requiring Python, Homebrew, or Xcode.
const UV_VERSION = '0.13.7';
const UV_SHA256 = '81b811b57e4624df7ed3aac148e0359100d9962f3d9dce00aec533dc2e086731';
const WHEEL_LOCK_SHA256 = '981792e4dce2b4177eaa26bec3670f0a30ec3507a363028a9dea5bfc9e68a20b';
export const MKSERVE_BUNDLE = sha256Text([MKSERVE_VERSION, ARCHIVE_SHA256, MODEL_REVISION, UV_SHA256, WHEEL_LOCK_SHA256]
  .join(':')).slice(0, 40);
const RUNTIME_ROOT = join(PATHS.data, 'cache', 'mkserve');
const MARKER = join(RUNTIME_ROOT, 'installed.json');
const LOCK = join(PATHS.root, 'scripts', 'ml', 'requirements', 'requirements-mkserve-mlx.lock.txt');
const MINUTE = 60_000;

// The two large hashes are the official HF LFS object IDs, not redirect ETags.
const CHECKPOINT = Object.freeze([
  ['chat_template.jinja', 6868, '53a9035f3255945704b5857657cfb00c1165090c0641c4f782a0cbf268cc16dc'],
  ['config.json', 2722, 'a7a349601f0984c4abf999c480ef775d8567d21f5f84b4e8a3e035b44f288dc2'],
  ['generation_config.json', 98, 'a08737c07a65a8fdf69f7cf086576210e5aad4b241437090b26d7b0c4f7905f7'],
  ['hf_quant_config.json', 67924, '7c656207d3ce37879c7be209a036b0dde43bf01f78159bff06880b868ed57143'],
  ['model.safetensors.index.json', 109300, 'c1631065b7b00787993522dddc66a68b3abee869192977fb3dcb796e63bc5838'],
  ['special_tokens_map.json', 529, 'c16f44b3594563d82743ddb0417a2be1bfe3e2000dfad2da4b8f32554593e1a0'],
  ['tiktoken/tokenizer.model', 3386494, 'f170372dd655728909228220d77cf6b8104a59f38a91262a7d2c4027906ec0d8'],
  ['tokenizer.json', 26178678, '7f332727f9a3f093dd452a39cc978e6757627e5dad1b0673aa4e75174f236dd6'],
  ['tokenizer_config.json', 13235, 'bf09342d285139fd37ce10c70878af1d52cb390e9901e10248654293a80ee636'],
  ['model-00001-of-00001.safetensors', 19526019168, '65e60f51aa1284d4fb022584908c315270334d991828bb774af60584523539d1'],
  ['mtp.safetensors', 635801416, '7c3b651317f01f73bcf4e1dceba66ef8b7e1a1eac6bc171e882e690a4b10a1d2'],
]);
const CHECKPOINT_FILES = CHECKPOINT.map(([name, size]) => [name, size]);
export const isMkserveRevision = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const fileSize = (path) => stat(path).then((entry) => entry.isFile() ? entry.size : null).catch((error) => {
  if (error.code === 'ENOENT') return null;
  throw error;
});

export function mkserveInstallPaths(bundle, revision) {
  const work = join(RUNTIME_ROOT, 'runtime', bundle);
  const venv = join(work, 'venv');
  return {
    work, venv, source: join(work, 'source'), build: join(work, 'engine'),
    python: join(venv, 'bin', 'python3'),
    weights: join(RUNTIME_ROOT, 'checkpoints', revision),
  };
}

function isCheckpointEntry(entry) {
  if (!Array.isArray(entry)) return false;
  const [name, size] = entry;
  return typeof name === 'string' && /^[\w.-]+(?:\/[\w.-]+)*$/.test(name)
    && !name.split('/').some((part) => part === '.' || part === '..')
    && Number.isSafeInteger(size) && size > 0;
}

export async function removeMkserveRelease({ bundle, revision }) {
  if (!isMkserveRevision(bundle) || !isMkserveRevision(revision)) throw new TypeError('Invalid mkserve release');
  await rm(mkserveInstallPaths(bundle, revision).work, { recursive: true, force: true });
  await rm(MARKER, { force: true });
}

export async function readMkserveInstall() {
  const raw = await readFile(MARKER, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!raw) return null;
  let record;
  try { record = JSON.parse(raw); } catch { return null; }
  if (!isMkserveRevision(record?.bundle) || !isMkserveRevision(record?.version) || !isMkserveRevision(record?.revision)
    || !Array.isArray(record.files) || !record.files.length || !record.files.every(isCheckpointEntry)) return null;
  if (record.bundle === MKSERVE_BUNDLE
    && (record.revision !== MODEL_REVISION || JSON.stringify(record.files) !== JSON.stringify(CHECKPOINT_FILES))) return null;
  const paths = mkserveInstallPaths(record.bundle, record.revision);
  // Old markers retain their own manifest so a failed update cannot mark a
  // still-usable previous release as missing. Byte lengths catch removed or
  // truncated files cheaply; hashing multi-GB files happens only at install.
  const weightsValid = (await Promise.all(record.files.map(async ([name, size]) =>
    await fileSize(join(paths.weights, name)) === size))).every(Boolean);
  if (!weightsValid) return null;
  const executable = await access(paths.python, constants.X_OK).then(() => true, () => false);
  if (!executable || !await fileSize(join(paths.source, 'mkserve', '__main__.py'))) return null;
  return { ...paths, bundle: record.bundle, version: record.version, revision: record.revision };
}

const runFailure = (message) => new ServerError(message, { status: 502, code: 'MKSERVE_INSTALL_FAILED' });
const cleanEnv = () => ({ HOME: homedir(), PATH: '/usr/bin:/bin:/usr/sbin:/sbin', PYTHONNOUSERSITE: '1' });
export function mkserveLaunchEnvironment() {
  // Clear the environment inside the PM2-owned process, not merely the PM2
  // CLI. Its daemon can merge variables from a previous invocation.
  return ['-i', ...Object.entries({ ...cleanEnv(), HF_HUB_OFFLINE: '1' }).map(([key, value]) => key + '=' + value)];
}

async function command(bin, args, message, { timeoutMs = 20 * MINUTE, cwd, env = {}, signal, network = false } = {}) {
  // Only fixed curl/uv invocations get the machine's proxy/CA settings. The
  // unpacked engine and daemon never receive them or other server credentials.
  const exactEnv = withSpawnCwdEnv({ ...cleanEnv(), ...(network ? artifactDownloadEnv() : {}), ...env }, cwd);
  const result = await runStreamingCommand(bin, args, undefined, {
    cwd, timeoutMs, signal, processGroup: true,
    // The streaming helper's normal env option merges with process.env.
    spawnImpl: (file, argv, options) => spawn(file, argv, { ...options, env: exactEnv }),
  });
  signal?.throwIfAborted();
  if (!result.success) throw runFailure(message);
}

async function downloadArchive({ url, final, expectedHash, emit, label, signal }) {
  if (await fileSize(final) !== null && await sha256File(final, { signal }) === expectedHash) return;
  await mkdir(dirname(final), { recursive: true });
  const partial = final + '.part';
  await rm(partial, { force: true });
  emit('Downloading ' + label + '…');
  await command('/usr/bin/curl', [
    '-q', '--fail', '--location', '--proto', '=https', '--proto-redir', '=https',
    '--silent', '--show-error', '--retry', '2', '--connect-timeout', '30',
    '--speed-limit', '1024', '--speed-time', '90', '--output', partial, url,
  ], 'Could not download ' + label + '. Retry Install.', { timeoutMs: 180 * MINUTE, network: true, signal });
  await verifyAndPublish(partial, final, expectedHash, label, emit, signal);
}

async function verifyAndPublish(partial, final, expectedHash, label, emit, signal) {
  emit('Verifying ' + label + '…');
  if (await sha256File(partial, { signal }) !== expectedHash) {
    await rm(partial, { force: true });
    if (partial === partialPathFor(final)) await rm(etagPathFor(final), { force: true });
    throw runFailure(label + ' failed SHA-256 verification and was discarded. Retry Install.');
  }
  signal?.throwIfAborted();
  await rename(partial, final);
}

// Preserve the installer's artifact proxy and CA-file configuration without
// changing the HTTP dispatcher used by other PortOS requests.
async function checkpointTransport(signal) {
  const env = artifactDownloadEnv();
  const proxy = env.https_proxy || env.HTTPS_PROXY || env.all_proxy || env.ALL_PROXY;
  const caFile = env.CURL_CA_BUNDLE || env.SSL_CERT_FILE;
  if (!proxy && !caFile) return fetch;
  if (proxy && !/^https?:\/\//i.test(proxy)) {
    throw runFailure('The mkserve checkpoint download requires an HTTP or HTTPS proxy.');
  }
  const agent = new HttpsAgent({
    keepAlive: false,
    proxyEnv: { HTTPS_PROXY: proxy, NO_PROXY: env.no_proxy || env.NO_PROXY },
    ca: caFile ? await readFile(caFile, { signal }) : undefined,
  });
  return (url, options) => new Promise((resolve, reject) => {
    const request = httpsGet(url, { agent, headers: options.headers, signal: options.signal }, (response) => {
      const { statusCode: status, statusMessage: statusText } = response;
      resolve({
        status, statusText, ok: status >= 200 && status < 300,
        headers: new Headers(response.headers),
        body: Readable.toWeb(response),
      });
    });
    request.on('error', reject);
  });
}

async function fetchCheckpoint(url, options, transport) {
  let target = new URL(url);
  for (let redirects = 0; redirects <= 20; redirects += 1) {
    if (target.protocol !== 'https:' || target.username || target.password) {
      throw runFailure('The mkserve checkpoint download redirected to an invalid HTTPS URL.');
    }
    const response = await transport(target, { ...options, redirect: 'manual' });
    const location = response.headers.get('location');
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) {
      if (!response.ok) await response.body?.cancel().catch(() => {});
      return response;
    }
    await response.body?.cancel();
    target = new URL(location, target);
  }
  throw runFailure('The mkserve checkpoint download exceeded its HTTPS redirect limit.');
}

async function downloadCheckpointFile({ url, final, expectedHash, expectedSize, emit, label, signal, transport }) {
  if (await fileSize(final) === expectedSize && await sha256File(final, { signal }) === expectedHash) return;
  signal?.throwIfAborted();
  const partial = partialPathFor(final);
  const legacy = final + '.part';
  const legacySize = await fileSize(legacy);
  if (legacySize !== null) {
    // The pinned revision and digest still apply to curl's old ETag-less partial.
    if (await fileSize(partial) === null && legacySize <= expectedSize) {
      await rm(etagPathFor(final), { force: true });
      await rename(legacy, partial);
    } else {
      await rm(legacy, { force: true });
    }
  }
  if (await fileSize(partial) !== expectedSize) {
    const transfer = new AbortController();
    const transferSignal = AbortSignal.any([transfer.signal, AbortSignal.timeout(180 * MINUTE), ...(signal ? [signal] : [])]);
    let lastUpdate = -Infinity;
    emit('Downloading ' + label + '…');
    try {
      await streamResumableDownload({
        url, destPath: final, fetchImpl: (source, options) => fetchCheckpoint(source, options, transport),
        finalize: false, signal: transferSignal,
        idleStallTimeoutMs: 90_000,
        onIdleStall: () => transfer.abort(),
        onBytes: (received) => {
          if (received > expectedSize) {
            transfer.abort(runFailure(label + ' exceeded its pinned download size.'));
            return;
          }
          const now = performance.now();
          if (now - lastUpdate < 500 && received !== expectedSize) return;
          lastUpdate = now;
          emit(`Downloading ${label}: ${Math.floor(received * 100 / expectedSize)}% (${received} / ${expectedSize} bytes)`);
        },
      });
    } catch (err) {
      signal?.throwIfAborted();
      if (transfer.signal.reason instanceof ServerError) {
        await rm(partial, { force: true });
        await rm(etagPathFor(final), { force: true });
        throw transfer.signal.reason;
      }
      if (err instanceof ServerError) throw err;
      throw runFailure('Could not download ' + label + '. Retry Install to resume.');
    }
  }
  await verifyAndPublish(partial, final, expectedHash, label, emit, signal);
  await rm(etagPathFor(final), { force: true });
}

// Finished files and resumable partials already occupy their share of the disk.
async function assertCheckpointFits(weights) {
  const remaining = await Promise.all(CHECKPOINT_FILES.map(async ([name, size]) => {
    const path = join(weights, name);
    if (await fileSize(path) === size) return 0;
    const partial = (await fileSize(partialPathFor(path))) ?? (await fileSize(path + '.part')) ?? 0;
    return partial <= size ? size - partial : size;
  }));
  assertDownloadFits(await assessDownloadPreflight({
    destPath: weights, expectedBytes: remaining.reduce((total, bytes) => total + bytes, 0),
  }));
}

async function installCheckpoint(weights, emit, signal) {
  let transportPromise;
  const transport = async (url, options) => {
    transportPromise ??= checkpointTransport(signal);
    return (await transportPromise)(url, options);
  };
  for (const [name, expectedSize, expectedHash] of CHECKPOINT) {
    await downloadCheckpointFile({
      url: ['https://huggingface.co', MKSERVE_MODEL, 'resolve', MODEL_REVISION, name].join('/'),
      final: join(weights, name), expectedSize, expectedHash, emit, label: name, signal, transport,
    });
  }
}

async function installUv(work, emit, signal) {
  const archive = join(work, 'uv.tar.gz');
  await downloadArchive({
    url: 'https://github.com/astral-sh/uv/releases/download/' + UV_VERSION + '/uv-aarch64-apple-darwin.tar.gz',
    final: archive, expectedHash: UV_SHA256, emit, label: 'pinned Python installer', signal,
  });
  await command('/usr/bin/tar', [
    '-xzf', archive, '-C', work, '--strip-components', '1', 'uv-aarch64-apple-darwin/uv',
  ], 'Could not unpack the verified Python installer.', { signal });
  return join(work, 'uv');
}

async function installRuntime(paths, emit, signal) {
  if (await sha256File(LOCK, { signal }) !== WHEEL_LOCK_SHA256) throw runFailure('The shipped mkserve wheel lock does not match its pinned digest. Update PortOS and retry.');
  await mkdir(paths.work, { recursive: true });
  const uv = await installUv(paths.work, emit, signal);
  const archive = join(paths.work, 'source.tar.gz');
  await downloadArchive({
    url: 'https://codeload.github.com/dangxingyu/megakernel-zoo/tar.gz/' + MKSERVE_VERSION,
    final: archive, expectedHash: ARCHIVE_SHA256, emit, label: 'pinned mkserve source', signal,
  });
  signal?.throwIfAborted();
  await rm(paths.source, { recursive: true, force: true });
  await mkdir(paths.source);
  await command('/usr/bin/tar', [
    '-xzf', archive, '-C', paths.source, '--strip-components', '1',
  ], 'Could not unpack the verified mkserve source.', { signal });
  emit('Preparing an isolated Python and installing verified MLX wheels…');
  const uvOptions = { network: true, signal, env: {
    UV_CACHE_DIR: join(RUNTIME_ROOT, 'uv-cache'),
    UV_PYTHON_INSTALL_DIR: join(RUNTIME_ROOT, 'python'),
  } };
  await command(uv, [
    '--no-config', 'venv', '--python', 'cpython-3.13-macos-aarch64-none', '--managed-python', '--allow-existing', paths.venv,
  ], 'Could not create the mkserve Python environment. Check disk space and retry.', uvOptions);
  await command(uv, [
    '--no-config', 'pip', 'sync', '--python', paths.python, '--require-hashes', '--only-binary', ':all:',
    '--default-index', 'https://pypi.org/simple', LOCK,
  ], 'Could not install the verified mkserve wheels. Check your connection and retry.', uvOptions);
}

export async function installPinnedMkserve(emit, previous, { signal } = {}) {
  const paths = mkserveInstallPaths(MKSERVE_BUNDLE, MODEL_REVISION);
  signal?.throwIfAborted();
  await assertCheckpointFits(paths.weights);
  await installRuntime(paths, emit, signal);
  await installCheckpoint(paths.weights, emit, signal);
  await rebuildMkserveEngine(paths, emit, { signal });
  signal?.throwIfAborted();
  await activateMkserveInstall(previous);
}

export async function rebuildMkserveEngine(paths, emit, { repair = false, signal } = {}) {
  signal?.throwIfAborted();
  if (repair) {
    emit('Clearing the mkserve engine cache for rebuild…');
    await rm(paths.build, { recursive: true, force: true });
  }
  // Local pull checks the engine without a model call, daemon launch or
  // implicit snapshot download by mkserve.
  emit('Checking the installed mkserve engine and checkpoint…');
  await command(paths.python, [
    '-m', 'mkserve', 'pull', MKSERVE_MODEL,
    '--card', 'm5max', '--engine', 'offline-c', '--model-dir', paths.weights, '--workdir', paths.build,
  ], 'The pinned mkserve engine could not validate the local checkpoint.', { cwd: paths.source, signal });
}

// Only retire the exact prior managed bundle after the new one is active.
export async function activateMkserveInstall(previous) {
  await atomicWrite(MARKER, JSON.stringify({
    bundle: MKSERVE_BUNDLE, version: MKSERVE_VERSION, revision: MODEL_REVISION,
    files: CHECKPOINT_FILES,
  }));
  if (!isMkserveRevision(previous?.bundle) || !isMkserveRevision(previous?.revision)) return;
  const { work, weights } = mkserveInstallPaths(previous.bundle, previous.revision);
  const retired = [
    previous.bundle !== MKSERVE_BUNDLE && work,
    previous.revision !== MODEL_REVISION && weights,
  ].filter(Boolean);
  await Promise.all(retired.map((path) => rm(path, { recursive: true, force: true }).catch((err) => {
    console.error(`⚠️ Could not reclaim superseded mkserve cache: ${err.code || 'unknown error'}`);
  })));
}

// Pinned, resumable installation of mkserve and the official Inkling 2 Mini.
import { constants } from 'node:fs';
import { access, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from '../lib/childProcess.js';
import { atomicWrite, sha256File, sha256Text } from '../lib/fileCore.js';
import { assessDownloadPreflight, assertDownloadFits } from '../lib/downloadPreflight.js';
import { PATHS } from '../lib/paths.js';
import { ServerError } from '../lib/errorHandler.js';
import { runStreamingCommand } from '../lib/streamingSpawn.js';
import { artifactDownloadEnv } from '../lib/processEnv.js';
import { withSpawnCwdEnv } from '../lib/spawnCwd.js';

export const MKSERVE_VERSION = '95e315c808a7d935c10ef924a8fc0d901bfc3b89';
export const MKSERVE_MODEL = 'thinkingmachines/Inkling-2-Mini';
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

const runFailure = (message) => new ServerError(message, { status: 500, code: 'MKSERVE_INSTALL_FAILED' });
const cleanEnv = () => ({ HOME: homedir(), PATH: '/usr/bin:/bin:/usr/sbin:/sbin', PYTHONNOUSERSITE: '1' });
export function mkserveLaunchEnvironment() {
  // Clear the environment inside the PM2-owned process, not merely the PM2
  // CLI. Its daemon can merge variables from a previous invocation.
  return ['-i', ...Object.entries({ ...cleanEnv(), HF_HUB_OFFLINE: '1' }).map(([key, value]) => key + '=' + value)];
}

async function command(bin, args, message, { timeoutMs = 20 * MINUTE, cwd, env = {}, network = false } = {}) {
  // Only fixed curl/uv invocations get the machine's proxy/CA settings. The
  // unpacked engine and daemon never receive them or other server credentials.
  const exactEnv = withSpawnCwdEnv({ ...cleanEnv(), ...(network ? artifactDownloadEnv() : {}), ...env }, cwd);
  const result = await runStreamingCommand(bin, args, undefined, {
    cwd, timeoutMs, processGroup: true,
    // The streaming helper's normal env option merges with process.env.
    spawnImpl: (file, argv, options) => spawn(file, argv, { ...options, env: exactEnv }),
  });
  if (!result.success) throw runFailure(message);
}

async function downloadVerified({ url, final, expectedHash, expectedSize, emit, label }) {
  if (await fileSize(final) !== null && await sha256File(final) === expectedHash) return;
  await mkdir(dirname(final), { recursive: true });
  const partial = final + '.part';
  const partialSize = (await fileSize(partial)) ?? 0;
  const resume = expectedSize && partialSize > 0 && partialSize < expectedSize;
  if (!resume && partialSize !== expectedSize) await rm(partial, { force: true });
  if (!expectedSize || partialSize !== expectedSize) {
    emit('Downloading ' + label + '…');
    await command('/usr/bin/curl', [
      '-q', '--fail', '--location', '--proto', '=https', '--proto-redir', '=https',
      '--silent', '--show-error', '--retry', '2', '--connect-timeout', '30',
      '--speed-limit', '1024', '--speed-time', '90',
      ...(expectedSize ? ['--max-filesize', String(expectedSize)] : []),
      ...(resume ? ['--continue-at', '-'] : []), '--output', partial, url,
    ], 'Could not download ' + label + '. Retry Install to resume.', { timeoutMs: 180 * MINUTE, network: true });
  }
  emit('Verifying ' + label + '…');
  if (await sha256File(partial) !== expectedHash) {
    await rm(partial, { force: true });
    throw runFailure(label + ' failed SHA-256 verification and was discarded. Retry Install.');
  }
  await rename(partial, final);
}

// Finished files and resumable partials already occupy their share of the disk.
async function assertCheckpointFits(weights) {
  const remaining = await Promise.all(CHECKPOINT_FILES.map(async ([name, size]) => {
    const path = join(weights, name);
    if (await fileSize(path) === size) return 0;
    return Math.max(0, size - ((await fileSize(path + '.part')) ?? 0));
  }));
  assertDownloadFits(await assessDownloadPreflight({
    destPath: weights, expectedBytes: remaining.reduce((total, bytes) => total + bytes, 0),
  }));
}

async function installCheckpoint(weights, emit) {
  for (const [name, expectedSize, expectedHash] of CHECKPOINT) {
    await downloadVerified({
      url: ['https://huggingface.co', MKSERVE_MODEL, 'resolve', MODEL_REVISION, name].join('/'),
      final: join(weights, name), expectedSize, expectedHash, emit, label: name,
    });
  }
}

async function installUv(work, emit) {
  const archive = join(work, 'uv.tar.gz');
  await downloadVerified({
    url: 'https://github.com/astral-sh/uv/releases/download/' + UV_VERSION + '/uv-aarch64-apple-darwin.tar.gz',
    final: archive, expectedHash: UV_SHA256, emit, label: 'pinned Python installer',
  });
  await command('/usr/bin/tar', [
    '-xzf', archive, '-C', work, '--strip-components', '1', 'uv-aarch64-apple-darwin/uv',
  ], 'Could not unpack the verified Python installer.');
  return join(work, 'uv');
}

async function installRuntime(paths, emit) {
  if (await sha256File(LOCK) !== WHEEL_LOCK_SHA256) throw runFailure('The shipped mkserve wheel lock does not match its pinned digest. Update PortOS and retry.');
  await mkdir(paths.work, { recursive: true });
  const uv = await installUv(paths.work, emit);
  const archive = join(paths.work, 'source.tar.gz');
  await downloadVerified({
    url: 'https://codeload.github.com/dangxingyu/megakernel-zoo/tar.gz/' + MKSERVE_VERSION,
    final: archive, expectedHash: ARCHIVE_SHA256, emit, label: 'pinned mkserve source',
  });
  await rm(paths.source, { recursive: true, force: true });
  await mkdir(paths.source);
  await command('/usr/bin/tar', [
    '-xzf', archive, '-C', paths.source, '--strip-components', '1',
  ], 'Could not unpack the verified mkserve source.');
  emit('Preparing an isolated Python and installing verified MLX wheels…');
  const uvOptions = { network: true, env: {
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

export async function installPinnedMkserve(emit, previous) {
  const paths = mkserveInstallPaths(MKSERVE_BUNDLE, MODEL_REVISION);
  await assertCheckpointFits(paths.weights);
  await installRuntime(paths, emit);
  await installCheckpoint(paths.weights, emit);
  // Local pull checks the engine without a model call, daemon launch or
  // implicit snapshot download by mkserve.
  emit('Checking the installed mkserve engine and checkpoint…');
  await command(paths.python, [
    '-m', 'mkserve', 'pull', MKSERVE_MODEL,
    '--card', 'm5max', '--engine', 'offline-c', '--model-dir', paths.weights, '--workdir', paths.build,
  ], 'The pinned mkserve engine could not validate the local checkpoint.', { cwd: paths.source });
  await activateMkserveInstall(previous);
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

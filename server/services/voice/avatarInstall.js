// Install pinned AvatarForcing dependencies and verify and convert its model weights.
import { access, mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PATHS } from '../../lib/paths.js';
import { atomicWrite, sha256File, sha256Text } from '../../lib/fileCore.js';
import { artifactDownloadEnv } from '../../lib/processEnv.js';
import { runStreamingCommand } from '../../lib/streamingSpawn.js';
import { withSpawnCwdEnv } from '../../lib/spawnCwd.js';
import { spawn } from '../../lib/childProcess.js';
import { installPinnedAppleUv } from '../mkserveRuntimeInstall.js';

export const avatarRoot = join(PATHS.data, 'cache', 'avatarforcing');
const scripts = join(PATHS.root, 'scripts', 'ml', 'avatarforcing');
const lock = join(scripts, '..', 'requirements', 'requirements-avatarforcing-mps.lock.txt');
export const avatarWeights = join(avatarRoot, 'weights');
export const avatarMarker = join(avatarRoot, 'installed');
export const avatarScript = (name) => join(scripts, name + '.py');
export const avatarPython = (bundle) => join(avatarRoot, bundle, 'bin', 'python3');
export const avatarPortrait = join(PATHS.root, 'client', 'src', 'components', 'voice', 'call-portrait.webp');
export const avatarOfflineEnv = () => ({
  HOME: homedir(), PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', PYTHONNOUSERSITE: '1',
});
export const denyNetwork = '(version 1) (allow default) (deny network*)';
const convertProfile = denyNetwork + ' (deny file-write*) (allow file-write* (subpath (param "WEIGHTS")))';
export const avatarBundle = async () => sha256Text((await Promise.all(
  [lock, avatarScript('weights'), avatarScript('convert')].map(file => sha256File(file)),
)).join(':')).slice(0, 24);

export async function avatarFilesPresent(bundle) {
  const files = ['tensor/flow_transformer.safetensors', 'tensor/motion_autoencoder.safetensors', 'audio/model.safetensors',
    'audio/config.json', 'audio/preprocessor_config.json'];
  return Promise.all([avatarPython(bundle), ...files.map(file => join(avatarWeights, file))].map(file =>
    access(file).then(() => true, () => false))).then(results => results.every(Boolean));
}

async function run(file, args, { signal, network = false, message, timeoutMs = 30 * 60_000 } = {}) {
  const env = { ...avatarOfflineEnv(), ...(network ? artifactDownloadEnv() : {}),
    UV_CACHE_DIR: join(avatarRoot, 'uv-cache'), UV_PYTHON_INSTALL_DIR: join(avatarRoot, 'python') };
  const result = await runStreamingCommand(file, args, undefined, {
    signal, timeoutMs, processGroup: true, cwd: avatarRoot,
    spawnImpl: (cmd, argv, options) => spawn(cmd, argv, { ...options, env: withSpawnCwdEnv(env, avatarRoot) }),
  });
  signal.throwIfAborted();
  if (!result.success) throw new Error(message);
}

export async function installAvatar({ signal, progress }) {
  const bundle = await avatarBundle();
  await mkdir(avatarRoot, { recursive: true, mode: 0o700 });
  const uv = await installPinnedAppleUv(avatarRoot, progress, signal);
  const python = avatarPython(bundle);
  const network = { signal, network: true };
  progress('Preparing isolated Python…');
  await run(uv, ['--no-config', 'venv', '--python', 'cpython-3.13-macos-aarch64-none', '--managed-python',
    '--allow-existing', join(avatarRoot, bundle)], { ...network, message: 'Could not prepare isolated Python. Check disk space and network access.' });
  progress('Installing hash-locked wheels…');
  await run(uv, ['--no-config', 'pip', 'sync', '--python', python, '--require-hashes', '--only-binary', ':all:', lock],
    { ...network, message: 'Could not install verified AvatarForcing wheels. Check disk space and network access.' });
  progress('Downloading and verifying model weights (about 1.17 GB)…');
  await run(python, ['-B', avatarScript('weights'), 'download', avatarWeights],
    { ...network, message: 'Could not verify the model downloads. Check your connection and retry.' });
  progress('Converting verified weights offline…');
  const weightsPath = await realpath(avatarWeights);
  if (weightsPath !== join(await realpath(avatarRoot), 'weights')) throw new Error('AvatarForcing weights cannot be symlinked.');
  await run('/usr/bin/sandbox-exec', ['-D', 'WEIGHTS=' + weightsPath, '-p', convertProfile,
    python, '-B', avatarScript('convert'), avatarWeights],
  { signal, message: 'Could not convert the verified checkpoints offline.' });
  signal.throwIfAborted();
  await atomicWrite(avatarMarker, bundle);
}

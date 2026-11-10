// Caller-triggered Demucs provisioning. No package or build dependency is resolved
// at install time: the source archive and its build backend are both hash-locked.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, release } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAppleSilicon } from '../../lib/platform.js';
import { ServerError } from '../../lib/errorHandler.js';
import { runStreamingCommand } from '../../lib/streamingSpawn.js';

const LOCK = fileURLToPath(new URL('../../../scripts/requirements-demucs.lock.txt', import.meta.url));
const BUILD_LOCK = fileURLToPath(new URL('../../../scripts/requirements-demucs-build.lock.txt', import.meta.url));
const TIMEOUT = 45 * 60_000;
const fail = (message, code = 'DEMUCS_INSTALL_FAILED') => new ServerError(message, { status: 503, code });
const lockVersion = (text, name) => new RegExp(`^${name}==([^\\s;\\\\]+)`, 'm').exec(text)?.[1];

const demucsVenvDir = () => process.env.PORTOS_DEMUCS_VENV_DIR || join(homedir(), '.portos', 'venvs', 'demucs');

// Kept injectable at this process boundary so unsupported hosts can be checked
// without running an installer or requiring that hardware in the test suite.
export function _demucsRuntimePlan({ platform = process.platform, arch = process.arch, appleSilicon, darwinMajor } = {}) {
  const nativeArch = platform === 'darwin' && (appleSilicon ?? isAppleSilicon({ platform, arch })) ? 'arm64' : arch;
  if (platform === 'darwin' ? nativeArch !== 'arm64' || (darwinMajor ?? Number(release().split('.')[0])) < 23
    : !['linux', 'win32'].includes(platform) || nativeArch !== 'x64') {
    return { unsupported: 'Demucs has a hash-locked runtime for Apple Silicon macOS 14+, Linux x64 and Windows x64 only.' };
  }
  const lock = readFileSync(LOCK, 'utf8');
  const buildLock = readFileSync(BUILD_LOCK, 'utf8');
  const versions = Object.fromEntries(['demucs', 'soundfile', 'torch', 'torchaudio', 'setuptools', 'wheel', 'packaging']
    .map((name) => [name, lockVersion(lock, name)]));
  return {
    unsupported: null,
    arch: nativeArch,
    lockId: createHash('sha256').update(lock).update(buildLock).digest('hex'),
    versionProbe: `import sys, platform; assert sys.version_info[:2] == (3, 11); assert platform.machine().lower() in ${JSON.stringify(nativeArch === 'x64' ? ['x86_64', 'amd64'] : ['arm64'])}`,
    probe: `import demucs.separate, soundfile, torch, torchaudio; import importlib.metadata as m; assert all(m.version(n).split('+')[0] == v for n, v in ${JSON.stringify(versions)}.items())`,
    installs: [
      ['-m', 'pip', 'install', '--disable-pip-version-check', '--require-hashes', '--no-deps', '--only-binary', ':all:', '-r', BUILD_LOCK],
      ['-m', 'pip', 'install', '--disable-pip-version-check', '--require-hashes', '--no-deps', '--no-build-isolation', '--only-binary', ':all:', '--no-binary', 'demucs', '-r', LOCK],
    ],
  };
}

async function defaultBasePython(plan) {
  const { classifyVenvBases, probePythonVersion, probePythonArch } = await import('../../lib/pythonSetup.js');
  const { whichFirst } = await import('../../lib/processEnv.js');
  const { supported } = await classifyVenvBases().catch(() => ({ supported: [] }));
  const candidates = [...supported, await whichFirst('python3.11')].filter(Boolean);
  for (const candidate of candidates) {
    const version = await probePythonVersion(candidate);
    const arch = await probePythonArch(candidate);
    if (version?.major === 3 && version.minor === 11 && (plan.arch === 'x64' ? ['x86_64', 'amd64'].includes(arch?.toLowerCase()) : arch === plan.arch)) return candidate;
  }
  return null;
}

const provisioning = new Map();

/** Rebuild legacy/unverified private environments; reuse only this exact lock. */
export async function ensureDemucsRuntime({
  dir = demucsVenvDir(), plan = _demucsRuntimePlan(), onProgress = () => {},
  run = runStreamingCommand, resolveBasePython = defaultBasePython,
} = {}) {
  if (plan.unsupported) throw fail(plan.unsupported, 'DEMUCS_UNSUPPORTED_PROFILE');
  const python = join(dir, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const stamp = join(dir, 'portos-lock.sha256');
  const passes = async (code) => (await run(python, ['-c', code], null, { timeoutMs: 120_000 })).success;
  if (existsSync(python) && await readFile(stamp, 'utf8').catch(() => null) === plan.lockId
    && await passes(`${plan.versionProbe}; ${plan.probe}`)) return python;
  if (!provisioning.has(dir)) {
    const install = (async () => {
      const base = await resolveBasePython(plan);
      if (!base) throw fail(`Separating vocals needs ${plan.arch} CPython 3.11 for its hash-locked Demucs runtime. Install Python 3.11 and retry.`, 'DEMUCS_PYTHON_MISSING');
      // Check even injected/discovered candidates before clearing an old venv.
      if (!(await run(base, ['-c', plan.versionProbe], null, { timeoutMs: 120_000 })).success) {
        throw fail('The Demucs base interpreter does not match its CPython 3.11 architecture profile.', 'DEMUCS_PYTHON_MISSING');
      }
      await mkdir(dirname(dir), { recursive: true });
      onProgress({ stage: 'provision', detail: 'Creating the hash-locked Demucs environment' });
      const made = await run(base, ['-m', 'venv', '--clear', dir], null, { timeoutMs: 300_000 });
      if (!made.success) throw fail(`Could not create the Demucs environment: ${made.error}`);
      onProgress({ stage: 'installing', detail: 'Installing hash-locked Demucs dependencies (first run only)' });
      for (const args of plan.installs) {
        const installed = await run(python, args, (line) => {
          if (/^(Collecting|Downloading|Building|Installing|Successfully)/.test(line)) onProgress({ stage: 'installing', detail: line.slice(0, 160) });
        }, { timeoutMs: TIMEOUT });
        if (!installed.success) throw fail(`Could not install hash-locked Demucs dependencies: ${installed.error}`);
      }
      if (!await passes(`${plan.versionProbe}; ${plan.probe}`)) throw fail('The hash-locked Demucs runtime failed its import/version probe.');
      await writeFile(stamp, plan.lockId);
      console.log('✅ Hash-locked Demucs runtime ready');
    })().finally(() => { provisioning.delete(dir); });
    provisioning.set(dir, install);
  }
  await provisioning.get(dir);
  return python;
}

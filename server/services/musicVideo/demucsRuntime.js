// Caller-triggered Demucs provisioning. No package or build dependency is resolved
// at install time: the complete dependency closure uses hash-verified wheels.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, release } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { awaitWithAbort } from '../../lib/abortTimeout.js';
import { anyAbortSignal } from '../../lib/requestAbort.js';
import { isAppleSilicon } from '../../lib/platform.js';
import { ServerError } from '../../lib/errorHandler.js';
import { runStreamingCommand } from '../../lib/streamingSpawn.js';
import { whichFirst } from '../../lib/processEnv.js';

const LOCK = fileURLToPath(new URL('../../../scripts/ml/requirements/requirements-demucs.lock.txt', import.meta.url));
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
  const versions = Object.fromEntries(['demucs', 'soundfile', 'torch', 'sphn']
    .map((name) => [name, lockVersion(lock, name)]));
  return {
    unsupported: null,
    arch: nativeArch,
    lockId: createHash('sha256').update(lock).digest('hex'),
    versionProbe: `import sys, platform; assert sys.implementation.name == 'cpython'; assert sys.version_info[:2] == (3, 11); assert platform.machine().lower() in ${JSON.stringify(nativeArch === 'x64' ? ['x86_64', 'amd64'] : ['arm64'])}`,
    probe: `import demucs.separate, soundfile, torch, sphn; import importlib.metadata as m; assert all(m.version(n).split('+')[0] == v for n, v in ${JSON.stringify(versions)}.items())
import tempfile
from pathlib import Path
from demucs.audio import save_audio
with tempfile.TemporaryDirectory(prefix='portos-demucs-probe-') as directory:
    target = Path(directory) / 'vocals.wav'
    save_audio(torch.zeros(2, 64), target, 44100)
    audio, rate = soundfile.read(target)
    assert audio.shape == (64, 2) and rate == 44100`,
    install: ['-m', 'pip', 'install', '--disable-pip-version-check', '--require-hashes', '--no-deps', '--only-binary', ':all:', '-r', LOCK],
  };
}

async function defaultBasePython(plan, signal) {
  const { classifyVenvBases, probePythonVersion, probePythonArch } = await import('../../lib/pythonSetup.js');
  const { supported } = await classifyVenvBases().catch(() => ({ supported: [] }));
  signal.throwIfAborted();
  const candidates = [...supported, await whichFirst('python3.11')].filter(Boolean);
  for (const candidate of candidates) {
    signal.throwIfAborted();
    const version = await probePythonVersion(candidate);
    signal.throwIfAborted();
    const arch = await probePythonArch(candidate);
    if (version?.major === 3 && version.minor === 11 && (plan.arch === 'x64' ? ['x86_64', 'amd64'].includes(arch?.toLowerCase()) : arch === plan.arch)) return candidate;
  }
  return null;
}

const provisioning = new Map();

async function provisionRuntime({ dir, plan, run, resolveBasePython, signal, progress }) {
  const python = join(dir, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const stamp = join(dir, 'portos-lock.sha256');
  const checkedRun = async (bin, args, onLine, options) => {
    signal.throwIfAborted();
    const result = await run(bin, args, onLine, { ...options, signal });
    signal.throwIfAborted();
    return result;
  };
  const passes = async (bin, code) => (await checkedRun(bin, ['-c', code], null, { timeoutMs: 120_000 })).success;
  const runtimeProbe = `${plan.versionProbe}\n${plan.probe}`;
  if (existsSync(python) && await readFile(stamp, 'utf8').catch(() => null) === plan.lockId
    && await passes(python, runtimeProbe)) return python;
  signal.throwIfAborted();
  const base = await resolveBasePython(plan, signal);
  signal.throwIfAborted();
  if (!base) throw fail(`Separating vocals needs ${plan.arch} CPython 3.11 for its hash-locked Demucs runtime. Install Python 3.11 and retry.`, 'DEMUCS_PYTHON_MISSING');
  // Check even injected/discovered candidates before clearing an old venv.
  if (!await passes(base, plan.versionProbe)) {
    throw fail('The Demucs base interpreter does not match its CPython 3.11 architecture profile.', 'DEMUCS_PYTHON_MISSING');
  }
  await mkdir(dirname(dir), { recursive: true });
  progress({ stage: 'provision', detail: 'Creating the hash-locked Demucs environment' });
  const made = await checkedRun(base, ['-m', 'venv', '--clear', dir], null, { timeoutMs: 300_000, processGroup: true });
  if (!made.success) throw fail(`Could not create the Demucs environment: ${made.error}`);
  progress({ stage: 'installing', detail: 'Installing hash-locked Demucs dependencies (first run only)' });
  const installed = await checkedRun(python, plan.install, (line) => {
    if (/^(Collecting|Downloading|Installing|Successfully)/.test(line)) progress({ stage: 'installing', detail: line.slice(0, 160) });
  }, { timeoutMs: TIMEOUT, processGroup: true });
  if (!installed.success) throw fail(`Could not install hash-locked Demucs dependencies: ${installed.error}`);
  if (!await passes(python, runtimeProbe)) throw fail('The hash-locked Demucs runtime failed its import/version probe.');
  signal.throwIfAborted();
  await writeFile(stamp, plan.lockId);
  console.log('✅ Hash-locked Demucs runtime ready');
  return python;
}

/** Rebuild legacy/unverified private environments; reuse only this exact lock. */
export async function ensureDemucsRuntime({
  dir = demucsVenvDir(), plan = _demucsRuntimePlan(), onProgress = () => {},
  run = runStreamingCommand, resolveBasePython = defaultBasePython, signal, isCancelled,
} = {}) {
  if (plan.unsupported) throw fail(plan.unsupported, 'DEMUCS_UNSUPPORTED_PROFILE');
  const predicateAbort = isCancelled && new AbortController();
  const waitSignal = anyAbortSignal([signal, predicateAbort?.signal]);
  const pollCancellation = () => {
    try {
      if (isCancelled()) predicateAbort.abort();
    } catch (error) { predicateAbort.abort(error); }
  };
  if (predicateAbort) pollCancellation();
  const timer = predicateAbort && setInterval(pollCancellation, 1000);
  try {
    waitSignal?.throwIfAborted();
    let pending = provisioning.get(dir);
    // Keep a cancelled build reserved until the child exits. A fresh waiter
    // can then retry without clearing a venv that the old process still uses.
    while (pending?.controller.signal.aborted) {
      await awaitWithAbort(pending.promise.catch(() => {}), waitSignal);
      waitSignal?.throwIfAborted();
      pending = provisioning.get(dir);
    }
    if (!pending) {
      const controller = new AbortController();
      const waiters = new Set();
      const progress = (frame) => {
        for (const waiter of waiters) {
          if (waiter.signal?.aborted) continue;
          try { waiter.onProgress(frame); } catch (err) { console.error(`❌ Demucs progress observer failed: ${err.message}`); }
        }
      };
      const promise = Promise.resolve().then(() => provisionRuntime({
        dir, plan, run, resolveBasePython, signal: controller.signal, progress,
      })).finally(() => { provisioning.delete(dir); });
      pending = { controller, promise, waiters };
      provisioning.set(dir, pending);
    }
    const waiter = { signal: waitSignal, onProgress };
    pending.waiters.add(waiter);
    try {
      return await awaitWithAbort(pending.promise, waitSignal);
    } finally {
      pending.waiters.delete(waiter);
      if (!pending.waiters.size && provisioning.get(dir) === pending) pending.controller.abort();
    }
  } finally {
    clearInterval(timer);
  }
}

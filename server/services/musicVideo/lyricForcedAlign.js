/** User-triggered MMS_FA alignment in a private, version-pinned Python venv. */
import { existsSync } from 'fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { ServerError } from '../../lib/errorHandler.js';
import { isAppleSilicon } from '../../lib/platform.js';
import { whichFirst } from '../../lib/processEnv.js';
import { runStreamingCommand } from '../../lib/streamingSpawn.js';
import { lyricTokens } from './timedText.js';
import { sliceWav, wavDurationSec } from './lyricAlignCore.js';

const SCRIPT = fileURLToPath(new URL('../../../scripts/align_lyrics_ctc.py', import.meta.url));
let provisioning = null;
// Probe of a venv that already imported. The hardware pin is tried every
// time; this remembers an Intel fallback so the next line does not rediscover
// every interpreter. It is not success: the next call runs the probe again.
let acceptedProbe = null;

// Wheel arch follows the interpreter, not the Node process. Apple Silicon
// (including Rosetta) uses current arm64 wheels. A real Intel Mac stays on
// torch 2.2.2 — the last release with official Intel Mac wheels. forced_align
// was removed in torchaudio 2.9, so both pins stay below that.
// Leading underscore: the wheel-pin contract test is the only out-of-file caller.
export function _lyricAlignRuntimePlan({ platform = process.platform, appleSilicon } = {}) {
  const silicon = appleSilicon ?? (platform === 'darwin' && isAppleSilicon({ platform }));
  const intelWheels = platform === 'darwin' && !silicon;
  const torch = intelWheels ? '2.2.2' : '2.8.0';
  const maxPythonMinor = intelWheels ? 12 : 13;
  // Current macOS wheels are arm64-only. An x86_64 venv (Rosetta, or a
  // previously working Intel pin) must not be reused for them: pip can never
  // install torch 2.8 there, and the venv would stay broken.
  const arch = intelWheels || platform !== 'darwin' ? null : 'arm64';
  const versionBound = `(3, 10) <= sys.version_info[:2] <= (3, ${maxPythonMinor})`;
  const versionProbe = arch
    ? `import sys, platform; assert ${versionBound}; assert platform.machine() == ${JSON.stringify(arch)}`
    : `import sys; assert ${versionBound}`;
  return {
    intelWheels,
    torch,
    maxPythonMinor,
    arch,
    packages: [`torch==${torch}`, `torchaudio==${torch}`, ...(intelWheels ? ['numpy<2'] : [])],
    probe: `import torch, torchaudio; assert torch.__version__.split("+")[0] == "${torch}"; assert torchaudio.__version__.split("+")[0] == "${torch}"; assert callable(torchaudio.functional.forced_align); assert torchaudio.pipelines.MMS_FA`,
    versionProbe,
    pythonRange: `Python 3.10–3.${maxPythonMinor}`,
  };
}

const canceled = () => Object.assign(new Error('cancelled'), { canceled: true });
const failure = (message, code = 'LYRIC_ALIGN_CTC_FAILED') => new ServerError(message, { status: 503, code });

async function defaultFindPython(plan, { arch } = {}) {
  const { classifyVenvBases, probePythonVersion, probePythonArch } = await import('../../lib/pythonSetup.js');
  const { supported } = await classifyVenvBases().catch(() => ({ supported: [] }));
  const candidates = [...supported];
  for (const name of ['python3.13', 'python3.12', 'python3.11', 'python3.10', process.platform === 'win32' ? 'python' : 'python3']) {
    const found = await whichFirst(name);
    if (found && !candidates.includes(found)) candidates.push(found);
  }
  for (const candidate of candidates) {
    const version = await probePythonVersion(candidate);
    if (!(version?.major === 3 && version.minor >= 10 && version.minor <= plan.maxPythonMinor)) continue;
    if (arch && await probePythonArch(candidate) !== arch) continue;
    return candidate;
  }
  return null;
}

// On Apple Silicon, torch 2.8 has no x86_64 macOS wheel. Prefer an arm64
// interpreter; if the only interpreter is x86_64, keep the Intel pins so pip
// can finish instead of failing closed on a missing wheel.
// Leading underscore: the interpreter-selection test is the only out-of-file caller.
export async function _resolveLyricAlignRuntime({
  platform = process.platform, appleSilicon, findPython = defaultFindPython,
} = {}) {
  const silicon = appleSilicon ?? (platform === 'darwin' && isAppleSilicon({ platform }));
  if (!silicon) {
    const plan = _lyricAlignRuntimePlan({ platform, appleSilicon: false });
    return { plan, python: await findPython(plan) };
  }
  const modern = _lyricAlignRuntimePlan({ platform, appleSilicon: true });
  const arm = await findPython(modern, { arch: 'arm64' });
  if (arm) return { plan: modern, python: arm };
  const legacy = _lyricAlignRuntimePlan({ platform, appleSilicon: false });
  return { plan: legacy, python: await findPython(legacy) };
}

async function ensureRuntime({ run, onProgress, dir, resolveRuntime }) {
  const python = process.platform === 'win32' ? join(dir, 'Scripts', 'python.exe') : join(dir, 'bin', 'python');
  const quick = _lyricAlignRuntimePlan();
  // A venv that already matches the hardware pin is ready. A healthy Intel
  // fallback does not match that pin; try its probe before discovery so a
  // later line does not classify every interpreter again.
  if (existsSync(python)) {
    const probes = acceptedProbe && acceptedProbe !== quick.probe ? [acceptedProbe, quick.probe] : [quick.probe];
    for (const probe of probes) {
      if ((await run(python, ['-c', probe], null, { timeoutMs: 120_000 })).success) {
        acceptedProbe = probe;
        return python;
      }
    }
  }
  if (!provisioning) {
    provisioning = (async () => {
      const selected = await resolveRuntime();
      let plan = selected.plan;
      const exists = existsSync(python);
      // Discovery can miss the venv's own base and fall back to the Intel
      // plan. An interpreter that already matches the hardware pin is repaired
      // in place; the Intel ceiling would reject it and refuse to install.
      let compatible = false;
      if (exists && plan.versionProbe !== quick.versionProbe
          && (await run(python, ['-c', quick.versionProbe], null, { timeoutMs: 120_000 })).success) {
        plan = quick;
        compatible = true;
      }
      // No arm64 interpreter: keep an existing venv that already has the
      // Intel pin instead of rebuilding it for a wheel this Mac cannot install.
      if (exists && plan.probe !== quick.probe
          && (await run(python, ['-c', plan.probe], null, { timeoutMs: 120_000 })).success) {
        acceptedProbe = plan.probe;
        return;
      }
      if (!compatible) {
        compatible = exists && (await run(python, ['-c', plan.versionProbe], null, { timeoutMs: 120_000 })).success;
      }
      if (!compatible) {
        const base = selected.python;
        if (!base) throw failure(`MMS_FA lyric alignment needs ${plan.pythonRange}.`, 'LYRIC_ALIGN_CTC_PYTHON_MISSING');
        await mkdir(dirname(dir), { recursive: true });
        onProgress({ stage: 'installing', detail: 'Creating the MMS_FA environment (first run only)' });
        const result = await run(base, ['-m', 'venv', ...(exists ? ['--clear'] : []), dir], null, { timeoutMs: 300_000 });
        if (!result.success) throw failure('Could not create the MMS_FA environment.', 'LYRIC_ALIGN_CTC_INSTALL_FAILED');
      }
      onProgress({ stage: 'installing', detail: 'Installing MMS_FA dependencies (first run only)' });
      const result = await run(python, ['-m', 'pip', 'install', ...plan.packages], null, { timeoutMs: 45 * 60_000 });
      if (!result.success || !(await run(python, ['-c', plan.probe], null, { timeoutMs: 120_000 })).success) {
        throw failure(`Could not install MMS_FA dependencies. Use ${plan.pythonRange} with compatible PyTorch wheels.`, 'LYRIC_ALIGN_CTC_INSTALL_FAILED');
      }
      acceptedProbe = plan.probe;
    })().finally(() => { provisioning = null; });
  }
  await provisioning;
  return python;
}

/** Returns one word list per supplied cue, preserving occurrence and spelling. */
export async function forceAlignLyrics(wav, cues, {
  startSec = 0, endSec = wavDurationSec(wav), onProgress = () => {}, isCancelled = () => false,
  run = runStreamingCommand, resolveBasePython, resolveRuntime,
  dir = process.env.PORTOS_LYRIC_ALIGN_VENV_DIR || join(homedir(), '.portos', 'venvs', 'lyric-align'),
} = {}) {
  const checkCancel = () => { if (isCancelled()) throw canceled(); };
  checkCancel();
  const duration = wavDurationSec(wav);
  const from = Math.max(0, startSec);
  const to = Math.min(duration, endSec ?? duration);
  if (!(to > from)) throw failure('That lyric line has no audio window to align.');
  const lines = cues.map((cue) => lyricTokens(cue.text).map((token) => token.w));
  // A caller-supplied resolver owns the interpreter (tests). Production picks
  // the interpreter and the wheel pin together, and only after the ready-venv
  // probe misses, so an x86_64-only Mac is not asked for a torch 2.8 wheel.
  const python = await ensureRuntime({
    run, onProgress, dir,
    resolveRuntime: resolveBasePython
      ? async () => {
          const plan = _lyricAlignRuntimePlan();
          return { plan, python: await resolveBasePython(plan) };
        }
      : (resolveRuntime ?? _resolveLyricAlignRuntime),
  });
  checkCancel();
  const scratch = await mkdtemp(join(tmpdir(), 'portos-ctc-align-'));
  try {
    const audio = join(scratch, 'vocal.wav');
    const transcript = join(scratch, 'lyrics.json');
    const output = join(scratch, 'words.json');
    await writeFile(audio, sliceWav(wav, from, to));
    await writeFile(transcript, JSON.stringify(lines), { mode: 0o600 });
    const result = await run(python, [SCRIPT, '--audio', audio, '--lyrics', transcript, '--output', output], (line) => {
      const match = /^PROGRESS:(loading-model|aligning|emissions)(?::(\d+))?$/.exec(line);
      if (match) onProgress({ stage: match[1], ...(match[2] ? { percent: Number(match[2]) } : {}) });
    }, { timeoutMs: 60 * 60_000, isCancelled });
    checkCancel();
    if (!result.success) throw failure('MMS_FA could not align these lyrics. Check that lyrics match the vocal, spell numbers out, and allow the first-use model download.');
    const raw = await readFile(output, 'utf8').catch(() => null);
    const parsed = raw ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : null;
    let previousEnd = 0;
    if (!Array.isArray(parsed) || parsed.length !== lines.length || parsed.some((words, i) => !Array.isArray(words)
      || words.length !== lines[i].length || words.some((word, j) => {
        const invalid = word?.w !== lines[i][j] || !Number.isFinite(word.startSec) || !Number.isFinite(word.endSec)
          || word.startSec < previousEnd || word.endSec <= word.startSec || word.endSec > to - from + 0.001;
        previousEnd = word?.endSec;
        return invalid;
      }))) throw failure('MMS_FA returned invalid word timings.');
    return parsed.map((words) => words.map((word) => ({
      w: word.w, startSec: Math.round((word.startSec + from) * 1000) / 1000,
      endSec: Math.round((word.endSec + from) * 1000) / 1000, conf: 'matched',
    })));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

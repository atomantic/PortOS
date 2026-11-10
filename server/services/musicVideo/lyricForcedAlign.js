/** User-triggered MMS_FA alignment in a private, hash-locked Python venv. */
import { existsSync, readFileSync } from 'fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { homedir, release, tmpdir } from 'os';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { ServerError } from '../../lib/errorHandler.js';
import { isAppleSilicon } from '../../lib/platform.js';
import { whichFirst } from '../../lib/processEnv.js';
import { runStreamingCommand } from '../../lib/streamingSpawn.js';
import { lyricTokens } from './timedText.js';
import { sliceWav, wavDurationSec } from './lyricAlignCore.js';

const SCRIPT = fileURLToPath(new URL('../../../scripts/align_lyrics_ctc.py', import.meta.url));
// Every transitive package, including a patched torch, is version- and hash-pinned;
// pip resolves nothing at install time. Regeneration: the lock's header.
const LOCK = fileURLToPath(new URL('../../../scripts/requirements-lyric-align.lock.txt', import.meta.url));
const PYTHON_MINORS = [11, 14];
let provisioning = null;

const lockedVersion = (lock, name) => new RegExp(`^${name}==([^\\s;\\\\]+)`, 'm').exec(lock)?.[1];

// Wheel arch follows the interpreter, not the Node process, so Apple Silicon
// (including a Rosetta Node) needs an arm64 Python. The lock's torch has no
// Intel macOS or pre-macOS 14 wheel; those hosts are refused before any
// install rather than given an older, vulnerable torch.
// Leading underscore: the platform-plan contract test is the only out-of-file caller.
export function _lyricAlignRuntimePlan({
  platform = process.platform, appleSilicon, darwinMajor, lock = readFileSync(LOCK, 'utf8'),
} = {}) {
  if (platform === 'darwin') {
    const silicon = appleSilicon ?? isAppleSilicon({ platform });
    if (!silicon) {
      return { unsupported: 'MMS_FA lyric alignment needs an Apple Silicon Mac: patched PyTorch has no Intel macOS build.' };
    }
    if ((darwinMajor ?? Number(release().split('.')[0])) < 23) {
      return { unsupported: 'MMS_FA lyric alignment needs macOS 14 or later for patched PyTorch.' };
    }
  }
  const torch = lockedVersion(lock, 'torch');
  const torchaudio = lockedVersion(lock, 'torchaudio');
  const [minMinor, maxMinor] = PYTHON_MINORS;
  const arch = platform === 'darwin' ? 'arm64' : null;
  const versionBound = `(3, ${minMinor}) <= sys.version_info[:2] <= (3, ${maxMinor})`;
  return {
    unsupported: null,
    arch,
    minMinor,
    maxMinor,
    install: ['-m', 'pip', 'install', '--disable-pip-version-check', '--require-hashes', '--no-deps',
      '--only-binary', ':all:', '-r', LOCK],
    probe: `import numpy, torch, torchaudio; assert torch.__version__.split("+")[0] == "${torch}"; assert torchaudio.__version__.split("+")[0] == "${torchaudio}"; assert callable(torchaudio.models.wav2vec2_model)`,
    versionProbe: arch
      ? `import sys, platform; assert ${versionBound}; assert platform.machine() == ${JSON.stringify(arch)}`
      : `import sys; assert ${versionBound}`,
    pythonRange: `${arch ? `${arch} ` : ''}Python 3.${minMinor}–3.${maxMinor}`,
  };
}

const canceled = () => Object.assign(new Error('cancelled'), { canceled: true });
const failure = (message, code = 'LYRIC_ALIGN_CTC_FAILED') => new ServerError(message, { status: 503, code });

async function defaultFindPython(plan) {
  const { classifyVenvBases, probePythonVersion, probePythonArch } = await import('../../lib/pythonSetup.js');
  const { supported } = await classifyVenvBases().catch(() => ({ supported: [] }));
  const candidates = [...supported];
  const names = [];
  for (let minor = plan.maxMinor; minor >= plan.minMinor; minor--) names.push(`python3.${minor}`);
  for (const name of [...names, process.platform === 'win32' ? 'python' : 'python3']) {
    const found = await whichFirst(name);
    if (found && !candidates.includes(found)) candidates.push(found);
  }
  for (const candidate of candidates) {
    const version = await probePythonVersion(candidate);
    if (!(version?.major === 3 && version.minor >= plan.minMinor && version.minor <= plan.maxMinor)) continue;
    if (plan.arch && await probePythonArch(candidate) !== plan.arch) continue;
    return candidate;
  }
  return null;
}

async function ensureRuntime({ run, onProgress, dir, plan, findPython }) {
  if (plan.unsupported) throw failure(plan.unsupported, 'LYRIC_ALIGN_CTC_UNSUPPORTED_PLATFORM');
  const python = process.platform === 'win32' ? join(dir, 'Scripts', 'python.exe') : join(dir, 'bin', 'python');
  const passes = async (code) => (await run(python, ['-c', code], null, { timeoutMs: 120_000 })).success;
  if (existsSync(python) && await passes(plan.probe)) return python;
  if (!provisioning) {
    provisioning = (async () => {
      const exists = existsSync(python);
      // A venv on a compatible interpreter (including an older torch pin) is
      // upgraded in place; any other venv is rebuilt from a compatible base.
      if (!(exists && await passes(plan.versionProbe))) {
        const base = await findPython(plan);
        if (!base) throw failure(`MMS_FA lyric alignment needs ${plan.pythonRange}.`, 'LYRIC_ALIGN_CTC_PYTHON_MISSING');
        await mkdir(dirname(dir), { recursive: true });
        onProgress({ stage: 'installing', detail: 'Creating the MMS_FA environment (first run only)' });
        const result = await run(base, ['-m', 'venv', ...(exists ? ['--clear'] : []), dir], null, { timeoutMs: 300_000 });
        if (!result.success) throw failure('Could not create the MMS_FA environment.', 'LYRIC_ALIGN_CTC_INSTALL_FAILED');
      }
      onProgress({ stage: 'installing', detail: 'Installing hash-locked MMS_FA dependencies (first run only)' });
      const result = await run(python, plan.install, null, { timeoutMs: 45 * 60_000 });
      if (!result.success || !await passes(plan.probe)) {
        throw failure(`Could not install MMS_FA dependencies. Use ${plan.pythonRange}.`, 'LYRIC_ALIGN_CTC_INSTALL_FAILED');
      }
    })().finally(() => { provisioning = null; });
  }
  await provisioning;
  return python;
}

/** Returns one word list per supplied cue, preserving occurrence and spelling. */
export async function forceAlignLyrics(wav, cues, {
  startSec = 0, endSec = wavDurationSec(wav), onProgress = () => {}, isCancelled = () => false,
  run = runStreamingCommand, findPython = defaultFindPython, plan = _lyricAlignRuntimePlan(),
  dir = process.env.PORTOS_LYRIC_ALIGN_VENV_DIR || join(homedir(), '.portos', 'venvs', 'lyric-align'),
  // Beside the venv, so rebuilding the venv keeps the 1.2 GB checkpoint.
  modelDir = join(dirname(dir), `${basename(dir)}-models`),
} = {}) {
  const checkCancel = () => { if (isCancelled()) throw canceled(); };
  checkCancel();
  const duration = wavDurationSec(wav);
  const from = Math.max(0, startSec);
  const to = Math.min(duration, endSec ?? duration);
  if (!(to > from)) throw failure('That lyric line has no audio window to align.');
  const lines = cues.map((cue) => lyricTokens(cue.text).map((token) => token.w));
  const python = await ensureRuntime({ run, onProgress, dir, plan, findPython });
  checkCancel();
  const scratch = await mkdtemp(join(tmpdir(), 'portos-ctc-align-'));
  try {
    const audio = join(scratch, 'vocal.wav');
    const transcript = join(scratch, 'lyrics.json');
    const output = join(scratch, 'words.json');
    await writeFile(audio, sliceWav(wav, from, to));
    await writeFile(transcript, JSON.stringify(lines), { mode: 0o600 });
    let rejectedModel = false;
    const result = await run(python, [SCRIPT, '--audio', audio, '--lyrics', transcript, '--output', output,
      '--model-dir', modelDir], (line) => {
      if (line === 'ERROR:checkpoint-rejected') rejectedModel = true;
      const match = /^PROGRESS:(downloading-model|loading-model|aligning|emissions)(?::(\d+))?$/.exec(line);
      if (match) onProgress({ stage: match[1], ...(match[2] ? { percent: Number(match[2]) } : {}) });
    }, { timeoutMs: 60 * 60_000, isCancelled });
    checkCancel();
    if (rejectedModel) {
      throw failure('The downloaded MMS_FA model did not match its pinned checksum and was not loaded. Retry, or check the network path.',
        'LYRIC_ALIGN_CTC_MODEL_REJECTED');
    }
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

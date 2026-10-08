/** User-triggered MMS_FA alignment in a private, version-pinned Python venv. */
import { existsSync } from 'fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { ServerError } from '../../lib/errorHandler.js';
import { whichFirst } from '../../lib/processEnv.js';
import { runStreamingCommand } from '../../lib/streamingSpawn.js';
import { lyricTokens } from './timedText.js';
import { sliceWav, wavDurationSec } from './lyricAlignCore.js';

const SCRIPT = fileURLToPath(new URL('../../../scripts/align_lyrics_ctc.py', import.meta.url));
// forced_align was removed in 2.9. Keep matching wheels in this venv only.
const INTEL_MAC = process.platform === 'darwin' && process.arch === 'x64';
// 2.2 was the last release with official Intel Mac wheels.
const TORCH_VERSION = INTEL_MAC ? '2.2.2' : '2.8.0';
const MAX_PYTHON_MINOR = INTEL_MAC ? 12 : 13;
const PYTHON_RANGE = `Python 3.10–3.${MAX_PYTHON_MINOR}`;
const PACKAGES = [`torch==${TORCH_VERSION}`, `torchaudio==${TORCH_VERSION}`, ...(INTEL_MAC ? ['numpy<2'] : [])];
const PROBE = `import torch, torchaudio; assert torch.__version__.split("+")[0] == "${TORCH_VERSION}"; assert torchaudio.__version__.split("+")[0] == "${TORCH_VERSION}"; assert callable(torchaudio.functional.forced_align); assert torchaudio.pipelines.MMS_FA`;
let provisioning = null;

const canceled = () => Object.assign(new Error('cancelled'), { canceled: true });
const failure = (message, code = 'LYRIC_ALIGN_CTC_FAILED') => new ServerError(message, { status: 503, code });

async function basePython() {
  const { classifyVenvBases, probePythonVersion } = await import('../../lib/pythonSetup.js');
  const { supported } = await classifyVenvBases().catch(() => ({ supported: [] }));
  const candidates = [...supported];
  for (const name of ['python3.13', 'python3.12', 'python3.11', 'python3.10', process.platform === 'win32' ? 'python' : 'python3']) {
    const found = await whichFirst(name);
    if (found && !candidates.includes(found)) candidates.push(found);
  }
  for (const candidate of candidates) {
    const version = await probePythonVersion(candidate);
    if (version?.major === 3 && version.minor >= 10 && version.minor <= MAX_PYTHON_MINOR) return candidate;
  }
  return null;
}

async function ensureRuntime({ run, onProgress, resolveBasePython, dir }) {
  const python = process.platform === 'win32' ? join(dir, 'Scripts', 'python.exe') : join(dir, 'bin', 'python');
  if (existsSync(python) && (await run(python, ['-c', PROBE], null, { timeoutMs: 120_000 })).success) return python;
  if (!provisioning) {
    provisioning = (async () => {
      const exists = existsSync(python);
      const compatible = exists && (await run(python, ['-c', `import sys; assert (3, 10) <= sys.version_info[:2] <= (3, ${MAX_PYTHON_MINOR})`], null, { timeoutMs: 120_000 })).success;
      if (!compatible) {
        const base = await resolveBasePython();
        if (!base) throw failure(`MMS_FA lyric alignment needs ${PYTHON_RANGE}.`, 'LYRIC_ALIGN_CTC_PYTHON_MISSING');
        await mkdir(dirname(dir), { recursive: true });
        onProgress({ stage: 'installing', detail: 'Creating the MMS_FA environment (first run only)' });
        const result = await run(base, ['-m', 'venv', ...(exists ? ['--clear'] : []), dir], null, { timeoutMs: 300_000 });
        if (!result.success) throw failure('Could not create the MMS_FA environment.', 'LYRIC_ALIGN_CTC_INSTALL_FAILED');
      }
      onProgress({ stage: 'installing', detail: 'Installing MMS_FA dependencies (first run only)' });
      const result = await run(python, ['-m', 'pip', 'install', ...PACKAGES], null, { timeoutMs: 45 * 60_000 });
      if (!result.success || !(await run(python, ['-c', PROBE], null, { timeoutMs: 120_000 })).success) {
        throw failure(`Could not install MMS_FA dependencies. Use ${PYTHON_RANGE} with compatible PyTorch wheels.`, 'LYRIC_ALIGN_CTC_INSTALL_FAILED');
      }
    })().finally(() => { provisioning = null; });
  }
  await provisioning;
  return python;
}

/** Returns one word list per supplied cue, preserving occurrence and spelling. */
export async function forceAlignLyrics(wav, cues, {
  startSec = 0, endSec = wavDurationSec(wav), onProgress = () => {}, isCancelled = () => false,
  run = runStreamingCommand, resolveBasePython = basePython,
  dir = process.env.PORTOS_LYRIC_ALIGN_VENV_DIR || join(homedir(), '.portos', 'venvs', 'lyric-align'),
} = {}) {
  const checkCancel = () => { if (isCancelled()) throw canceled(); };
  checkCancel();
  const duration = wavDurationSec(wav);
  const from = Math.max(0, startSec);
  const to = Math.min(duration, endSec ?? duration);
  if (!(to > from)) throw failure('That lyric line has no audio window to align.');
  const lines = cues.map((cue) => lyricTokens(cue.text).map((token) => token.w));
  const python = await ensureRuntime({ run, onProgress, resolveBasePython, dir });
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

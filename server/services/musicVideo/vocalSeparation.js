/**
 * Music Video vocal separation: split the project's song into an isolated
 * vocal with demucs (htdemucs_ft, two stems) and attach it as the project's
 * vocal stem.
 *
 * Runs only when the director clicks "Separate vocals" or starts an autopilot
 * run — never at boot. The first run provisions a private venv at
 * `~/.portos/venvs/demucs` (`python -m venv` + `pip install demucs soundfile`),
 * and demucs fetches its own weights on first use. Separation picks the best
 * device (Apple Silicon → mps, NVIDIA → cuda, otherwise cpu) and retries on the
 * CPU when the accelerator run fails. The result goes through the same
 * `attachVocalStem` as an uploaded stem, so the timebase check still applies
 * and the file lands in the shared music library like any other stem.
 *
 * Job shape mirrors audioMidiTranscription.js: kickoff returns `{ jobId }`,
 * the work runs detached and streams `{ type: 'progress' | 'complete' |
 * 'error' | 'canceled' }` frames. One job per project at a time — a second
 * kickoff re-attaches to the running one.
 */

import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, readdir, rm } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { dirname, join } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { shortId } from '../../lib/fileUtils.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay } from '../../lib/sseUtils.js';
import { runStreamingCommand } from '../../lib/streamingSpawn.js';
import { whichFirst } from '../../lib/processEnv.js';
import { getProject } from './projects.js';
import { attachVocalStem } from './vocalStem.js';

const IS_WIN = process.platform === 'win32';
const VENV_TIMEOUT_MS = 5 * 60 * 1000;
const PIP_TIMEOUT_MS = 45 * 60 * 1000;
const PROBE_TIMEOUT_MS = 2 * 60 * 1000;
const SEPARATE_TIMEOUT_MS = 60 * 60 * 1000;
// htdemucs_ft is a bag of four models; demucs draws one progress bar per model.
const DEMUCS_MODEL = 'htdemucs_ft';
const DEMUCS_PASSES = 4;

/** Where the demucs venv lives. `PORTOS_DEMUCS_VENV_DIR` overrides it. */
export const demucsVenvDir = () => process.env.PORTOS_DEMUCS_VENV_DIR || join(homedir(), '.portos', 'venvs', 'demucs');
export const venvPython = (dir) => (IS_WIN ? join(dir, 'Scripts', 'python.exe') : join(dir, 'bin', 'python'));

/** Best demucs device for this host. */
function pickDemucsDevice({ platform = process.platform, arch = process.arch, cudaAvailable = false } = {}) {
  if (platform === 'darwin' && arch === 'arm64') return 'mps';
  if (cudaAvailable) return 'cuda';
  return 'cpu';
}

function demucsArgs({ audioPath, outDir, device }) {
  return ['-m', 'demucs', '--two-stems=vocals', '-n', DEMUCS_MODEL, '-d', device, '-o', outDir, audioPath];
}

async function defaultBasePython() {
  const { classifyVenvBases } = await import('../../lib/pythonSetup.js');
  const { supported } = await classifyVenvBases().catch(() => ({ supported: [] }));
  return supported[0] || whichFirst(IS_WIN ? 'python' : 'python3');
}

async function defaultCudaAvailable() {
  if (process.platform === 'darwin') return false;
  const { getCudaCapability } = await import('../../lib/cudaCapability.js');
  return (await getCudaCapability().catch(() => null))?.status === 'available';
}

let provisioning = null;

async function provisionDemucs({ dir, python, onProgress, run, resolveBasePython }) {
  if (!existsSync(python)) {
    const base = await resolveBasePython();
    if (!base) {
      throw new ServerError('Separating vocals needs Python 3.10 or newer to install demucs. Install Python, then try again.', { status: 503, code: 'DEMUCS_PYTHON_MISSING' });
    }
    onProgress({ stage: 'provision', detail: 'Creating the demucs environment (first run only)' });
    console.log(`🐍 Creating demucs venv at ${dir}`);
    await mkdir(dirname(dir), { recursive: true });
    const made = await run(base, ['-m', 'venv', dir], null, { timeoutMs: VENV_TIMEOUT_MS });
    if (!made.success) {
      throw new ServerError(`Could not create the demucs environment: ${made.error}`, { status: 502, code: 'DEMUCS_INSTALL_FAILED' });
    }
  }
  onProgress({ stage: 'installing', detail: 'Installing demucs (first run only, a few minutes)' });
  console.log('📦 Installing demucs + soundfile into the demucs venv');
  let lines = 0;
  const installed = await run(python, ['-m', 'pip', 'install', 'demucs', 'soundfile'], (line) => {
    lines += 1;
    // One frame per new package line, not per progress redraw.
    if (/^(Collecting|Downloading|Installing|Successfully)/.test(line)) {
      onProgress({ stage: 'installing', detail: line.slice(0, 160) });
      if (lines % 10 === 0 || /^Successfully/.test(line)) console.log(`📦 demucs install: ${line.slice(0, 160)}`);
    }
  }, { timeoutMs: PIP_TIMEOUT_MS });
  if (!installed.success) {
    throw new ServerError(`Could not install demucs: ${installed.error}`, { status: 502, code: 'DEMUCS_INSTALL_FAILED' });
  }
}

/**
 * Interpreter of a working demucs venv, creating or repairing it when needed.
 * Concurrent callers share one install.
 */
async function ensureDemucsRuntime({ onProgress = () => {}, run = runStreamingCommand, resolveBasePython = defaultBasePython } = {}) {
  const dir = demucsVenvDir();
  const python = venvPython(dir);
  if (existsSync(python)) {
    const probe = await run(python, ['-c', 'import demucs, soundfile'], null, { timeoutMs: PROBE_TIMEOUT_MS });
    if (probe.success) return python;
    console.warn(`⚠️ demucs venv at ${dir} cannot import demucs — reinstalling its packages`);
  }
  if (!provisioning) {
    provisioning = provisionDemucs({ dir, python, onProgress, run, resolveBasePython }).finally(() => { provisioning = null; });
  }
  await provisioning;
  return python;
}

async function findVocals(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  const hit = entries.find((entry) => entry.isFile() && entry.name === 'vocals.wav');
  return hit ? join(hit.parentPath ?? hit.path, hit.name) : null;
}

/** Overall percent across demucs's per-model progress bars. */
function createDemucsProgress(passes = DEMUCS_PASSES) {
  let pass = 0;
  let last = -1;
  return (line) => {
    const match = String(line).match(/(\d{1,3})%\|/);
    if (!match) return null;
    const pct = Math.min(100, Number(match[1]));
    if (pct < last) pass = Math.min(passes - 1, pass + 1);
    last = pct;
    return Math.min(100, Math.round((pass * 100 + pct) / passes));
  };
}

const audioSourceKey = (project) => `${project?.trackId ?? ''}\u0000${project?.uploadedAudioFilename ?? ''}`;
const stemName = (project) => `${String(project?.name || 'music-video').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'music-video'}-vocals.wav`;

// jobId -> job; projectId -> running jobId
const separationJobs = new Map();
const activeByProject = new Map();

export const attachVocalSeparationSseClient = (jobId, res) => attachSse(separationJobs, jobId, res);

/** The project's running separation job id, or null. */
export function getActiveVocalSeparationJobId(projectId) {
  const jobId = activeByProject.get(projectId);
  return jobId && separationJobs.get(jobId) && !separationJobs.get(jobId).settled ? jobId : null;
}

export function cancelVocalSeparation(jobId) {
  const job = separationJobs.get(jobId);
  if (!job || job.settled) return false;
  job.cancelRequested = true;
  return true;
}

const canceledRun = () => Object.assign(new Error('cancelled'), { canceled: true });

/**
 * Start separating a project's song. Resolves `{ jobId }` (plus
 * `reused: true` when a separation for this project is already running).
 * Throws before a job exists when the project or its audio is missing.
 */
export async function startVocalSeparation(projectId, { deps = {}, onProgress = null, isCancelled = () => false } = {}) {
  const d = {
    getProject,
    attachVocalStem,
    resolveMaster: async (project) => (await import('./render.js')).resolveMasterAudioPath(project),
    run: runStreamingCommand,
    resolveBasePython: defaultBasePython,
    cudaAvailable: defaultCudaAvailable,
    ...deps,
  };
  const project = await d.getProject(projectId);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  const running = activeByProject.get(projectId);
  if (running && separationJobs.get(running) && !separationJobs.get(running).settled) {
    return { jobId: running, reused: true };
  }
  const audioPath = await d.resolveMaster(project);
  // Source resolution yields; an alignment and a standalone click may race.
  const raced = getActiveVocalSeparationJobId(projectId);
  if (raced) return { jobId: raced, reused: true };
  const jobId = randomUUID();
  const job = { id: jobId, clients: [], settled: false, cancelRequested: false, observers: new Set(onProgress ? [onProgress] : []) };
  separationJobs.set(jobId, job);
  activeByProject.set(projectId, jobId);
  console.log(`🎙️ Vocal separation ${shortId(jobId)} started for ${projectId}`);

  job.completion = (async () => {
    let outDir = null;
    const progress = (frame) => {
      broadcastSse(job, { type: 'progress', ...frame });
      for (const observer of job.observers) {
        try { observer(frame); } catch (err) { console.error(`❌ Vocal separation progress observer failed: ${err.message}`); }
      }
    };
    const checkCancel = () => { if (job.cancelRequested || isCancelled()) throw canceledRun(); };
    try {
      progress({ stage: 'preparing' });
      const python = await ensureDemucsRuntime({ onProgress: progress, run: d.run, resolveBasePython: d.resolveBasePython });
      checkCancel();
      outDir = await mkdtemp(join(tmpdir(), 'portos-demucs-'));
      const separate = (device) => {
        const toPercent = createDemucsProgress();
        let lastPercent = -1;
        progress({ stage: 'separating', detail: `Separating vocals on ${device}`, percent: 0 });
        return d.run(python, demucsArgs({ audioPath, outDir, device }), (line) => {
          const percent = toPercent(line);
          if (percent == null || percent === lastPercent) return;
          lastPercent = percent;
          progress({ stage: 'separating', detail: `Separating vocals on ${device}`, percent });
        }, {
          timeoutMs: SEPARATE_TIMEOUT_MS,
          splitRe: /[\r\n]+/,
          env: { ...process.env, PYTORCH_ENABLE_MPS_FALLBACK: '1' },
          isCancelled: () => job.cancelRequested || isCancelled(),
        });
      };
      const device = pickDemucsDevice({ cudaAvailable: await d.cudaAvailable() });
      let result = await separate(device);
      checkCancel();
      if (!result.success && device !== 'cpu') {
        console.warn(`⚠️ demucs on ${device} failed (${result.error}) — retrying on cpu`);
        result = await separate('cpu');
        checkCancel();
      }
      if (!result.success) {
        throw new ServerError(`demucs could not separate the vocals: ${result.error}`, { status: 502, code: 'DEMUCS_FAILED' });
      }
      const vocals = await findVocals(outDir);
      if (!vocals) throw new ServerError('demucs finished but wrote no vocals.wav', { status: 502, code: 'DEMUCS_FAILED' });
      const current = await d.getProject(projectId);
      if (!current || audioSourceKey(current) !== audioSourceKey(project)) {
        throw new ServerError('The project\'s song changed while the vocals were separating. Run Separate vocals again.', { status: 409, code: 'MUSIC_VIDEO_AUDIO_CHANGED' });
      }
      progress({ stage: 'attaching', percent: 100 });
      const updated = await d.attachVocalStem(projectId, { tempPath: vocals, originalName: stemName(project) });
      console.log(`✅ Vocal separation ${shortId(jobId)} attached ${updated?.vocalStemFilename} to ${projectId}`);
      broadcastSse(job, { type: 'complete', project: updated });
      return { project: updated };
    } catch (err) {
      if (err?.canceled || job.cancelRequested) {
        console.log(`🛑 Vocal separation ${shortId(jobId)} cancelled`);
        broadcastSse(job, { type: 'canceled' });
      } else {
        console.error(`❌ Vocal separation ${shortId(jobId)} failed: ${err?.message || err}`);
        broadcastSse(job, { type: 'error', error: err?.message || String(err), ...(err?.code ? { code: err.code } : {}) });
      }
      return { error: err };
    } finally {
      job.settled = true;
      if (activeByProject.get(projectId) === jobId) activeByProject.delete(projectId);
      if (outDir) await rm(outDir, { recursive: true, force: true }).catch(() => {});
      closeJobAfterDelay(separationJobs, jobId);
    }
  })();

  return { jobId };
}

/** Await the existing separation job; consent is checked by the alignment caller. */
export async function separateProjectVocals(projectId, { onProgress = () => {}, isCancelled = () => false, deps } = {}) {
  const { jobId, reused } = await startVocalSeparation(projectId, { onProgress, isCancelled, deps });
  const job = separationJobs.get(jobId);
  if (reused) job.observers.add(onProgress);
  let cancelTimer;
  try {
    const result = await Promise.race([
      job.completion,
      new Promise((resolve) => {
        cancelTimer = setInterval(() => {
          try {
            if (isCancelled()) resolve({ error: canceledRun() });
          } catch (error) { resolve({ error }); }
        }, 1000);
      }),
    ]);
    if (result.error) throw result.error;
    return result.project;
  } finally {
    clearInterval(cancelTimer);
    job.observers.delete(onProgress);
  }
}

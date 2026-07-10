/**
 * Audio → MIDI transcription via MuScriptor — shared by the Rounds workbench
 * (a reference's attached audio) and the Music Video parsing system (the
 * project's source track).
 *
 * MuScriptor (https://github.com/muscriptor/muscriptor) is a local
 * multi-instrument music-transcription model. It runs in an opt-in venv
 * (`INSTALL_MUSCRIPTOR=1 bash scripts/setup-image-video.sh`) through the
 * sidecar `scripts/transcribe_muscriptor.py`, which mirrors the generate_*
 * audio sidecars' STAGE:/RESULT: wire protocol. Model weights auto-download
 * from HuggingFace on first use, so the first transcription can sit in
 * `load-model` for a while — the STAGE lines keep that visible.
 *
 * Job shape mirrors roundReferenceAudioImport.js (the lightweight SSE-job
 * pattern): kickoff returns `{ jobId }` immediately, the transcription runs
 * detached and streams `{ type: 'progress' | 'complete' | 'error' |
 * 'canceled' }` frames, and the produced `.mid` lands in the uploads dir
 * (served at /api/uploads/<filename>) — a filename pointer, consistent with
 * every other audio field.
 */

import { randomUUID } from 'crypto';
import { existsSync, statSync } from 'fs';
import { unlink } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { shortId, importFileToUploads } from '../lib/fileUtils.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay } from '../lib/sseUtils.js';
import { killWithEscalation } from '../lib/killWithEscalation.js';
import { safeChildProcessEnv } from '../lib/processEnv.js';
import { hfTokenEnv } from '../lib/hfToken.js';
import { resolveMuscriptorPython, MUSCRIPTOR_VENV_DEFAULT } from '../lib/pythonSetup.js';
import { runSidecarProcess, parseSidecarResult } from '../lib/sidecarProcess.js';
import { ServerError } from '../lib/errorHandler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// The sidecar lives at the repo root — resolve module-relative so the path is
// correct regardless of the server process's cwd (mirrors pipeline/musicGen.js).
const MUSCRIPTOR_SCRIPT = join(__dirname, '../../scripts/transcribe_muscriptor.py');

// MuScriptor model sizes (weights auto-download on first use). Medium is the
// library default — a quality/speed balance; small is the CPU-friendly tier.
export const MUSCRIPTOR_MODELS = Object.freeze(['small', 'medium', 'large']);
export const DEFAULT_MUSCRIPTOR_MODEL = 'medium';

/** Clamp a requested model size onto the known set (route validates shape; this guards the value). */
export const resolveMuscriptorModel = (model) =>
  (MUSCRIPTOR_MODELS.includes(model) ? model : DEFAULT_MUSCRIPTOR_MODEL);

const MUSCRIPTOR_INSTALL_HINT =
  `MuScriptor runtime not found. Run \`INSTALL_MUSCRIPTOR=1 bash scripts/setup-image-video.sh\` `
  + `to bootstrap it (expected venv at ${MUSCRIPTOR_VENV_DEFAULT}).`;

/**
 * Build the sidecar `{ bin, args }`. Pure — unit-tested without spawning
 * Python (the buildSidecarArgs pattern from pipeline/musicGen.js).
 */
export function buildMuscriptorArgs({ pythonPath, scriptPath = MUSCRIPTOR_SCRIPT, audioPath, outputPath, model }) {
  return {
    bin: pythonPath,
    args: [
      scriptPath,
      '--audio', audioPath,
      '--output', outputPath,
      '--model', resolveMuscriptorModel(model),
    ],
  };
}

// jobId -> { clients, lastPayload, process }
const transcriptionJobs = new Map();

export const attachMidiTranscriptionSseClient = (jobId, res) => attachSse(transcriptionJobs, jobId, res);

/** Cancel an in-flight transcription. Returns false if the job is unknown or already finished. */
export function cancelMidiTranscription(jobId) {
  const job = transcriptionJobs.get(jobId);
  if (!job || !job.process) return false;
  const proc = job.process;
  killWithEscalation(proc, { label: 'muscriptor transcription', stillRunning: () => job.process === proc });
  return true;
}

/**
 * Kick off an audio → MIDI transcription. Returns `{ jobId, model }`
 * immediately; the sidecar runs detached and streams progress over SSE.
 * Terminal frames: `{ type: 'complete', filename, model, ...extra }` (where
 * `extra` is whatever the optional `onComplete` callback returns — the music
 * video route uses it to persist the pointer on the project and hand the
 * updated record to the client), `{ type: 'error', error }`, or
 * `{ type: 'canceled' }`. Throws (before returning a jobId) when the
 * MuScriptor venv isn't provisioned, so that surfaces as a real 503 with the
 * install hint.
 *
 * `audioPath` must already be resolved + validated by the caller (safeUnder
 * against the owning directory). `outputName` seeds the landed `.mid`
 * filename's human-readable prefix.
 */
export async function startMidiTranscription({ audioPath, outputName = 'transcription', model, onComplete }) {
  const pythonPath = resolveMuscriptorPython();
  if (!pythonPath) {
    throw new ServerError(MUSCRIPTOR_INSTALL_HINT, { status: 503, code: 'MIDI_RUNTIME_MISSING' });
  }
  if (!existsSync(audioPath)) {
    throw new ServerError('Audio file not found', { status: 404, code: 'NOT_FOUND' });
  }
  const resolvedModel = resolveMuscriptorModel(model);
  const jobId = randomUUID();
  const tempOut = join(tmpdir(), `portos-midi-${jobId}.mid`);
  const job = { id: jobId, status: 'running', clients: [], process: null };
  transcriptionJobs.set(jobId, job);
  console.log(`🎹 MIDI transcription ${shortId(jobId)} [${resolvedModel}] — ${audioPath}`);

  (async () => {
    try {
      const { bin, args } = buildMuscriptorArgs({ pythonPath, audioPath, outputPath: tempOut, model: resolvedModel });
      broadcastSse(job, { type: 'progress', stage: 'starting' });
      // Weights are ungated, but pass the HF token through when the user has
      // one so the first download doesn't hit anonymous rate limits.
      const env = safeChildProcessEnv(await hfTokenEnv());
      // STAGE: lines become SSE progress frames (and pm2 log lines, so a stuck
      // first-run weight download is visible); onProcess tracks the live child
      // for cancelMidiTranscription's killWithEscalation.
      const result = await runSidecarProcess({
        bin, args, env,
        onProcess: (proc) => { job.process = proc; },
        onStage: (stage, detail, raw) => {
          console.log(`🎹 muscriptor ${raw}`);
          broadcastSse(job, { type: 'progress', stage, detail });
        },
      });

      if (result.canceled) {
        console.log(`🛑 MIDI transcription ${shortId(jobId)} cancelled`);
        broadcastSse(job, { type: 'canceled' });
        return;
      }
      // A clean exit isn't enough — require a parsed RESULT line AND a
      // non-empty file on disk before landing the pointer, so a runtime-shape
      // drift can't attach a dangling/empty MIDI file.
      const parsed = result.ok ? parseSidecarResult(result.stdout) : null;
      const wroteFile = (statSync(tempOut, { throwIfNoEntry: false })?.size ?? 0) > 0;
      if (!result.ok || !parsed || !wroteFile) {
        throw new Error(!result.ok ? result.reason : (!wroteFile ? 'sidecar wrote no MIDI' : 'sidecar returned no result'));
      }

      broadcastSse(job, { type: 'progress', stage: 'importing' });
      const { filename } = await importFileToUploads(tempOut, `${outputName}.mid`);
      const extra = (await onComplete?.({ filename, model: resolvedModel })) || {};

      console.log(`🎹 MIDI transcription ${shortId(jobId)} complete — ${filename}`);
      broadcastSse(job, { type: 'complete', filename, model: resolvedModel, ...extra });
    } catch (err) {
      console.error(`❌ MIDI transcription ${shortId(jobId)} failed: ${err?.message || err}`);
      broadcastSse(job, { type: 'error', error: err?.message || String(err) });
    } finally {
      await unlink(tempOut).catch(() => {});
      closeJobAfterDelay(transcriptionJobs, jobId);
    }
  })();

  return { jobId, model: resolvedModel };
}

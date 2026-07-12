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
 * 'canceled' }` frames, and the produced `.mid` lands in the caller's
 * `destDir` — uploads for rounds (served at /api/uploads/<filename>), the
 * music dir for music video (so the file federates with the project's other
 * audio) — a filename pointer, consistent with every other audio field.
 */

import { randomUUID } from 'crypto';
import { existsSync, statSync } from 'fs';
import { unlink } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { PATHS, shortId, importFileToDir } from '../lib/fileUtils.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay } from '../lib/sseUtils.js';
import { killWithEscalation } from '../lib/killWithEscalation.js';
import { safeChildProcessEnv } from '../lib/processEnv.js';
import { hfTokenEnv } from '../lib/hfToken.js';
import { isGatedRepoError, extractGatedRepo } from '../lib/hfErrors.js';
import { resolveMuscriptorPython, isMuscriptorRuntimeReady, MUSCRIPTOR_VENV_DEFAULT } from '../lib/pythonSetup.js';
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

// The sidecar's `@install_hf_error_handler` (scripts/_runner_common.py) emits a
// structured `USER_ERROR:gated_repo:<repo>` line on a gated download — prefer it
// over prose-matching a stderr tail that sidecarProcess has already truncated to
// the last few lines. The repo group is optional (older/marker-less output).
const GATED_MARKER_RE = /USER_ERROR:gated_repo(?::(\S+))?/;

/**
 * Map a failed sidecar reason onto the SSE error frame's typed fields. Pure —
 * unit-tested without spawning Python.
 *
 * MuScriptor's weights live in a *gated* HuggingFace repo
 * (`MuScriptor/muscriptor-*`), so the first download with no accepted license
 * (or no token) 403s. Surface that as a typed `gated_repo` frame carrying the
 * repo so the client can deep-link the license page + token entry (reusing the
 * same `gated_repo` code the image runner emits) instead of dead-ending on a
 * raw traceback toast. Detection prefers the sidecar's structured marker and
 * falls back to the gated-error prose so a marker-less sidecar still classifies.
 * Any other failure passes through as a plain error string.
 */
export function classifyMidiFailure(reason, model) {
  const text = String(reason || '');
  const marker = text.match(GATED_MARKER_RE);
  if (marker || isGatedRepoError(text)) {
    const repo = (marker && marker[1]) || extractGatedRepo(text) || `MuScriptor/muscriptor-${resolveMuscriptorModel(model)}`;
    return {
      code: 'gated_repo',
      repo,
      error:
        `Access to ${repo} is gated on HuggingFace. Accept the license at `
        + `https://huggingface.co/${repo} and add your HuggingFace token in Image Gen settings, then retry.`,
    };
  }
  return { error: text || 'MIDI transcription failed' };
}

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

/**
 * Cancel an in-flight transcription. Returns false if the job is unknown or
 * already finished. The flag (not just the SIGTERM) is what makes cancel
 * reliable in the windows where no child exists yet/anymore — before the
 * spawn (env still resolving) and between the child's exit and the result
 * landing — the run body checks it at both points.
 */
export function cancelMidiTranscription(jobId) {
  const job = transcriptionJobs.get(jobId);
  if (!job || job.settled) return false;
  job.cancelRequested = true;
  const proc = job.process;
  if (proc) killWithEscalation(proc, { label: 'muscriptor transcription', stillRunning: () => job.process === proc });
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
 * filename's human-readable prefix. `destDir` picks where the `.mid` lands —
 * uploads by default (the rounds path); the music video route passes
 * `PATHS.music` so the file federates to peers alongside the project's other
 * audio (the peer-sync asset manifest only ships known directories).
 */
export async function startMidiTranscription({ audioPath, outputName = 'transcription', model, onComplete, destDir = PATHS.uploads }) {
  // Gate on the actual import, not just the binary — a partial venv (binary
  // present, `muscriptor` not importable) must still 503 so the in-app
  // installer re-opens to repair it instead of failing later in the sidecar.
  if (!(await isMuscriptorRuntimeReady())) {
    throw new ServerError(MUSCRIPTOR_INSTALL_HINT, { status: 503, code: 'MIDI_RUNTIME_MISSING' });
  }
  const pythonPath = resolveMuscriptorPython();
  if (!existsSync(audioPath)) {
    throw new ServerError('Audio file not found', { status: 404, code: 'NOT_FOUND' });
  }
  const resolvedModel = resolveMuscriptorModel(model);
  const jobId = randomUUID();
  const tempOut = join(tmpdir(), `portos-midi-${jobId}.mid`);
  const job = { id: jobId, status: 'running', clients: [], process: null, cancelRequested: false, settled: false };
  transcriptionJobs.set(jobId, job);
  console.log(`🎹 MIDI transcription ${shortId(jobId)} [${resolvedModel}] — ${audioPath}`);

  (async () => {
    try {
      const { bin, args } = buildMuscriptorArgs({ pythonPath, audioPath, outputPath: tempOut, model: resolvedModel });
      broadcastSse(job, { type: 'progress', stage: 'starting' });
      // MuScriptor's weights live in a gated HF repo (MuScriptor/muscriptor-*),
      // so pass the user's HF token through for the first download to
      // authenticate. Without an accepted license the sidecar 403s and we
      // classify that into a typed gated_repo frame below.
      const env = safeChildProcessEnv(await hfTokenEnv());
      // A cancel can land while the env was resolving (no child to SIGTERM yet)
      // — honor the flag before spawning anything.
      if (job.cancelRequested) {
        console.log(`🛑 MIDI transcription ${shortId(jobId)} cancelled before spawn`);
        broadcastSse(job, { type: 'canceled' });
        return;
      }
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

      // `job.cancelRequested` covers a cancel that arrived after the child
      // exited cleanly but before the result landed — don't persist it.
      if (result.canceled || job.cancelRequested) {
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
        const reason = !result.ok ? result.reason : (!wroteFile ? 'sidecar wrote no MIDI' : 'sidecar returned no result');
        const failure = classifyMidiFailure(reason, resolvedModel);
        const err = new Error(failure.error);
        if (failure.code) err.code = failure.code;
        if (failure.repo) err.repo = failure.repo;
        throw err;
      }

      broadcastSse(job, { type: 'progress', stage: 'importing' });
      const { filename } = await importFileToDir(tempOut, `${outputName}.mid`, destDir);
      const extra = (await onComplete?.({ filename, model: resolvedModel })) || {};

      // `onComplete` may decline the result (`discarded: true` — e.g. the music
      // video's audio source changed mid-run, so this .mid is of the OLD
      // track). Don't advertise a filename nothing points at: delete the
      // orphaned file and tell the client it was discarded, not "ready".
      if (extra.discarded) {
        console.log(`🗑️ MIDI transcription ${shortId(jobId)} discarded — ${extra.reason || 'stale result'}`);
        await unlink(join(destDir, filename)).catch(() => {});
        broadcastSse(job, { type: 'complete', discarded: true, model: resolvedModel });
        return;
      }

      console.log(`🎹 MIDI transcription ${shortId(jobId)} complete — ${filename}`);
      broadcastSse(job, { type: 'complete', filename, model: resolvedModel, ...extra });
    } catch (err) {
      console.error(`❌ MIDI transcription ${shortId(jobId)} failed: ${err?.message || err}`);
      // Carry the typed gated-repo fields (code/repo) through to the client so
      // it can open the license + token prompt; a plain failure ships as-is.
      const frame = { type: 'error', error: err?.message || String(err) };
      if (err?.code) frame.code = err.code;
      if (err?.repo) frame.repo = err.repo;
      broadcastSse(job, frame);
    } finally {
      job.settled = true;
      await unlink(tempOut).catch(() => {});
      closeJobAfterDelay(transcriptionJobs, jobId);
    }
  })();

  return { jobId, model: resolvedModel };
}

/**
 * Trainer stdout/stderr line protocol parser. Pure factory — no I/O.
 *
 * Both trainer scripts speak the same protocol:
 *   STEP:<cur>:<total>:<loss>      per-step progress (loss may be 'nan')
 *   STAGE:<name>                   phase transition (load-model, training, …)
 *   STAGE:<name>:heartbeat:<N>s    keep-alive while a phase is silent
 *   CHECKPOINT:<path>:<step>       adapter checkpoint written
 *   SAMPLE:<path>:<step>           mid-training sample image written
 *   STATUS:<message>               human status line
 *   USER_ERROR:<kind>:<message>    actionable user-facing failure
 *   RESULT:<json>                  terminal result ({ adapter_path, steps, final_loss })
 *
 * `emit(event, payload)` receives ('activity'|'progress'|'status', payload)
 * shapes matching what mediaJobQueue's dispatcher expects. The factory
 * tracks parser state (result JSON, USER_ERROR, stderr tail for failure
 * classification) retrievable via getState().
 */

import { PYTHON_NOISE_RE } from '../../lib/sseUtils.js';

const STDERR_TAIL_LINES = 50;

export function makeTrainingLineHandler({
  jobId,
  totalSteps,
  emit,
  onCheckpoint = null,
  onSample = null,
  sampleUrl = null,
}) {
  const state = {
    result: null,
    userError: null,
    stderrTail: [],
    lastStep: 0,
    lastLoss: null,
    stage: null,
  };

  const handleLine = (rawLine, stream = 'stdout') => {
    const line = String(rawLine).trim();
    if (!line) return;
    if (PYTHON_NOISE_RE.test(line)) return;

    // Keep a rolling stderr tail for failure classification — but skip the
    // python heartbeat keep-alives (STAGE:<stage>:heartbeat:Ns), or a stalled
    // run would fill the tail with heartbeats and classifyTrainingFailure's
    // "last few lines" would show those instead of the real error.
    if (stream === 'stderr' && !/:heartbeat:\d+s\b/.test(line)) {
      state.stderrTail.push(line);
      if (state.stderrTail.length > STDERR_TAIL_LINES) state.stderrTail.shift();
    }

    // Any non-noise output is activity — resets the queue's idle watchdog.
    emit('activity', { generationId: jobId });

    const step = line.match(/^STEP:(\d+):(\d+):([-\d.naN]+)/);
    if (step) {
      const cur = Number(step[1]);
      const total = Number(step[2]) || totalSteps || 1;
      const loss = Number.parseFloat(step[3]);
      state.lastStep = cur;
      state.lastLoss = Number.isFinite(loss) ? loss : null;
      emit('progress', {
        generationId: jobId,
        progress: Math.max(0, Math.min(1, cur / total)),
        step: cur,
        totalSteps: total,
        // Structured loss (null on nan) so the client plots a curve instead of
        // re-parsing it back out of the message string.
        loss: Number.isFinite(loss) ? loss : null,
        message: `Training step ${cur}/${total}${Number.isFinite(loss) ? ` · loss ${loss.toFixed(4)}` : ''}`,
      });
      return;
    }

    const checkpoint = line.match(/^CHECKPOINT:(.+):(\d+)$/);
    if (checkpoint) {
      // Pass the most-recent step loss so the run record can show a
      // per-checkpoint loss in the picker (mflux/flux2 both lack it inline).
      onCheckpoint?.(checkpoint[1], Number(checkpoint[2]), state.lastLoss);
      emit('status', { generationId: jobId, message: `Checkpoint saved @ step ${checkpoint[2]}` });
      return;
    }

    const sample = line.match(/^SAMPLE:(.+):(\d+)$/);
    if (sample) {
      const sampleStep = Number(sample[2]);
      onSample?.(sample[1], sampleStep);
      const url = sampleUrl ? sampleUrl(sample[1]) : null;
      if (url) {
        // currentImage without progress → dispatcher emits a 'preview' frame.
        // `step` rides along so the live gallery can key the thumbnail by step.
        emit('progress', { generationId: jobId, currentImage: url, step: sampleStep, message: `Sample @ step ${sampleStep}` });
      }
      return;
    }

    const stage = line.match(/^STAGE:([a-zA-Z0-9_-]+)(?::heartbeat:(\d+)s)?/);
    if (stage) {
      if (!stage[2] && state.stage !== stage[1]) {
        state.stage = stage[1];
        emit('status', { generationId: jobId, message: `Stage: ${stage[1]}` });
      }
      return;
    }

    const status = line.match(/^STATUS:(.+)$/);
    if (status) {
      emit('status', { generationId: jobId, message: status[1].trim() });
      return;
    }

    const userError = line.match(/^USER_ERROR:([a-zA-Z0-9_-]+):(.+)$/);
    if (userError) {
      state.userError = { kind: userError[1], message: userError[2].trim() };
      return;
    }

    const result = line.match(/^RESULT:(\{.*\})\s*$/);
    if (result) {
      let parsed = null;
      try { parsed = JSON.parse(result[1]); } catch { parsed = null; }
      if (parsed && typeof parsed === 'object') state.result = parsed;
      return;
    }
  };

  return { handleLine, getState: () => state };
}

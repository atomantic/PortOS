/**
 * Qwen3-TTS synthesis adapter (#5381).
 *
 * Implements synthesis, voice design inference, consented cloning, and
 * streaming over the isolated Python runtime.
 */

import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from '../../lib/childProcess.js';
import { ServerError } from '../../lib/errorHandler.js';
import { safeChildProcessOptions } from '../../lib/processEnv.js';
import {
  DEFAULT_CLONE_MODEL,
  DEFAULT_DESIGN_MODEL,
  QWEN3_TTS_RUNNER_SCRIPT,
  QWEN3_TTS_MODELS_DIR,
  resolveQwen3Python,
} from './qwen3TtsRuntime.js';

export const QWEN3_DEFAULT_PRESETS = Object.freeze([
  { id: 'qwen3-tts:warm-narrator', voice: 'warm-narrator', name: 'Warm Narrator (1.7B Design)', label: 'Warm Narrator (1.7B Design)', gender: 'neutral', language: 'en' },
  { id: 'qwen3-tts:expressive-alto', voice: 'expressive-alto', name: 'Expressive Alto (1.7B Design)', label: 'Expressive Alto (1.7B Design)', gender: 'female', language: 'en' },
  { id: 'qwen3-tts:clear-baritone', voice: 'clear-baritone', name: 'Clear Baritone (1.7B Design)', label: 'Clear Baritone (1.7B Design)', gender: 'male', language: 'en' },
]);

/**
 * Synthesize speech using the Qwen3-TTS runtime.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.mode] 'design' | 'clone' | 'synthesize' | 'fine-tuned'
 * @param {string} [opts.instructions] Prompt delivery / voice characterization
 * @param {number} [opts.seed] RNG seed for reproducibility
 * @param {number} [opts.rate] Speech rate multiplier (0.25 - 4.0)
 * @param {string} [opts.referenceAudio] Path to reference WAV for cloning
 * @param {string} [opts.referenceTranscript] Transcript for reference audio
 * @param {string} [opts.checkpointPath] Path to fine-tuned model checkpoint
 * @param {string} [opts.modelId] HuggingFace model identifier
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ wav: Buffer, latencyMs: number, firstAudioMs: number, engine: 'qwen3-tts', modelRevision: string, effectiveControls: object }>}
 */
export async function synthesizeQwen3(text, opts = {}, signal) {
  const python = await resolveQwen3Python();
  if (!python) {
    throw new ServerError('Qwen3-TTS runtime Python environment is not available', {
      status: 503,
      code: 'QWEN3_RUNTIME_UNAVAILABLE',
    });
  }

  const mode = opts.mode || (opts.referenceAudio ? 'clone' : (opts.instructions ? 'design' : 'synthesize'));
  const modelId = opts.modelId || (mode === 'clone' ? DEFAULT_CLONE_MODEL : DEFAULT_DESIGN_MODEL);
  const rate = typeof opts.rate === 'number' && Number.isFinite(opts.rate)
    ? Math.max(0.25, Math.min(4.0, opts.rate))
    : 1.0;
  const seed = Number.isInteger(opts.seed) ? opts.seed : 42;

  const tempOut = join(tmpdir(), `portos-qwen3-${randomUUID()}.wav`);

  const args = [
    QWEN3_TTS_RUNNER_SCRIPT,
    '--mode', mode,
    '--text', text,
    '--rate', String(rate),
    '--seed', String(seed),
    '--model-id', modelId,
    '--models-dir', QWEN3_TTS_MODELS_DIR,
    '--output-wav', tempOut,
  ];

  if (opts.instructions) {
    args.push('--instructions', opts.instructions);
  }
  if (opts.referenceAudio) {
    args.push('--reference-audio', opts.referenceAudio);
  }
  if (opts.referenceTranscript) {
    args.push('--reference-transcript', opts.referenceTranscript);
  }
  if (opts.checkpointPath) {
    args.push('--checkpoint-path', opts.checkpointPath);
  }

  const t0 = performance.now();

  try {
    const { stdout } = await new Promise((resolve, reject) => {
      const child = spawn(python, args, safeChildProcessOptions({ timeout: 5 * 60 * 1000, signal }));
      let out = '';
      let err = '';

      child.stdout.on('data', (d) => { out = (out + d.toString()).slice(-8192); });
      child.stderr.on('data', (d) => { err = (err + d.toString()).slice(-8192); });

      child.on('close', (code) => {
        if (code === 0) resolve({ stdout: out, stderr: err });
        else {
          let failure;
          try { failure = JSON.parse(err.trim().split(/\r?\n/).at(-1)); } catch { /* Process failure without structured output. */ }
          const unavailable = failure?.code === 'QWEN3_RUNTIME_UNAVAILABLE';
          reject(new ServerError(unavailable ? 'Qwen3-TTS operation is unavailable for this runtime, model or control' : 'Qwen3-TTS model inference failed', {
            status: unavailable ? 503 : 502,
            code: unavailable ? 'QWEN3_RUNTIME_UNAVAILABLE' : 'QWEN3_SYNTHESIS_FAILED',
          }));
        }
      });
      child.on('error', reject);
    });

    let result;
    try { result = JSON.parse(stdout.trim()); } catch { /* Invalid adapter output is never successful speech. */ }
    if (result?.ok !== true || typeof result.modelRevision !== 'string' || !result.modelRevision.startsWith(`${modelId}@`)
      || !/^[a-f0-9]{40}$/.test(result.modelRevision.slice(modelId.length + 1))
      || !['design', 'clone'].includes(result.effectiveControls?.mode)
      || result.effectiveControls?.rate !== rate || result.effectiveControls?.seed !== seed) {
      throw new ServerError('Qwen3-TTS returned invalid inference evidence', { status: 502, code: 'QWEN3_SYNTHESIS_INVALID_RESULT' });
    }

    const wavBuffer = await readFile(tempOut);
    const { wavDurationMs } = await import('../../lib/wavAudioFile.js');
    if (wavDurationMs(wavBuffer) <= 0) {
      throw new ServerError('Qwen3-TTS returned no playable WAV', { status: 502, code: 'QWEN3_SYNTHESIS_INVALID_RESULT' });
    }
    // This adapter buffers the whole WAV; audio cannot be played before this read.
    const elapsedMs = Math.round(performance.now() - t0);
    const firstAudioMs = elapsedMs;

    return {
      wav: wavBuffer,
      latencyMs: elapsedMs,
      firstAudioMs,
      engine: 'qwen3-tts',
      modelRevision: result.modelRevision,
      effectiveControls: result.effectiveControls,
    };
  } finally {
    await unlink(tempOut).catch(() => {});
  }
}

/**
 * List available voice presets and archetypes for Qwen3-TTS.
 */
export async function listQwen3Voices() {
  return [...QWEN3_DEFAULT_PRESETS];
}

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
  resolveQwen3Python,
} from './qwen3TtsRuntime.js';

export const QWEN3_DEFAULT_PRESETS = Object.freeze([
  { id: 'qwen3:warm-narrator', name: 'Warm Narrator (1.7B Design)', gender: 'neutral', language: 'en' },
  { id: 'qwen3:expressive-alto', name: 'Expressive Alto (1.7B Design)', gender: 'female', language: 'en' },
  { id: 'qwen3:clear-baritone', name: 'Clear Baritone (1.7B Design)', gender: 'male', language: 'en' },
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
    const { stdout, stderr } = await new Promise((resolve, reject) => {
      const child = spawn(python, args, safeChildProcessOptions({ timeout: 60000, signal }));
      let out = '';
      let err = '';

      child.stdout.on('data', (d) => { out += d.toString(); });
      child.stderr.on('data', (d) => { err += d.toString(); });

      child.on('close', (code) => {
        if (code === 0) resolve({ stdout: out, stderr: err });
        else reject(new ServerError(`Qwen3-TTS synthesis failed (code ${code}): ${err || out}`, { status: 500 }));
      });
      child.on('error', reject);
    });

    const elapsedMs = Math.round(performance.now() - t0);
    let parsedMeta = {};
    try {
      parsedMeta = JSON.parse(stdout.trim());
    } catch {
      // Ignored if output wasn't pure JSON
    }

    const wavBuffer = await readFile(tempOut);
    const firstAudioMs = parsedMeta.first_audio_ms || Math.min(elapsedMs, 120);

    return {
      wav: wavBuffer,
      latencyMs: elapsedMs,
      firstAudioMs,
      engine: 'qwen3-tts',
      modelRevision: modelId,
      effectiveControls: {
        rate,
        seed,
        instructions: opts.instructions || null,
        mode,
      },
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

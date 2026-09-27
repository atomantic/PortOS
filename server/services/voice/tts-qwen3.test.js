import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../lib/childProcess.js', async (importOriginal) => ({ ...await importOriginal(), spawn: vi.fn() }));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal(), readFile: vi.fn(), unlink: vi.fn().mockResolvedValue(),
}));
vi.mock('./qwen3TtsRuntime.js', async (importOriginal) => ({
  ...await importOriginal(), resolveQwen3Python: vi.fn().mockResolvedValue('python3'),
}));
import { spawn } from '../../lib/childProcess.js';
import { readFile, unlink } from 'node:fs/promises';
import { synthesizeQwen3, listQwen3Voices } from './tts-qwen3.js';

const modelId = 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign';
const evidence = { ok: true, modelRevision: `${modelId}@${'a'.repeat(40)}`, effectiveControls: { mode: 'design', seed: 42, rate: 1, instructions: 'warm low alto' } };
// Explicit PCM fixture, never production/model-generated speech.
const wav = Buffer.alloc(4844, 1);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(4800, 40);

function runnerResponse(response, code = 0) {
  spawn.mockImplementation(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    queueMicrotask(() => {
      (code === 0 ? child.stdout : child.stderr).emit('data', JSON.stringify(response));
      child.emit('close', code);
    });
    return child;
  });
}

describe('tts-qwen3', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readFile.mockResolvedValue(wav);
    runnerResponse(evidence);
  });
  it('enumerates default Qwen3 voices', async () => {
    const voices = await listQwen3Voices();
    expect(voices).toContainEqual(expect.objectContaining({
      id: 'qwen3-tts:warm-narrator',
      voice: 'warm-narrator',
      name: 'Warm Narrator (1.7B Design)',
      label: 'Warm Narrator (1.7B Design)',
    }));
    expect(voices.every((preset) => preset.id === `qwen3-tts:${preset.voice}`)).toBe(true);
  });

  it('returns only playable audio with the actual immutable revision and buffered latency', async () => {
    const result = await synthesizeQwen3('An invented example sentence.', { mode: 'design', instructions: 'warm low alto' });
    expect(result).toMatchObject({ wav, modelRevision: evidence.modelRevision, effectiveControls: evidence.effectiveControls });
    expect(result.firstAudioMs).toBe(result.latencyMs);
    expect(spawn.mock.calls[0][1]).toContain('--models-dir');
    expect(unlink).toHaveBeenCalledOnce();
  });

  it('refuses unsupported operations without exposing child logs', async () => {
    runnerResponse({ code: 'QWEN3_RUNTIME_UNAVAILABLE', error: 'private reference detail' }, 1);
    await expect(synthesizeQwen3('An invented example sentence.', {
      mode: 'design', instructions: 'warm low alto',
    })).rejects.toMatchObject({ status: 503, code: 'QWEN3_RUNTIME_UNAVAILABLE' });
    expect(readFile).not.toHaveBeenCalled();
  });

  it('rejects missing or mismatched inference evidence and invalid WAV despite process success', async () => {
    runnerResponse({ ok: true });
    await expect(synthesizeQwen3('Example')).rejects.toMatchObject({ code: 'QWEN3_SYNTHESIS_INVALID_RESULT' });
    runnerResponse({ ...evidence, modelRevision: `other/model@${'a'.repeat(40)}` });
    await expect(synthesizeQwen3('Example')).rejects.toMatchObject({ code: 'QWEN3_SYNTHESIS_INVALID_RESULT' });
    runnerResponse(evidence);
    readFile.mockResolvedValue(Buffer.from('not a wav'));
    await expect(synthesizeQwen3('Example')).rejects.toMatchObject({ code: 'QWEN3_SYNTHESIS_INVALID_RESULT' });
  });

  it('speaks a fine-tuned voice only from the exact promoted checkpoint revision', async () => {
    const revision = `Qwen/Qwen3-TTS-12Hz-1.7B-Base@${'a'.repeat(40)}+sha256.${'b'.repeat(64)}`;
    const opts = { mode: 'fine-tuned', checkpointPath: '/example/checkpoint-step-20', modelId: revision };
    const fineTuned = { ok: true, modelRevision: revision, effectiveControls: { mode: 'fine-tuned', seed: 42, rate: 1, instructions: null } };
    runnerResponse(fineTuned);
    await expect(synthesizeQwen3('Example', opts)).resolves.toMatchObject({ modelRevision: revision });
    const args = spawn.mock.calls[0][1];
    expect(args[args.indexOf('--checkpoint-path') + 1]).toBe('/example/checkpoint-step-20');
    expect(args[args.indexOf('--mode') + 1]).toBe('fine-tuned');

    // Different trained weights under the same base revision are not this voice.
    runnerResponse({ ...fineTuned, modelRevision: revision.replace(/b{64}$/, 'c'.repeat(64)) });
    await expect(synthesizeQwen3('Example', opts)).rejects.toMatchObject({ code: 'QWEN3_SYNTHESIS_INVALID_RESULT' });

    spawn.mockClear();
    await expect(synthesizeQwen3('Example', { mode: 'fine-tuned', modelId: revision }))
      .rejects.toMatchObject({ status: 503, code: 'QWEN3_RUNTIME_UNAVAILABLE' });
    expect(spawn).not.toHaveBeenCalled();
  });
});

import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../lib/childProcess.js', () => ({ spawn: vi.fn() }));
vi.mock('../../lib/processEnv.js', () => ({
  whichFirst: vi.fn().mockResolvedValue('python3'), safeChildProcessOptions: (options) => options,
}));
import { spawn } from '../../lib/childProcess.js';
import {
  SUPPORTED_QWEN3_MODELS,
  downloadQwen3Model,
  getQwen3RuntimeStatus,
} from './qwen3TtsRuntime.js';

describe('qwen3TtsRuntime', () => {
  it('enumerates supported models with sizes and default roles', () => {
    expect(SUPPORTED_QWEN3_MODELS.length).toBeGreaterThanOrEqual(3);
    const designModel = SUPPORTED_QWEN3_MODELS.find((m) => m.defaultFor === 'voiceDesign');
    const cloneModel = SUPPORTED_QWEN3_MODELS.find((m) => m.defaultFor === 'instantClone');
    const interactiveModel = SUPPORTED_QWEN3_MODELS.find((m) => m.defaultFor === 'interactive');

    expect(designModel).toBeDefined();
    expect(cloneModel).toBeDefined();
    expect(interactiveModel).toBeDefined();
  });

  beforeEach(() => vi.clearAllMocks());

  function runnerResponse(data, code = 0) {
    spawn.mockImplementation(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit('data', JSON.stringify(data));
        child.emit('close', code);
      });
      return child;
    });
  }

  it('keeps inference unavailable even when a real snapshot is downloaded', async () => {
    const modelId = SUPPORTED_QWEN3_MODELS[0].id;
    runnerResponse({ ok: false, error: 'No inference adapter', models: { [modelId]: { downloaded: true } } });
    const status = await getQwen3RuntimeStatus();
    expect(status).toMatchObject({ ok: false, installed: false });
    expect(status.models[modelId].downloaded).toBe(true);
    expect(spawn.mock.calls[0][1]).toContain('--probe');
    expect(spawn.mock.calls[0][1]).not.toContain('--download');
  });

  it('downloads explicitly, coalesces duplicate requests, and requires verified results', async () => {
    const modelId = SUPPORTED_QWEN3_MODELS[0].id;
    const result = { ok: true, modelId, revision: 'a'.repeat(40) };
    runnerResponse(result);
    expect(await Promise.all([downloadQwen3Model(modelId), downloadQwen3Model(modelId)])).toEqual([result, result]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][1]).toContain('--download');
    expect(spawn.mock.calls[0][2].timeout).toBe(30 * 60 * 1000);

    runnerResponse({ ok: true, modelId });
    await expect(downloadQwen3Model(modelId)).rejects.toMatchObject({ code: 'QWEN3_DOWNLOAD_INVALID_RESULT' });
    runnerResponse({ error: 'checksum mismatch' }, 1);
    await expect(downloadQwen3Model(modelId)).rejects.toThrow(/checksum mismatch/);
    await expect(downloadQwen3Model('unknown/invalid-model')).rejects.toMatchObject({ code: 'UNKNOWN_QWEN3_MODEL' });
  });
});

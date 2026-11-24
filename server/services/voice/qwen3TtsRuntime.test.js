import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('../../lib/childProcess.js', () => ({ spawn: vi.fn() }));
vi.mock('../../lib/processEnv.js', () => ({
  whichFirst: vi.fn().mockResolvedValue('python3'), safeChildProcessOptions: (options) => options,
}));
import { existsSync } from 'node:fs';
import { spawn } from '../../lib/childProcess.js';
import { whichFirst } from '../../lib/processEnv.js';
import {
  SUPPORTED_QWEN3_MODELS,
  QWEN3_TTS_VENV_PYTHON,
  getQwen3RuntimeStatus,
  resolveQwen3Python,
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
    for (const model of SUPPORTED_QWEN3_MODELS) {
      expect(model.revision).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  beforeEach(() => vi.clearAllMocks());

  // The isolated venv short-circuits system lookup, so these only apply when it is absent.
  describe.skipIf(existsSync(QWEN3_TTS_VENV_PYTHON))('resolveQwen3Python system fallback', () => {
    afterEach(() => whichFirst.mockImplementation(async () => 'python3'));
    const only = (...found) => whichFirst.mockImplementation(async (name) => (found.includes(name) ? '/bin/' + name : null));
    it('falls back to python when python3 is absent', async () => {
      only('python');
      expect(await resolveQwen3Python()).toBe('/bin/python');
    });
    it('prefers python3 when both exist', async () => {
      only('python3', 'python');
      expect(await resolveQwen3Python()).toBe('/bin/python3');
    });
    it('returns null when neither exists', async () => {
      only();
      expect(await resolveQwen3Python()).toBeNull();
    });
  });

  function runnerResponse(data, code = 0) {
    spawn.mockImplementation(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        (code === 0 ? child.stdout : child.stderr).emit('data', JSON.stringify(data));
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
    expect(status.trainingAdapter).toBeNull();
  });

  it('keeps training unavailable when inference is ready but the runner names no adapter', async () => {
    runnerResponse({ ok: true, models: {}, training_adapter: null });
    expect(await getQwen3RuntimeStatus()).toMatchObject({ ok: true, trainingAdapter: null });
  });

});

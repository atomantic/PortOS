import { beforeEach, expect, it, vi } from 'vitest';
import * as lmStudio from './lmStudioManager.js';
import * as ollama from './ollamaDiskImport.js';
import { recordModelInstall } from './modelManifest.js';
import { migrateLocalModels } from './localLlmMigration.js';

vi.mock('./lmStudioManager.js', () => ({ resolveLocalModel: vi.fn(), importModelFromGguf: vi.fn() }));
vi.mock('./ollamaDiskImport.js', () => ({ resolveLocalModel: vi.fn(), importModelFromGguf: vi.fn() }));
vi.mock('./modelManifest.js', () => ({ recordModelInstall: vi.fn() }));

const ollamaId = 'gemma4:12b';
const lmStudioId = 'lmstudio-community/gemma-4-12B-it-GGUF';
const ggufPath = '/models/weights.gguf';
const projectorPath = '/models/mmproj.gguf';

function migration(...ids) {
  return {
    listManagedBackendModels: vi.fn(async () => ({ models: ids.map((id) => ({ id })) })),
    installModel: vi.fn(),
    describeInstallProgress: vi.fn(),
  };
}

beforeEach(() => vi.resetAllMocks());

it('links an LM Studio GGUF into Ollama by default and records the target install', async () => {
  const models = migration(lmStudioId);
  lmStudio.resolveLocalModel.mockResolvedValue({ ggufPath });
  ollama.importModelFromGguf.mockResolvedValue({ success: true, modelId: ollamaId, linked: true });

  const result = await migrateLocalModels(models, 'ollama');

  expect(models.listManagedBackendModels).toHaveBeenCalledExactlyOnceWith('lmstudio', true);
  expect(ollama.importModelFromGguf).toHaveBeenCalledExactlyOnceWith({ name: ollamaId, ggufPath, mode: 'link' });
  expect(models.installModel).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    success: true, from: 'lmstudio', to: 'ollama', mode: 'link',
    results: [{ source: lmStudioId, target: ollamaId, status: 'imported', linked: true }],
  });
  expect(recordModelInstall).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    backend: 'ollama', source: 'import', action: { type: 'local-model', backend: 'ollama', modelId: ollamaId },
  }));
});

it.each(['copy', 'link'])('carries a projector into LM Studio in %s mode and reports the actual copy', async (mode) => {
  const models = migration(ollamaId);
  const onProgress = vi.fn();
  ollama.resolveLocalModel.mockResolvedValue({ ggufPath, projectorPath });
  lmStudio.importModelFromGguf.mockResolvedValue({ success: true, modelId: lmStudioId, linked: false });

  const result = await migrateLocalModels(models, 'lmstudio', { mode, onProgress });

  expect(models.listManagedBackendModels).toHaveBeenCalledExactlyOnceWith('ollama', true);
  expect(lmStudio.importModelFromGguf).toHaveBeenCalledExactlyOnceWith({ lmstudioId: lmStudioId, ggufPath, projectorPath, mode });
  expect(models.installModel).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    success: true, from: 'ollama', to: 'lmstudio', mode,
    results: [{ source: ollamaId, target: lmStudioId, status: 'imported', linked: false }],
  });
  expect(recordModelInstall).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    backend: 'lmstudio', source: 'import', action: { type: 'local-model', backend: 'lmstudio', modelId: lmStudioId },
  }));
  expect(onProgress).toHaveBeenLastCalledWith({ event: 'complete', message: expect.stringContaining('1 copied') });
});

it.each([
  ['MLX', 'mlx-community/Qwen3.8-27B-4bit', 'qwen3.8:27b-mlx', { isMlx: true }],
  ['sharded GGUF', lmStudioId, ollamaId, { ggufPath, isSharded: true }],
  ['GGUF with projector', lmStudioId, ollamaId, { ggufPath, projectorPath }],
])('re-pulls the mapped %s model when Ollama cannot import the local files', async (_format, source, target, resolved) => {
  const models = migration(source);
  lmStudio.resolveLocalModel.mockResolvedValue(resolved);
  models.installModel.mockResolvedValue({ success: true });

  const result = await migrateLocalModels(models, 'ollama');

  expect(ollama.importModelFromGguf).not.toHaveBeenCalled();
  expect(recordModelInstall).not.toHaveBeenCalled();
  expect(models.installModel).toHaveBeenCalledExactlyOnceWith('ollama', target, expect.any(Function));
  expect(result).toMatchObject({ success: true, results: [{ source, target, status: 'installed' }] });
});

it('re-pulls after local import fails and reports a queued download as started', async () => {
  const models = migration(ollamaId);
  const onProgress = vi.fn();
  ollama.resolveLocalModel.mockResolvedValue({ ggufPath });
  lmStudio.importModelFromGguf.mockResolvedValue({ success: false, error: 'Copy failed' });
  models.installModel.mockImplementation(async (_backend, _target, progress) => {
    progress({ status: 'downloading' });
    return { success: true, pending: true };
  });
  models.describeInstallProgress.mockReturnValue('downloading');

  const result = await migrateLocalModels(models, 'lmstudio', { onProgress });

  expect(models.installModel).toHaveBeenCalledExactlyOnceWith('lmstudio', lmStudioId, expect.any(Function));
  expect(result).toMatchObject({ success: true, results: [{ target: lmStudioId, status: 'started' }] });
  expect(recordModelInstall).not.toHaveBeenCalled();
  expect(onProgress).toHaveBeenCalledWith({ event: 'start', message: `Pulling ${lmStudioId}: downloading` });
  expect(onProgress).toHaveBeenLastCalledWith({ event: 'complete', message: expect.stringContaining('1 downloading') });
});

it('returns each failed or skipped model and emits an error when none was provisioned', async () => {
  const onProgress = vi.fn();
  const models = migration('custom-unlisted:latest', ollamaId);
  ollama.resolveLocalModel.mockResolvedValue(null);
  models.installModel.mockResolvedValue({ success: false, error: 'Backend unavailable' });

  const result = await migrateLocalModels(models, 'lmstudio', { onProgress });

  expect(result).toMatchObject({
    success: false,
    error: expect.stringContaining('no models could be provisioned'),
    results: [
      { source: 'custom-unlisted:latest', target: null, status: 'skipped' },
      { source: ollamaId, target: lmStudioId, status: 'failed', reason: 'Backend unavailable' },
    ],
  });
  expect(onProgress).toHaveBeenLastCalledWith({ event: 'error', message: result.error });
  expect(recordModelInstall).not.toHaveBeenCalled();
});

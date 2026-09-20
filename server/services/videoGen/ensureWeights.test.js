import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { findCachedRepoFile } from '../../lib/hfCache.js';
import { downloadHfRepo } from '../hfDownload.js';
import { ensureMiniMaxH3Weights } from './ensureWeights.js';

vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));
vi.mock('../../lib/hfCache.js', async (original) => ({
  ...(await original()), findCachedRepoFile: vi.fn(),
}));
vi.mock('../hfDownload.js', () => ({ downloadHfRepo: vi.fn() }));
const model = {
  runtime: 'minimax_h3', repo: 'example/transformer', revision: 'a'.repeat(40),
  requiredWeights: [{ repo: 'example/conditioner', revision: 'b'.repeat(40), files: ['vae/config.json', 'vae/model.safetensors'] }],
};
let missing;
beforeEach(() => {
  vi.clearAllMocks();
  missing = new Set();
  vi.mocked(readFile).mockResolvedValue(JSON.stringify({ weight_map: { layer: 'model-00001-of-00001.safetensors' } }));
  vi.mocked(findCachedRepoFile).mockImplementation(async (repo, file) => missing.has(`${repo}/${file}`) ? null : `/cache/${file}`);
  vi.mocked(downloadHfRepo).mockImplementation(({ repo }) => {
    for (const file of missing) if (file.startsWith(`${repo}/`)) missing.delete(file);
    return { promise: Promise.resolve({ ok: true }) };
  });
});

describe('MiniMax render provisioning', () => {
  it('repairs missing metadata, indexed shards and shared dependencies without a registry repoFiles list', async () => {
    missing.add('example/transformer/quant_config.json');
    missing.add('example/transformer/model-00001-of-00001.safetensors');
    missing.add('example/conditioner/vae/model.safetensors');
    await ensureMiniMaxH3Weights(model);
    expect(downloadHfRepo.mock.calls.map(([args]) => args)).toEqual([
      { repo: model.repo, revision: model.revision, only: [] },
      { repo: 'example/conditioner', revision: 'b'.repeat(40), only: model.requiredWeights[0].files },
    ]);
    await ensureMiniMaxH3Weights(model);
    expect(downloadHfRepo).toHaveBeenCalledTimes(2);
  });

  it('detects a missing shard even with all metadata cached', async () => {
    missing.add('example/transformer/model-00001-of-00001.safetensors');
    await ensureMiniMaxH3Weights(model);
    expect(downloadHfRepo).toHaveBeenCalledTimes(1);
  });

  it('does not accept a successful downloader result when files remain missing', async () => {
    missing.add('example/transformer/quant_config.json');
    downloadHfRepo.mockReturnValue({ promise: Promise.resolve({ ok: true }) });
    await expect(ensureMiniMaxH3Weights(model)).rejects.toMatchObject({ code: 'MINIMAX_H3_WEIGHTS_NOT_CACHED' });
    expect(downloadHfRepo).toHaveBeenCalledTimes(1);
  });

  it('keeps declared selective downloads scoped', async () => {
    missing.add('example/transformer/config.json');
    await ensureMiniMaxH3Weights({ ...model, repoFiles: ['config.json', 'model.safetensors'] });
    expect(downloadHfRepo).toHaveBeenCalledWith({ repo: model.repo, revision: model.revision, only: ['config.json', 'model.safetensors'] });
  });
});

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveTestPython } from '../../lib/testHelper.js';
import { MINIMAX_H3_LIGHTX2V_PROFILE as profile } from '../../lib/minimaxH3SpeedProfiles.js';
import { resolveVideoSampler } from '../../lib/videoSpeedProfiles.js';
import { prepareMiniMaxH3SpeedProfile } from './ensureWeights.js';
import { prepareVideoGenParams, validateVideoRetryParams } from './prepareParams.js';
import { buildArgs } from './renderArgs.js';
import { findCachedRepoFile } from '../../lib/hfCache.js';
import { sha256File, PATHS } from '../../lib/fileUtils.js';
import { resolveByovRuntimeLoraCapable } from './runtimes.js';
import { getSettings } from '../settings.js';
import { listVideoModels } from './local.js';
import { modelDownloadTargets } from './modelCache.js';
import { readSafetensorsHeader } from '../../lib/safetensors.js';

vi.mock('fs', async (original) => ({ ...(await original()), existsSync: vi.fn(() => true) }));
vi.mock('node:fs/promises', async (original) => ({ ...(await original()), stat: vi.fn(async () => ({ size: profile.adapter.sizeBytes, isFile: () => true })) }));
vi.mock('../../lib/fileUtils.js', async (original) => ({ ...(await original()), sha256File: vi.fn() }));
vi.mock('../../lib/hfCache.js', async (original) => ({ ...(await original()), findCachedRepoFile: vi.fn() }));
vi.mock('./runtimes.js', async (original) => ({ ...(await original()), resolveByovRuntimeLoraCapable: vi.fn() }));
vi.mock('./local.js', () => ({ listVideoModels: vi.fn(), defaultVideoModelId: vi.fn(), loadHistory: vi.fn(),
  BYOV_VIDEO_RUNTIMES: new Set(['minimax_h3_cuda']), DEFAULT_NUM_FRAMES: 124 }));
vi.mock('../settings.js', () => ({ getSettings: vi.fn() }));
vi.mock('../../lib/safetensors.js', async (original) => ({ ...(await original()), readSafetensorsHeader: vi.fn() }));
vi.mock('../loras.js', async (original) => ({ ...(await original()), getLoraKeyLayout: vi.fn(async () => 'bare') }));

const model = { ...profile.model, name: 'Example H3 CUDA', supportedModes: ['text', 'image', 'fflf'],
  steps: 8, guidance: 0, samplerLocked: true, speedProfiles: [profile],
  defaultWidth: 1344, defaultHeight: 768, repoFiles: ['modular_model_index.json'],
  defaultFrames: 124, frameOptions: [124], fpsOptions: [24], termsGate: { id: 'example-h3-terms' } };
const settings = { videoGen: { acceptedModelTerms: ['example-h3-terms'] } };
const request = { backend: 'local', modelId: model.id, prompt: 'An invented paper boat crosses a pond.',
  width: 1344, height: 768, numFrames: 124, fps: 24, mode: 'text', speedProfileId: profile.id };
const prepare = (overrides = {}) => prepareVideoGenParams({ body: { ...request, ...overrides }, uploads: {}, localOnlyParamKeys: ['speedProfileId'] });

beforeEach(() => {
  vi.clearAllMocks();
  listVideoModels.mockReturnValue([model]);
  getSettings.mockResolvedValue(settings);
  resolveByovRuntimeLoraCapable.mockResolvedValue(true);
  findCachedRepoFile.mockResolvedValue('/example/cache/adapter.safetensors');
  sha256File.mockResolvedValue(profile.adapter.sha256);
  readSafetensorsHeader.mockResolvedValue({ __metadata__: { alpha: '2' },
    'transformer_blocks.0.attn.to_q.lora_A.weight': { dtype: 'BF16', shape: [2, 5376] },
    'transformer_blocks.0.attn.to_q.lora_B.weight': { dtype: 'BF16', shape: [7168, 2] } });
});

describe('H3 CUDA LightX2V admission → helper contract', () => {
  it('keeps stock admission and argv independent of the optional adapter', async () => {
    findCachedRepoFile.mockResolvedValue(null);
    await prepare({ speedProfileId: undefined });
    const sampler = resolveVideoSampler({ model });
    const { args } = buildArgs({ ...request, model, ...sampler, seed: 7, outputPath: '/example/stock.mp4' });
    expect(args[args.indexOf('--steps') + 1]).toBe('8');
    expect(args).not.toContain('--speed-profile');
    expect(args).not.toContain('--speed-adapter');
    expect(resolveByovRuntimeLoraCapable).not.toHaveBeenCalled();
    expect(findCachedRepoFile).not.toHaveBeenCalled();
    expect(modelDownloadTargets(model)).toEqual([{ repo: model.repo, revision: model.revision, only: model.repoFiles }]);
  });

  it('carries the complete selected schedule and exact cached adapter into the real CLI parser', () => {
    const python = resolveTestPython();
    expect(python).toBeTruthy();
    const speedProfile = { ...profile, adapterPath: '/example/cache/adapter.safetensors' };
    const { args } = buildArgs({ ...request, model: { ...model, runtimeLoraCapable: true }, ...resolveVideoSampler({ model, speedProfile }),
      speedProfile, loras: [{ path: '/example/style.safetensors', strength: 0.7 }], seed: 7, outputPath: '/example/profile.mp4' });
    const source = `import importlib.util, json, sys
from pathlib import Path
script = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location('runner', script)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
sys.argv = [str(script)] + json.loads(sys.argv[2])
args = runner.parse_args()
import minimax_h3_cuda_lora as adapter
adapter.file_digest = lambda path: adapter.CONTRACT['adapter']['sha256']
runner.validate_args(args)
print(json.dumps({'id':args.speed_profile,'steps':args.steps,'adapter':args.speed_adapter,'scales':args.lora_scale}))`;
    const result = JSON.parse(execFileSync(python, ['-c', source, join(PATHS.root, 'scripts/generate_minimax_h3_cuda.py'), JSON.stringify(args.slice(1))], { encoding: 'utf8', timeout: 10000 }));
    expect(result).toEqual({ id: profile.id, steps: 5, adapter: speedProfile.adapterPath, scales: [0.7] });
    expect(modelDownloadTargets(model, { speedProfileId: profile.id })).toEqual([
      { repo: profile.adapter.repo, revision: profile.adapter.revision, only: [profile.adapter.file] },
    ]);
  });

  it('admits the explicit profile only after terms, runtime and digest verification', async () => {
    await expect(prepare()).resolves.toMatchObject({ effectiveModelId: model.id });
    expect(findCachedRepoFile).toHaveBeenCalledWith(profile.adapter.repo, profile.adapter.file, { revision: profile.adapter.revision });
    expect(sha256File).toHaveBeenCalledWith('/example/cache/adapter.safetensors');
  });

  it.each([
    [{ width: 960, height: 544 }, 'MINIMAX_H3_SPEED_CANVAS_UNSUPPORTED'],
    [{ mode: 'fflf' }, 'MINIMAX_H3_SPEED_MODE_UNSUPPORTED'],
    [{ chunks: 2 }, 'MINIMAX_H3_SPEED_MODE_UNSUPPORTED'],
    [{ steps: 4 }, 'MINIMAX_H3_SPEED_SAMPLER_CONFLICT'],
    [{ guidanceScale: 1 }, 'MINIMAX_H3_SPEED_SAMPLER_CONFLICT'],
    [{ speedProfileId: 'unknown' }, 'VIDEO_SPEED_PROFILE_UNSUPPORTED'],
  ])('refuses an incompatible request before adapter lookup: %j', async (overrides, code) => {
    // FFLF has its own missing-keyframe error; use the public profile admission
    // boundary directly for that mode to pin the profile's independent guard.
    if (overrides.mode === 'fflf') {
      await expect(prepareMiniMaxH3SpeedProfile({ model, profileId: profile.id, ...overrides }, settings)).rejects.toMatchObject({ code });
    } else await expect(prepare(overrides)).rejects.toMatchObject({ code });
    expect(findCachedRepoFile).not.toHaveBeenCalled();
  });

  it('refuses changed checkpoint/runtime, missing weights and digest drift on submissions and retries', async () => {
    listVideoModels.mockReturnValue([{ ...model, revision: 'a'.repeat(40) }]);
    await expect(prepare()).rejects.toMatchObject({ code: 'MINIMAX_H3_SPEED_MODEL_UNSUPPORTED' });
    listVideoModels.mockReturnValue([model]);
    resolveByovRuntimeLoraCapable.mockResolvedValue(false);
    await expect(prepare()).rejects.toMatchObject({ code: 'MINIMAX_H3_SPEED_RUNTIME_UNSUPPORTED' });
    resolveByovRuntimeLoraCapable.mockResolvedValue(true);
    findCachedRepoFile.mockResolvedValue(null);
    await expect(prepare()).rejects.toMatchObject({ code: 'MINIMAX_H3_SPEED_WEIGHTS_NOT_CACHED' });
    await expect(validateVideoRetryParams(request)).rejects.toMatchObject({ code: 'MINIMAX_H3_SPEED_WEIGHTS_NOT_CACHED' });
    findCachedRepoFile.mockResolvedValue('/example/cache/adapter.safetensors');
    sha256File.mockResolvedValue('bad-digest');
    await expect(prepare()).rejects.toMatchObject({ code: 'MINIMAX_H3_SPEED_WEIGHTS_NOT_CACHED' });
  });

  it('requires persisted model terms before checking runtime or cached weights', async () => {
    getSettings.mockResolvedValue({ videoGen: { acceptedModelTerms: [] } });
    await expect(prepare()).rejects.toMatchObject({ code: 'VIDEO_MODEL_TERMS_ACCEPTANCE_REQUIRED' });
    expect(resolveByovRuntimeLoraCapable).not.toHaveBeenCalled();
    expect(findCachedRepoFile).not.toHaveBeenCalled();
  });

  it('admits a compatible style adapter with the speed profile and rejects a copied speed adapter', async () => {
    sha256File.mockImplementation(async (path) => path.endsWith('style.safetensors') ? 'style-digest' : profile.adapter.sha256);
    await expect(prepare({ loraFilenames: ['style.safetensors'], loraScales: [0.7] })).resolves.toMatchObject({
      loras: [{ filename: 'style.safetensors', scale: 0.7 }],
    });
    await expect(prepare({ loraFilenames: ['copied-speed.safetensors'] })).rejects.toMatchObject({ code: 'MINIMAX_H3_LORA_DUPLICATE' });
  });

  it('refuses incompatible H3 style adapter formats/dimensions before queue admission', async () => {
    readSafetensorsHeader.mockResolvedValue({ 'blocks.0.attn.qkv_proj.lora_A.weight': { dtype: 'BF16', shape: [2, 5376] } });
    await expect(prepare({ loraFilenames: ['native.safetensors'] })).rejects.toMatchObject({ code: 'MINIMAX_H3_LORA_LAYOUT_UNSUPPORTED' });
    readSafetensorsHeader.mockResolvedValue({ __metadata__: { alpha: '2' },
      'transformer_blocks.0.attn.to_q.lora_A.weight': { dtype: 'BF16', shape: [2, 100] },
      'transformer_blocks.0.attn.to_q.lora_B.weight': { dtype: 'BF16', shape: [7168, 2] } });
    await expect(prepare({ loraFilenames: ['wrong-size.safetensors'] })).rejects.toMatchObject({ code: 'MINIMAX_H3_LORA_LAYOUT_UNSUPPORTED' });
  });
});

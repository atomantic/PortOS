import { execFileSync } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveTestPython } from '../../lib/testHelper.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MINIMAX_H3_LIGHTX2V_MLX_PROFILE as profile, MINIMAX_H3_FLEX_MLX_PROFILE as flex } from '../../lib/minimaxH3SpeedProfiles.js';
import { resolveVideoSampler } from '../../lib/videoSpeedProfiles.js';
import { prepareMiniMaxH3SpeedProfile } from './ensureWeights.js';
import { prepareVideoGenParams, validateVideoRetryParams } from './prepareParams.js';
import { buildArgs } from './renderArgs.js';
import { findCachedRepoFile } from '../../lib/hfCache.js';
import { sha256File, PATHS } from '../../lib/fileUtils.js';
import { resolveByovRuntimeLoraCapable, resolveMiniMaxH3MlxSpeedCapable } from './runtimes.js';
import { getSettings } from '../settings.js';
import { listVideoModels } from './local.js';
import { modelDownloadTargets } from './modelCache.js';
import { readSafetensorsHeader } from '../../lib/safetensors.js';

vi.mock('fs', async (original) => ({ ...(await original()), existsSync: vi.fn(() => true) }));
vi.mock('node:fs/promises', async (original) => ({ ...(await original()), stat: vi.fn(async () => ({ size: profile.adapter.sizeBytes, isFile: () => true })) }));
vi.mock('../../lib/fileUtils.js', async (original) => ({ ...(await original()), sha256File: vi.fn() }));
vi.mock('../../lib/hfCache.js', async (original) => ({ ...(await original()), findCachedRepoFile: vi.fn() }));
vi.mock('./runtimes.js', async (original) => ({ ...(await original()), resolveByovRuntimeLoraCapable: vi.fn(), resolveMiniMaxH3MlxSpeedCapable: vi.fn() }));
vi.mock('./local.js', () => ({ listVideoModels: vi.fn(), defaultVideoModelId: vi.fn(), loadHistory: vi.fn(),
  BYOV_VIDEO_RUNTIMES: new Set(['minimax_h3']), DEFAULT_NUM_FRAMES: 124 }));
vi.mock('../settings.js', () => ({ getSettings: vi.fn() }));
vi.mock('../../lib/safetensors.js', async (original) => ({ ...(await original()), readSafetensorsHeader: vi.fn() }));
vi.mock('../loras.js', async (original) => ({ ...(await original()), getLoraKeyLayout: vi.fn(async () => 'bare') }));

const model = { ...profile.model, name: 'Example H3 MLX', supportedModes: ['text', 'image', 'fflf'],
  steps: 8, guidance: 0, samplerLocked: true, speedProfiles: [profile],
  defaultWidth: 1344, defaultHeight: 768, repoFiles: ['config.json'], requiredWeights: [profile.checkpoint],
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
  resolveMiniMaxH3MlxSpeedCapable.mockResolvedValue(true);
  findCachedRepoFile.mockResolvedValue('/example/cache/adapter.safetensors');
  sha256File.mockResolvedValue(profile.adapter.sha256);
  readSafetensorsHeader.mockResolvedValue({ __metadata__: { alpha: '2' },
    'transformer_blocks.0.attn.to_q.lora_A.weight': { dtype: 'BF16', shape: [2, 5376] },
    'transformer_blocks.0.attn.to_q.lora_B.weight': { dtype: 'BF16', shape: [7168, 2] } });
});

describe('H3 MLX LightX2V request admission', () => {
  it('keeps the stock argv independent of the speed adapter and checks', async () => {
    await prepare({ speedProfileId: undefined });
    const { args } = buildArgs({ ...request, model, ...resolveVideoSampler({ model }), seed: 7, outputPath: '/example/stock.mp4' });
    expect(args[args.indexOf('--steps') + 1]).toBe('8');
    expect(args).not.toContain('--speed-profile');
    expect(resolveMiniMaxH3MlxSpeedCapable).not.toHaveBeenCalled();
    expect(findCachedRepoFile).not.toHaveBeenCalled();
  });

  it('admits the cached explicit profile and carries its arguments with style exactly once', async () => {
    await expect(prepare()).resolves.toMatchObject({ effectiveModelId: model.id });
    const speedProfile = { ...profile, adapterPath: '/example/cache/adapter.safetensors' };
    const { args } = buildArgs({ ...request, model: { ...model, runtimeLoraCapable: true }, ...resolveVideoSampler({ model, speedProfile }),
      speedProfile, loras: [{ path: '/example/style.safetensors', strength: 0.7 }], seed: 7, outputPath: '/example/profile.mp4' });
    expect(args.filter((value) => value === '--speed-profile')).toHaveLength(1);
    expect(args[args.indexOf('--speed-profile') + 1]).toBe(profile.id);
    expect(args[args.indexOf('--steps') + 1]).toBe(String(profile.steps));
    expect(args.filter((value) => value === '--lora')).toHaveLength(1);
    const source = `import importlib.util, json, sys
from pathlib import Path
script = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location('runner', script)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
sys.argv = [str(script)] + json.loads(sys.argv[2])
args = runner.parse_args()
print(json.dumps({'id':args.speed_profile,'steps':args.steps,'adapter':args.speed_adapter,'scales':args.lora_scale}))`;
    const parsed = JSON.parse(execFileSync(resolveTestPython(), ['-c', source,
      join(PATHS.root, 'scripts/generate_minimax_h3.py'), JSON.stringify(args.slice(1))], { encoding: 'utf8', timeout: 10000 }));
    expect(parsed).toEqual({ id: profile.id, steps: profile.steps, adapter: speedProfile.adapterPath, scales: [0.7] });
    expect(modelDownloadTargets(model, { speedProfileId: profile.id })).toEqual([
      { repo: profile.adapter.repo, revision: profile.adapter.revision, only: [profile.adapter.file] },
    ]);
  });

  it.each([
    [{ width: 960, height: 544 }, 'MINIMAX_H3_SPEED_CANVAS_UNSUPPORTED'],
    [{ chunks: 2 }, 'MINIMAX_H3_SPEED_MODE_UNSUPPORTED'],
    [{ steps: 4 }, 'MINIMAX_H3_SPEED_SAMPLER_CONFLICT'],
    [{ speedProfileId: 'unknown' }, 'VIDEO_SPEED_PROFILE_UNSUPPORTED'],
  ])('refuses incompatible requests before adapter lookup: %j', async (overrides, code) => {
    await expect(prepare(overrides)).rejects.toMatchObject({ code });
    expect(findCachedRepoFile).not.toHaveBeenCalled();
  });

  it('refuses stale runtime, changed pins, missing base cache and corrupt adapters on submissions and retries', async () => {
    resolveMiniMaxH3MlxSpeedCapable.mockResolvedValue(false);
    await expect(prepare()).rejects.toMatchObject({ code: 'MINIMAX_H3_SPEED_RUNTIME_UNSUPPORTED' });
    expect(resolveByovRuntimeLoraCapable).not.toHaveBeenCalled();
    resolveMiniMaxH3MlxSpeedCapable.mockResolvedValue(true);
    listVideoModels.mockReturnValue([{ ...model, revision: 'b'.repeat(40) }]);
    await expect(prepare()).rejects.toMatchObject({ code: 'MINIMAX_H3_SPEED_MODEL_UNSUPPORTED' });
    listVideoModels.mockReturnValue([{ ...model, requiredWeights: [{ ...profile.checkpoint, revision: 'c'.repeat(40) }] }]);
    await expect(prepare()).rejects.toMatchObject({ code: 'MINIMAX_H3_SPEED_MODEL_UNSUPPORTED' });
    expect(findCachedRepoFile).not.toHaveBeenCalled();
    listVideoModels.mockReturnValue([model]);
    findCachedRepoFile.mockImplementation(async (repo) => repo === profile.adapter.repo ? '/example/adapter.safetensors' : null);
    await expect(prepare()).rejects.toMatchObject({ code: 'MINIMAX_H3_WEIGHTS_NOT_CACHED' });
    findCachedRepoFile.mockResolvedValue('/example/cache/adapter.safetensors');
    sha256File.mockResolvedValue('bad');
    await expect(validateVideoRetryParams(request)).rejects.toMatchObject({ code: 'MINIMAX_H3_SPEED_WEIGHTS_NOT_CACHED' });
  });

  it('retains MLX style formats while refusing renamed speed or duplicate user adapters', async () => {
    sha256File.mockImplementation(async (path) => path.endsWith('style.safetensors') ? 'style' : profile.adapter.sha256);
    await expect(prepare({ loraFilenames: ['style.safetensors'], loraScales: [0.7] })).resolves.toMatchObject({
      loras: [{ filename: 'style.safetensors', scale: 0.7 }],
    });
    await expect(prepare({ loraFilenames: ['copied-speed.safetensors'] })).rejects.toMatchObject({ code: 'MINIMAX_H3_LORA_DUPLICATE' });
    await expect(prepare({ speedProfileId: undefined, loraFilenames: ['copied-speed.safetensors'] })).rejects.toMatchObject({ code: 'MINIMAX_H3_LORA_PROFILE_REQUIRED' });
    expect(readSafetensorsHeader).not.toHaveBeenCalled();
  });

  it('checks persisted terms before runtime or adapter access', async () => {
    getSettings.mockResolvedValue({ videoGen: { acceptedModelTerms: [] } });
    await expect(prepare()).rejects.toMatchObject({ code: 'VIDEO_MODEL_TERMS_ACCEPTANCE_REQUIRED' });
    expect(resolveMiniMaxH3MlxSpeedCapable).not.toHaveBeenCalled();
    expect(findCachedRepoFile).not.toHaveBeenCalled();
  });
});


describe('Pika Flex request to runner boundary', () => {
  it('admits three canvases with verified adapter and supporting files, emits the named schedule, and refuses missing notices', async () => {
    const flexModel = { ...model, speedProfiles: [flex] };
    listVideoModels.mockReturnValue([flexModel]);
    stat.mockResolvedValue({ size: flex.adapter.sizeBytes, isFile: () => true });
    findCachedRepoFile.mockImplementation(async (_repo, file) => `/example/cache/${file}`);
    sha256File.mockImplementation(async (path) => path.endsWith(flex.adapter.file)
      ? flex.adapter.sha256 : flex.adapter.supportFiles[path.replace('/example/cache/', '')]);
    for (const [width, height] of flex.canvases) {
      await expect(prepare({ speedProfileId: flex.id, width, height })).resolves.toMatchObject({ effectiveModelId: model.id });
      const speedProfile = { ...flex, adapterPath: '/example/cache/fl2va/adapter.safetensors' };
      const { args } = buildArgs({ ...request, width, height, model: flexModel,
        ...resolveVideoSampler({ model: flexModel, speedProfile }), speedProfile, seed: 7, outputPath: '/example/flex.mp4' });
      expect(args[args.indexOf('--speed-profile') + 1]).toBe(flex.id);
      expect(args[args.indexOf('--steps') + 1]).toBe('7');
      expect(args.filter((value) => value === '--speed-adapter')).toHaveLength(1);
    }
    expect(resolveMiniMaxH3MlxSpeedCapable).toHaveBeenCalledWith(flex.id);
    expect(modelDownloadTargets(flexModel, { speedProfileId: flex.id })).toEqual([
      { repo: flex.adapter.repo, revision: flex.adapter.revision, only: [flex.adapter.file, ...Object.keys(flex.adapter.supportFiles)] },
    ]);
    findCachedRepoFile.mockImplementation(async (_repo, file) => file === 'NOTICE' ? null : `/example/cache/${file}`);
    await expect(validateVideoRetryParams({ ...request, speedProfileId: flex.id })).rejects.toMatchObject({ code: 'MINIMAX_H3_SPEED_WEIGHTS_NOT_CACHED' });
  });

  it('refuses a renamed Flex adapter under stock or LightX2V schedules', async () => {
    sha256File.mockResolvedValue(flex.adapter.sha256);
    await expect(prepare({ speedProfileId: undefined, loraFilenames: ['renamed-flex.safetensors'] })).rejects.toMatchObject({ code: 'MINIMAX_H3_LORA_PROFILE_REQUIRED' });
    const { validateMiniMaxH3MlxLoras } = await import('./ensureWeights.js');
    await expect(validateMiniMaxH3MlxLoras([{ path: '/example/renamed-flex.safetensors' }], profile)).rejects.toMatchObject({ code: 'MINIMAX_H3_LORA_PROFILE_REQUIRED' });
  });
});

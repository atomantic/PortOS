import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeReady = vi.hoisted(() => vi.fn());
const verifyFiles = vi.hoisted(() => vi.fn());
vi.mock('../videoGen/runtimes.js', () => ({
  MINIMAX_H3_VENV_PYTHON: '/runtime/.venv/bin/python3',
  MINIMAX_H3_REPO_DIR: '/runtime',
  MINIMAX_H3_EXPECTED_REVISION: 'pinned-runtime-sha',
  isByovRuntimeReady: (...args) => runtimeReady(...args),
}));
vi.mock('../../lib/hfCache.js', () => ({ verifyCachedRepoFiles: (...args) => verifyFiles(...args) }));
vi.mock('../../lib/platform.js', () => ({ isAppleSilicon: () => true }));

import { getImageModels, imageModelDownloadTargets } from '../../lib/mediaModels.js';
import { MINIMAX_H3_IMAGE_MODEL_ID } from '../../lib/imageRuntimeRemedies.js';
import {
  diagnoseMinimaxH3ImageRuntime, loadMinimaxH3Runtime, minimaxH3ImageEnv, minimaxH3ImageRenderArgs, minimaxH3ImageWeightsCached,
} from './minimaxH3ImageRuntime.js';

const model = getImageModels({ includeDisabled: true }).find(entry => entry.id === MINIMAX_H3_IMAGE_MODEL_ID);
const minimaxRuntime = await loadMinimaxH3Runtime();
const request = (over = {}) => ({
  model, prompt: 'a lake at dawn', negativePrompt: '', width: 3840, height: 2160, steps: 6, seed: 7,
  outputPath: '/out/image.png', referenceImagePaths: [], referenceImageStrengths: [], loraPaths: [], minimaxRuntime, ...over,
});
const flagValues = (args, flag) => args.flatMap((arg, i) => (arg === flag ? [args[i + 1]] : []));

beforeEach(() => vi.clearAllMocks());

describe('MiniMax H3-Image runtime', () => {
  it('runs the shared H3 MLX venv against pinned image and conditioner files, offline and without HF credentials', () => {
    const refs = Array.from({ length: 16 }, (_, i) => `/refs/${i}.png`);
    const { bin, args } = minimaxH3ImageRenderArgs(request({ referenceImagePaths: refs, referenceImageStrengths: refs.map(() => 1) }));
    const [main, encoder] = imageModelDownloadTargets(model);
    expect(bin).toBe('/runtime/.venv/bin/python3');
    expect(flagValues(args, '--runtime-revision')).toEqual(['pinned-runtime-sha']);
    expect(flagValues(args, '--model-revision')).toEqual([main.revision]);
    expect(flagValues(args, '--text-encoder-revision')).toEqual([encoder.revision]);
    expect(flagValues(args, '--text-encoder-file')).toEqual(encoder.only);
    expect(flagValues(args, '--reference-image')).toEqual(refs);
    expect(flagValues(args, '--width')).toEqual(['3840']);
    const env = minimaxH3ImageEnv({ HF_TOKEN: 'secret', HUGGING_FACE_HUB_TOKEN: 'secret', PATH: '/bin' });
    expect(env).toMatchObject({ HF_TOKEN: undefined, HUGGING_FACE_HUB_TOKEN: undefined, HF_HUB_OFFLINE: '1', PATH: '/bin' });
  });

  it.each([
    ['a negative prompt', { negativePrompt: 'blur' }, /no negative prompt/],
    ['an init image', { initImagePath: '/in.png' }, /reference slot/],
    ['a LoRA', { loraPaths: ['/l.safetensors'] }, /LoRAs/],
    ['a 17th reference', { referenceImagePaths: Array(17).fill('/r.png') }, /at most 16/],
    ['a per-reference strength', { referenceImagePaths: ['/r.png'], referenceImageStrengths: [0.5] }, /strength is fixed/],
    ['an aspect beyond 3:1', { width: 3840, height: 1024 }, /1:3 to 3:1/],
    ['a step count other than the distilled 6', { steps: 20 }, /exactly 6 steps/],
  ])('refuses %s instead of silently dropping it', (_label, over, message) => {
    expect(() => minimaxH3ImageRenderArgs(request(over))).toThrow(message);
  });

  it('reports readiness from the shared H3 runtime and points a missing one at its installer', async () => {
    runtimeReady.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(diagnoseMinimaxH3ImageRuntime({ platform: 'darwin', osRelease: '25.0.0' })).resolves.toEqual({ readiness: 'ready' });
    await expect(diagnoseMinimaxH3ImageRuntime({ platform: 'darwin', osRelease: '25.0.0' }))
      .resolves.toMatchObject({ readiness: 'unavailable', remedy: { kind: 'install-minimax-h3' } });
    await expect(diagnoseMinimaxH3ImageRuntime({ platform: 'linux' }))
      .resolves.toMatchObject({ readiness: 'unavailable', remedy: { kind: 'choose-model' } });
    expect(runtimeReady).toHaveBeenCalledWith('minimax_h3');
  });

  it('counts the weights as cached only when every pinned file of both repos verifies', async () => {
    verifyFiles.mockResolvedValue({ status: 'ok' });
    await expect(minimaxH3ImageWeightsCached(model)).resolves.toBe(true);
    expect(verifyFiles.mock.calls.map(([repo, , opts]) => [repo, opts.revision]))
      .toEqual(imageModelDownloadTargets(model).map(t => [t.repo, t.revision]));
    verifyFiles.mockResolvedValueOnce({ status: 'ok' }).mockResolvedValueOnce({ status: 'missing' });
    await expect(minimaxH3ImageWeightsCached(model)).resolves.toBe(false);
  });
});

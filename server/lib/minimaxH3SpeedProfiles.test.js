import { describe, it, expect } from 'vitest';
import {
  MINIMAX_H3_LIGHTX2V_PROFILE as cuda,
  MINIMAX_H3_LIGHTX2V_MLX_PROFILE as mlx,
  MINIMAX_H3_FLEX_MLX_PROFILE as flex,
  miniMaxH3SpeedProfileContract,
  miniMaxH3SpeedProfileDeclineReason,
} from './minimaxH3SpeedProfiles.js';
import { applyVideoSpeedProfiles, resolveVideoSpeedProfile, validateSpeedProfileTable } from './videoSpeedProfiles.js';

const model = (profile) => ({ ...profile.model, ...(profile.checkpoint ? { requiredWeights: [profile.checkpoint] } : {}), samplerLocked: true, steps: 9, guidance: 0, speedProfiles: [structuredClone(profile)] });

describe('separate H3 MLX and CUDA profile contracts', () => {
  it('offers only the exact shipped MLX INT8 row while preserving stock and explicit user settings', () => {
    const shipped = { ...mlx.model, requiredWeights: [mlx.checkpoint], samplerLocked: true, steps: 9 };
    const custom = [{ ...shipped, speedProfiles: [] }, { ...shipped, speedProfiles: null },
      { ...shipped, revision: 'custom' }, { ...shipped, id: 'minimax_h3_4bit' },
      { ...shipped, requiredWeights: [] },
      { ...shipped, requiredWeights: [{ ...mlx.checkpoint, revision: 'custom' }] }];
    const [upgraded, ...untouched] = applyVideoSpeedProfiles([shipped, ...custom]);
    expect(upgraded).toEqual({ ...shipped, speedProfiles: [mlx, flex] });
    expect(untouched).toEqual(custom);
    expect(resolveVideoSpeedProfile({ model: upgraded, profileId: 'quality', mode: 'text' })).toBeNull();
    expect(resolveVideoSpeedProfile({ model: upgraded, profileId: mlx.id, mode: 'image' })).toEqual(mlx);
    expect(validateSpeedProfileTable([upgraded])).toEqual([]);
  });

  it('keeps platform identities separate and refuses partial or mutated contracts', () => {
    expect(miniMaxH3SpeedProfileContract(cuda.id)).toEqual(cuda);
    expect(miniMaxH3SpeedProfileContract(mlx.id)).toEqual(mlx);
    expect(miniMaxH3SpeedProfileContract('unknown')).toBeNull();
    for (const [profile, other] of [[mlx, cuda], [cuda, mlx]]) {
      const incompatible = { ...other.model, speedProfiles: [profile] };
      expect(miniMaxH3SpeedProfileDeclineReason({ model: incompatible, profileId: profile.id }).code)
        .toBe('MINIMAX_H3_SPEED_MODEL_UNSUPPORTED');
      const mutated = model(profile);
      mutated.speedProfiles[0].videoShift = 12;
      expect(miniMaxH3SpeedProfileDeclineReason({ model: mutated, profileId: profile.id }).code)
        .toBe('MINIMAX_H3_SPEED_MODEL_UNSUPPORTED');
      expect(validateSpeedProfileTable([mutated])).toHaveLength(1);
    }
  });

  it('refuses substituted checkpoint/VAEs or an incomplete required manifest without blocking a selected text encoder', () => {
    const supported = model(mlx);
    expect(miniMaxH3SpeedProfileDeclineReason({ model: { ...supported, textEncoderId: 'custom' }, profileId: mlx.id })).toBeNull();
    for (const requiredWeights of [undefined, [], [{ ...mlx.checkpoint, repo: 'custom/checkpoint' }],
      [{ ...mlx.checkpoint, revision: 'custom' }], [{ ...mlx.checkpoint, files: mlx.checkpoint.files.slice(1) }]]) {
      const changed = { ...supported, requiredWeights };
      expect(miniMaxH3SpeedProfileDeclineReason({ model: changed, profileId: mlx.id }).code)
        .toBe('MINIMAX_H3_SPEED_MODEL_UNSUPPORTED');
    }
  });

  it('refuses MLX modes, canvases and overrides outside the four-update contract', () => {
    const request = { model: model(mlx), profileId: mlx.id, mode: 'text', width: 1344, height: 768 };
    expect(miniMaxH3SpeedProfileDeclineReason(request)).toBeNull();
    for (const overrides of [{ mode: 'fflf' }, { chunks: 2 }, { audioFilePath: '/synthetic.wav' },
      { extendFromVideoPath: '/synthetic.mp4' }, { lastImagePath: '/synthetic.png' }]) {
      expect(miniMaxH3SpeedProfileDeclineReason({ ...request, ...overrides }).code)
        .toBe('MINIMAX_H3_SPEED_MODE_UNSUPPORTED');
    }
    expect(miniMaxH3SpeedProfileDeclineReason({ ...request, width: 768 }).code).toBe('MINIMAX_H3_SPEED_CANVAS_UNSUPPORTED');
    expect(miniMaxH3SpeedProfileDeclineReason({ ...request, steps: 4 }).code).toBe('MINIMAX_H3_SPEED_SAMPLER_CONFLICT');
    expect(miniMaxH3SpeedProfileDeclineReason({ ...request, guidanceScale: 1 }).code).toBe('MINIMAX_H3_SPEED_SAMPLER_CONFLICT');
    expect(mlx.steps).toBe(mlx.denoisingSteps + 1);
    expect(mlx.sigmaPoints).toEqual([1, .75, .5, .25, 0]);
    expect([mlx.videoShift, mlx.audioShift]).toEqual([6, 3]);
    expect(mlx.speedupLabel).toBeNull();
  });
});


describe('Pika H3 Flex pinned multi-canvas contract', () => {
  it('offers the opt-in six-update schedule only on the pinned MLX model', () => {
    const supported = model(flex);
    for (const [width, height] of flex.canvases) {
      expect(miniMaxH3SpeedProfileDeclineReason({ model: supported, profileId: flex.id, width, height, mode: 'image' })).toBeNull();
    }
    expect(flex.sigmaKnots).toEqual([1000, 750, 500, 250, 100, 40, 0]);
    expect(flex.steps).toBe(7);
    expect(flex.denoisingSteps).toBe(6);
    expect(flex.speedupLabel).toBeNull();
    for (const overrides of [{ width: 960, height: 544 }, { steps: 6 }, { guidanceScale: 1 }, { chunks: 2 }, { mode: 'fflf' }]) {
      expect(miniMaxH3SpeedProfileDeclineReason({ model: supported, profileId: flex.id, ...overrides })).not.toBeNull();
    }
    expect(miniMaxH3SpeedProfileDeclineReason({ model: model(cuda), profileId: flex.id }).code).toBe('MINIMAX_H3_SPEED_MODEL_UNSUPPORTED');
    expect(validateSpeedProfileTable([supported])).toEqual([]);
  });
});

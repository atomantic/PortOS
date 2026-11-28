import { describe, expect, it } from 'vitest';
import { planLtxAlignment } from './upscalePlan.js';
import { upscalePlanBlocker } from './upscalePlanBlocker.js';

const source = { width: 768, height: 512, fps: 24, frameCount: 121 };
const runtime = { supported: true, installed: true };
const ltx = {
  method: 'ltx', source, runtime,
  adapter: { cached: true },
  baseModel: { cached: true, path: '/cache/base-model', hardwareCompatibility: { state: 'unknown' } },
  alignment: planLtxAlignment(source),
};
const realesrgan = { method: 'realesrgan', source, runtime };
const seedvr2 = { method: 'fal-seedvr2', runtime, estimatedCostUsd: 0 };

describe('upscalePlanBlocker', () => {
  it.each([ltx, realesrgan, seedvr2])('allows the ready $method plan', (plan) => {
    expect(upscalePlanBlocker(plan, { requireCost: true })).toBeNull();
  });

  it('refuses an already upscaled source before checking runtime readiness', () => {
    expect(upscalePlanBlocker({ method: 'ltx', alreadyUpscaled: true })).toMatchObject({
      status: 400, code: 'ALREADY_UPSCALED',
    });
  });

  it.each([
    ['unsupported LTX runtime', ltx, { runtime: { ...runtime, supported: false } }, 501, 'UNSUPPORTED_RUNTIME'],
    ['missing LTX runtime', ltx, { runtime: { ...runtime, installed: false } }, 501, 'UNSUPPORTED_RUNTIME'],
    ['incompatible LTX hardware', ltx, { baseModel: { hardwareCompatibility: { state: 'unavailable' } }, adapter: null }, 501, 'UNSUPPORTED_RUNTIME'],
    ['missing LTX adapter', ltx, { adapter: { cached: false } }, 400, 'IC_LORA_WEIGHT_UNRESOLVED'],
    ['missing LTX checkpoint path', ltx, { baseModel: { cached: true, path: null } }, 400, 'UPSCALE_BASE_MODEL_UNRESOLVED'],
    ['LTX alignment would trim frames', ltx, { alignment: { ...ltx.alignment, trimFrames: 1 } }, 400, 'UPSCALE_SOURCE_UNALIGNABLE'],
    ['unmeasured LTX cadence', ltx, { source: { ...source, fps: null } }, 400, 'UPSCALE_SOURCE_UNALIGNABLE'],
    ['unsupported Real-ESRGAN runtime', realesrgan, { runtime: { supported: false, installed: false } }, 501, 'UNSUPPORTED_RUNTIME'],
    ['missing Real-ESRGAN runtime', realesrgan, { runtime: { ...runtime, installed: false } }, 400, 'REALESRGAN_NOT_READY'],
    ['unmeasured Real-ESRGAN width', realesrgan, { source: { ...source, width: null } }, 400, 'UPSCALE_SOURCE_UNMEASURED'],
    ['unmeasured Real-ESRGAN height', realesrgan, { source: { ...source, height: null } }, 400, 'UPSCALE_SOURCE_UNMEASURED'],
    ['unmeasured Real-ESRGAN cadence', realesrgan, { source: { ...source, fps: null } }, 400, 'UPSCALE_SOURCE_UNMEASURED'],
    ['missing fal credentials', seedvr2, { runtime: { ...runtime, installed: false } }, 400, 'FAL_KEY_MISSING'],
  ])('returns the expected status and code for %s', (_description, plan, patch, status, code) => {
    expect(upscalePlanBlocker({ ...plan, ...patch })).toMatchObject({ status, code, message: expect.any(String) });
  });

  it('requires a SeedVR2 estimate only when requested', () => {
    const unpriced = { ...seedvr2, estimatedCostUsd: null };
    expect(upscalePlanBlocker(unpriced)).toBeNull();
    expect(upscalePlanBlocker(unpriced, { requireCost: true })).toMatchObject({
      status: 422, code: 'UPSCALE_GEOMETRY_UNKNOWN',
    });
  });
});

import { describe, it, expect } from 'vitest';
import {
  renderTierVideoSettings, sceneRenderTierChoices, sceneRenderTierPlan,
} from './musicVideoRenderTier.js';
import { musicVideoVideoSettingsSchema } from './musicVideoValidation.js';

const cutaway = { sceneId: 'a', startSec: 0, endSec: 4 };
const lipSync = { sceneId: 'p', startSec: 0, endSec: 6, shotMode: 'performance' };
const ctx = (videoSettings, scene = cutaway) => ({ scene, scenes: [scene], videoSettings });

describe('render tier resolution per model family (#16136)', () => {
  it('defaults draft to the lowest tier and final to the highest on every hosted family', () => {
    const cases = [
      ['fal', { falModelId: 'fal-ai/veo3.1/fast/image-to-video' }, 'falResolution', '720p', '4k'],
      ['fal', {}, 'falResolution', '512P', '768P'],
      ['runway', { runwayModelId: 'seedance2' }, 'runwayResolution', '480p', '4k'],
      ['higgsfield', {}, 'higgsfieldResolution', '480p', '1080p'],
      ['google', {}, 'googleResolution', '720p', '1080p'],
    ];
    for (const [backend, settings, field, draft, final] of cases) {
      expect(sceneRenderTierPlan(backend, ctx(settings))).toMatchObject({ settingsField: field, requestField: field, draft, final });
    }
  });

  it('puts a lip-sync shot on the lip-sync resolution field', () => {
    const plan = sceneRenderTierPlan('fal', ctx({}, lipSync));
    expect(plan).toMatchObject({ settingsField: 'falLipSyncResolution', requestField: 'falResolution', draft: '480P', final: '2K' });
  });

  it('treats the project resolutions as ceilings, falling back to the lowest tier', () => {
    // Seedance 2.0 on Runway offers 480p, 720p, 1080p and 4k.
    const tiers = (draftResolution, finalResolution) => {
      const plan = sceneRenderTierPlan('runway', ctx({ runwayModelId: 'seedance2', draftResolution, finalResolution }));
      return [plan.draft, plan.final];
    };
    expect(tiers('720p', '1080p')).toEqual(['720p', '1080p']);
    expect(tiers('900p', '2K')).toEqual(['720p', '1080p']);
    expect(tiers('360p', '8k')).toEqual(['480p', '4k']);
    expect(tiers('auto', null)).toEqual(['480p', '4k']);
  });

  it('lets a resolution the render names win over the tier', () => {
    const settings = renderTierVideoSettings('higgsfield', { ...ctx({ higgsfieldResolution: '1080p' }), override: { higgsfieldResolution: '720p' }, tier: 'draft' });
    expect(settings.higgsfieldResolution).toBe('720p');
    // A null on the override is "unset", so the tier applies over the project's pin.
    const reset = renderTierVideoSettings('higgsfield', { ...ctx({ higgsfieldResolution: '1080p' }), override: { higgsfieldResolution: null }, tier: 'draft' });
    expect(reset.higgsfieldResolution).toBe('480p');
  });

  it('leaves a lane or model without tiers, and a render with no tier, unchanged', () => {
    for (const [backend, settings] of [['local', { modelId: 'ltx' }], ['grok', {}], ['gemini', {}], ['runway', {}], ['fal', { falModelId: 'fal-ai/kling-video/v3/pro/image-to-video' }]]) {
      expect(sceneRenderTierPlan(backend, ctx(settings))).toBeNull();
      expect(sceneRenderTierChoices(backend, ctx(settings))).toBeNull();
      expect(renderTierVideoSettings(backend, { ...ctx(settings), tier: 'final' })).toEqual(settings);
    }
    expect(renderTierVideoSettings('google', { ...ctx({ googleResolution: '720p' }) })).toEqual({ googleResolution: '720p' });
  });

  it('prices each tier the way the board prices the take', () => {
    const choices = sceneRenderTierChoices('fal', ctx({ falModelId: 'bytedance/seedance-2.5/image-to-video' }));
    expect(choices.map((c) => [c.tier, c.resolution])).toEqual([['draft', '480p'], ['final', '1080p']]);
    expect(choices[0].costUsd).toBeGreaterThan(0);
    expect(choices[1].costUsd).toBeGreaterThan(choices[0].costUsd);
    // Higgsfield has no price table here, so its tiers carry no price.
    expect(sceneRenderTierChoices('higgsfield', ctx({})).map((c) => c.costUsd)).toEqual([null, null]);
  });
});

describe('draft and final resolution settings', () => {
  it('accepts resolution labels and null, and refuses anything else', () => {
    for (const value of ['480p', '768P', '2K', '4k', null]) {
      expect(musicVideoVideoSettingsSchema.safeParse({ draftResolution: value, finalResolution: value }).success).toBe(true);
    }
    for (const value of ['', 'big', '1280:720', 480]) {
      expect(musicVideoVideoSettingsSchema.safeParse({ draftResolution: value }).success).toBe(false);
      expect(musicVideoVideoSettingsSchema.safeParse({ finalResolution: value }).success).toBe(false);
    }
  });
});

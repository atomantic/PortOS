import { describe, it, expect } from 'vitest';
import { resolveVideoBackendPin, grokVideoJobParams, videoBackendJobParams } from './backendPin.js';
import { VIDEO_GEN_MODE } from './modes.js';
import { RENDER_TARGET } from '../../lib/renderTargets.js';

const grokOn = { imageGen: { grok: { enabled: true, grokPath: '/usr/local/bin/grok' } } };
const grokOff = { imageGen: { grok: { enabled: false, grokPath: '/usr/local/bin/grok' } } };
const project = (video) => ({ id: 'proj-1', renderBackend: video ? { video } : undefined });

describe('resolveVideoBackendPin', () => {
  it('reports no pin and resolves local when nothing is pinned', () => {
    // The byte-identical-when-auto contract: `pinned:false` is what lets the
    // planner's enqueue tool return the caller's params untouched.
    expect(resolveVideoBackendPin(project(null), grokOn)).toEqual({
      pinned: false, requested: null, mode: VIDEO_GEN_MODE.LOCAL, modelId: null,
    });
  });

  it('honors the project pin over the install default', () => {
    const pin = resolveVideoBackendPin(project({ mode: 'grok', modelId: null }), grokOn);
    expect(pin).toEqual({ pinned: true, requested: 'grok', mode: VIDEO_GEN_MODE.GROK, modelId: null });
  });

  it('reports requested vs resolved so a caller can spot a degraded pin', () => {
    // requested !== mode is the ONLY signal that the ladder overrode the user.
    const degraded = resolveVideoBackendPin(project({ mode: 'grok' }), grokOff);
    expect(degraded.requested).toBe('grok');
    expect(degraded.mode).toBe(VIDEO_GEN_MODE.LOCAL);

    const honored = resolveVideoBackendPin(project({ mode: 'grok' }), grokOn);
    expect(honored.requested).toBe(honored.mode);
  });

  it("reports no request for the 'auto' sentinel, so it never reads as degraded", () => {
    expect(resolveVideoBackendPin(project({ mode: 'auto' }), grokOff).requested).toBe(null);
  });

  it('counts a model-only pin as pinned so the planner path cannot drop it', () => {
    // Both surfaces must agree: the scene path reads modelId unconditionally,
    // so if `pinned` were false here the planner path's byte-identical early
    // return would silently discard a model the user explicitly chose.
    const pin = resolveVideoBackendPin(project({ modelId: 'ltx-13b' }), grokOn);
    expect(pin.pinned).toBe(true);
    expect(pin.mode).toBe(VIDEO_GEN_MODE.LOCAL);
    expect(pin.modelId).toBe('ltx-13b');
  });

  it('counts a model-only render-target default as pinned', () => {
    const settings = {
      ...grokOn,
      renderDefaults: { [RENDER_TARGET.CREATIVE_AGENT]: { videoModel: 'target-model' } },
    };
    expect(resolveVideoBackendPin(project(null), settings)).toEqual({
      pinned: true, requested: null, mode: VIDEO_GEN_MODE.LOCAL, modelId: 'target-model',
    });
  });

  it('degrades a grok pin to local when grok is not enabled', () => {
    // A nightly commission must still produce something rather than failing
    // every fire because the user flipped the toggle off after pinning.
    const pin = resolveVideoBackendPin(project({ mode: 'grok', modelId: null }), grokOff);
    expect(pin.mode).toBe(VIDEO_GEN_MODE.LOCAL);
    // Still `pinned` — a caller must NOT treat a degraded pin as "no pin", or
    // the local branch would skip applying the pinned model id.
    expect(pin.pinned).toBe(true);
  });

  it('carries the project pin model id', () => {
    const pin = resolveVideoBackendPin(project({ mode: 'local', modelId: 'ltx-2b' }), grokOn);
    expect(pin).toEqual({ pinned: true, requested: 'local', mode: VIDEO_GEN_MODE.LOCAL, modelId: 'ltx-2b' });
  });

  it("prefers the project pin's model over the render-target default", () => {
    const settings = {
      ...grokOn,
      renderDefaults: { [RENDER_TARGET.CREATIVE_AGENT]: { videoMode: 'local', videoModel: 'target-model' } },
    };
    const pin = resolveVideoBackendPin(project({ mode: 'local', modelId: 'project-model' }), settings);
    expect(pin.modelId).toBe('project-model');
  });

  it('falls back to the render-target default when the project pins nothing', () => {
    const settings = {
      ...grokOn,
      renderDefaults: { [RENDER_TARGET.CREATIVE_AGENT]: { videoMode: 'local', videoModel: 'target-model' } },
    };
    const pin = resolveVideoBackendPin(project(null), settings);
    expect(pin).toEqual({ pinned: true, requested: null, mode: VIDEO_GEN_MODE.LOCAL, modelId: 'target-model' });
  });

  it('falls back to the install-wide videoGen.mode pin', () => {
    const pin = resolveVideoBackendPin(project(null), { ...grokOn, videoGen: { mode: 'grok' } });
    expect(pin).toEqual({ pinned: true, requested: null, mode: VIDEO_GEN_MODE.GROK, modelId: null });
  });

  it("treats the 'auto' sentinel as no pin", () => {
    const settings = {
      ...grokOn,
      renderDefaults: { [RENDER_TARGET.CREATIVE_AGENT]: { videoMode: 'auto' } },
    };
    expect(resolveVideoBackendPin(project({ mode: 'auto' }), settings).pinned).toBe(false);
  });

  it('tolerates an absent project and absent settings', () => {
    expect(resolveVideoBackendPin(null, null)).toEqual({
      pinned: false, requested: null, mode: VIDEO_GEN_MODE.LOCAL, modelId: null,
    });
  });

  // A Runway model pin renders on the pinned catalog model (its price and
  // end-frame support differ from the Gen-4.5 default), and never leaks into
  // the local fallback when the Runway key goes away.
  it('carries a curated Runway model pin into the Runway job and drops it from a local fallback', () => {
    const runwayOn = { videoGen: { runway: { apiKey: 'key_test' } } };
    const pin = resolveVideoBackendPin(project({ mode: 'runway', modelId: 'kling2.5_turbo_pro' }), runwayOn);
    expect(pin).toMatchObject({ mode: VIDEO_GEN_MODE.RUNWAY, modelId: 'kling2.5_turbo_pro' });
    expect(videoBackendJobParams(runwayOn, pin, { sourceImagePath: '/tmp/frame.png', duration: 5 }))
      .toMatchObject({ mode: VIDEO_GEN_MODE.RUNWAY, modelId: 'kling2.5_turbo_pro', videoMode: 'image', duration: 5 });
    expect(resolveVideoBackendPin(project({ mode: 'runway', modelId: 'not-a-runway-model' }), runwayOn).modelId).toBeNull();

    const prev = process.env.RUNWAYML_API_SECRET;
    delete process.env.RUNWAYML_API_SECRET;
    const lapsed = resolveVideoBackendPin(project({ mode: 'runway', modelId: 'kling2.5_turbo_pro' }), {});
    if (prev !== undefined) process.env.RUNWAYML_API_SECRET = prev;
    expect(lapsed).toMatchObject({ requested: 'runway', mode: VIDEO_GEN_MODE.LOCAL, modelId: null });
  });
});

describe('grokVideoJobParams', () => {
  it('stamps the queue discriminator and the t2v semantic', () => {
    const params = grokVideoJobParams(grokOn, { durationSeconds: 6 });
    expect(params.mode).toBe(VIDEO_GEN_MODE.GROK);
    expect(params.videoMode).toBe('text');
    expect(params.grokPath).toBe('/usr/local/bin/grok');
  });

  it('marks an i2v render when a source image is present', () => {
    expect(grokVideoJobParams(grokOn, { sourceImagePath: '/img/a.png', durationSeconds: 6 }).videoMode)
      .toBe('image');
  });

  it('rounds a local-lane duration UP to a length grok delivers', () => {
    // An 8s scene must not silently come back 6s — grok only does 6, 10 or 15.
    expect(grokVideoJobParams(grokOn, { durationSeconds: 8 }).duration).toBe(10);
    expect(grokVideoJobParams(grokOn, { durationSeconds: 4 }).duration).toBe(6);
    expect(grokVideoJobParams(grokOn, { durationSeconds: 30 }).duration).toBe(15);
  });

  it('defaults the clip length when none is given', () => {
    expect(grokVideoJobParams(grokOn, {}).duration).toBe(6);
  });

  it("never restates geometry, so a caller's own width/height survives the merge", () => {
    // grok.js prefers width/height-derived aspect over the configured one, so
    // emitting either key here would let the helper clobber the project's.
    const params = grokVideoJobParams(grokOn, { durationSeconds: 6 });
    expect(params).not.toHaveProperty('width');
    expect(params).not.toHaveProperty('height');
    expect({ width: 544, height: 960, ...params }).toMatchObject({ width: 544, height: 960 });
  });

  it('carries the configured aspect ratio only when one is set', () => {
    expect(grokVideoJobParams(grokOn, {})).not.toHaveProperty('aspectRatio');
    const withRatio = { imageGen: { grok: { grokPath: 'grok', aspectRatio: '9:16' } } };
    expect(grokVideoJobParams(withRatio, {}).aspectRatio).toBe('9:16');
  });

  it('never emits local-lane render knobs', () => {
    // Grok has no frames/steps/guidance dials; leaking them would be noise the
    // worker silently ignores and a reader would mistake for an honored setting.
    const params = grokVideoJobParams(grokOn, { durationSeconds: 6 });
    for (const key of ['pythonPath', 'numFrames', 'steps', 'guidanceScale', 'fps', 'modelId']) {
      expect(params).not.toHaveProperty(key);
    }
  });
});

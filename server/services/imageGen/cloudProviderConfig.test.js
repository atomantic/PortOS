import { describe, it, expect } from 'vitest';
import {
  isModeUsable,
  pickUsableMode,
  renderTargetDefaults,
  resolveCloudProviderConfig,
  resolveRenderTargetConfig,
} from './cloudProviderConfig.js';
import {
  AGY_IMAGEGEN_DEFAULT_MODEL,
  CODEX_IMAGEGEN_DEFAULT_MODEL,
  IMAGE_GEN_MODE,
  resolveQueueImageEditMode,
  resolveQueueImageMode,
} from './modes.js';

const settingsWith = (imageGen) => ({ imageGen });

describe('resolveCloudProviderConfig', () => {
  it('returns null for non-cloud modes', () => {
    expect(resolveCloudProviderConfig(settingsWith({}), IMAGE_GEN_MODE.LOCAL)).toBeNull();
    expect(resolveCloudProviderConfig(settingsWith({}), IMAGE_GEN_MODE.EXTERNAL)).toBeNull();
    expect(resolveCloudProviderConfig(settingsWith({}), undefined)).toBeNull();
  });

  it('bundles codex job params and defaults the model for display + queue metadata', () => {
    const cloud = resolveCloudProviderConfig(
      settingsWith({ codex: { enabled: true, codexPath: '/bin/codex', effort: 'high' } }),
      IMAGE_GEN_MODE.CODEX,
    );
    expect(cloud.enabled).toBe(true);
    expect(cloud.disabledError).toBeNull();
    expect(cloud.modelId).toBe(CODEX_IMAGEGEN_DEFAULT_MODEL);
    expect(cloud.providerParams).toEqual({
      codexPath: '/bin/codex',
      model: CODEX_IMAGEGEN_DEFAULT_MODEL,
      effort: 'high',
    });
    expect(cloud.jobParams).toEqual({ mode: IMAGE_GEN_MODE.CODEX, ...cloud.providerParams });
  });

  it('keeps a saved codex model override', () => {
    const cloud = resolveCloudProviderConfig(
      settingsWith({ codex: { enabled: true, model: 'gpt-5.4' } }),
      IMAGE_GEN_MODE.CODEX,
    );
    expect(cloud.modelId).toBe('gpt-5.4');
    expect(cloud.providerParams.model).toBe('gpt-5.4');
  });

  it('bundles grok job params (no model knob — fixed backend id)', () => {
    const cloud = resolveCloudProviderConfig(
      settingsWith({ grok: { enabled: true, grokPath: '/bin/grok', aspectRatio: '16:9' } }),
      IMAGE_GEN_MODE.GROK,
    );
    expect(cloud.modelId).toBe('grok-imagegen');
    expect(cloud.jobParams).toEqual({
      mode: IMAGE_GEN_MODE.GROK,
      grokPath: '/bin/grok',
      aspectRatio: '16:9',
    });
  });

  it('bundles Agy path and selected model, defaulting to the cheap-tier pin', () => {
    const selected = resolveCloudProviderConfig(
      settingsWith({ agy: { enabled: true, agyPath: '/bin/agy', model: 'gemini-image' } }),
      IMAGE_GEN_MODE.AGY,
    );
    expect(selected.modelId).toBe('gemini-image');
    expect(selected.jobParams).toEqual({
      mode: IMAGE_GEN_MODE.AGY,
      agyPath: '/bin/agy',
      model: 'gemini-image',
    });

    const fallback = resolveCloudProviderConfig(
      settingsWith({ agy: { enabled: true } }),
      IMAGE_GEN_MODE.AGY,
    );
    // NOT the ANTIGRAVITY_CONFIGURED_DEFAULT sentinel — that resolved to "no
    // --model", letting agy run a possibly reasoning-heavy session default for
    // a single generate_image relay (#3231).
    expect(fallback.modelId).toBe(AGY_IMAGEGEN_DEFAULT_MODEL);
    expect(fallback.providerParams.model).toBe(AGY_IMAGEGEN_DEFAULT_MODEL);
  });

  it('lets a per-render model override win over the saved default', () => {
    const agy = resolveCloudProviderConfig(
      settingsWith({ agy: { enabled: true, agyPath: '/bin/agy', model: 'saved-model' } }),
      IMAGE_GEN_MODE.AGY,
      { model: 'gemini-3.6-flash-high' },
    );
    expect(agy.modelOverride).toBe('gemini-3.6-flash-high');
    expect(agy.modelId).toBe('gemini-3.6-flash-high');
    expect(agy.jobParams).toEqual({
      mode: IMAGE_GEN_MODE.AGY,
      agyPath: '/bin/agy',
      model: 'gemini-3.6-flash-high',
    });

    const codex = resolveCloudProviderConfig(
      settingsWith({ codex: { enabled: true, model: 'gpt-5.4' } }),
      IMAGE_GEN_MODE.CODEX,
      { model: 'gpt-5.6-luna' },
    );
    expect(codex.modelId).toBe('gpt-5.6-luna');
    expect(codex.providerParams.model).toBe('gpt-5.6-luna');
  });

  it('treats a blank or whitespace override as "inherit the saved default"', () => {
    for (const model of ['', '   ', undefined, null, 42]) {
      const cloud = resolveCloudProviderConfig(
        settingsWith({ agy: { enabled: true, model: 'saved-model' } }),
        IMAGE_GEN_MODE.AGY,
        { model },
      );
      expect(cloud.modelOverride).toBeNull();
      expect(cloud.modelId).toBe('saved-model');
    }
  });

  it('ignores a model override for a provider with no model knob (grok)', () => {
    const cloud = resolveCloudProviderConfig(
      settingsWith({ grok: { enabled: true, grokPath: '/bin/grok' } }),
      IMAGE_GEN_MODE.GROK,
      { model: 'not-a-thing' },
    );
    expect(cloud.supportsModelOverride).toBe(false);
    expect(cloud.modelOverride).toBeNull();
    expect(cloud.modelId).toBe('grok-imagegen');
    expect(cloud.jobParams).not.toHaveProperty('model');
  });

  it('produces a ready-to-throw ServerError + skip reason when disabled', () => {
    const cloud = resolveCloudProviderConfig(settingsWith({ grok: { enabled: false } }), IMAGE_GEN_MODE.GROK);
    expect(cloud.enabled).toBe(false);
    expect(cloud.disabledReason).toBe('grok-disabled');
    expect(cloud.connectionReason).toMatch(/Grok Imagegen is disabled/);
    expect(cloud.disabledError.status).toBe(400);
    expect(cloud.disabledError.code).toBe('GROK_IMAGEGEN_DISABLED');
    expect(cloud.disabledError.message).toMatch(/Settings → Image Gen/);
  });

  it('treats a missing settings slice as disabled rather than throwing', () => {
    const cloud = resolveCloudProviderConfig({}, IMAGE_GEN_MODE.CODEX);
    expect(cloud.enabled).toBe(false);
    expect(cloud.config).toEqual({});
    expect(cloud.disabledError.code).toBe('CODEX_IMAGEGEN_DISABLED');
  });

  it('only counts a strict `true` toggle as enabled', () => {
    const cloud = resolveCloudProviderConfig(settingsWith({ codex: { enabled: 'yes' } }), IMAGE_GEN_MODE.CODEX);
    expect(cloud.enabled).toBe(false);
  });
});

describe('isModeUsable', () => {
  it('gates cloud modes on their enable toggle', () => {
    const s = settingsWith({ codex: { enabled: true }, grok: { enabled: false }, agy: { enabled: true } });
    expect(isModeUsable(s, IMAGE_GEN_MODE.CODEX)).toBe(true);
    expect(isModeUsable(s, IMAGE_GEN_MODE.GROK)).toBe(false);
    expect(isModeUsable(s, IMAGE_GEN_MODE.AGY)).toBe(true);
  });

  it('always allows local and never allows the non-queueable external backend', () => {
    expect(isModeUsable(settingsWith({}), IMAGE_GEN_MODE.LOCAL)).toBe(true);
    expect(isModeUsable(settingsWith({}), IMAGE_GEN_MODE.EXTERNAL)).toBe(false);
    expect(isModeUsable(settingsWith({}), 'nonsense')).toBe(false);
  });
});

describe('pickUsableMode', () => {
  const bothOff = settingsWith({ codex: { enabled: false }, grok: { enabled: false } });

  it('honors the first usable candidate', () => {
    const s = settingsWith({ codex: { enabled: true }, grok: { enabled: true } });
    expect(pickUsableMode(s, [IMAGE_GEN_MODE.GROK, IMAGE_GEN_MODE.CODEX])).toBe(IMAGE_GEN_MODE.GROK);
  });

  it('falls through a candidate whose provider is disabled', () => {
    const s = settingsWith({ codex: { enabled: true }, grok: { enabled: false } });
    expect(pickUsableMode(s, [IMAGE_GEN_MODE.GROK, IMAGE_GEN_MODE.CODEX])).toBe(IMAGE_GEN_MODE.CODEX);
  });

  it('skips undefined / unsupported candidates', () => {
    const s = settingsWith({ codex: { enabled: true } });
    expect(pickUsableMode(s, [undefined, IMAGE_GEN_MODE.EXTERNAL])).toBe(IMAGE_GEN_MODE.CODEX);
  });

  it('auto-defaults to an enabled cloud backend, codex first', () => {
    expect(pickUsableMode(settingsWith({ grok: { enabled: true } }), [])).toBe(IMAGE_GEN_MODE.GROK);
    expect(pickUsableMode(
      settingsWith({ codex: { enabled: true }, grok: { enabled: true } }),
      [],
    )).toBe(IMAGE_GEN_MODE.CODEX);
  });

  it('falls back to local when nothing else is usable', () => {
    expect(pickUsableMode(bothOff, [IMAGE_GEN_MODE.EXTERNAL])).toBe(IMAGE_GEN_MODE.LOCAL);
    expect(pickUsableMode(bothOff)).toBe(IMAGE_GEN_MODE.LOCAL);
  });

  it('honors an explicit local candidate over an enabled cloud backend', () => {
    const s = settingsWith({ codex: { enabled: true } });
    expect(pickUsableMode(s, [IMAGE_GEN_MODE.LOCAL])).toBe(IMAGE_GEN_MODE.LOCAL);
  });
});

describe('queue mode resolution with Agy', () => {
  const settings = settingsWith({
    mode: IMAGE_GEN_MODE.AGY,
    codex: { enabled: true },
    grok: { enabled: false },
    agy: { enabled: true },
  });

  it('selects enabled Agy for text-to-image work', () => {
    expect(resolveQueueImageMode(undefined, settings)).toBe(IMAGE_GEN_MODE.AGY);
  });

  it('excludes Agy from image-edit fallback', () => {
    expect(resolveQueueImageEditMode(IMAGE_GEN_MODE.AGY, settings)).toBe(IMAGE_GEN_MODE.CODEX);
  });
});

describe('resolveRenderTargetConfig (#3231)', () => {
  const withDefaults = (imageGen, renderDefaults) => ({ imageGen, renderDefaults });

  it('per-request mode wins over the target pin, which wins over the install default', () => {
    const settings = withDefaults(
      { mode: IMAGE_GEN_MODE.LOCAL, codex: { enabled: true }, agy: { enabled: true } },
      { 'universe-bible': { imageMode: IMAGE_GEN_MODE.AGY } },
    );
    expect(resolveRenderTargetConfig(settings, 'universe-bible', { mode: IMAGE_GEN_MODE.CODEX }).mode)
      .toBe(IMAGE_GEN_MODE.CODEX);
    expect(resolveRenderTargetConfig(settings, 'universe-bible').mode).toBe(IMAGE_GEN_MODE.AGY);
    expect(resolveRenderTargetConfig(settings, 'series-first-pass').mode).toBe(IMAGE_GEN_MODE.LOCAL);
  });

  it("an 'auto' or absent pin falls through to the install default, then fallbackMode", () => {
    const auto = withDefaults({}, { 'universe-bible': { imageMode: 'auto' } });
    expect(resolveRenderTargetConfig(auto, 'universe-bible', { fallbackMode: IMAGE_GEN_MODE.EXTERNAL }).mode)
      .toBe(IMAGE_GEN_MODE.EXTERNAL);
    const saved = withDefaults({ mode: IMAGE_GEN_MODE.GROK, grok: { enabled: true } }, {});
    expect(resolveRenderTargetConfig(saved, 'universe-bible', { fallbackMode: IMAGE_GEN_MODE.EXTERNAL }).mode)
      .toBe(IMAGE_GEN_MODE.GROK);
  });

  it('threads the target imageModel pin into the cloud provider params', () => {
    const settings = withDefaults(
      { agy: { enabled: true } },
      { 'sprite-reference': { imageMode: IMAGE_GEN_MODE.AGY, imageModel: 'gemini-3.6-flash-low' } },
    );
    const { cloud } = resolveRenderTargetConfig(settings, 'sprite-reference');
    expect(cloud.modelId).toBe('gemini-3.6-flash-low');
    expect(cloud.jobParams.model).toBe('gemini-3.6-flash-low');
  });

  it('a per-request model override wins over the target imageModel pin', () => {
    const settings = withDefaults(
      { codex: { enabled: true } },
      { 'sprite-reference': { imageMode: IMAGE_GEN_MODE.CODEX, imageModel: 'pinned-model' } },
    );
    const { cloud } = resolveRenderTargetConfig(settings, 'sprite-reference', { model: 'request-model' });
    expect(cloud.modelId).toBe('request-model');
  });

  it('a resolveMode ladder receives the layered candidate and owns the fallback', () => {
    const settings = withDefaults(
      { codex: { enabled: true } },
      // Pin grok but leave it DISABLED — the ladder must fall through, not
      // honor a pinned-but-unusable backend.
      { 'sprite-reference': { imageMode: IMAGE_GEN_MODE.GROK } },
    );
    const { mode } = resolveRenderTargetConfig(settings, 'sprite-reference', {
      resolveMode: (candidate, s) => resolveQueueImageMode(candidate, s),
    });
    expect(mode).toBe(IMAGE_GEN_MODE.CODEX);
  });

  it('renderTargetDefaults normalizes auto/blank/missing to null', () => {
    expect(renderTargetDefaults({}, 'universe-bible')).toEqual({
      imageMode: null, imageModel: null, videoMode: null, videoModel: null,
    });
    expect(renderTargetDefaults(
      { renderDefaults: { 'universe-bible': { imageMode: 'auto', imageModel: '  ' } } },
      'universe-bible',
    )).toEqual({ imageMode: null, imageModel: null, videoMode: null, videoModel: null });
  });
});

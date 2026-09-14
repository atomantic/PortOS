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
  resolveQueueImageMode,
} from './modes.js';
import { recordRenderPin } from '../../lib/renderTargets.js';

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
      modelIsShippedDefault: false,
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
    // Provenance for the agy provider's retired-pin re-point: only an id
    // PortOS chose may be swapped out from under the render.
    expect(fallback.providerParams.modelIsShippedDefault).toBe(true);
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
      modelIsShippedDefault: false,
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

  it('allows every queueable backend for an edit render — all take input images', () => {
    // Each backend feeds an input image to its own tool: local `--image-path`,
    // codex `referenced_image_paths`, grok `image_edit.image`, agy
    // `ImagePaths`. So an i2i render walks this exact ladder with no edit
    // variant — the sole edit-incapable backend (external) isn't queueable.
    const s = settingsWith({ agy: { enabled: true }, codex: { enabled: true }, grok: { enabled: true } });
    for (const mode of [IMAGE_GEN_MODE.AGY, IMAGE_GEN_MODE.CODEX, IMAGE_GEN_MODE.GROK, IMAGE_GEN_MODE.LOCAL]) {
      expect(isModeUsable(s, mode), `${mode} should be usable for an edit render`).toBe(true);
    }
    // Disabled-ness still gates.
    const off = settingsWith({ agy: { enabled: false }, codex: { enabled: true } });
    expect(isModeUsable(off, IMAGE_GEN_MODE.AGY)).toBe(false);
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

  it('keeps a record pin on an edit render — every queueable backend takes input images', () => {
    // Agy used to fall through here (#3243) because its generate_image was
    // believed to take no input image. Its tool schema documents `ImagePaths`
    // ("edit, combine, or use as references"), so the pin is now honored and an
    // edit render lands where the user asked for it.
    const s = settingsWith({ agy: { enabled: true }, codex: { enabled: true } });
    expect(pickUsableMode(s, [IMAGE_GEN_MODE.AGY])).toBe(IMAGE_GEN_MODE.AGY);
  });

  it('lands on local for an edit render when every cloud backend is off', () => {
    // LOCAL is edit-capable, so the auto tail always resolves — an edit render
    // can never fall off the end of the ladder.
    const allOff = settingsWith({ codex: { enabled: false }, grok: { enabled: false }, agy: { enabled: false } });
    expect(pickUsableMode(allOff, [IMAGE_GEN_MODE.AGY])).toBe(IMAGE_GEN_MODE.LOCAL);
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

  it('uses the same ladder for image-edit work — Agy takes input images too', () => {
    expect(resolveQueueImageMode(IMAGE_GEN_MODE.AGY, settings)).toBe(IMAGE_GEN_MODE.AGY);
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

  it('a disabled pinned backend falls through — and takes its model pin with it', () => {
    const settings = withDefaults(
      // Agy pin is DISABLED; install default is codex.
      { mode: IMAGE_GEN_MODE.CODEX, codex: { enabled: true }, agy: { enabled: false } },
      { 'universe-bible': { imageMode: IMAGE_GEN_MODE.AGY, imageModel: 'gemini-3.6-flash-low' } },
    );
    const { mode, cloud } = resolveRenderTargetConfig(settings, 'universe-bible');
    expect(mode).toBe(IMAGE_GEN_MODE.CODEX);
    // The gemini model pinned FOR AGY must not leak into codex's --model —
    // supportsModelOverride gates by provider, not by id namespace.
    expect(cloud.modelId).toBe(CODEX_IMAGEGEN_DEFAULT_MODEL);
    expect(cloud.jobParams.model).toBe(CODEX_IMAGEGEN_DEFAULT_MODEL);
  });

  it('an explicit mode on another backend does not inherit the pinned model', () => {
    const settings = withDefaults(
      { codex: { enabled: true }, agy: { enabled: true } },
      { 'sprite-reference': { imageMode: IMAGE_GEN_MODE.AGY, imageModel: 'gemini-3.6-flash-low' } },
    );
    const { cloud } = resolveRenderTargetConfig(settings, 'sprite-reference', { mode: IMAGE_GEN_MODE.CODEX });
    expect(cloud.modelId).toBe(CODEX_IMAGEGEN_DEFAULT_MODEL);
  });

  it('a record pin beats the target pin and loses to a per-request mode (#3231 Phase 3)', () => {
    const settings = withDefaults(
      { mode: IMAGE_GEN_MODE.LOCAL, codex: { enabled: true }, agy: { enabled: true }, grok: { enabled: true } },
      { 'universe-bible': { imageMode: IMAGE_GEN_MODE.AGY } },
    );
    expect(resolveRenderTargetConfig(settings, 'universe-bible', { recordMode: IMAGE_GEN_MODE.CODEX }).mode)
      .toBe(IMAGE_GEN_MODE.CODEX);
    expect(resolveRenderTargetConfig(settings, 'universe-bible', {
      mode: IMAGE_GEN_MODE.GROK, recordMode: IMAGE_GEN_MODE.CODEX,
    }).mode).toBe(IMAGE_GEN_MODE.GROK);
  });

  it('a record model pin rides its backend and wins over the target model pin', () => {
    const settings = withDefaults(
      { agy: { enabled: true } },
      { 'universe-bible': { imageMode: IMAGE_GEN_MODE.AGY, imageModel: 'target-model' } },
    );
    const { cloud } = resolveRenderTargetConfig(settings, 'universe-bible', {
      recordMode: IMAGE_GEN_MODE.AGY, recordModel: 'record-model',
    });
    expect(cloud.modelId).toBe('record-model');
    expect(cloud.jobParams.model).toBe('record-model');
  });

  it('a disabled record pin falls through and takes its model with it', () => {
    const settings = withDefaults(
      { mode: IMAGE_GEN_MODE.CODEX, codex: { enabled: true }, agy: { enabled: false } },
      {},
    );
    const { mode, cloud } = resolveRenderTargetConfig(settings, 'universe-bible', {
      recordMode: IMAGE_GEN_MODE.AGY, recordModel: 'gemini-3.6-flash-low',
    });
    expect(mode).toBe(IMAGE_GEN_MODE.CODEX);
    expect(cloud.modelId).toBe(CODEX_IMAGEGEN_DEFAULT_MODEL);
  });

  it('a pre-resolved mode matching the record pin still applies the record model', () => {
    // Surfaces with their own usability ladder (sprites, pipeline) resolve
    // mode first and pass it as `mode` — the record model must still ride
    // when that mode IS the record's pinned backend.
    const settings = withDefaults({ codex: { enabled: true } }, {});
    const { cloud } = resolveRenderTargetConfig(settings, 'sprite-reference', {
      mode: IMAGE_GEN_MODE.CODEX, recordMode: IMAGE_GEN_MODE.CODEX, recordModel: 'record-model',
    });
    expect(cloud.modelId).toBe('record-model');
  });

  it('recordRenderPin normalizes auto/blank/missing to null', () => {
    expect(recordRenderPin(null)).toEqual({ mode: null, modelId: null });
    expect(recordRenderPin({ imageMode: 'auto', imageModelId: '  ' })).toEqual({ mode: null, modelId: null });
    expect(recordRenderPin({ imageMode: ` ${IMAGE_GEN_MODE.AGY} `, imageModelId: 'gemini-3.6-flash-low' }))
      .toEqual({ mode: IMAGE_GEN_MODE.AGY, modelId: 'gemini-3.6-flash-low' });
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

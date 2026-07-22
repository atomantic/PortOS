import { describe, it, expect } from 'vitest';
import {
  isCloudImageMode,
  isModeUsable,
  pickUsableMode,
  resolveCloudProviderConfig,
} from './cloudProviderConfig.js';
import { CODEX_IMAGEGEN_DEFAULT_MODEL, IMAGE_GEN_MODE } from './modes.js';

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

describe('isCloudImageMode', () => {
  it('is true for the cloud CLIs only', () => {
    expect(isCloudImageMode(IMAGE_GEN_MODE.CODEX)).toBe(true);
    expect(isCloudImageMode(IMAGE_GEN_MODE.GROK)).toBe(true);
    expect(isCloudImageMode(IMAGE_GEN_MODE.LOCAL)).toBe(false);
    expect(isCloudImageMode(IMAGE_GEN_MODE.EXTERNAL)).toBe(false);
  });
});

describe('isModeUsable', () => {
  it('gates cloud modes on their enable toggle', () => {
    const s = settingsWith({ codex: { enabled: true }, grok: { enabled: false } });
    expect(isModeUsable(s, IMAGE_GEN_MODE.CODEX)).toBe(true);
    expect(isModeUsable(s, IMAGE_GEN_MODE.GROK)).toBe(false);
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

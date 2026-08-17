import { describe, it, expect } from 'vitest';
import {
  IMAGE_GEN_MODE,
  I2I_CAPABLE_MODES,
  MAX_INPUT_IMAGES,
  cloudPromptRequired,
  isI2iCapableMode,
  pickI2iMode,
  referenceSlotsFor,
  supportsReferenceStrength,
  deriveAvailableBackends,
  applyRecordRenderPin,
  renderPinLadder,
  renderTargetPin,
} from './imageGenBackends';

describe('I2I_CAPABLE_MODES / isI2iCapableMode', () => {
  it('treats every generation backend as i2i-capable, but not external', () => {
    expect(I2I_CAPABLE_MODES).toEqual([
      IMAGE_GEN_MODE.LOCAL, IMAGE_GEN_MODE.CODEX, IMAGE_GEN_MODE.GROK, IMAGE_GEN_MODE.AGY,
    ]);
    expect(isI2iCapableMode(IMAGE_GEN_MODE.LOCAL)).toBe(true);
    expect(isI2iCapableMode(IMAGE_GEN_MODE.CODEX)).toBe(true);
    expect(isI2iCapableMode(IMAGE_GEN_MODE.GROK)).toBe(true);
    expect(isI2iCapableMode(IMAGE_GEN_MODE.AGY)).toBe(true);
    expect(isI2iCapableMode(IMAGE_GEN_MODE.EXTERNAL)).toBe(false);
    expect(isI2iCapableMode(undefined)).toBe(false);
  });
});

describe('input-image capability helpers', () => {
  it('caps agy at the 3 images its generate_image tool accepts', () => {
    expect(MAX_INPUT_IMAGES[IMAGE_GEN_MODE.AGY]).toBe(3);
    // The other two declare no maximum, so they carry no entry at all — the
    // form's own slot count is their only ceiling. Restating it here as a
    // "capability" would make a form change look like a provider limit.
    expect(MAX_INPUT_IMAGES[IMAGE_GEN_MODE.CODEX]).toBeUndefined();
    expect(MAX_INPUT_IMAGES[IMAGE_GEN_MODE.GROK]).toBeUndefined();
  });

  it('lets codex/grok render image-only but always demands a prompt for agy', () => {
    expect(cloudPromptRequired(IMAGE_GEN_MODE.CODEX, true)).toBe(false);
    expect(cloudPromptRequired(IMAGE_GEN_MODE.GROK, true)).toBe(false);
    expect(cloudPromptRequired(IMAGE_GEN_MODE.AGY, true)).toBe(true);
    for (const mode of [IMAGE_GEN_MODE.CODEX, IMAGE_GEN_MODE.GROK, IMAGE_GEN_MODE.AGY]) {
      expect(cloudPromptRequired(mode, false)).toBe(true);
    }
  });

  it('leaves room for the init image when capping a cloud backend\'s reference slots', () => {
    // agy's tool takes 3 images TOTAL, so an init image leaves 2 ref slots.
    expect(referenceSlotsFor(IMAGE_GEN_MODE.AGY, { hasInitImage: false })).toBe(3);
    expect(referenceSlotsFor(IMAGE_GEN_MODE.AGY, { hasInitImage: true })).toBe(2);
    // codex/grok declare no cap, so the form's own 4 slots are the ceiling and
    // an init image doesn't eat into them.
    expect(referenceSlotsFor(IMAGE_GEN_MODE.CODEX, { hasInitImage: true })).toBe(4);
    expect(referenceSlotsFor(IMAGE_GEN_MODE.GROK, { hasInitImage: false })).toBe(4);
  });

  it('offers local reference slots only when the model supports them, and none for external', () => {
    expect(referenceSlotsFor(IMAGE_GEN_MODE.LOCAL, { localSupportsReferences: true })).toBe(4);
    expect(referenceSlotsFor(IMAGE_GEN_MODE.LOCAL, { localSupportsReferences: false })).toBe(0);
    expect(referenceSlotsFor(IMAGE_GEN_MODE.EXTERNAL, { localSupportsReferences: true })).toBe(0);
    expect(referenceSlotsFor(undefined)).toBe(0);
  });

  it('offers numeric per-reference strength only on the local runner', () => {
    expect(supportsReferenceStrength(IMAGE_GEN_MODE.LOCAL)).toBe(true);
    for (const mode of [IMAGE_GEN_MODE.CODEX, IMAGE_GEN_MODE.GROK, IMAGE_GEN_MODE.AGY]) {
      expect(supportsReferenceStrength(mode)).toBe(false);
    }
  });
});

describe('pickI2iMode', () => {
  const backend = (id) => ({ id });

  it('prefers local when both local and codex are available', () => {
    expect(pickI2iMode([backend('external'), backend('codex'), backend('local')]))
      .toBe(IMAGE_GEN_MODE.LOCAL);
  });

  it('falls back to codex when local is absent', () => {
    expect(pickI2iMode([backend('external'), backend('codex')])).toBe(IMAGE_GEN_MODE.CODEX);
  });

  it('returns null when neither i2i backend is installed', () => {
    expect(pickI2iMode([backend('external')])).toBeNull();
    expect(pickI2iMode([])).toBeNull();
  });
});

describe('deriveAvailableBackends', () => {
  it('includes only configured backends and respects excludeExternal', () => {
    const settings = {
      imageGen: {
        local: { pythonPath: '/usr/bin/python3' },
        codex: { enabled: true },
        agy: { enabled: true },
        external: { sdapiUrl: 'http://localhost:7860' },
      },
    };
    expect(deriveAvailableBackends(settings).map((b) => b.id))
      .toEqual([IMAGE_GEN_MODE.LOCAL, IMAGE_GEN_MODE.CODEX, IMAGE_GEN_MODE.AGY, IMAGE_GEN_MODE.EXTERNAL]);
    expect(deriveAvailableBackends(settings, { excludeExternal: true }).map((b) => b.id))
      .toEqual([IMAGE_GEN_MODE.LOCAL, IMAGE_GEN_MODE.CODEX, IMAGE_GEN_MODE.AGY]);
    expect(deriveAvailableBackends(undefined)).toEqual([]);
  });
});

describe('renderPinLadder', () => {
  const backends = [
    { id: IMAGE_GEN_MODE.LOCAL }, { id: IMAGE_GEN_MODE.CODEX }, { id: IMAGE_GEN_MODE.AGY },
  ];
  const record = (imageMode, imageModelId = null) => ({ imageMode, imageModelId });

  it('reports no pin when every source is empty', () => {
    expect(renderPinLadder([null, {}, record(null)])).toEqual({ mode: null, modelId: null });
    // 'auto' is the "no pin" sentinel, same as the server's normalizer.
    expect(renderPinLadder([record('auto')])).toEqual({ mode: null, modelId: null });
  });

  it('takes the highest-priority source that carries a pin', () => {
    expect(renderPinLadder([record(null), record('agy', 'm')], backends))
      .toEqual({ mode: IMAGE_GEN_MODE.AGY, modelId: 'm' });
    expect(renderPinLadder([record('codex'), record('agy')], backends).mode)
      .toBe(IMAGE_GEN_MODE.CODEX);
  });

  it('falls THROUGH a pin whose backend is not enabled, rather than giving up', () => {
    // The old behavior returned "no pin" here, so a stale record pin also
    // suppressed the target pin sitting below it.
    expect(renderPinLadder([record('grok'), record('agy')], backends).mode)
      .toBe(IMAGE_GEN_MODE.AGY);
    // A null backend list skips the usability gate entirely.
    expect(renderPinLadder([record('grok')], null).mode).toBe(IMAGE_GEN_MODE.GROK);
    // `[]` is "loaded, nothing enabled" — a real gate, not "unknown".
    expect(renderPinLadder([record('agy')], []).mode).toBeNull();
  });
});

describe('renderTargetPin', () => {
  it("re-keys settings.renderDefaults[target] to the flat record-pin shape", () => {
    const settings = { renderDefaults: { 'universe-bible': { imageMode: 'agy', imageModel: 'm' } } };
    expect(renderTargetPin(settings, 'universe-bible')).toEqual({ imageMode: 'agy', imageModelId: 'm' });
    expect(renderTargetPin(settings, 'music-video')).toEqual({ imageMode: null, imageModelId: null });
    expect(renderTargetPin(undefined, 'universe-bible')).toEqual({ imageMode: null, imageModelId: null });
  });
});

describe('applyRecordRenderPin', () => {
  const backends = [
    { id: IMAGE_GEN_MODE.LOCAL }, { id: IMAGE_GEN_MODE.CODEX }, { id: IMAGE_GEN_MODE.AGY },
  ];
  const cfg = { mode: IMAGE_GEN_MODE.CODEX, modelId: 'flux2-klein-4b', width: 1024 };

  it('returns the cfg BY IDENTITY when no pin applies', () => {
    // Identity matters: this cfg is a prop, so a fresh object every render
    // would churn every consumer for the common unpinned case.
    expect(applyRecordRenderPin(cfg, [null, {}], backends)).toBe(cfg);
  });

  it('overrides the settings-derived mode and keeps the untouched knobs', () => {
    const out = applyRecordRenderPin(cfg, [{ imageMode: 'agy' }], backends);
    expect(out.mode).toBe(IMAGE_GEN_MODE.AGY);
    expect(out.width).toBe(1024);
  });

  it('routes the pinned model to modelId for local and cloudModel for a cloud CLI', () => {
    const local = applyRecordRenderPin(cfg, [{ imageMode: 'local', imageModelId: 'flux-1' }], backends);
    expect(local.modelId).toBe('flux-1');
    expect(local.cloudModel).toBeNull();

    const cloud = applyRecordRenderPin(cfg, [{ imageMode: 'agy', imageModelId: 'gemini-3.5-pro' }], backends);
    expect(cloud.cloudModel).toBe('gemini-3.5-pro');
    // The settings-derived LOCAL model must not leak into a cloud render.
    expect(cloud.modelId).toBeNull();
  });

  it('drops a pinned model for a cloud CLI with no model knob (grok)', () => {
    const out = applyRecordRenderPin(cfg, [{ imageMode: 'grok', imageModelId: 'nope' }], null);
    expect(out.cloudModel).toBeNull();
    expect(out.modelId).toBeNull();
  });

  it('still applies a model-only pin when the pinned mode equals the settings mode', () => {
    const out = applyRecordRenderPin(cfg, [{ imageMode: 'codex', imageModelId: 'gpt-5.6-luna' }], backends);
    expect(out.mode).toBe(IMAGE_GEN_MODE.CODEX);
    expect(out.cloudModel).toBe('gpt-5.6-luna');
  });
});
// @vitest-environment node

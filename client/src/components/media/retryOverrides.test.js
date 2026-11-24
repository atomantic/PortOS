import { describe, it, expect } from 'vitest';
import { DEFAULT_SPEED_PROFILE_ID } from '../../lib/videoGenParams';
import { buildVideoRetryOverrides, reconcileModelBoundParams, textChanged, numberChanged, codexEffortOf } from './retryOverrides';

const baseParams = { prompt: 'a cat', negativePrompt: '', modelId: 'm1', width: 512, height: 512, numFrames: 49, fps: 24, chunks: 1, seed: 7, steps: 20 };

const draftFrom = (p, patch = {}) => ({
  prompt: p.prompt, negativePrompt: p.negativePrompt || '', modelId: p.modelId,
  width: p.width ?? '', height: p.height ?? '', numFrames: p.numFrames ?? '', fps: p.fps ?? '',
  chunks: p.chunks ?? 1, chunkPrompts: p.chunkPrompts || [], seed: p.seed ?? '', steps: p.steps ?? '',
  guidanceScale: p.guidanceScale ?? '', imageStrength: p.imageStrength ?? '',
  i2vReferenceMode: 'anchor', tiling: 'auto', disableAudio: false, textEncoderId: 'stock',
  speedProfileId: DEFAULT_SPEED_PROFILE_ID, draftDecode: 'full', a2vLoraStageStrengths: [1, 1], streamingMode: 'auto',
  selectedLoras: [], ...patch,
});

const ctxFor = (patch = {}) => ({
  currentModel: null, isHosted: false, chainingActive: false, displayedContextFrames: 0,
  originalEncoder: 'stock', originalSpeedProfileForModel: DEFAULT_SPEED_PROFILE_ID, originalDraftDecode: 'full', ...patch,
});

describe('change helpers', () => {
  it('textChanged ignores surrounding whitespace and absent-vs-empty', () => {
    expect(textChanged(' a ', 'a')).toBe(false);
    expect(textChanged('', undefined)).toBe(false);
    expect(textChanged('b', 'a')).toBe(true);
  });
  it('numberChanged treats a blank field as absent', () => {
    expect(numberChanged('', undefined)).toBe(false);
    expect(numberChanged('5', 5)).toBe(false);
    expect(numberChanged('6', 5)).toBe(true);
  });
  it('codexEffortOf never throws on non-strings', () => {
    expect(codexEffortOf(42)).toBe('');
    expect(codexEffortOf(' high ')).toBe('high');
  });
});

describe('buildVideoRetryOverrides', () => {
  it('returns null when nothing changed', () => {
    expect(buildVideoRetryOverrides(draftFrom(baseParams), baseParams, ctxFor())).toBeNull();
  });

  it('sends only the edited keys, trimmed', () => {
    const out = buildVideoRetryOverrides(draftFrom(baseParams, { prompt: '  a dog ', width: '640' }), baseParams, ctxFor());
    expect(out).toEqual({ prompt: 'a dog', width: 640 });
  });

  it('clears a clearable knob with null when the field is blanked', () => {
    const out = buildVideoRetryOverrides(draftFrom(baseParams, { seed: '', steps: '30' }), baseParams, ctxFor());
    expect(out).toEqual({ seed: null, steps: 30 });
  });

  it('limits a hosted retry to the prompts', () => {
    const out = buildVideoRetryOverrides(
      draftFrom(baseParams, { prompt: 'new', width: '1024', modelId: 'other' }), baseParams, ctxFor({ isHosted: true }),
    );
    expect(out).toEqual({ prompt: 'new' });
  });

  it('a model switch re-sends the model-bound knobs even when they snap to defaults', () => {
    const out = buildVideoRetryOverrides(draftFrom(baseParams, { modelId: 'm2' }), baseParams, ctxFor());
    expect(out).toEqual({ modelId: 'm2', textEncoderId: 'stock', speedProfileId: null, draftDecode: null });
  });

  it('drops chunk prompts when chaining is collapsed back to one chunk', () => {
    const p = { ...baseParams, chunks: 3, chunkPrompts: ['a', 'b'] };
    const out = buildVideoRetryOverrides(draftFrom(p, { chunks: 1 }), p, ctxFor());
    expect(out).toMatchObject({ chunks: 1, chunkPrompts: [] });
  });

  it('sets the continuity strategy from the submitted context frames', () => {
    const out = buildVideoRetryOverrides(
      draftFrom(baseParams, { chunks: 2 }), baseParams, ctxFor({ chainingActive: true, displayedContextFrames: 8 }),
    );
    expect(out).toMatchObject({ chunks: 2, contextFrames: 8, continuityStrategy: 'window' });
  });

  it('resets a non-default reference mode back to null', () => {
    const p = { ...baseParams, i2vReferenceMode: 'inspire' };
    const out = buildVideoRetryOverrides(draftFrom(p, { i2vReferenceMode: 'anchor' }), p, ctxFor());
    expect(out).toEqual({ i2vReferenceMode: null });
  });

  it('nulls inherited steps and guidance under a MiniMax H3 speed profile', () => {
    const p = { ...baseParams, guidanceScale: 3 };
    const currentModel = { speedProfiles: [{ id: 'h3', type: 'minimax-h3-lightx2v' }] };
    const out = buildVideoRetryOverrides(draftFrom(p, { speedProfileId: 'h3' }), p, ctxFor({
      currentModel, originalSpeedProfileForModel: DEFAULT_SPEED_PROFILE_ID,
    }));
    expect(out).toMatchObject({ speedProfileId: 'h3', steps: null, guidanceScale: null });
  });
});

describe('reconcileModelBoundParams', () => {
  const draft = { contextFrames: 0, i2vReferenceMode: 'anchor', textEncoderId: 'stock', speedProfileId: DEFAULT_SPEED_PROFILE_ID, draftDecode: 'full' };

  it('leaves the draft untouched until the model resolves', () => {
    expect(reconcileModelBoundParams(null, [], draft)).toBe(draft);
  });

  it('is idempotent for a resolved model', () => {
    const model = { id: 'm1', runtime: 'ltx' };
    const once = reconcileModelBoundParams(model, [model], draft);
    expect(reconcileModelBoundParams(model, [model], once)).toEqual(once);
  });
});

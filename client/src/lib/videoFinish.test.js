import { describe, it, expect } from 'vitest';
import { isReproducibleTextToVideo, finishTargetForRecord, isDeliveryVideoModel, MIN_RENDER_INPUTS_VERSION } from './videoFinish.js';

const DRAFT_MODEL = { id: 'draft_model', name: 'Draft (4-step)', finishModelId: 'delivery_model' };
const DELIVERY_MODEL = { id: 'delivery_model', name: 'Delivery (20-step)' };
const MODELS = [DRAFT_MODEL, DELIVERY_MODEL];

// A record as the finish-aware writer stamps it for a plain text-to-video run.
const record = (over = {}) => ({
  id: 'rec-1',
  prompt: 'a quiet street at dusk',
  modelId: 'draft_model',
  seed: 424242,
  mode: 'text',
  renderInputsVersion: MIN_RENDER_INPUTS_VERSION,
  conditioning: [],
  ...over,
});

describe('isReproducibleTextToVideo', () => {
  it('accepts a fully reproducible text-to-video record', () => {
    expect(isReproducibleTextToVideo(record())).toBe(true);
    expect(isReproducibleTextToVideo(record({ seed: 0 }))).toBe(true);
  });

  it('rejects a legacy record that predates the durable-inputs fields', () => {
    // The dangerous case: absent `conditioning` must NOT read as "no
    // conditioning" — a legacy image-to-video render looks identical here.
    const { renderInputsVersion, conditioning, ...legacy } = record();
    expect(isReproducibleTextToVideo(legacy)).toBe(false);
  });

  it('rejects an incomplete record that has the marker but no inventory', () => {
    expect(isReproducibleTextToVideo(record({ conditioning: undefined }))).toBe(false);
    expect(isReproducibleTextToVideo(record({ conditioning: null }))).toBe(false);
  });

  it('rejects an image-conditioned draft', () => {
    expect(isReproducibleTextToVideo(record({ mode: 'image', conditioning: ['image'] }))).toBe(false);
  });

  it('rejects a record whose mode reads text but which was audio-conditioned', () => {
    expect(isReproducibleTextToVideo(record({ conditioning: ['audio'] }))).toBe(false);
  });

  it('rejects the non-text modes wholesale', () => {
    for (const mode of ['image', 'fflf', 'extend', 'a2v', 'ic-control', 'grok']) {
      expect(isReproducibleTextToVideo(record({ mode }))).toBe(false);
    }
  });

  it('rejects a record with no resolved seed', () => {
    expect(isReproducibleTextToVideo(record({ seed: undefined }))).toBe(false);
    expect(isReproducibleTextToVideo(record({ seed: null }))).toBe(false);
    expect(isReproducibleTextToVideo(record({ seed: '' }))).toBe(false);
    expect(isReproducibleTextToVideo(record({ seed: 'random' }))).toBe(false);
  });

  it('rejects a record with no usable prompt', () => {
    expect(isReproducibleTextToVideo(record({ prompt: '' }))).toBe(false);
    expect(isReproducibleTextToVideo(record({ prompt: '   ' }))).toBe(false);
    expect(isReproducibleTextToVideo(record({ prompt: '(no prompt)' }))).toBe(false);
    expect(isReproducibleTextToVideo(record({ prompt: undefined }))).toBe(false);
  });

  it('rejects derivatives that are not a single render', () => {
    expect(isReproducibleTextToVideo(record({ chainedFrom: ['a', 'b'] }))).toBe(false);
    expect(isReproducibleTextToVideo(record({ stitchedFrom: ['a', 'b'] }))).toBe(false);
    expect(isReproducibleTextToVideo(record({ upscaledFrom: 'rec-0' }))).toBe(false);
  });

  it('rejects non-records without throwing', () => {
    expect(isReproducibleTextToVideo(null)).toBe(false);
    expect(isReproducibleTextToVideo(undefined)).toBe(false);
    expect(isReproducibleTextToVideo('rec-1')).toBe(false);
  });
});

describe('finishTargetForRecord', () => {
  it('resolves the delivery model declared by the draft model', () => {
    expect(finishTargetForRecord(record(), MODELS)).toEqual(DELIVERY_MODEL);
  });

  it('returns null when the delivery model is unavailable on this install', () => {
    // e.g. the user deleted the full-quality entry from their registry.
    expect(finishTargetForRecord(record(), [DRAFT_MODEL])).toBeNull();
  });

  it('returns null when the draft model declares no delivery target', () => {
    expect(finishTargetForRecord(record({ modelId: 'delivery_model' }), MODELS)).toBeNull();
  });

  it('returns null when the record\'s model is not in the catalog at all', () => {
    expect(finishTargetForRecord(record({ modelId: 'some_removed_model' }), MODELS)).toBeNull();
  });

  it('returns null for an image-conditioned draft even on a pair-capable model', () => {
    expect(finishTargetForRecord(record({ mode: 'image', conditioning: ['image'] }), MODELS)).toBeNull();
  });

  it('returns null before the model list has loaded', () => {
    expect(finishTargetForRecord(record(), [])).toBeNull();
    expect(finishTargetForRecord(record(), null)).toBeNull();
  });

  it('ignores a malformed finishModelId on the draft entry', () => {
    for (const finishModelId of ['', null, 42]) {
      expect(finishTargetForRecord(record(), [{ ...DRAFT_MODEL, finishModelId }, DELIVERY_MODEL])).toBeNull();
    }
  });
});
// @vitest-environment node

// The other end of the same graph (#5449). A delivery model always decodes on
// its own decoder, so the client reads delivery intent the same way
// `draftDecodeDeclineReason` does server-side.
describe('isDeliveryVideoModel', () => {
  it('is true for a model another entry names as its finish target', () => {
    expect(isDeliveryVideoModel(DELIVERY_MODEL, MODELS)).toBe(true);
  });

  it('is false for the draft end of the pair, and for a model in no pair', () => {
    expect(isDeliveryVideoModel(DRAFT_MODEL, MODELS)).toBe(false);
    expect(isDeliveryVideoModel({ id: 'unrelated_model' }, MODELS)).toBe(false);
  });

  // Fails closed on an unresolved model / unloaded catalog: a locked picker
  // would claim 'this is a delivery model' about a model nobody has seen yet.
  it('is false when the model or the list is not resolved', () => {
    expect(isDeliveryVideoModel(null, MODELS)).toBe(false);
    expect(isDeliveryVideoModel({}, MODELS)).toBe(false);
    expect(isDeliveryVideoModel(DELIVERY_MODEL, null)).toBe(false);
    expect(isDeliveryVideoModel(DELIVERY_MODEL, [])).toBe(false);
  });
});

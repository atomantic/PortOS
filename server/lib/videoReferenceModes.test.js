/**
 * The i2v reference-mode contract (#4874).
 *
 * These assert the RULE, not the plumbing: which promises are legal, which
 * runtime can keep them, and what strength actually applies. Every boundary
 * (route, retry, render, client picker) resolves through this one table, so a
 * hole here is a hole everywhere.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_I2V_REFERENCE_MODE,
  INSPIRE_DEFAULT_IMAGE_STRENGTH,
  normalizeI2vReferenceMode,
  isDefaultI2vReferenceMode,
  runtimeSupportsI2vReferenceMode,
  i2vReferenceModeLabel,
  resolveI2vReferenceStrength,
  i2vReferenceModeViolation,
} from './videoReferenceModes.js';

const ltx25 = { name: 'LTX-2.5', runtime: 'ltx25' };
const ltx2 = { name: 'LTX-2.3', runtime: 'ltx2' };
const wan = { name: 'Wan 2.2', runtime: 'wan22' };

describe('normalizeI2vReferenceMode', () => {
  it('treats null/undefined/empty as unset → the default', () => {
    expect(normalizeI2vReferenceMode(null)).toBe(DEFAULT_I2V_REFERENCE_MODE);
    expect(normalizeI2vReferenceMode(undefined)).toBe(DEFAULT_I2V_REFERENCE_MODE);
    expect(normalizeI2vReferenceMode('')).toBe(DEFAULT_I2V_REFERENCE_MODE);
  });
  it('returns an unknown value VERBATIM so the gate can reject it', () => {
    // Collapsing garbage into 'anchor' would turn a typo into a silently
    // different render — the whole point of the sentinel-vs-invalid split.
    expect(normalizeI2vReferenceMode('inspiration')).toBe('inspiration');
  });
  it('isDefaultI2vReferenceMode is true only for anchor/unset', () => {
    expect(isDefaultI2vReferenceMode('')).toBe(true);
    expect(isDefaultI2vReferenceMode('anchor')).toBe(true);
    expect(isDefaultI2vReferenceMode('inspire')).toBe(false);
  });
});

describe('runtimeSupportsI2vReferenceMode', () => {
  it('anchors on every runtime, including an unknown one', () => {
    for (const runtime of ['ltx25', 'ltx2', 'wan22', 'mlx_video', 'minimax_h3', undefined]) {
      expect(runtimeSupportsI2vReferenceMode(runtime, 'anchor')).toBe(true);
    }
  });
  it('inspires ONLY on ltx25 — the 2.3 pin shares the family but not the API', () => {
    expect(runtimeSupportsI2vReferenceMode('ltx25', 'inspire')).toBe(true);
    expect(runtimeSupportsI2vReferenceMode('ltx2', 'inspire')).toBe(false);
    expect(runtimeSupportsI2vReferenceMode('wan22', 'inspire')).toBe(false);
    expect(runtimeSupportsI2vReferenceMode(undefined, 'inspire')).toBe(false);
  });
  it('never supports an unknown mode', () => {
    expect(runtimeSupportsI2vReferenceMode('ltx25', 'inspiration')).toBe(false);
  });
});

describe('resolveI2vReferenceStrength', () => {
  it('defers to the pipeline for an unset anchored reference', () => {
    expect(resolveI2vReferenceStrength('anchor', '')).toBeNull();
    expect(resolveI2vReferenceStrength(null, null)).toBeNull();
  });
  it('substitutes the loose default for an unset inspired reference', () => {
    expect(resolveI2vReferenceStrength('inspire', '')).toBe(INSPIRE_DEFAULT_IMAGE_STRENGTH);
    expect(resolveI2vReferenceStrength('inspire', null)).toBe(INSPIRE_DEFAULT_IMAGE_STRENGTH);
  });
  it('honors an explicit strength on BOTH modes', () => {
    expect(resolveI2vReferenceStrength('inspire', '0.8')).toBe(0.8);
    expect(resolveI2vReferenceStrength('anchor', 0.6)).toBe(0.6);
  });
  it('keeps an explicit 0 rather than treating it as unset', () => {
    expect(resolveI2vReferenceStrength('anchor', 0)).toBe(0);
    expect(resolveI2vReferenceStrength('inspire', '0')).toBe(0);
  });
  it('falls back rather than emitting NaN for a non-numeric strength', () => {
    expect(resolveI2vReferenceStrength('anchor', 'loose')).toBeNull();
    expect(resolveI2vReferenceStrength('inspire', 'loose')).toBe(INSPIRE_DEFAULT_IMAGE_STRENGTH);
  });
});

describe('i2vReferenceModeViolation', () => {
  it('never rejects a request that left the field alone', () => {
    for (const referenceMode of [undefined, null, '', 'anchor']) {
      expect(i2vReferenceModeViolation({
        model: wan, mode: 'text', referenceMode, hasFirstImage: false,
      })).toBeNull();
    }
  });
  it('accepts inspire on ltx25 image-to-video', () => {
    expect(i2vReferenceModeViolation({
      model: ltx25, mode: 'image', referenceMode: 'inspire', hasFirstImage: true,
    })).toBeNull();
  });
  it('rejects an unknown mode', () => {
    expect(i2vReferenceModeViolation({
      model: ltx25, mode: 'image', referenceMode: 'inspiration', hasFirstImage: true,
    })).toMatchObject({ code: 'I2V_REFERENCE_MODE_UNKNOWN' });
  });
  it('rejects inspire outside image mode', () => {
    for (const mode of ['text', 'fflf', 'extend', 'a2v', 'ic-control']) {
      expect(i2vReferenceModeViolation({
        model: ltx25, mode, referenceMode: 'inspire', hasFirstImage: true,
      })).toMatchObject({ code: 'I2V_REFERENCE_MODE_REQUIRES_IMAGE' });
    }
  });
  it('rejects inspire when the image never resolved', () => {
    expect(i2vReferenceModeViolation({
      model: ltx25, mode: 'image', referenceMode: 'inspire', hasFirstImage: false,
    })).toMatchObject({ code: 'I2V_REFERENCE_MODE_REQUIRES_IMAGE' });
  });
  it('rejects inspire on a runtime that pins frame one', () => {
    for (const model of [ltx2, wan, { name: 'Legacy', runtime: undefined }]) {
      const v = i2vReferenceModeViolation({
        model, mode: 'image', referenceMode: 'inspire', hasFirstImage: true,
      });
      expect(v).toMatchObject({ code: 'I2V_REFERENCE_MODE_UNSUPPORTED' });
      // The message has to name the way out, not just the refusal.
      expect(v.message).toContain('LTX-2.5');
    }
  });
  it('names the mode in user-facing words', () => {
    expect(i2vReferenceModeLabel('inspire')).toBe('Inspire');
    expect(i2vReferenceModeLabel('')).toBe('Anchor');
  });
});

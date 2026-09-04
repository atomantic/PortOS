import { describe, it, expect } from 'vitest';
import {
  AVATAR_VARIANT_PATTERN,
  RIGGED_VARIANT_PREFIX,
  isAnimatedRecordReady,
  parseRiggedVariant,
  riggedVariantForId,
} from './avatarVariants.js';

describe('avatarVariants', () => {
  it('parses rigged spellings and rejects traversal ids', () => {
    expect(parseRiggedVariant('rigged-image3d-abc-123')).toBe('image3d-abc-123');
    expect(parseRiggedVariant('mini-male-c')).toBe(null);
    expect(parseRiggedVariant('rigged-../secret')).toBe(null);
    expect(parseRiggedVariant('rigged-')).toBe(null);
    expect(parseRiggedVariant(null)).toBe(null);
  });

  it('emits only variant-safe spellings', () => {
    expect(riggedVariantForId('image3d-abc-123')).toBe('rigged-image3d-abc-123');
    expect(riggedVariantForId('../secret')).toBe(null);
    expect(riggedVariantForId(null)).toBe(null);
  });

  it('keeps the rigged spelling inside the file-variant guard', () => {
    // The route checks the rigged prefix FIRST, so a rigged spelling must also
    // satisfy the file charset — otherwise one spelling could pass its own
    // parse and fail (or bypass) the shared traversal guard.
    expect(AVATAR_VARIANT_PATTERN.test(`${RIGGED_VARIANT_PREFIX}image3d-abc-123`)).toBe(true);
  });

  it('treats only verified retargets as selectable', () => {
    expect(isAnimatedRecordReady({ retarget: { status: 'ready', retargetId: 'retarget-1' } })).toBe(true);
    // Absent key (pre-rigging record), null, in-flight, and failed are all "not yet".
    expect(isAnimatedRecordReady({ rig: null })).toBe(false);
    expect(isAnimatedRecordReady({ retarget: null })).toBe(false);
    expect(isAnimatedRecordReady({ retarget: { status: 'retargeting' } })).toBe(false);
    expect(isAnimatedRecordReady({ retarget: { status: 'failed' } })).toBe(false);
    expect(isAnimatedRecordReady({ retarget: { status: 'ready' } })).toBe(false);
    expect(isAnimatedRecordReady(null)).toBe(false);
  });
});

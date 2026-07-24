import { describe, expect, it } from 'vitest';
import {
  EXECUTION_LANE,
  OUTPUT_KIND,
  IMAGE_TO_3D_TARGETS,
  IMAGE_TO_3D_TARGET_IDS,
  DEFAULT_IMAGE_TO_3D_TARGET,
  getTarget,
  unavailableReason,
  isTargetAvailable,
  resolveTarget,
  listTargets,
  detectHostCapabilities,
} from './targets.js';

// A host that can run TRELLIS.2's local-MPS lane, and one that can't.
const APPLE_128GB = { appleSilicon: true, unifiedMemoryGb: 128, cuda: false };
const APPLE_16GB = { appleSilicon: true, unifiedMemoryGb: 16, cuda: false };
const INTEL_MAC = { appleSilicon: false, unifiedMemoryGb: 64, cuda: false };
const CUDA_BOX = { appleSilicon: false, unifiedMemoryGb: 64, cuda: true };

describe('image-to-3d target registry', () => {
  it('registers trellis2 as the default target with a stable descriptor shape', () => {
    expect(DEFAULT_IMAGE_TO_3D_TARGET).toBe('trellis2');
    expect(IMAGE_TO_3D_TARGET_IDS).toContain('trellis2');
    const t = getTarget('trellis2');
    expect(t).toMatchObject({
      id: 'trellis2',
      label: 'TRELLIS.2',
      executionLane: EXECUTION_LANE.LOCAL_MPS,
      outputKind: OUTPUT_KIND.GLB_MESH,
    });
    expect(t.requires).toMatchObject({ appleSilicon: true, minUnifiedMemoryGb: 24 });
  });

  it('freezes the registry and its descriptors so a target cannot be mutated at runtime', () => {
    expect(Object.isFrozen(IMAGE_TO_3D_TARGETS)).toBe(true);
    expect(Object.isFrozen(IMAGE_TO_3D_TARGETS.trellis2)).toBe(true);
    expect(() => {
      IMAGE_TO_3D_TARGETS.trellis2.label = 'hacked';
    }).toThrow();
    expect(getTarget('trellis2').label).toBe('TRELLIS.2');
  });

  it('returns null for an unknown target id', () => {
    expect(getTarget('does-not-exist')).toBeNull();
    expect(getTarget('')).toBeNull();
    expect(getTarget(undefined)).toBeNull();
  });
});

describe('unavailableReason / isTargetAvailable (local-mps gating)', () => {
  it('is available on Apple Silicon with enough memory', () => {
    expect(unavailableReason('trellis2', APPLE_128GB)).toBeNull();
    expect(isTargetAvailable('trellis2', APPLE_128GB)).toBe(true);
  });

  it('is available at exactly the memory floor', () => {
    expect(isTargetAvailable('trellis2', { appleSilicon: true, unifiedMemoryGb: 24 })).toBe(true);
  });

  it('reports requires-apple-silicon on a non-Apple-Silicon host', () => {
    expect(unavailableReason('trellis2', INTEL_MAC)).toBe('requires-apple-silicon');
    expect(isTargetAvailable('trellis2', INTEL_MAC)).toBe(false);
  });

  it('reports insufficient-memory on an under-spec Apple Silicon host', () => {
    expect(unavailableReason('trellis2', APPLE_16GB)).toBe('insufficient-memory');
    expect(isTargetAvailable('trellis2', APPLE_16GB)).toBe(false);
  });

  it('reports unknown-target for an unregistered id', () => {
    expect(unavailableReason('nope', APPLE_128GB)).toBe('unknown-target');
    expect(isTargetAvailable('nope', APPLE_128GB)).toBe(false);
  });

  it('treats absent capabilities as un-runnable rather than throwing', () => {
    expect(unavailableReason('trellis2')).toBe('requires-apple-silicon');
    expect(isTargetAvailable('trellis2', {})).toBe(false);
  });
});

describe('resolveTarget', () => {
  it('resolves the requested target when available', () => {
    expect(resolveTarget('trellis2', APPLE_128GB)).toMatchObject({
      targetId: 'trellis2',
      available: true,
      reason: null,
    });
  });

  it('falls back to the default target id when none requested', () => {
    const r = resolveTarget(undefined, APPLE_128GB);
    expect(r.targetId).toBe(DEFAULT_IMAGE_TO_3D_TARGET);
    expect(r.available).toBe(true);
  });

  it('returns the target with an unavailable verdict rather than silently swapping models', () => {
    const r = resolveTarget('trellis2', APPLE_16GB);
    expect(r.targetId).toBe('trellis2');
    expect(r.target).not.toBeNull();
    expect(r.available).toBe(false);
    expect(r.reason).toBe('insufficient-memory');
  });

  it('reports unknown-target with a null descriptor for a bad id', () => {
    const r = resolveTarget('ghost', APPLE_128GB);
    expect(r).toMatchObject({ targetId: 'ghost', target: null, available: false, reason: 'unknown-target' });
  });

  it('honors a custom defaultId', () => {
    const r = resolveTarget(undefined, APPLE_128GB, { defaultId: 'trellis2' });
    expect(r.targetId).toBe('trellis2');
  });
});

describe('listTargets', () => {
  it('annotates every registered target with availability for the host', () => {
    const available = listTargets(APPLE_128GB);
    expect(available).toHaveLength(IMAGE_TO_3D_TARGET_IDS.length);
    expect(available.find((t) => t.id === 'trellis2')).toMatchObject({
      available: true,
      unavailableReason: null,
    });

    const blocked = listTargets(CUDA_BOX);
    expect(blocked.find((t) => t.id === 'trellis2')).toMatchObject({
      available: false,
      unavailableReason: 'requires-apple-silicon',
    });
  });
});

describe('detectHostCapabilities', () => {
  it('rounds unified memory to whole GB and normalizes flags', () => {
    const caps = detectHostCapabilities({
      appleSilicon: true,
      totalMemBytes: 128 * 1024 ** 3,
      cuda: false,
    });
    expect(caps).toEqual({ appleSilicon: true, unifiedMemoryGb: 128, cuda: false });
  });

  it('rounds a hair-under-marketed RAM reading up to the marketed size', () => {
    // Physical RAM on a "24 GB" Mac reads slightly under 24*1024^3.
    const caps = detectHostCapabilities({
      appleSilicon: true,
      totalMemBytes: 24 * 1024 ** 3 - 50 * 1024 ** 2,
      cuda: false,
    });
    expect(caps.unifiedMemoryGb).toBe(24);
    expect(isTargetAvailable('trellis2', caps)).toBe(true);
  });

  it('coerces truthy non-boolean overrides to strict booleans', () => {
    const caps = detectHostCapabilities({ appleSilicon: 1, totalMemBytes: 8 * 1024 ** 3, cuda: 'yes' });
    expect(caps.appleSilicon).toBe(true);
    expect(caps.cuda).toBe(true);
  });
});

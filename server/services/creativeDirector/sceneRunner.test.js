import { describe, it, expect } from 'vitest';
import {
  resolveImageStrength,
  DEFAULT_CONTINUATION_IMAGE_STRENGTH,
} from './sceneRunner.js';
import {
  creativeDirectorSceneSchema,
  creativeDirectorSceneUpdateSchema,
} from '../../lib/validation.js';

const baseScene = {
  sceneId: 'scene-1',
  order: 0,
  intent: 'cat enters frame',
  prompt: 'a cat walks into view',
  durationSeconds: 4,
};

describe('resolveImageStrength', () => {
  it('returns explicit value when set', () => {
    expect(resolveImageStrength({ explicit: 0.6, isContinuation: true })).toBe(0.6);
    expect(resolveImageStrength({ explicit: 0.6, isContinuation: false })).toBe(0.6);
  });

  it('returns 0 when explicitly set to 0 (does not treat as falsy)', () => {
    // Bug guard: a naive `explicit ||  0.85` would clobber an explicit 0.
    expect(resolveImageStrength({ explicit: 0, isContinuation: true })).toBe(0);
  });

  it('defaults continuation scenes to 0.85 when no explicit value', () => {
    expect(resolveImageStrength({ explicit: null, isContinuation: true }))
      .toBe(DEFAULT_CONTINUATION_IMAGE_STRENGTH);
    expect(resolveImageStrength({ explicit: undefined, isContinuation: true }))
      .toBe(DEFAULT_CONTINUATION_IMAGE_STRENGTH);
  });

  it('returns null for non-continuation scenes with no explicit value', () => {
    expect(resolveImageStrength({ explicit: null, isContinuation: false })).toBe(null);
  });

  it('exports 0.85 as the documented continuation default', () => {
    expect(DEFAULT_CONTINUATION_IMAGE_STRENGTH).toBe(0.85);
  });
});

describe('creativeDirectorSceneSchema — imageStrength', () => {
  it('accepts an in-range imageStrength', () => {
    const result = creativeDirectorSceneSchema.safeParse({ ...baseScene, imageStrength: 0.7 });
    expect(result.success).toBe(true);
    expect(result.data.imageStrength).toBe(0.7);
  });

  it('accepts boundary values 0 and 1', () => {
    expect(creativeDirectorSceneSchema.safeParse({ ...baseScene, imageStrength: 0 }).success).toBe(true);
    expect(creativeDirectorSceneSchema.safeParse({ ...baseScene, imageStrength: 1 }).success).toBe(true);
  });

  it('accepts null imageStrength (use default behavior)', () => {
    const result = creativeDirectorSceneSchema.safeParse({ ...baseScene, imageStrength: null });
    expect(result.success).toBe(true);
    expect(result.data.imageStrength).toBe(null);
  });

  it('accepts an omitted imageStrength', () => {
    const result = creativeDirectorSceneSchema.safeParse({ ...baseScene });
    expect(result.success).toBe(true);
  });

  it('rejects values above 1', () => {
    expect(creativeDirectorSceneSchema.safeParse({ ...baseScene, imageStrength: 1.5 }).success).toBe(false);
  });

  it('rejects values below 0', () => {
    expect(creativeDirectorSceneSchema.safeParse({ ...baseScene, imageStrength: -0.1 }).success).toBe(false);
  });
});

describe('creativeDirectorSceneUpdateSchema — imageStrength', () => {
  it('lets the evaluator adjust imageStrength on retry', () => {
    const result = creativeDirectorSceneUpdateSchema.safeParse({
      status: 'pending',
      retryCount: 1,
      imageStrength: 0.6,
    });
    expect(result.success).toBe(true);
    expect(result.data.imageStrength).toBe(0.6);
  });

  it('lets the evaluator clear imageStrength back to default behavior', () => {
    const result = creativeDirectorSceneUpdateSchema.safeParse({
      status: 'pending',
      imageStrength: null,
    });
    expect(result.success).toBe(true);
    expect(result.data.imageStrength).toBe(null);
  });

  it('rejects out-of-range adjustments', () => {
    expect(creativeDirectorSceneUpdateSchema.safeParse({ imageStrength: 2 }).success).toBe(false);
  });
});

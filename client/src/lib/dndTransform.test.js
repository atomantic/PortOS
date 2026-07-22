import { describe, it, expect } from 'vitest';
import { dndTransformToCss } from './dndTransform.js';

describe('dndTransformToCss', () => {
  it('renders a full translate + scale string', () => {
    expect(dndTransformToCss({ x: 12, y: -4, scaleX: 1, scaleY: 1 }))
      .toBe('translate3d(12px, -4px, 0) scaleX(1) scaleY(1)');
  });

  it('rounds fractional pixel offsets', () => {
    expect(dndTransformToCss({ x: 12.4, y: -4.6, scaleX: 1, scaleY: 1 }))
      .toBe('translate3d(12px, -5px, 0) scaleX(1) scaleY(1)');
  });

  it('emits 0px for zero/NaN offsets instead of "NaNpx"', () => {
    expect(dndTransformToCss({ x: 0, y: NaN, scaleX: 1, scaleY: 1 }))
      .toBe('translate3d(0px, 0px, 0) scaleX(1) scaleY(1)');
  });

  it('passes non-unit scales through verbatim', () => {
    expect(dndTransformToCss({ x: 0, y: 0, scaleX: 1.5, scaleY: 0.5 }))
      .toBe('translate3d(0px, 0px, 0) scaleX(1.5) scaleY(0.5)');
  });

  it('returns undefined for a nullish transform so React omits the property', () => {
    expect(dndTransformToCss(null)).toBeUndefined();
    expect(dndTransformToCss(undefined)).toBeUndefined();
  });
});

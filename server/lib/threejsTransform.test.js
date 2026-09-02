import { describe, expect, it } from 'vitest';

import {
  applyLinear,
  applyTransform,
  composeTransform,
  IDENTITY_LINEAR,
  IDENTITY_TRANSFORM,
  multiplyLinear,
  rotationMatrix,
  scaleLinear,
  vectorLength,
} from './threejsTransform.js';

const closeTo = (actual, expected) => {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 10));
};

describe('rotationMatrix', () => {
  // Hand-computed against THREE.Euler order 'XYZ'. A transposition or a swapped
  // composition order still produces a plausible-looking rotation, so nothing
  // downstream would localise the defect — these three pin the convention.
  it('matches the XYZ single-axis matrices', () => {
    closeTo(rotationMatrix([90, 0, 0]), [1, 0, 0, 0, 0, -1, 0, 1, 0]);
    closeTo(rotationMatrix([0, 90, 0]), [0, 0, 1, 0, 1, 0, -1, 0, 0]);
    closeTo(rotationMatrix([0, 0, 90]), [0, -1, 0, 1, 0, 0, 0, 0, 1]);
  });

  it('rotates a basis vector right-handed about each axis', () => {
    closeTo(applyLinear(rotationMatrix([90, 0, 0]), [0, 1, 0]), [0, 0, 1]);
    closeTo(applyLinear(rotationMatrix([0, 90, 0]), [1, 0, 0]), [0, 0, -1]);
    closeTo(applyLinear(rotationMatrix([0, 0, 90]), [1, 0, 0]), [0, 1, 0]);
  });

  it('composes X then Y then Z in that order', () => {
    const composed = multiplyLinear(
      multiplyLinear(rotationMatrix([30, 0, 0]), rotationMatrix([0, 40, 0])),
      rotationMatrix([0, 0, 50]),
    );
    closeTo(rotationMatrix([30, 40, 50]), composed);
  });

  it('reads a non-finite component as zero degrees instead of emitting NaN', () => {
    // The regression: a stored spec with a null/NaN rotation used to feed
    // Math.cos directly, and the NaN bounds that came back read downstream as
    // "no overlap" and "no defect" — a silently passing audit.
    closeTo(rotationMatrix([null, NaN, undefined]), IDENTITY_LINEAR);
    closeTo(rotationMatrix([Infinity, 0, 'ninety']), IDENTITY_LINEAR);
    closeTo(rotationMatrix(null), IDENTITY_LINEAR);
    closeTo(rotationMatrix(), IDENTITY_LINEAR);
  });
});

describe('scaleLinear', () => {
  it('builds the diagonal matrix', () => {
    closeTo(scaleLinear([2, 3, 4]), [2, 0, 0, 0, 3, 0, 0, 0, 4]);
    closeTo(scaleLinear(), IDENTITY_LINEAR);
  });

  it('reads a non-finite component as an unscaled axis', () => {
    closeTo(scaleLinear([null, NaN, 4]), [1, 0, 0, 0, 1, 0, 0, 0, 4]);
    closeTo(scaleLinear(null), IDENTITY_LINEAR);
  });
});

describe('composeTransform', () => {
  it('nests a rotated, scaled child inside a rotated parent', () => {
    const parent = composeTransform(IDENTITY_TRANSFORM, {
      position: [1, 0, 0],
      rotationDegrees: [0, 90, 0],
    });
    closeTo(parent.linear, [0, 0, 1, 0, 1, 0, -1, 0, 0]);
    closeTo(parent.translation, [1, 0, 0]);

    const child = composeTransform(parent, {
      position: [0, 0, 2],
      rotationDegrees: [0, 0, 90],
      scale: [2, 1, 1],
    });
    closeTo(child.linear, [0, 0, 1, 2, 0, 0, 0, 1, 0]);
    closeTo(child.translation, [3, 0, 0]);
    // Hand-computed world position of the child's local +X unit point.
    closeTo(applyTransform(child, [1, 0, 0]), [3, 2, 0]);
  });

  it('reads an absent local TRS as the parent transform', () => {
    const parent = composeTransform(IDENTITY_TRANSFORM, { position: [1, 2, 3] });
    const child = composeTransform(parent, {});
    closeTo(child.linear, parent.linear);
    closeTo(child.translation, parent.translation);
    closeTo(composeTransform(IDENTITY_TRANSFORM).translation, [0, 0, 0]);
  });

  it('stays finite when a stored spec carries a non-finite rotation or scale', () => {
    const child = composeTransform(IDENTITY_TRANSFORM, {
      position: [1, 2, 3],
      rotationDegrees: [null, undefined, NaN],
      scale: [NaN, null, 2],
    });
    closeTo(child.linear, [1, 0, 0, 0, 1, 0, 0, 0, 2]);
    closeTo(child.translation, [1, 2, 3]);
  });

  it('leaves IDENTITY_TRANSFORM unmutated so every walk starts from the same frame', () => {
    composeTransform(IDENTITY_TRANSFORM, { position: [5, 5, 5], scale: [9, 9, 9] });
    expect(IDENTITY_TRANSFORM).toEqual({ linear: IDENTITY_LINEAR, translation: [0, 0, 0] });
    // Frozen rather than merely unwritten: these are process-wide now.
    expect(Object.isFrozen(IDENTITY_TRANSFORM)).toBe(true);
    expect(Object.isFrozen(IDENTITY_TRANSFORM.linear)).toBe(true);
    expect(Object.isFrozen(IDENTITY_TRANSFORM.translation)).toBe(true);
  });
});

describe('vectorLength', () => {
  it('measures a 3-vector', () => {
    expect(vectorLength([3, 4, 0])).toBe(5);
    expect(vectorLength(applyLinear(scaleLinear([2, 1, 1]), [1, 0, 0]))).toBe(2);
  });
});

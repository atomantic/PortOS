/**
 * Cross-package parity for the image-to-3D render-option bounds.
 *
 * `renderOptions.js` owns the server-side bounds; `client/src/lib/
 * imageTo3dRenderOptions.js` is the hand-maintained client mirror (the input's
 * `max` attribute and the steps presets). This suite imports BOTH and asserts
 * they stay compatible — the same mechanism as
 * `unavailableReasons.parity.test.js` next door. It lives server-side because
 * the client mirror is a pure module that loads fine under the node runner.
 */

import { describe, it, expect } from 'vitest';
import {
  RENDER_SEED_MAX,
  isValidRenderSteps,
} from './renderOptions.js';
import {
  SEED_MAX as CLIENT_SEED_MAX,
  STEPS_PRESETS as CLIENT_STEPS_PRESETS,
} from '../../../client/src/lib/imageTo3dRenderOptions.js';

describe('image-to-3D render-option parity (server bounds ↔ client mirror)', () => {
  it('the client seed ceiling equals the server bound', () => {
    expect(CLIENT_SEED_MAX).toBe(RENDER_SEED_MAX);
  });

  it('every non-default client steps preset is a value the server accepts', () => {
    const numeric = CLIENT_STEPS_PRESETS
      .map((preset) => preset.value)
      .filter((value) => value !== '');
    expect(numeric.length).toBeGreaterThan(0);
    for (const value of numeric) {
      expect(isValidRenderSteps(Number(value)), `preset ${value}`).toBe(true);
    }
  });
});

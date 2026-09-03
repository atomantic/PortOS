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

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { trellis2GenerateRunnerScript } from './trellis2.js';
import { TRELLIS2_ALPHA_MODES } from './trellis2MeshQuality.js';
import {
  ALPHA_MODES,
  DETAIL_TIERS,
  RENDER_SEED_MAX,
  DEFAULT_SUBJECT_SCALE,
  isValidRenderSteps,
  isValidSubjectScale,
} from './renderOptions.js';
import {
  ALPHA_MODE_PRESETS as CLIENT_ALPHA_MODE_PRESETS,
  DETAIL_PRESETS as CLIENT_DETAIL_PRESETS,
  SEED_MAX as CLIENT_SEED_MAX,
  STEPS_PRESETS as CLIENT_STEPS_PRESETS,
  SUBJECT_SCALE_DEFAULT as CLIENT_SUBJECT_SCALE_DEFAULT,
  SUBJECT_SCALE_SLIDER_MIN as CLIENT_SUBJECT_SCALE_SLIDER_MIN,
  SUBJECT_SCALE_SLIDER_STEP as CLIENT_SUBJECT_SCALE_SLIDER_STEP,
  renderOptionsBody as clientRenderOptionsBody,
} from '../../../client/src/lib/imageTo3dRenderOptions.js';

describe('image-to-3D render-option parity (server bounds ↔ client mirror)', () => {
  it('the client seed ceiling equals the server bound', () => {
    expect(CLIENT_SEED_MAX).toBe(RENDER_SEED_MAX);
  });

  it('the client detail presets cover exactly the server tiers', () => {
    // Both directions matter: a client tier the server rejects 400s the render, and
    // a server tier with no client preset is a knob the user can never reach.
    expect(CLIENT_DETAIL_PRESETS.map((p) => p.value).sort()).toEqual([...DETAIL_TIERS].sort());
  });

  it('every client alpha-mode preset is a server mode, plus the unset sentinel', () => {
    const values = CLIENT_ALPHA_MODE_PRESETS.map((p) => p.value);
    // '' is client-only and load-bearing: it means "leave PortOS's force-opaque
    // normalization on", which is distinct from asking the exporter for OPAQUE.
    expect(values).toContain('');
    expect(values.filter((v) => v !== '').sort()).toEqual([...ALPHA_MODES].sort());
  });

  it('the two server-side alpha-mode lists agree', () => {
    // ALPHA_MODES gates the route; TRELLIS2_ALPHA_MODES gates arg building. Adding a
    // mode to only the first means the route 202s the render and then the arg builder
    // throws — a failure after the job was already accepted.
    expect([...TRELLIS2_ALPHA_MODES].sort()).toEqual([...ALPHA_MODES].sort());
  });

  it('the runner’s argparse choices match the server alpha-mode list', () => {
    // The fourth copy lives in Python. Read it out of the source rather than restating
    // it, so a drift in either direction fails here instead of at render time.
    const src = readFileSync(trellis2GenerateRunnerScript(), 'utf8');
    const block = src.slice(src.indexOf('"--alpha-mode"'));
    const choices = block.slice(block.indexOf('choices=['), block.indexOf(']') + 1);
    for (const mode of ALPHA_MODES) {
      expect(choices, `argparse choices missing ${mode}`).toContain(`"${mode}"`);
    }
    // And nothing extra: count the quoted entries.
    expect((choices.match(/"/g) || []).length / 2).toBe(ALPHA_MODES.length);
  });

  it('the client subject-scale default is the server identity', () => {
    // A drift here would reframe every render the user never asked to reframe.
    expect(CLIENT_SUBJECT_SCALE_DEFAULT).toBe(DEFAULT_SUBJECT_SCALE);
  });

  it('every value the subject-scale slider can emit is one the server accepts', () => {
    // Walk the slider's own min/step/max rather than sampling: a floating-point step
    // that overshoots the server's closed upper bound would 400 the render only at
    // the very end of the track, which is exactly where nobody tests by hand.
    for (
      let value = CLIENT_SUBJECT_SCALE_SLIDER_MIN;
      value <= CLIENT_SUBJECT_SCALE_DEFAULT;
      value += CLIENT_SUBJECT_SCALE_SLIDER_STEP
    ) {
      const emitted = clientRenderOptionsBody({
        steps: '', seed: '', keyBackground: false, detail: 'auto', alphaMode: '', normalMap: false, subjectScale: value,
      }).subjectScale;
      expect(isValidSubjectScale(emitted), `slider value ${value}`).toBe(true);
    }
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

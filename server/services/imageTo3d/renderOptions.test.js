import { describe, expect, it } from 'vitest';
import {
  RENDER_SEED_MAX,
  RENDER_STEPS_MAX,
  RENDER_STEPS_MIN,
  isValidRenderSeed,
  isValidRenderSteps,
  normalizeRenderOptions,
  randomRenderSeed,
  renderOptionArgs,
  validateRenderOptions,
  honorTargetRenderSupport,
  ALPHA_MODES,
  DEFAULT_DETAIL_TIER,
  DETAIL_TIERS,
  RENDER_OPTION_KEYS,
  DEFAULT_SUBJECT_SCALE,
  SUBJECT_SCALE_MAX,
  isValidSubjectScale,
} from './renderOptions.js';

describe('normalizeRenderOptions', () => {
  it('defaults to unset steps/seed with keying disabled', () => {
    expect(normalizeRenderOptions()).toEqual({ steps: null, seed: null, keyBackground: false, detail: 'auto', alphaMode: null, normalMap: false, subjectScale: 1 });
    expect(normalizeRenderOptions({})).toEqual({ steps: null, seed: null, keyBackground: false, detail: 'auto', alphaMode: null, normalMap: false, subjectScale: 1 });
  });

  it('keeps valid values and collapses invalid ones to the unset sentinel', () => {
    expect(normalizeRenderOptions({ steps: 24, seed: 0, keyBackground: false }))
      .toEqual({ steps: 24, seed: 0, keyBackground: false, detail: 'auto', alphaMode: null, normalMap: false, subjectScale: 1 });
    expect(normalizeRenderOptions({ steps: RENDER_STEPS_MAX + 1, seed: RENDER_SEED_MAX + 1 }))
      .toEqual({ steps: null, seed: null, keyBackground: false, detail: 'auto', alphaMode: null, normalMap: false, subjectScale: 1 });
    expect(normalizeRenderOptions({ steps: 12.5, seed: '42' }))
      .toEqual({ steps: null, seed: null, keyBackground: false, detail: 'auto', alphaMode: null, normalMap: false, subjectScale: 1 });
  });

  // Pinned on its own, not just as a field of a shape assertion, so flipping the
  // default back is a deliberate test edit rather than a line noise diff. Keying
  // writes an alpha channel, which makes TRELLIS.2's `preprocess_image` skip
  // RMBG-2.0 — so default-on silently replaces a learned matte with a flood fill
  // that cannot remove a cast shadow. See issue #4684.
  it('leaves background keying OFF unless a run explicitly asks for it', () => {
    expect(normalizeRenderOptions().keyBackground).toBe(false);
    expect(normalizeRenderOptions({ keyBackground: undefined }).keyBackground).toBe(false);
    expect(normalizeRenderOptions({ keyBackground: false }).keyBackground).toBe(false);
    // Truthy-but-not-true must not enable it either — the wire value is a boolean.
    expect(normalizeRenderOptions({ keyBackground: 'true' }).keyBackground).toBe(false);
    expect(normalizeRenderOptions({ keyBackground: true }).keyBackground).toBe(true);
  });
});

describe('renderOptionArgs', () => {
  it('emits --seed/--steps for provided values and nothing for unset ones', () => {
    expect(renderOptionArgs('x', { steps: 24, seed: 1234 }))
      .toEqual(['--seed', '1234', '--steps', '24']);
    expect(renderOptionArgs('x', { seed: 0 })).toEqual(['--seed', '0']);
    expect(renderOptionArgs('x', {})).toEqual([]);
    expect(renderOptionArgs('x')).toEqual([]);
  });

  it('throws with the caller label on out-of-range values', () => {
    expect(() => renderOptionArgs('buildGenerateArgs', { steps: 0 }))
      .toThrow(/buildGenerateArgs: steps must be an integer/);
    expect(() => renderOptionArgs('buildCudaGenerateArgs', { seed: -1 }))
      .toThrow(/buildCudaGenerateArgs: seed must be an integer/);
    expect(() => renderOptionArgs('x', { steps: RENDER_STEPS_MAX + 1 }))
      .toThrow(/steps must be an integer/);
    expect(() => renderOptionArgs('x', { seed: RENDER_SEED_MAX + 1 }))
      .toThrow(/seed must be an integer/);
  });
});

describe('randomRenderSeed', () => {
  it('stays in the valid int32 seed range', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(isValidRenderSeed(randomRenderSeed())).toBe(true);
    }
  });
});

describe('validators', () => {
  it('accept the bounds and reject just outside them', () => {
    expect(isValidRenderSteps(RENDER_STEPS_MIN)).toBe(true);
    expect(isValidRenderSteps(RENDER_STEPS_MAX)).toBe(true);
    expect(isValidRenderSteps(RENDER_STEPS_MIN - 1)).toBe(false);
    expect(isValidRenderSteps(RENDER_STEPS_MAX + 1)).toBe(false);
    expect(isValidRenderSeed(0)).toBe(true);
    expect(isValidRenderSeed(RENDER_SEED_MAX)).toBe(true);
    expect(isValidRenderSeed(-1)).toBe(false);
    expect(isValidRenderSeed(RENDER_SEED_MAX + 1)).toBe(false);
  });
});

describe('validateRenderOptions', () => {
  it('enforces the same bounds as renderOptionArgs without emitting flags', () => {
    expect(() => validateRenderOptions('x', { steps: 0 })).toThrow(/steps must be an integer/);
    expect(() => validateRenderOptions('x', { steps: 65 })).toThrow(/steps must be an integer/);
    expect(() => validateRenderOptions('x', { seed: -1 })).toThrow(/seed must be an integer/);
    expect(() => validateRenderOptions('x', { seed: 2147483648 })).toThrow(/seed must be an integer/);
    expect(validateRenderOptions('x', { steps: 12, seed: 7 })).toBeUndefined();
    expect(validateRenderOptions('x')).toBeUndefined();
  });

  it('names the caller in the error, so a lane-specific builder reads as the thrower', () => {
    expect(() => validateRenderOptions('buildPixal3dGenerateArgs', { steps: 999 }))
      .toThrow(/^buildPixal3dGenerateArgs:/);
  });
});

describe('detail tier and alpha mode', () => {
  it('defaults detail to the auto sentinel, not null', () => {
    // 'auto' is a choosable value ("derive from host"), so a run entry recording it
    // is the truth rather than an absence.
    expect(normalizeRenderOptions().detail).toBe(DEFAULT_DETAIL_TIER);
    expect(DETAIL_TIERS).toContain(DEFAULT_DETAIL_TIER);
  });

  it.each(DETAIL_TIERS)('keeps the valid tier %s', (tier) => {
    expect(normalizeRenderOptions({ detail: tier }).detail).toBe(tier);
  });

  it.each(['ultra', '1024_cascade', '', null, 7])('collapses invalid tier %s to auto', (bad) => {
    // Notably '1024_cascade' — a lane's concrete pipeline value is NOT a tier, and
    // letting it through would leak one lane's vocabulary into the shared API.
    expect(normalizeRenderOptions({ detail: bad }).detail).toBe(DEFAULT_DETAIL_TIER);
  });

  it.each(ALPHA_MODES)('keeps the valid alpha mode %s', (mode) => {
    expect(normalizeRenderOptions({ alphaMode: mode }).alphaMode).toBe(mode);
  });

  it('keeps alphaMode null when unset, which is distinct from OPAQUE', () => {
    // null = "don't instruct the exporter, and keep the force-opaque normalization".
    // OPAQUE = "the exporter should emit OPAQUE". Collapsing them would make the
    // normalization impossible to opt out of.
    expect(normalizeRenderOptions().alphaMode).toBeNull();
    expect(normalizeRenderOptions({ alphaMode: 'OPAQUE' }).alphaMode).toBe('OPAQUE');
  });
});

describe('normalMap', () => {
  it('defaults OFF, like every other quality knob that can lose a render', () => {
    // Opt-in for the same reason --fill-holes is: the bake runs before the GLB is
    // exported and builds a BVH beyond its dependency's tested sizes, so a segfault /
    // OOM / GPU-watchdog kill there destroys a multi-minute render. No Python guard
    // catches those. An earlier revision defaulted this ON on the strength of a
    // "cannot fail a render" claim that was false.
    expect(normalizeRenderOptions().normalMap).toBe(false);
  });

  it('requires an explicit true — the only way to opt in', () => {
    expect(normalizeRenderOptions({ normalMap: true }).normalMap).toBe(true);
    expect(normalizeRenderOptions({ normalMap: false }).normalMap).toBe(false);
  });

  it('treats a non-boolean as off rather than as opted-in', () => {
    // Fail safe: a garbage or truthy-string value must not enable a pass that can
    // take the render down with it.
    for (const bad of [undefined, null, 'true', 1, {}]) {
      expect(normalizeRenderOptions({ normalMap: bad }).normalMap).toBe(false);
    }
  });
});

describe('subjectScale', () => {
  it('defaults to the identity, so no existing render is reframed', () => {
    // The whole opt-in premise: reframing resamples the source, which costs detail.
    // A run that never asked for it must reach the decoder untouched.
    expect(normalizeRenderOptions().subjectScale).toBe(DEFAULT_SUBJECT_SCALE);
    expect(DEFAULT_SUBJECT_SCALE).toBe(SUBJECT_SCALE_MAX);
  });

  it.each([0.35, 0.5, 0.65, 0.999, 1])('keeps the in-range value %s', (value) => {
    expect(normalizeRenderOptions({ subjectScale: value }).subjectScale).toBe(value);
  });

  it.each([0, -0.5, 1.0001, 2, NaN, Infinity, '0.65', null, {}])(
    'collapses the out-of-range value %s to the identity',
    (bad) => {
      // Open at zero (0 scales the subject out of existence) and closed at one
      // (above 1 CROPS, which is the failure this knob exists to avoid).
      expect(normalizeRenderOptions({ subjectScale: bad }).subjectScale)
        .toBe(DEFAULT_SUBJECT_SCALE);
    },
  );

  it('validates the boundary itself', () => {
    expect(isValidSubjectScale(0)).toBe(false);
    expect(isValidSubjectScale(Number.MIN_VALUE)).toBe(true);
    expect(isValidSubjectScale(1)).toBe(true);
    expect(isValidSubjectScale(1.000001)).toBe(false);
  });
});

describe('RENDER_OPTION_KEYS', () => {
  it('matches exactly what normalizeRenderOptions returns', () => {
    expect(RENDER_OPTION_KEYS).toEqual(Object.keys(normalizeRenderOptions()));
  });
});

describe('honorTargetRenderSupport', () => {
  const opts = { steps: 24, seed: 7, keyBackground: true };

  it('passes everything through for a target that declares no limits', () => {
    // Absent support must mean "honors everything", so existing targets need no entry.
    expect(honorTargetRenderSupport(opts, undefined)).toBe(opts);
    expect(honorTargetRenderSupport(opts, null)).toBe(opts);
  });

  it('nulls only the unsupported knob, leaving the rest intact', () => {
    expect(honorTargetRenderSupport(opts, { steps: false }))
      .toEqual({ steps: null, seed: 7, keyBackground: true });
  });

  it('resets an unsupported knob to ITS OWN unset sentinel, not null', () => {
    // keyBackground's sentinel is `false`, so a target that cannot key must record
    // `false` — recording `null` would claim the subprocess got a value it never did.
    expect(honorTargetRenderSupport(opts, { keyBackground: false }))
      .toEqual({ steps: 24, seed: 7, keyBackground: false });
  });

  it('leaves a knob alone when support is explicitly true', () => {
    expect(honorTargetRenderSupport(opts, { steps: true })).toEqual(opts);
  });

  it('does not mutate its input', () => {
    honorTargetRenderSupport(opts, { steps: false });
    expect(opts.steps).toBe(24);
  });
});

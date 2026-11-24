import { describe, expect, it } from 'vitest';
import {
  TRELLIS2_ALPHA_MODES,
  TRELLIS2_DECIMATION_BASELINE,
  TRELLIS2_DECIMATION_HIGH,
  TRELLIS2_DECIMATION_MAX,
  TRELLIS2_DECIMATION_UPSTREAM_CLAMP,
  TRELLIS2_NORMAL_SOURCE_FACE_CAP,
  isValidDecimationTarget,
  selectTrellis2DecimationTarget,
  trellis2MeshQualityArgs,
} from './trellis2MeshQuality.js';

const HIGH_TIER_GB = 48;

describe('selectTrellis2DecimationTarget', () => {
  it('keeps a 24 GB host on the baseline tier', () => {
    expect(selectTrellis2DecimationTarget(24, HIGH_TIER_GB)).toBe(TRELLIS2_DECIMATION_BASELINE);
  });

  it('promotes a high-memory host to the exporter’s own default target', () => {
    expect(selectTrellis2DecimationTarget(64, HIGH_TIER_GB)).toBe(TRELLIS2_DECIMATION_HIGH);
    expect(selectTrellis2DecimationTarget(128, HIGH_TIER_GB)).toBe(TRELLIS2_DECIMATION_HIGH);
  });

  it('treats the threshold as inclusive, matching the pipeline/texture selectors', () => {
    expect(selectTrellis2DecimationTarget(HIGH_TIER_GB, HIGH_TIER_GB))
      .toBe(TRELLIS2_DECIMATION_HIGH);
    expect(selectTrellis2DecimationTarget(HIGH_TIER_GB - 1, HIGH_TIER_GB))
      .toBe(TRELLIS2_DECIMATION_BASELINE);
  });

  // The entire point of the module: every tier must beat upstream's clamp, or the
  // geometry the render paid for is still being thrown away.
  it('every tier exceeds upstream’s 200K clamp', () => {
    expect(TRELLIS2_DECIMATION_BASELINE).toBeGreaterThan(TRELLIS2_DECIMATION_UPSTREAM_CLAMP);
    expect(TRELLIS2_DECIMATION_HIGH).toBeGreaterThan(TRELLIS2_DECIMATION_BASELINE);
  });

  // Guards the claim in the module header: the targets stay inside the largest
  // face count with a published Apple-Silicon result behind it. A future bump
  // past that has to move the ceiling deliberately, with new evidence.
  it('no tier outruns the evidence ceiling', () => {
    expect(TRELLIS2_DECIMATION_HIGH).toBeLessThanOrEqual(TRELLIS2_DECIMATION_MAX);
  });
});

describe('isValidDecimationTarget', () => {
  it.each([1, 200000, 1000000, TRELLIS2_DECIMATION_MAX])('accepts %i', (v) => {
    expect(isValidDecimationTarget(v)).toBe(true);
  });

  it.each([0, -1, 1.5, TRELLIS2_DECIMATION_MAX + 1, null, undefined, '1000', NaN])(
    'rejects %s', (v) => {
      expect(isValidDecimationTarget(v)).toBe(false);
    },
  );
});

describe('trellis2MeshQualityArgs', () => {
  it('emits only the separator when nothing is overridden', () => {
    // Upstream-identical behaviour must stay reachable — an empty override set
    // cannot smuggle in a target the caller never asked for.
    expect(trellis2MeshQualityArgs()).toEqual(['--']);
    expect(trellis2MeshQualityArgs({})).toEqual(['--']);
  });

  it('always terminates with `--`, which is what separates it from upstream argv', () => {
    const args = trellis2MeshQualityArgs({ decimationTarget: 1000000, fillHoles: true });
    expect(args.at(-1)).toBe('--');
    expect(args.filter((a) => a === '--')).toHaveLength(1);
  });

  it('emits each knob only when set', () => {
    expect(trellis2MeshQualityArgs({ decimationTarget: 500000 }))
      .toEqual(['--decimation-target', '500000', '--']);
    expect(trellis2MeshQualityArgs({ fillHoles: true })).toEqual(['--fill-holes', '--']);
    expect(trellis2MeshQualityArgs({ remesh: true })).toEqual(['--remesh', '--']);
    expect(trellis2MeshQualityArgs({ alphaMode: 'auto' })).toEqual(['--alpha-mode', 'auto', '--']);
    expect(trellis2MeshQualityArgs({ meshClusterRefineIterations: 2 }))
      .toEqual(['--mesh-cluster-refine-iterations', '2', '--']);
    expect(trellis2MeshQualityArgs({ meshClusterSmoothStrength: 0.5 }))
      .toEqual(['--mesh-cluster-smooth-strength', '0.5', '--']);
  });

  it('treats false/null as unset rather than emitting a disabling flag', () => {
    // There is no `--no-fill-holes`; absence IS the off state. Emitting a flag
    // for `false` would make the subprocess reject the whole invocation.
    expect(trellis2MeshQualityArgs({ fillHoles: false, remesh: false, alphaMode: null }))
      .toEqual(['--']);
  });

  it('emits the normal-map flags only when asked', () => {
    expect(trellis2MeshQualityArgs({ normalMap: true })).toEqual(['--normal-map', '--']);
    expect(trellis2MeshQualityArgs({ normalMap: false })).toEqual(['--']);
    expect(trellis2MeshQualityArgs({ normalMap: true, normalMapMaxSourceFaces: 8000000 }))
      .toEqual(['--normal-map', '--normal-map-max-source-faces', '8000000', '--']);
  });

  it('keeps the normal source cap at or under the evidence ceiling', () => {
    // The bake builds a BVH over the pre-decimation mesh. The cap is what keeps that
    // inside sizes with a published Apple-Silicon result behind them.
    expect(TRELLIS2_NORMAL_SOURCE_FACE_CAP).toBeLessThanOrEqual(TRELLIS2_DECIMATION_MAX);
    // And well above the viewer mesh, or the bake would have no detail to recover.
    expect(TRELLIS2_NORMAL_SOURCE_FACE_CAP).toBeGreaterThan(TRELLIS2_DECIMATION_HIGH * 4);
  });

  it('throws rather than clamping an out-of-range decimation target', () => {
    // Clamping would make the run ledger record a target the subprocess never got.
    expect(() => trellis2MeshQualityArgs({ decimationTarget: 0 }))
      .toThrow(/decimationTarget must be an integer/);
    expect(() => trellis2MeshQualityArgs({ decimationTarget: TRELLIS2_DECIMATION_MAX + 1 }))
      .toThrow(/decimationTarget must be an integer/);
    expect(() => trellis2MeshQualityArgs({ decimationTarget: 1.5 }))
      .toThrow(/decimationTarget must be an integer/);
  });

  it('rejects an alpha mode the exporter does not implement', () => {
    expect(() => trellis2MeshQualityArgs({ alphaMode: 'TRANSPARENT' }))
      .toThrow(/alphaMode must be one of/);
    for (const mode of TRELLIS2_ALPHA_MODES) {
      expect(() => trellis2MeshQualityArgs({ alphaMode: mode })).not.toThrow();
    }
  });
});

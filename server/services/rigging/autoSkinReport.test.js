/**
 * The gate reducer is the part of this lane that decides whether a rig is publishable,
 * and it is the part no Blender-less host can exercise any other way. These cases are
 * fixture-driven measurements, not re-implementations of the arithmetic: each names a
 * distinct way a rig can be wrong and asserts the decision, not the computation.
 */

import { describe, expect, it } from 'vitest';
import {
  AUTO_SKIN_DEFAULTS,
  describeAutoSkinFailure,
  reduceAutoSkinGate,
  resolveAutoSkinThresholds,
  summarizeAutoSkin,
  thresholdsForWorker,
} from './autoSkinReport.js';

/** A clean 10,000-vertex rig: welded, fully weighted, round-tripped. */
const cleanReport = (overrides = {}) => ({
  report_version: 1,
  thresholds: thresholdsForWorker(AUTO_SKIN_DEFAULTS),
  vertices: { before_weld: 30_000, after_weld: 10_000, welded: 20_000 },
  removed_components: { count: 2, vertices: 9, fraction: 0.0009 },
  weighting: {
    after_heat: { weighted: 9_980, unweighted: 20, unweighted_fraction: 0.002 },
    nearest_bone_completed: 20,
    after_fill: { weighted: 10_000, unweighted: 0, unweighted_fraction: 0 },
  },
  armature: { name: 'PortOSHumanoid', bone_count: 17, bones: [] },
  round_trip: { mesh: true, armature: true, armature_modifier: true },
  ...overrides,
});

const withHeat = (unweighted, total = 10_000) => cleanReport({
  weighting: {
    after_heat: { weighted: total - unweighted, unweighted, unweighted_fraction: unweighted / total },
    nearest_bone_completed: unweighted,
    after_fill: { weighted: total, unweighted: 0, unweighted_fraction: 0 },
  },
});

describe('auto-skin publication gate', () => {
  it('publishes a rig that welded, weighted, filled and round-tripped', () => {
    expect(reduceAutoSkinGate(cleanReport())).toMatchObject({ ok: true, reason: null });
  });

  it('holds the ceiling in both directions', () => {
    // 0.5% of 10,000 is exactly 50 — at the ceiling passes, one vertex past it fails.
    expect(reduceAutoSkinGate(withHeat(50))).toMatchObject({ ok: true });
    expect(reduceAutoSkinGate(withHeat(51))).toMatchObject({ ok: false, reason: 'unweighted-over-ceiling' });
  });

  it('refuses an empty mesh instead of reading 0-of-0 as full coverage', () => {
    const empty = cleanReport({
      vertices: { before_weld: 12, after_weld: 0, welded: 12 },
      weighting: {
        after_heat: { weighted: 0, unweighted: 0, unweighted_fraction: 0 },
        nearest_bone_completed: 0,
        after_fill: { weighted: 0, unweighted: 0, unweighted_fraction: 0 },
      },
    });
    expect(reduceAutoSkinGate(empty)).toMatchObject({ ok: false, reason: 'empty-mesh' });
  });

  it('refuses when the nearest-bone pass still left vertices unweighted', () => {
    const leftover = cleanReport({
      weighting: {
        after_heat: { weighted: 9_980, unweighted: 20, unweighted_fraction: 0.002 },
        nearest_bone_completed: 17,
        after_fill: { weighted: 9_997, unweighted: 3, unweighted_fraction: 0.0003 },
      },
    });
    const result = reduceAutoSkinGate(leftover);
    expect(result).toMatchObject({ ok: false, reason: 'fill-incomplete' });
    // The assertion is absolute — a fraction well under the ceiling is still a failure.
    expect(result.metrics.unweightedFractionAfterFill).toBeLessThan(AUTO_SKIN_DEFAULTS.unweightedCeiling);
  });

  it('refuses a cleanup pass that removed more of the mesh than the guard allows', () => {
    const greedy = cleanReport({ removed_components: { count: 40, vertices: 300, fraction: 0.03 } });
    expect(reduceAutoSkinGate(greedy)).toMatchObject({ ok: false, reason: 'component-removal-over-ceiling' });
    // …and the guard is not simply "any removal": the clean fixture removes 9 vertices.
    expect(reduceAutoSkinGate(cleanReport())).toMatchObject({ ok: true });
  });

  it('refuses a worker that gated itself against different thresholds', () => {
    const relaxed = cleanReport({
      thresholds: { ...thresholdsForWorker(AUTO_SKIN_DEFAULTS), unweighted_ceiling: 0.2 },
    });
    expect(reduceAutoSkinGate(relaxed)).toMatchObject({ ok: false, reason: 'thresholds-mismatch' });
  });

  it('refuses a report it cannot read rather than treating absence as success', () => {
    expect(reduceAutoSkinGate(null)).toMatchObject({ ok: false, reason: 'report-malformed', metrics: null });
    expect(reduceAutoSkinGate(cleanReport({ vertices: { before_weld: 10 } })))
      .toMatchObject({ ok: false, reason: 'report-malformed' });
  });

  it('refuses an export that did not survive re-import, and a rig with no bones', () => {
    expect(reduceAutoSkinGate(cleanReport({ round_trip: { mesh: true, armature: true, armature_modifier: false } })))
      .toMatchObject({ ok: false, reason: 'round-trip-failed' });
    expect(reduceAutoSkinGate(cleanReport({ armature: { name: null, bone_count: 0, bones: [] } })))
      .toMatchObject({ ok: false, reason: 'no-armature' });
  });

  it('honors an advanced ceiling override on both sides of the new line', () => {
    const thresholds = resolveAutoSkinThresholds({ unweightedCeiling: 0.02 });
    const report = cleanReport({ thresholds: thresholdsForWorker(thresholds) });
    expect(reduceAutoSkinGate({
      ...report,
      weighting: { ...report.weighting, after_heat: { weighted: 9_850, unweighted: 150, unweighted_fraction: 0.015 } },
    }, thresholds)).toMatchObject({ ok: true });
    expect(reduceAutoSkinGate({
      ...report,
      weighting: { ...report.weighting, after_heat: { weighted: 9_700, unweighted: 300, unweighted_fraction: 0.03 } },
    }, thresholds)).toMatchObject({ ok: false, reason: 'unweighted-over-ceiling' });
  });
});

describe('auto-skin failure prose', () => {
  it('names the measured number and the threshold it missed', () => {
    const { reason, metrics } = reduceAutoSkinGate(withHeat(420));
    expect(describeAutoSkinFailure(reason, metrics))
      .toContain('automatic weighting left 4.2% of 10000 vertices unweighted, ceiling is 0.5%');
  });

  it('degrades to the headline rather than rendering an unknown code', () => {
    expect(describeAutoSkinFailure('brand-new-code', null)).toBe('Rigging failed for an unrecognized reason.');
  });
});

describe('auto-skin record summary', () => {
  it('carries the evidence the UI shows and nothing that belongs in the on-disk report', () => {
    const { metrics } = reduceAutoSkinGate(cleanReport());
    expect(summarizeAutoSkin(metrics)).toEqual({
      vertices: 10_000,
      welded: 20_000,
      bones: 17,
      unweightedFractionAfterHeat: 0.002,
      nearestBoneCompleted: 20,
      unweightedCeiling: AUTO_SKIN_DEFAULTS.unweightedCeiling,
    });
    expect(summarizeAutoSkin(null)).toBeNull();
  });
});

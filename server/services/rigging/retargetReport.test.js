/**
 * The retarget gate arithmetic, against fixtures.
 *
 * Every branch here is a refusal the product depends on, and none of them is observable
 * from an integration test on a host with no Blender: a partial skeleton, a cleanup that
 * exceeded its cap, a diagnostic run that wrote anyway, and — the three that separate a
 * retarget from a file — an export with no named clip, one with no duration, and one
 * that holds a single pose.
 *
 * The cap in particular is re-derived HERE from the vertex count, not read from the
 * report: that is the whole safety argument for a pass that edits skin weights, so the
 * tests pin that a worker echoing a roomier cap cannot widen it.
 */

import { describe, expect, it } from 'vitest';
import {
  describeRetargetFailure,
  headCleanupCap,
  reduceRetargetGate,
  resolveRetargetThresholds,
  RETARGET_DEFAULTS,
  RETARGET_FAILURE_REASONS,
  summarizeRetarget,
  thresholdsForRetargetWorker,
} from './retargetReport.js';

const cleanReport = (overrides = {}) => ({
  report_version: 1,
  kind: 'retarget',
  thresholds: thresholdsForRetargetWorker(RETARGET_DEFAULTS),
  skeleton: { hint: 'mixamo', mapped_bones: 17, unmapped_bones: [] },
  vertices: { total: 10_000 },
  head_cleanup: {
    mode: 'diagnostic',
    zone_bones: ['mixamorig:Neck', 'mixamorig:Head'],
    proposed_vertices: 40,
    changed_vertices: 0,
    cap_vertices: 200,
  },
  clip: { name: 'Walk', duration: 1.25 },
  motion: { sampled_frames: 8, max_joint_translation: 0.043 },
  armature: { name: 'PortOSHumanoid', bone_count: 17, bones: [] },
  round_trip: {
    mesh: true, armature: true, armature_modifier: true,
    animation_count: 1, clip_name: 'Walk', clip_duration: 1.25,
  },
  ...overrides,
});

const gate = (report, opts) => reduceRetargetGate(report, opts);

describe('retarget gate', () => {
  it('passes a clean diagnostic report and summarizes what it measured', () => {
    const result = gate(cleanReport());
    expect(result).toMatchObject({ ok: true, reason: null });
    expect(summarizeRetarget(result.metrics)).toMatchObject({
      clip: 'Walk', mode: 'diagnostic', mappedBones: 17,
      proposedCleanupVertices: 40, changedCleanupVertices: 0, cleanupCapVertices: 200,
      cleanupOverCap: false, sampledFrames: 8,
    });
  });

  it('refuses a report it cannot read rather than treating absent measurements as fine', () => {
    expect(gate({ ...cleanReport(), vertices: null })).toMatchObject({ ok: false, reason: 'report-malformed', metrics: null });
    expect(gate({ ...cleanReport(), motion: { sampled_frames: 8 } })).toMatchObject({ ok: false, reason: 'report-malformed' });
  });

  it('refuses a worker that used different thresholds or a different mode than requested', () => {
    const relaxed = cleanReport();
    relaxed.thresholds.head_cleanup_fraction = 0.5;
    expect(gate(relaxed)).toMatchObject({ ok: false, reason: 'thresholds-mismatch' });
    expect(gate(cleanReport(), { mode: 'write' })).toMatchObject({ ok: false, reason: 'mode-mismatch' });
  });

  it('refuses a partial or unrecognized skeleton before anything measured on the export matters', () => {
    const partial = cleanReport();
    partial.skeleton = { hint: 'mixamo', mapped_bones: 15, unmapped_bones: ['mixamorig:LeftHandThumb1', 'mixamorig:RightToeBase'] };
    // Every downstream signal in this report is clean — the refusal must still come from
    // the skeleton, because a partial mapping means a partial retarget was exported.
    const result = gate(partial);
    expect(result).toMatchObject({ ok: false, reason: 'skeleton-partial' });
    expect(describeRetargetFailure(result.reason, result.metrics))
      .toContain('mixamorig:LeftHandThumb1');

    const unknown = cleanReport();
    unknown.skeleton = { hint: 'unknown', mapped_bones: 0, unmapped_bones: [] };
    expect(gate(unknown)).toMatchObject({ ok: false, reason: 'skeleton-unrecognized' });
  });

  it('derives the cleanup cap from the vertex count, so a roomier reported cap cannot widen it', () => {
    // 2% of 10,000 vertices is 200 — whatever the worker claims its own cap was.
    expect(headCleanupCap(10_000, RETARGET_DEFAULTS.headCleanupFraction)).toBe(200);

    const overCap = cleanReport();
    overCap.head_cleanup = {
      ...overCap.head_cleanup, mode: 'write', proposed_vertices: 900, changed_vertices: 900, cap_vertices: 9_000,
    };
    const result = gate(overCap, { mode: 'write' });
    expect(result).toMatchObject({ ok: false, reason: 'head-cleanup-over-cap' });
    expect(result.metrics.cleanupCapVertices).toBe(200);
    expect(describeRetargetFailure(result.reason, result.metrics))
      .toContain('re-bind 900 of 10000 vertices, and the cap is 200');

    // A CORRECT worker refuses an over-cap proposal before touching a weight, so it
    // reports `changed: 0`. Gating only on `changed` would pass this run and lose the
    // sentence naming the numbers behind a generic worker-exit message.
    const refusedByWorker = cleanReport();
    refusedByWorker.head_cleanup = {
      ...refusedByWorker.head_cleanup, mode: 'write', proposed_vertices: 900, changed_vertices: 0,
    };
    expect(gate(refusedByWorker, { mode: 'write' }))
      .toMatchObject({ ok: false, reason: 'head-cleanup-over-cap' });

    // At the cap exactly, a write run is allowed — the cap is a ceiling, not a limit
    // that also forbids reaching it.
    const atCap = cleanReport();
    atCap.head_cleanup = { ...atCap.head_cleanup, mode: 'write', proposed_vertices: 200, changed_vertices: 200 };
    expect(gate(atCap, { mode: 'write' })).toMatchObject({ ok: true });
  });

  it('refuses a diagnostic run that changed any weights at all', () => {
    const wrote = cleanReport();
    wrote.head_cleanup = { ...wrote.head_cleanup, changed_vertices: 3 };
    // Well under the 200-vertex cap: the refusal is about the MODE, not the size.
    expect(gate(wrote)).toMatchObject({ ok: false, reason: 'diagnostic-mode-wrote' });
  });

  it('reports an over-cap proposal from a diagnostic run instead of failing it', () => {
    // Measuring the problem IS what diagnostic mode is for; a later write run is what
    // refuses. Failing here would leave the user with no way to see the number.
    const proposal = cleanReport();
    proposal.head_cleanup = { ...proposal.head_cleanup, proposed_vertices: 900 };
    const result = gate(proposal);
    expect(result.ok).toBe(true);
    expect(summarizeRetarget(result.metrics)).toMatchObject({
      proposedCleanupVertices: 900, cleanupCapVertices: 200, cleanupOverCap: true, changedCleanupVertices: 0,
    });
  });

  it('rejects a file-only export: no named clip, or one with no duration', () => {
    const unnamed = cleanReport();
    unnamed.round_trip = { ...unnamed.round_trip, animation_count: 0, clip_name: null, clip_duration: 0 };
    expect(gate(unnamed)).toMatchObject({ ok: false, reason: 'clip-unnamed' });

    const instant = cleanReport();
    instant.round_trip = { ...instant.round_trip, clip_duration: 0.004 };
    const result = gate(instant);
    expect(result).toMatchObject({ ok: false, reason: 'clip-zero-duration' });
    expect(describeRetargetFailure(result.reason, result.metrics)).toContain('lasts 0.004s');
  });

  it('rejects a re-import that lost the mesh, the armature, or the armature modifier', () => {
    for (const key of ['mesh', 'armature', 'armature_modifier']) {
      const broken = cleanReport();
      broken.round_trip = { ...broken.round_trip, [key]: false };
      expect(gate(broken)).toMatchObject({ ok: false, reason: 'round-trip-failed' });
    }
  });

  it('rejects an export that holds a single pose, and one sampled too thinly to tell', () => {
    const still = cleanReport();
    still.motion = { sampled_frames: 8, max_joint_translation: 1e-9 };
    const result = gate(still);
    expect(result).toMatchObject({ ok: false, reason: 'no-motion' });
    expect(describeRetargetFailure(result.reason, result.metrics)).toContain('8 sampled frames');

    // One frame cannot demonstrate movement no matter how large the number beside it.
    const unsampled = cleanReport();
    unsampled.motion = { sampled_frames: 1, max_joint_translation: 5 };
    expect(gate(unsampled)).toMatchObject({ ok: false, reason: 'no-motion' });
  });

  it('names every failure reason it can return, and falls back rather than rendering undefined', () => {
    for (const reason of Object.keys(RETARGET_FAILURE_REASONS)) {
      expect(describeRetargetFailure(reason, gate(cleanReport()).metrics)).toMatch(/\S/);
    }
    expect(describeRetargetFailure('constructor')).toBe('The retarget failed for an unrecognized reason.');
  });
});

describe('retarget thresholds', () => {
  it('uses the default for an absent override and the caller value for a present one', () => {
    expect(resolveRetargetThresholds()).toEqual(RETARGET_DEFAULTS);
    expect(resolveRetargetThresholds({ headCleanupFraction: 0.01 }))
      .toMatchObject({ headCleanupFraction: 0.01, minClipDuration: RETARGET_DEFAULTS.minClipDuration });
    // A zero cap is a real request (measure only, change nothing), so it must survive the
    // "absent means default" merge rather than being read as falsy.
    expect(resolveRetargetThresholds({ headCleanupFraction: 0 }).headCleanupFraction).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { buildClipCoverage } from './clipCapabilities.js';
import { buildHumanoidArmatureSpec, HUMANOID_JOINT_PARENTS, reduceBoneMapping, SKELETON_BONE_MAPPINGS } from './skeletonMapping.js';

describe('rigging skeleton compatibility', () => {
  const cc3Bones = Object.values(SKELETON_BONE_MAPPINGS.cc3);

  it('maps a recognized Mixamo source onto a complete CC3 target', () => {
    const sourceBones = Object.values(SKELETON_BONE_MAPPINGS.mixamo);
    const result = reduceBoneMapping({ sourceBones, targetBones: cc3Bones, skeletonHint: 'cc3' });
    expect(result).toMatchObject({ ok: true, skeletonHint: 'cc3', unmappedBones: [] });
    expect(result.mappings).toHaveLength(sourceBones.length);
    expect(result.mappings[0]).toMatchObject({ sourceBone: 'mixamorig:Hips', targetBone: 'CC_Base_Hip', joint: 'hips' });
  });

  it('refuses an unknown target convention and names every source bone', () => {
    expect(reduceBoneMapping({ sourceBones: ['Hips', 'MysteryJoint'], targetBones: cc3Bones, skeletonHint: 'unknown' }))
      .toEqual({ ok: false, reason: 'unrecognized-skeleton', mappings: [], unmappedBones: ['Hips', 'MysteryJoint'] });
  });

  it('refuses a partial match rather than retargeting only the compatible bones', () => {
    const result = reduceBoneMapping({ sourceBones: ['mixamorig:Hips', 'mixamorig:Head'], targetBones: ['CC_Base_Hip'], skeletonHint: 'cc3' });
    expect(result).toEqual({ ok: false, reason: 'partial-match', mappings: [], unmappedBones: ['mixamorig:Head'] });
  });
});

describe('clip capability report', () => {
  it('reports covered and missing states without treating a partial roster as complete', () => {
    const result = buildClipCoverage(['Idle', 'Wave', 'Dance']);
    expect(result.coverageByState.thinking).toEqual({ covered: true, clip: 'Idle' });
    expect(result.coverageByState.speaking).toEqual({ covered: true, clip: 'Wave' });
    expect(result.coverageByState.coding).toEqual({ covered: false, clip: null });
    expect(result).toMatchObject({ complete: false, missingStates: expect.arrayContaining(['coding']) });
  });
});

describe('humanoid armature spec', () => {
  // The worker builds its armature from this spec, so a bone whose parent is emitted
  // AFTER it (or a leaf whose head equals its tail) would be silently dropped by
  // Blender on a host nobody testing this has — the failure would only ever surface as
  // a short bone list in a rig report.
  it('names bones by the requested convention and emits every parent before its child', () => {
    const spec = buildHumanoidArmatureSpec({ skeletonHint: 'cc3' });
    expect(spec.skeletonHint).toBe('cc3');
    const seen = new Set();
    for (const bone of spec.bones) {
      expect(bone.name).toBe(SKELETON_BONE_MAPPINGS.cc3[bone.joint]);
      if (bone.parent) expect(seen.has(bone.parent)).toBe(true);
      expect(bone.head).not.toEqual(bone.tail);
      seen.add(bone.name);
    }
    expect(seen.size).toBe(Object.keys(HUMANOID_JOINT_PARENTS).length);
  });

  it('falls back to a known convention rather than emitting unnamed bones', () => {
    expect(buildHumanoidArmatureSpec({ skeletonHint: 'not-a-convention' }).skeletonHint).toBe('mixamo');
    expect(buildHumanoidArmatureSpec().bones.every((bone) => typeof bone.name === 'string' && bone.name)).toBe(true);
  });
});

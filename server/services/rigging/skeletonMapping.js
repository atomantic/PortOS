/** Canonical joints deliberately shared by the two declared avatar conventions. */
const JOINTS = ['hips', 'spine', 'chest', 'neck', 'head', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'];

export const SKELETON_BONE_MAPPINGS = {
  cc3: {
    hips: 'CC_Base_Hip', spine: 'CC_Base_Spine', chest: 'CC_Base_Spine02', neck: 'CC_Base_NeckTwist01', head: 'CC_Base_Head',
    leftUpperArm: 'CC_Base_L_Upperarm', leftLowerArm: 'CC_Base_L_Forearm', leftHand: 'CC_Base_L_Hand',
    rightUpperArm: 'CC_Base_R_Upperarm', rightLowerArm: 'CC_Base_R_Forearm', rightHand: 'CC_Base_R_Hand',
    leftUpperLeg: 'CC_Base_L_Thigh', leftLowerLeg: 'CC_Base_L_Calf', leftFoot: 'CC_Base_L_Foot',
    rightUpperLeg: 'CC_Base_R_Thigh', rightLowerLeg: 'CC_Base_R_Calf', rightFoot: 'CC_Base_R_Foot',
  },
  mixamo: {
    hips: 'mixamorig:Hips', spine: 'mixamorig:Spine', chest: 'mixamorig:Spine2', neck: 'mixamorig:Neck', head: 'mixamorig:Head',
    leftUpperArm: 'mixamorig:LeftArm', leftLowerArm: 'mixamorig:LeftForeArm', leftHand: 'mixamorig:LeftHand',
    rightUpperArm: 'mixamorig:RightArm', rightLowerArm: 'mixamorig:RightForeArm', rightHand: 'mixamorig:RightHand',
    leftUpperLeg: 'mixamorig:LeftUpLeg', leftLowerLeg: 'mixamorig:LeftLeg', leftFoot: 'mixamorig:LeftFoot',
    rightUpperLeg: 'mixamorig:RightUpLeg', rightLowerLeg: 'mixamorig:RightLeg', rightFoot: 'mixamorig:RightFoot',
  },
};

const normalizeBoneName = (name) => String(name || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
const semanticByNormalizedName = new Map([
  ...JOINTS.map((joint) => [normalizeBoneName(joint), joint]),
  ...Object.values(SKELETON_BONE_MAPPINGS).flatMap((mapping) => Object.entries(mapping)
    .map(([joint, bone]) => [normalizeBoneName(bone), joint])),
]);

export function knownSkeletonHint(hint) {
  return Object.hasOwn(SKELETON_BONE_MAPPINGS, hint) ? hint : 'unknown';
}

/**
 * Builds an all-or-nothing mapping. Every source bone must be understood and
 * represented by the declared target convention; otherwise callers get a
 * deterministic unmapped list and must refuse the retarget.
 */
export function reduceBoneMapping({ sourceBones, targetBones, skeletonHint } = {}) {
  const sources = [...new Set((Array.isArray(sourceBones) ? sourceBones : []).filter((bone) => typeof bone === 'string' && bone))];
  const targetHint = knownSkeletonHint(skeletonHint);
  const targetSet = new Set(Array.isArray(targetBones) ? targetBones : []);
  if (targetHint === 'unknown') return { ok: false, reason: 'unrecognized-skeleton', mappings: [], unmappedBones: sources };

  const mapping = SKELETON_BONE_MAPPINGS[targetHint];
  const mappings = [];
  const unmappedBones = [];
  for (const sourceBone of sources) {
    const joint = semanticByNormalizedName.get(normalizeBoneName(sourceBone));
    const targetBone = joint && mapping[joint];
    if (!targetBone || !targetSet.has(targetBone)) {
      unmappedBones.push(sourceBone);
      continue;
    }
    mappings.push({ sourceBone, targetBone, joint });
  }
  return unmappedBones.length
    ? { ok: false, reason: 'partial-match', mappings: [], unmappedBones }
    : { ok: true, skeletonHint: targetHint, mappings, unmappedBones: [] };
}

export const REQUIRED_RETARGET_JOINTS = JOINTS;

/**
 * Parent joint for every canonical joint (`null` = root). The armature the auto-skin
 * worker builds is derived from this, so the hierarchy lives with the bone names it
 * has to stay consistent with rather than being duplicated in the Python worker.
 */
export const HUMANOID_JOINT_PARENTS = Object.freeze({
  hips: null, spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck',
  leftUpperArm: 'chest', leftLowerArm: 'leftUpperArm', leftHand: 'leftLowerArm',
  rightUpperArm: 'chest', rightLowerArm: 'rightUpperArm', rightHand: 'rightLowerArm',
  leftUpperLeg: 'hips', leftLowerLeg: 'leftUpperLeg', leftFoot: 'leftLowerLeg',
  rightUpperLeg: 'hips', rightLowerLeg: 'rightUpperLeg', rightFoot: 'rightLowerLeg',
});

/**
 * Joint heads in UNIT space over the mesh's own bounding box: x across (0 = the
 * mesh's -X face, 1 = +X), y up, z depth. The worker maps these onto the measured
 * bounds, so one spec fits any character proportion without the Node side needing to
 * know the mesh. Numbers are the standard bipedal proportions (hips at ~53% of height,
 * shoulders at ~82%, arms spanning to ~20%/~80% of width).
 */
export const HUMANOID_JOINT_PLACEMENT = Object.freeze({
  hips: [0.50, 0.53, 0.50], spine: [0.50, 0.62, 0.50], chest: [0.50, 0.72, 0.50],
  neck: [0.50, 0.84, 0.50], head: [0.50, 0.90, 0.50],
  leftUpperArm: [0.62, 0.82, 0.50], leftLowerArm: [0.72, 0.82, 0.50], leftHand: [0.82, 0.82, 0.50],
  rightUpperArm: [0.38, 0.82, 0.50], rightLowerArm: [0.28, 0.82, 0.50], rightHand: [0.18, 0.82, 0.50],
  leftUpperLeg: [0.57, 0.52, 0.50], leftLowerLeg: [0.57, 0.28, 0.50], leftFoot: [0.57, 0.03, 0.50],
  rightUpperLeg: [0.43, 0.52, 0.50], rightLowerLeg: [0.43, 0.28, 0.50], rightFoot: [0.43, 0.03, 0.50],
});

// A leaf joint has no child to take its tail from, so it extends along a fixed unit
// direction. Without this a leaf bone would have zero length and Blender would drop it.
const LEAF_TAIL_OFFSET = Object.freeze({
  head: [0, 0.08, 0], leftHand: [0.06, 0, 0], rightHand: [-0.06, 0, 0],
  leftFoot: [0, 0, 0.08], rightFoot: [0, 0, 0.08],
});

/**
 * The armature the auto-skin worker builds, in unit-bbox space: bone names from the
 * requested convention, hierarchy from `HUMANOID_JOINT_PARENTS`, head/tail from
 * `HUMANOID_JOINT_PLACEMENT`. Pure — no mesh needed, so it is fixture-testable.
 *
 * A joint's tail is its FIRST child's head, which is what makes the chain continuous;
 * a leaf extends by its own offset. Bones are emitted parents-first so the worker can
 * create them in one pass.
 *
 * @param {{skeletonHint?: string}} [opts]
 * @returns {{skeletonHint: string, bones: Array<{joint: string, name: string, parent: string|null, head: number[], tail: number[]}>}}
 */
export function buildHumanoidArmatureSpec({ skeletonHint = 'mixamo' } = {}) {
  const hint = knownSkeletonHint(skeletonHint) === 'unknown' ? 'mixamo' : knownSkeletonHint(skeletonHint);
  const names = SKELETON_BONE_MAPPINGS[hint];
  const firstChild = new Map();
  for (const joint of JOINTS) {
    const parent = HUMANOID_JOINT_PARENTS[joint];
    if (parent && !firstChild.has(parent)) firstChild.set(parent, joint);
  }
  const bones = JOINTS.map((joint) => {
    const head = HUMANOID_JOINT_PLACEMENT[joint];
    const child = firstChild.get(joint);
    const offset = LEAF_TAIL_OFFSET[joint] || [0, 0.05, 0];
    const tail = child
      ? HUMANOID_JOINT_PLACEMENT[child]
      : head.map((value, axis) => value + offset[axis]);
    const parentJoint = HUMANOID_JOINT_PARENTS[joint];
    return { joint, name: names[joint], parent: parentJoint ? names[parentJoint] : null, head: [...head], tail: [...tail] };
  });
  return { skeletonHint: hint, bones };
}

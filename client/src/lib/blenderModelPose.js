/**
 * The 0-1 pose of a Blender model's controls: defaults, which controls a dependency holds back, and what to show.
 *
 * Pure. `controls` is a build report's `checks.motion.controls`; a pose is `{ [controlId]: 0-1 }`. The sweep's rule
 * (server/services/blenderModels/py/portos_model_poses.py) is the same one: only a control off its default needs its
 * dependencies to hold.
 */
const EPSILON = 1e-6;
const trim = (value, digits) => Number(value.toFixed(digits));

export const defaultPose = (controls) => Object.fromEntries(controls.map((control) => [control.id, control.default01]));

const unmetDependency = (control, values) => control.dependsOn.find(({ control: other, atLeast = 0, atMost = 1 }) => (
  values[other] !== undefined && (values[other] < atLeast - EPSILON || values[other] > atMost + EPSILON)));

/** Why a control cannot move now ("Needs Lid at most 0.02"), or null when it can. */
export function controlBlocked(control, values, controls) {
  const unmet = unmetDependency(control, values);
  if (!unmet) return null;
  const label = controls.find((entry) => entry.id === unmet.control)?.label ?? unmet.control;
  const range = [unmet.atLeast === undefined ? null : `at least ${unmet.atLeast}`, unmet.atMost === undefined ? null : `at most ${unmet.atMost}`].filter(Boolean).join(' and ');
  return `Needs ${label} ${range}`;
}

/** `values` with one control moved; a control whose dependency that breaks goes back to its default, and so on up the chain. */
export function movedPose(controls, values, id, value) {
  const next = { ...values, [id]: Math.min(1, Math.max(0, value)) };
  // Each pass settles at least one control, so this many passes settle every chain.
  for (let pass = 0; pass < controls.length; pass += 1) {
    const broken = controls.find((control) => Math.abs(next[control.id] - control.default01) > EPSILON && unmetDependency(control, next));
    if (!broken) break;
    next[broken.id] = broken.default01;
  }
  return next;
}

/** The joint position a 0-1 value stands for: "55°", "0.05 m". */
export function jointLabel(control, value) {
  const joint = control.min + (control.max - control.min) * value;
  return control.type === 'slide' ? `${trim(joint, 4)} m` : `${trim(joint, 1)}°`;
}

/** What GlbViewer seeks: each control's clip by name. */
export const poseClips = (controls, values) => Object.fromEntries(controls.map((control) => [`control:${control.id}`, values[control.id]]));

/**
 * Named execution postures shared by the agent spawners and their environment
 * builders. Keep this leaf free of provider/runtime imports so adding a
 * restricted profile cannot pull the full provider graph into schedule reads.
 */

export const PUBLIC_REVIEW_EXECUTION_PROFILE = 'public-review';

// The public-review pipeline has three deliberately different trust postures:
// the security scan is a server-side classifier, the eligibility gate is a
// tool-free reasoner, and the final review is a configured direct CLI inside a
// provider-specific maintained sandbox. Keep the profile names here so every
// spawn path agrees on which posture is enforced instead of comparing stage
// names or task types.
export const PUBLIC_REVIEW_GATE_EXECUTION_PROFILE = 'public-review-gate';
export const PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE = 'public-review-actions';

/**
 * The two enforceable postures behind those profiles. A posture is what a
 * VENDOR declares a maintained recipe for; a profile is what a STAGE declares
 * it needs. Keeping them separate is what lets a stage be configured onto any
 * enabled provider whose vendor row declares the posture, instead of the
 * pipeline naming specific vendors.
 *
 * - `no-tool`           — reasoning only. No filesystem writes, no command
 *                         execution, no network/MCP tools, no forge credentials.
 * - `sandboxed-actions` — may apply the already-screened patch and run local
 *                         tests inside the vendor's own maintained sandbox.
 *                         Still no forge credentials: the deterministic
 *                         coordinator owns every GitHub mutation.
 */
export const PUBLIC_REVIEW_NO_TOOL_POSTURE = 'no-tool';
export const PUBLIC_REVIEW_ACTIONS_POSTURE = 'sandboxed-actions';
export const PUBLIC_REVIEW_POSTURES = Object.freeze([
  PUBLIC_REVIEW_NO_TOOL_POSTURE,
  PUBLIC_REVIEW_ACTIONS_POSTURE,
]);

const PROFILE_POSTURES = Object.freeze({
  [PUBLIC_REVIEW_EXECUTION_PROFILE]: PUBLIC_REVIEW_NO_TOOL_POSTURE,
  [PUBLIC_REVIEW_GATE_EXECUTION_PROFILE]: PUBLIC_REVIEW_NO_TOOL_POSTURE,
  [PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE]: PUBLIC_REVIEW_ACTIONS_POSTURE,
});

export const PUBLIC_REVIEW_EXECUTION_PROFILES = Object.freeze(Object.keys(PROFILE_POSTURES));

/** The posture a stage's execution profile requires, or null for an ordinary task. */
export function publicReviewPostureForProfile(profile) {
  return PROFILE_POSTURES[profile] || null;
}

export function isPublicReviewNoToolProfile(profile) {
  return publicReviewPostureForProfile(profile) === PUBLIC_REVIEW_NO_TOOL_POSTURE;
}

export function isPublicReviewRestrictedProfile(profile) {
  return publicReviewPostureForProfile(profile) !== null;
}

/**
 * Named agent execution postures shared by lifecycle dispatch, CLI/TUI spawners, and child-environment filtering.
 *
 * A stage declares a PROFILE; `publicReviewPostureForProfile` maps it to the enforceable POSTURE a provider must carry a
 * maintained recipe for (`no-tool` or `sandboxed-actions`), which keeps pipeline stages vendor-agnostic.
 * `isPublicReviewRestrictedProfile` covers both postures; the NoTool/Actions predicates separate them for callers whose
 * rule differs by posture (credential-bootstrap wrapping, child-env allowlist). Keep this leaf free of provider/runtime
 * imports so a new restricted profile cannot pull the provider graph into schedule reads.
 */

import { PRIVATE_SECURITY_EXECUTION_PROFILE } from '../privateSecurityPolicy.js';

export const PUBLIC_REVIEW_EXECUTION_PROFILE = 'public-review';

// Three deliberately different trust postures: security scan (server-side classifier), eligibility gate (tool-free
// reasoner), final review (direct CLI in a provider-specific sandbox). Spawn paths compare these names, not stage names.
export const PUBLIC_REVIEW_GATE_EXECUTION_PROFILE = 'public-review-gate';
export const PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE = 'public-review-actions';

/**
 * A posture is what a VENDOR declares a maintained recipe for; a profile is what a STAGE declares it needs, so a stage
 * can run on any enabled provider whose vendor row declares the posture.
 * - `no-tool`: reasoning only; no writes, command execution, network/MCP tools or forge credentials.
 * - `sandboxed-actions`: may apply the screened patch and run local tests inside the vendor's sandbox; still no forge
 *   credentials (the coordinator owns every GitHub mutation).
 */
export const PUBLIC_REVIEW_NO_TOOL_POSTURE = 'no-tool';
export const PUBLIC_REVIEW_ACTIONS_POSTURE = 'sandboxed-actions';
export const PUBLIC_REVIEW_POSTURES = Object.freeze([
  PUBLIC_REVIEW_NO_TOOL_POSTURE,
  PUBLIC_REVIEW_ACTIONS_POSTURE,
]);

const PROFILE_POSTURES = Object.freeze({
  [PRIVATE_SECURITY_EXECUTION_PROFILE]: PUBLIC_REVIEW_NO_TOOL_POSTURE,
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

/** True only for the posture that may EXECUTE contributor-supplied code (see `applyCredentialBootstrap`). */
export function isPublicReviewActionsProfile(profile) {
  return publicReviewPostureForProfile(profile) === PUBLIC_REVIEW_ACTIONS_POSTURE;
}

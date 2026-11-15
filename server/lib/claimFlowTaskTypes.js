// The task kinds whose prompts own their own claim/<item> worktree and
// push/PR/MR/review lifecycle, declared ONCE for both sides of the contract:
//
//   - WRITE side (`services/cosTaskGenerator.js`) stamps `metadata.claimFlow`
//     on a queued task.
//   - READ side (`services/agentPromptBuilder.js` → `isClaimFlowTask`) decides
//     a run's claim posture (prompt shape, `configClaimFlow`,
//     `configCodingOnMain`).
//
// A type added to one copy and not the other used to split the writer from the
// reader silently — no error, just a claim run treated as a plain commit-only
// handoff (#6613). The list is also the backstop for schedules queued before
// the explicit `claimFlow` marker existed, which carry their kind only in
// `metadata.analysisType`.
//
// Pure leaf: shared by prompt selection, registration and resume authority.
export const CLAIM_FLOW_TASK_TYPES = new Set([
  'plan-task', 'claim-issue', 'claim-issue-gitlab', 'claim-issue-jira', 'claim-work'
]);

/** Trusted structured task identity only; descriptions and prompts confer no authority. */
export function hasClaimFlowContract(task) {
  const metadata = task?.metadata;
  return metadata?.claimFlow === true || metadata?.claimFlow === 'true'
    || CLAIM_FLOW_TASK_TYPES.has(metadata?.analysisType || metadata?.taskAnalysisType || task?.taskType);
}

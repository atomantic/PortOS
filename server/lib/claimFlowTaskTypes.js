// The task kinds whose prompts own their own claim/<item> worktree and
// push/PR/MR/review lifecycle, declared ONCE for both sides of the contract:
//
// `hasClaimFlowContract(task)` shares trusted claim identity across registration, completion and
// resume. `CLAIM_FLOW_TASK_TYPES` — the ONE list of task kinds whose prompts own their own
// `claim/<item>` worktree and push/PR/MR/review lifecycle (#6613). `services/cosTaskGenerator.js`
// stamps `metadata.claimFlow` from it (WRITE side); `services/agentPromptBuilder.js` reads it back
// through `isClaimFlowTask()` to pick a run's claim posture (READ side). It lived as two
// byte-identical copies, so a new claim type added to one silently split the writer from the reader —
// no error, just a claim run treated as a plain commit-only handoff; `claimFlowTaskTypes.test.js`
// fails if a local copy reappears. Imports nothing.
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

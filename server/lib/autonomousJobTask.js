/**
 * The projection that turns a generated autonomous-job task back into the
 * top-level fields `cos.addTask` maps onto `metadata`.
 *
 * `generateTaskFromJob` (`services/autonomousJobs/skillTemplates.js`) builds the
 * task the SCHEDULED fire emits straight onto `task:ready`, metadata and all.
 * Every other caller queues it through the non-raw `addTask` path instead, which
 * only reads top-level keys — so each of them has to flatten the same bag.
 *
 * That flattening is an allowlist, which is exactly why it lives here once: a
 * key added to the generator and missed by one caller silently vanishes from
 * that lane, and the task still queues, so nothing fails loudly. (`noChangeSuccess`
 * had to be added twice for this reason.) Callers layer their OWN posture on top
 * of the spread — `approvalRequired`, `context`, provider pins, quota-burn
 * provenance — because that is where they legitimately differ.
 *
 * Pure: `server/lib/` rather than beside the generator, because it needs none of
 * the generator's app / skill-template / data-input I/O and both callers'
 * suites double that module.
 */

/** @param {object} generated - a `generateTaskFromJob` result */
export function generatedJobTaskFields(generated) {
  const meta = generated?.metadata || {};
  return {
    description: generated?.description,
    priority: generated?.priority,
    prompt: meta.prompt,
    // App-scoped jobs carry the target app so `prepareAgentWorkspace` resolves
    // the agent's workspace to the app's repoPath instead of the PortOS root.
    app: meta.app,
    useWorktree: meta.useWorktree,
    openPR: meta.openPR,
    simplify: meta.simplify,
    // A marked audit may complete successfully with a verified empty branch.
    noChangeSuccess: meta.noChangeSuccess,
    // The report-shaped posture: the deliverable is an action performed DURING
    // the run, or a scratch checkout nothing may land from. `FILE_ISSUES_DELIVERY_SETTINGS`
    // stamps `noCodeOutput` on every issues-only job, and a job converted from a
    // legacy quota-burn step carries both (#6381) — missing here, the burn lane
    // queued them as ordinary code work and told the agent to push.
    noCodeOutput: meta.noCodeOutput,
    discardWorktree: meta.discardWorktree,
    worktreeChangesExpected: meta.worktreeChangesExpected,
    // Read by the `job:spawned` listener, which records the execution and
    // re-registers the saved schedule.
    autonomousJob: meta.autonomousJob,
    jobId: meta.jobId,
    // Per-job AI overrides: `addTask` maps these onto `metadata.provider` /
    // `.model` / `.effort`, which the spawner resolves against.
    provider: meta.provider,
    model: meta.model,
    effort: meta.effort,
  };
}

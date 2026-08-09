/**
 * Launchable slashdo workflows — the single catalog of which bundled
 * `lib/slashdo/commands/do/*.md` workflows PortOS offers as a one-click agent run
 * (#3114).
 *
 * Before this module there were two catalogs that had already drifted:
 * `SLASHDO_COMMANDS` in `server/routes/cosTaskRoutes.js` (feeding the app
 * overview's Agent Operations buttons) and `BUILT_IN_TEMPLATES` in
 * `server/services/taskTemplates.js` (feeding the CoS quick templates).
 * `push` / `better-swift` existed only in the first; `plan-task` / `depfree` /
 * `scan` / `replan` only in the second — so a workflow added to one surface was
 * silently missing from the other.
 *
 * Add a workflow HERE and it appears in every surface: the Agent Operations
 * buttons, the CoS quick templates, and the `POST /api/cos/tasks/slashdo`
 * allowlist. `command` is the BARE slashdo command name — never a rendered
 * `/do:x` string, because the invocation shape is only knowable once a provider
 * is picked (see `slashdoInvocation.js`).
 *
 * Companion to `slashdoInvocation.js`: that module answers "how do I phrase this
 * workflow for this host", this one answers "which workflows can be launched".
 */

/*
 * The run-shape defaults a catalog entry implies. All ten workflows set
 * `useWorktree`/`openPR`/`simplify` to false, for two distinct reasons:
 *   - plan-task / replan / review / scan write no code at all, so there is
 *     nothing to isolate, PR, or simplify.
 *   - next / better / better-swift / depfree / release / push MANAGE THEIR OWN
 *     worktrees and PRs — a PortOS-level worktree would nest one inside another,
 *     and `release` must run from `main` in the primary checkout.
 * A key absent from `settings` means "leave the current toggle alone" (the
 * absent-vs-empty rule) — it does NOT mean false.
 *
 * The two postures below differ ONLY in `worktreeChangesExpected`, which declares
 * the workflow's DELIVERABLE (#3636). The TUI idle reaper fails a run as
 * `idle-no-changes` when the worktree is clean and no commit landed during the
 * run (`worktreeHasWorkEvidence`), so a workflow whose output never touches the
 * repo has to opt out — the reaper cannot see a filed issue or a printed report.
 */

/**
 * Commit-shaped workflows: `next` / `better` / `better-swift` / `depfree` /
 * `release` / `push` land a commit (usually behind their own PR), so the
 * reaper's evidence probe covers them and the clean-tree gate stays armed.
 */
export const WORKFLOW_OWNS_ITS_OWN_GIT = Object.freeze({
  useWorktree: false, openPR: false, simplify: false, worktreeChangesExpected: true,
});

/**
 * Report-shaped workflows: `plan-task` / `replan` / `review` / `scan` deliver a
 * filed issue or a printed report and write no code at all. A clean tree IS
 * their success shape, so they opt out of the clean-tree gate the way
 * `reference-watch` against a non-file work tracker already does (#3102).
 */
export const WORKFLOW_REPORTS_NO_CODE = Object.freeze({
  useWorktree: false, openPR: false, simplify: false, worktreeChangesExpected: false,
});

/** App-type gates for the Agent Operations buttons. */
export const SLASHDO_APP_TYPES = Object.freeze({
  ANY: 'any',
  SWIFT: 'swift',
  NON_SWIFT: 'non-swift',
});

/**
 * @typedef {Object} SlashdoWorkflow
 * @property {string} command - bare slashdo command name (`plan-task`)
 * @property {string} label - short human name for a button/heading
 * @property {string} description - one line, shown as button tooltip + task text
 * @property {string} detail - what the workflow actually does, phrased to follow
 *   "Runs the slashdo <cmd> workflow: …" in a queued task's context
 * @property {string} icon - emoji for the quick-template chip
 * @property {string} templateName - quick-template display name
 * @property {string} [templatePrompt] - trailing fragment appended to the
 *   template's description when the workflow needs a user-typed target
 *   (`Safety scan of: `). Absent ⇒ the description stands alone.
 * @property {Object} settings - implied run-shape toggles; exactly one of
 *   WORKFLOW_OWNS_ITS_OWN_GIT (commit-shaped) or WORKFLOW_REPORTS_NO_CODE
 *   (report-shaped), per the workflow's deliverable
 * @property {string} appTypes - one of SLASHDO_APP_TYPES; gates the button only
 * @property {boolean} [configurable] - the button opens the run-settings drawer
 *   instead of queuing immediately
 */

/** @type {ReadonlyArray<SlashdoWorkflow>} */
export const SLASHDO_WORKFLOWS = Object.freeze([
  {
    command: 'plan-task',
    detail: 'investigate the codebase, then file a ready-to-work issue',
    label: 'Plan Task',
    description: 'Investigate the codebase and file a decision-complete issue',
    icon: '📋',
    templateName: 'Plan a Task',
    templatePrompt: 'Investigate and file a decision-complete issue for: ',
    settings: WORKFLOW_REPORTS_NO_CODE,
    appTypes: SLASHDO_APP_TYPES.ANY,
  },
  {
    command: 'next',
    detail: 'claim an unclaimed item, do the work in its own worktree, ship a PR',
    label: 'Next',
    description: "Claim the next unclaimed work item (per the app's Work Tracker) and ship a PR",
    icon: '🎯',
    templateName: 'Ship Next Issue',
    settings: WORKFLOW_OWNS_ITS_OWN_GIT,
    appTypes: SLASHDO_APP_TYPES.ANY,
    // Routes the button to the pre-flight run-settings drawer (which work item
    // to claim, provider pin, reviewers) instead of queuing straight away.
    configurable: true,
  },
  {
    command: 'replan',
    detail: 'prune completed items, suggest new work, keep the plan lean',
    label: 'Replan',
    description: 'Audit the backlog, archive completed items, prune stale work',
    icon: '🗺️',
    templateName: 'Replan Backlog',
    settings: WORKFLOW_REPORTS_NO_CODE,
    appTypes: SLASHDO_APP_TYPES.ANY,
  },
  {
    command: 'review',
    detail: 'review the changed files against software engineering best practices',
    label: 'Review',
    description: 'Deep code review of the changed files',
    icon: '🔍',
    templateName: 'Review Changes',
    settings: WORKFLOW_REPORTS_NO_CODE,
    appTypes: SLASHDO_APP_TYPES.ANY,
  },
  {
    command: 'push',
    detail: 'stage the files you changed, write a conventional commit and changelog entry, push safely',
    label: 'Push',
    description: 'Commit and push all work with a changelog entry',
    icon: '📤',
    templateName: 'Commit and Push',
    settings: WORKFLOW_OWNS_ITS_OWN_GIT,
    appTypes: SLASHDO_APP_TYPES.ANY,
  },
  {
    command: 'release',
    detail: 'follow the project\'s documented release process to open a release PR',
    label: 'Release',
    description: 'Create a release PR',
    icon: '🚀',
    templateName: 'Cut a Release',
    settings: WORKFLOW_OWNS_ITS_OWN_GIT,
    appTypes: SLASHDO_APP_TYPES.ANY,
  },
  {
    command: 'better',
    detail: 'audit, remediate, enhance tests, open per-category PRs',
    label: 'Better',
    description: 'Run a DevSecOps audit and remediation pass',
    icon: '🛡️',
    templateName: 'DevSecOps Audit',
    settings: WORKFLOW_OWNS_ITS_OWN_GIT,
    appTypes: SLASHDO_APP_TYPES.NON_SWIFT,
  },
  {
    command: 'better-swift',
    detail: 'audit and remediate a multi-platform Swift/SwiftUI app, enhance tests, open per-category PRs',
    label: 'Better Swift',
    description: 'Run a SwiftUI DevSecOps audit and remediation pass',
    icon: '🛡️',
    templateName: 'SwiftUI DevSecOps Audit',
    settings: WORKFLOW_OWNS_ITS_OWN_GIT,
    appTypes: SLASHDO_APP_TYPES.SWIFT,
  },
  {
    command: 'depfree',
    detail: 'audit third-party deps and replace the removable ones with code',
    label: 'Depfree',
    description: 'Audit dependencies and remove the unnecessary ones',
    icon: '📦',
    templateName: 'Prune Dependencies',
    settings: WORKFLOW_OWNS_ITS_OWN_GIT,
    appTypes: SLASHDO_APP_TYPES.ANY,
  },
  {
    command: 'scan',
    detail: 'flag malware patterns, network calls, and vulnerable deps without executing anything',
    label: 'Scan',
    description: 'Read-only safety audit — malware patterns, network calls, vulnerable deps',
    icon: '🔒',
    templateName: 'Safety Scan',
    templatePrompt: 'Read-only safety audit of: ',
    settings: WORKFLOW_REPORTS_NO_CODE,
    appTypes: SLASHDO_APP_TYPES.ANY,
  },
]);

/** Bare command name → catalog entry. */
const BY_COMMAND = new Map(SLASHDO_WORKFLOWS.map(w => [w.command, w]));

/**
 * The catalog entry for a bare command name, or null when the command isn't a
 * launchable workflow. Callers use this as the allowlist gate — a command that
 * resolves to null must not be queued. A `Map` lookup (not a plain object) so
 * prototype keys like `constructor` can't resolve.
 * @param {unknown} command
 * @returns {SlashdoWorkflow|null}
 */
export function getSlashdoWorkflow(command) {
  return BY_COMMAND.get(command) || null;
}

/**
 * True when `workflow` applies to an app of this stack. `better` and
 * `better-swift` are the same audit for different stacks, so exactly one of the
 * two applies per app — every other workflow applies to both.
 * @param {SlashdoWorkflow} workflow
 * @param {boolean} isSwiftApp
 * @returns {boolean}
 */
export function slashdoWorkflowAppliesTo(workflow, isSwiftApp) {
  if (workflow?.appTypes === SLASHDO_APP_TYPES.ANY) return true;
  return workflow?.appTypes === (isSwiftApp ? SLASHDO_APP_TYPES.SWIFT : SLASHDO_APP_TYPES.NON_SWIFT);
}

/**
 * The workflows launchable for one app. Mirrored in
 * `client/src/lib/slashdoCatalog.js`, which drives the Agent Operations buttons;
 * the route uses `slashdoWorkflowAppliesTo` to reject a mismatched command rather
 * than trusting the client to only offer applicable ones.
 * @param {boolean} isSwiftApp
 * @returns {SlashdoWorkflow[]}
 */
export function slashdoWorkflowsForApp(isSwiftApp) {
  return SLASHDO_WORKFLOWS.filter(w => slashdoWorkflowAppliesTo(w, isSwiftApp));
}

/** Every launchable command name, in catalog order. */
export const SLASHDO_COMMAND_NAMES = Object.freeze(SLASHDO_WORKFLOWS.map(w => w.command));

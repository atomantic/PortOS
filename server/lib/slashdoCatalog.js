/**
 * Bundled slashdo workflow catalog (#3108).
 *
 * The single declaration of "which bundled slashdo command can a CoS agent run,
 * how is it labelled, and what run-shape does it imply". Before this module the
 * same question had three independent answers that had already diverged:
 *
 *   - `SLASHDO_COMMANDS` in `server/routes/cosTaskRoutes.js` (route allowlist)
 *   - `SLASHDO_COMMANDS` in `client/src/components/apps/SlashDoPanel.jsx` (buttons)
 *   - `BUILT_IN_TEMPLATES` in `server/services/taskTemplates.js` (quick templates)
 *
 * `push`/`better-swift` existed only in the first two, `plan-task`/`depfree`/`scan`
 * only in the third, and the shared commands carried different descriptions and
 * run shapes depending on which surface queued them. All three now read from here;
 * the client fetches it over `GET /api/cos/slashdo-commands` rather than mirroring
 * a fourth copy.
 *
 * Presentation that is genuinely per-surface stays with that surface: the panel's
 * per-command Tailwind `classes` are colors, not catalog data.
 *
 * `command` is always the BARE name — never a rendered `/do:x` string, which is
 * Claude-only. `server/lib/slashdoInvocation.js` renders the concrete invocation
 * once the provider is known at spawn time.
 */
import { SLASHDO_NAMESPACE } from './slashdoInvocation.js';

/**
 * Run-shape every bundled workflow implies: PortOS wraps none of them in its own
 * worktree/PR/review machinery, for three distinct reasons.
 *   - `plan-task` / `replan` / `review` / `scan` write no code at all, so there is
 *     nothing to isolate, PR, or simplify.
 *   - `next` / `better` / `depfree` / `pr`-shaped flows MANAGE THEIR OWN worktrees
 *     and PRs — a PortOS-level worktree would nest one inside another, and
 *     `release` must run from `main` in the primary checkout.
 *   - `reviewLoop` stays off because each `/do:*` body owns its own review/PR
 *     sequence; a CoS-managed loop on top would double-review.
 * A key ABSENT from `settings` means "leave the current toggle alone" (the
 * absent-vs-empty rule) — it does NOT mean false, which is why every key is
 * spelled out here rather than relying on defaults.
 */
const WORKFLOW_OWNS_ITS_OWN_GIT = Object.freeze({
  useWorktree: false,
  openPR: false,
  simplify: false,
  reviewLoop: false,
});

/**
 * One entry per launchable bundled workflow, in the order surfaces should show them.
 *
 * - `command` — bare slashdo command name (`lib/slashdo/commands/do/<command>.md`).
 *   `label` is NOT stored: it is always `/do:<command>`, so it is derived by
 *   `slashdoLabel` rather than typed ten times and kept in sync by hand.
 * - `name` / `icon` — short human label + emoji for a template or menu row.
 * - `description` — one line, user-facing. The ONE description for this command
 *   across every surface.
 * - `context` — extra prose the quick-template seeds into the task context.
 * - `argsPlaceholder` — set when the workflow needs a subject; surfaces append it
 *   to the description so the user finishes the sentence.
 * - `settings` — the implied run shape (see WORKFLOW_OWNS_ITS_OWN_GIT).
 * - `swiftOnly` / `hideForSwift` — Swift/Xcode app gating for the app-overview buttons.
 * - `templateEligible` — whether this command ships as a CoS quick template.
 * - `configurable` — clicking it opens the pre-flight run-settings drawer instead
 *   of queuing immediately.
 * - `claimsWork` — this workflow drains a work tracker, so the route builds a
 *   workTracker-aware claim prompt for it instead of pinning the bare command, and
 *   the run drawer offers a work-item picker.
 */
export const SLASHDO_CATALOG = Object.freeze([
  {
    command: 'plan-task',
    name: 'Plan a Task',
    icon: '📋',
    description: 'Investigate the codebase and file a decision-complete issue',
    context: 'Runs the slashdo plan-task workflow: investigate the codebase, then file a ready-to-work issue.',
    argsPlaceholder: 'Investigate and file a decision-complete issue for: ',
    settings: WORKFLOW_OWNS_ITS_OWN_GIT,
    templateEligible: true,
  },
  {
    command: 'next',
    name: 'Ship Next Issue',
    icon: '🎯',
    description: "Claim a work item (per this app's Work Tracker) and ship a PR",
    context: 'Runs the slashdo next workflow: claim an unclaimed item, do the work in its own worktree, ship a PR.',
    settings: WORKFLOW_OWNS_ITS_OWN_GIT,
    templateEligible: true,
    configurable: true,
    claimsWork: true,
  },
  {
    command: 'replan',
    name: 'Replan Backlog',
    icon: '🗺️',
    description: 'Audit the backlog — prune shipped items, surface new work',
    context: 'Runs the slashdo replan workflow: prune completed items, suggest new work, keep the plan lean.',
    settings: WORKFLOW_OWNS_ITS_OWN_GIT,
    templateEligible: true,
  },
  {
    command: 'review',
    name: 'Review Changes',
    icon: '🔍',
    description: 'Deep code review of the changed files',
    context: 'Runs the slashdo review workflow: review changed files against software engineering best practices.',
    settings: WORKFLOW_OWNS_ITS_OWN_GIT,
    templateEligible: true,
  },
  {
    command: 'push',
    name: 'Push Work',
    icon: '⬆️',
    description: 'Commit and push all work with a changelog entry',
    context: 'Runs the slashdo push workflow: commit staged work with a changelog entry and push safely.',
    settings: WORKFLOW_OWNS_ITS_OWN_GIT,
    templateEligible: false,
  },
  {
    command: 'release',
    name: 'Cut a Release',
    icon: '🚀',
    description: 'Create a release PR',
    context: "Runs the slashdo release workflow using the project's documented release process.",
    settings: WORKFLOW_OWNS_ITS_OWN_GIT,
    templateEligible: true,
  },
  {
    command: 'better',
    name: 'DevSecOps Audit',
    icon: '🛡️',
    description: 'Run a DevSecOps audit and remediation pass',
    context: 'Runs the slashdo better workflow: audit, remediate, enhance tests, open per-category PRs.',
    settings: WORKFLOW_OWNS_ITS_OWN_GIT,
    hideForSwift: true,
    templateEligible: true,
  },
  {
    command: 'better-swift',
    name: 'SwiftUI DevSecOps Audit',
    icon: '🛡️',
    description: 'Run a SwiftUI DevSecOps audit and remediation pass',
    context: 'Runs the slashdo better-swift workflow: audit and remediate a multi-platform Swift/SwiftUI app.',
    settings: WORKFLOW_OWNS_ITS_OWN_GIT,
    swiftOnly: true,
    templateEligible: false,
  },
  {
    command: 'depfree',
    name: 'Prune Dependencies',
    icon: '📦',
    description: 'Audit dependencies and remove the unnecessary ones',
    context: 'Runs the slashdo depfree workflow: audit third-party deps and replace the removable ones with code.',
    settings: WORKFLOW_OWNS_ITS_OWN_GIT,
    templateEligible: true,
  },
  {
    command: 'scan',
    name: 'Safety Scan',
    icon: '🔒',
    description: 'Read-only safety audit — malware patterns, network calls, vulnerable deps',
    context: 'Runs the slashdo scan workflow: flag malware patterns, network calls, and vulnerable deps.',
    argsPlaceholder: 'Read-only safety audit of: ',
    settings: WORKFLOW_OWNS_ITS_OWN_GIT,
    templateEligible: true,
  },
]);

const BY_COMMAND = new Map(SLASHDO_CATALOG.map(entry => [entry.command, entry]));

/**
 * The catalog entry for a bare command name, or null when the command is not a
 * launchable bundled workflow. This IS the route allowlist — a `null` return is
 * what `POST /api/cos/tasks/slashdo` rejects on.
 * @param {unknown} command
 * @returns {Readonly<Object>|null}
 */
export function getSlashdoEntry(command) {
  return (typeof command === 'string' && BY_COMMAND.get(command)) || null;
}

/**
 * True when `command` names a launchable bundled workflow — the allowlist behind
 * `slashdoTaskSchema`'s `command` field, so an out-of-catalog command is rejected
 * by validation rather than by a hand-rolled check in the route.
 * @param {unknown} command
 * @returns {boolean}
 */
export function isLaunchableSlashdoCommand(command) {
  return getSlashdoEntry(command) !== null;
}

/**
 * Every launchable bare command name, in catalog order — the list a rejection
 * message enumerates.
 * @returns {string[]}
 */
export function slashdoCommandNames() {
  return SLASHDO_CATALOG.map(entry => entry.command);
}

/**
 * The entries that ship as CoS quick templates (`templateEligible`).
 * @returns {Readonly<Object>[]}
 */
export function templateEligibleEntries() {
  return SLASHDO_CATALOG.filter(entry => entry.templateEligible);
}

/**
 * The typed slash-command form users recognise on a button (`/do:next`). Derived
 * rather than stored — `slashdoInvocation.js` owns the per-host invocation shapes,
 * and this is only the Claude-Code label the UI prints.
 * @param {string} command - bare command name
 * @returns {string}
 */
export function slashdoLabel(command) {
  return `/${SLASHDO_NAMESPACE}:${command}`;
}

/**
 * The catalog projected to just what the client's Agent Operations buttons read,
 * served by `GET /api/cos/slashdo-commands`. Built once: the catalog is a frozen
 * constant, so the payload never varies per request. Deliberately narrow — the
 * server-only fields (`settings`, `context`, `templateEligible`, …) stay off the
 * wire so they don't become a shape the client can start depending on.
 */
export const SLASHDO_CLIENT_CATALOG = Object.freeze(
  SLASHDO_CATALOG.map(({ command, description, configurable, claimsWork, swiftOnly, hideForSwift }) => Object.freeze({
    command,
    label: slashdoLabel(command),
    description,
    ...(configurable ? { configurable } : {}),
    ...(claimsWork ? { claimsWork } : {}),
    ...(swiftOnly ? { swiftOnly } : {}),
    ...(hideForSwift ? { hideForSwift } : {}),
  }))
);

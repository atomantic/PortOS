/**
 * Branch & PR Reconciler — scheduler + coordinator dispatch (Tier 2).
 *
 * Registers a daily cron (via eventScheduler, the backupScheduler.js pattern)
 * that runs the deterministic Tier-1 `reconcile()` and, when in-flight branches
 * remain, enqueues ONE coordinator CoS task. The coordinator agent orchestrates
 * one sub-agent per in-flight branch (each in that branch's existing worktree)
 * to open PRs, resolve conflicts, drive review loops, and merge when fully green.
 *
 * The whole feature is opt-in: the cron handler no-ops unless
 * `settings.branchReconcile.enabled` is true. The API "Run now" path passes
 * `{ force: true }` — an explicit user action is its own consent, so it runs even
 * while the schedule is off (letting the user test on demand).
 */

import { schedule, cancel } from './eventScheduler.js';
import { getSettings } from './settings.js';
import { getUserTimezone } from '../lib/timezone.js';
import { PATHS } from '../lib/fileUtils.js';
import { PRIORITY_VALUES, addTask } from './cosTaskStore.js';
import { reconcile } from './branchReconcile.js';
import { getDomainMode } from '../lib/domainAutonomy.js';
import { getActiveAgentIds } from './agentState.js';

const CRON_ID = 'branch-reconcile';

// Stable first-line description → addTask dedups it against any pending/in_progress
// coordinator, so a later daily run can't stack a second coordinator on top of one
// still finishing (the re-entrancy guard, for free).
const COORDINATOR_DESCRIPTION = 'Branch & PR reconcile: finish this machine\'s in-flight local branches';

// Last run summary, surfaced by GET /api/branch-reconcile/status.
let lastRun = null;
export function getLastRun() { return lastRun; }

/** An action is ON unless the settings explicitly set it to false (opt-out). */
const actionOn = (actions, key) => actions?.[key] !== false;

/**
 * Which in-flight branches have an enabled action? Pure — drives both the
 * dispatch gate and the prompt payload.
 * @param {object[]} inFlight - reconcile()'s inFlight entries (with `state`)
 * @param {object} actions - settings.branchReconcile.actions
 */
export function filterActionable(inFlight, actions) {
  return inFlight.filter((b) => {
    if (b.state === 'NEEDS_PR') return actionOn(actions, 'openPr');
    if (b.state === 'CONFLICTED') return actionOn(actions, 'resolveConflicts');
    if (b.state === 'IN_REVIEW') return actionOn(actions, 'resolveConflicts') || actionOn(actions, 'autoMerge');
    return false;
  });
}

/** Per-state one-line instruction to the coordinator/sub-agent. */
function desiredEndState(state, actions) {
  if (state === 'NEEDS_PR') {
    return 'Verify the branch\'s work is complete and ready (tests pass, no stubs/TODO markers, changelog present). If ready, run `/do:pr`. If NOT ready, report it as incomplete and leave the branch untouched — do not open a half-baked PR.';
  }
  if (state === 'CONFLICTED') {
    return 'Rebase the branch onto the default branch, resolve all conflicts, run the tests, and push.';
  }
  // IN_REVIEW
  const canMerge = actionOn(actions, 'autoMerge');
  return `Drive the open PR toward green: request/await the Copilot review and address feedback.${canMerge
    ? ' Then MERGE it (`gh pr merge --merge --delete-branch`) ONLY when it is MERGEABLE, CI is fully green, and the LATEST Copilot review reports "0 comments" (pre-resolved threads do NOT count; a PR over 20k lines is exempt from the Copilot check and needs only CI-green + mergeable). After merging, delete the local branch and remove its worktree.'
    : ' Do NOT merge (auto-merge is disabled) — stop once the PR is green and ready for the user to merge.'}`;
}

/**
 * Render the in-flight branch set into the coordinator prompt body.
 * @param {object[]} inFlight - actionable branches
 * @param {{ defaultBranch:string, actions:object }} ctx
 * @returns {string}
 */
export function formatInFlightForPrompt(inFlight, { defaultBranch, actions }) {
  const lines = [`Default branch: \`${defaultBranch}\`. Branches to reconcile (${inFlight.length}):`, ''];
  for (const b of inFlight) {
    const pr = b.openPr ? ` — PR #${b.openPr.number} (${b.openPr.mergeable})${b.openPr.url ? ` ${b.openPr.url}` : ''}` : ' — no PR';
    lines.push(`### \`${b.branch}\` [${b.state}]${pr}`);
    if (b.worktreePath) lines.push(`- Worktree: \`${b.worktreePath}\``);
    lines.push(`- Do: ${desiredEndState(b.state, actions)}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Build the coordinator CoS task (raw shape, ready for addTask({raw:true})).
 * Multi-line instructions live in `metadata.context` (survives the TASKS.md
 * round-trip); `description` is a stable single line for dedup.
 *
 * @param {object[]} inFlight - actionable in-flight branches
 * @param {{ defaultBranch:string, actions:object, now?:number }} ctx
 * @returns {object} task object
 */
export function buildCoordinatorTask(inFlight, { defaultBranch, actions, now = 0 }) {
  const body = [
    '# Branch & PR Reconciliation',
    '',
    'You are the coordinator for finishing this machine\'s unfinished local git work. Each branch below is a LOCAL branch on this machine (peer branches are never included). Spawn ONE sub-agent per branch (they are independent — run them in parallel) to carry out the "Do:" instruction for that branch, each working in the branch\'s existing worktree when it has one. Never touch any branch not listed here.',
    '',
    formatInFlightForPrompt(inFlight, { defaultBranch, actions }),
    '## Rules',
    '- Work only on the branches listed above.',
    '- Never force-push the default branch and never merge unreviewed work.',
    '- If a sub-agent reports a branch is incomplete or blocked, leave it and note it in your summary.',
    '- Summarize what each branch ended up doing (PR opened / conflicts resolved / merged / left incomplete).'
  ].join('\n');

  return {
    id: `sys-branch-reconcile-${now.toString(36)}`,
    status: 'pending',
    priority: 'LOW',
    priorityValue: PRIORITY_VALUES.LOW,
    description: COORDINATOR_DESCRIPTION,
    metadata: {
      context: body,
      // Runs on the PortOS checkout itself (it orchestrates across sibling
      // worktrees), so no isolated worktree for the coordinator.
      useWorktree: false,
      source: 'branchReconcile',
      updatedAt: new Date(now).toISOString()
    },
    approvalRequired: false,
    autoApproved: true,
    section: 'pending'
  };
}

/**
 * Run one reconcile pass. Wrapped in try/catch — it runs from a cron handler and
 * the API route, both outside the Express request lifecycle.
 *
 * @param {{ force?: boolean, now?: number }} [opts]
 * @returns {Promise<object>} summary
 */
export async function runBranchReconcile({ force = false, now = Date.now() } = {}) {
  try {
    const settings = await getSettings();
    const cfg = settings.branchReconcile || {};
    if (!force && !cfg.enabled) {
      lastRun = { at: new Date(now).toISOString(), skipped: 'disabled' };
      return lastRun;
    }
    const actions = cfg.actions || {};

    const result = await reconcile(PATHS.root, {
      cleanup: actionOn(actions, 'cleanupMerged'),
      activeAgentIds: new Set(getActiveAgentIds())
    });
    const actionable = filterActionable(result.inFlight, actions);

    let queued = false;
    // The coordinator is an auto-approved INTERNAL task, which the CoS runner
    // only actually spawns when its autonomy mode for the `cos` domain is
    // `execute` (off/dry-run leave it queued). Surface the mode so the summary
    // can't claim an agent will run when it won't — the reconciler's enable
    // toggle is independent of the CoS auto-run setting.
    let cosAutonomy = 'unknown';
    if (actionable.length > 0) {
      const task = buildCoordinatorTask(actionable, {
        defaultBranch: result.defaultBranch, actions, now
      });
      const added = await addTask(task, 'internal', { raw: true });
      queued = !added?.duplicate;
      if (added?.duplicate) {
        console.log('🔀 branch-reconcile: a coordinator is already in flight — skipping dispatch');
      }
      const { getConfig } = await import('./cos.js');
      const config = await getConfig().catch(() => null);
      cosAutonomy = config ? getDomainMode(config, 'cos') : 'unknown';
    }

    const summary = {
      at: new Date(now).toISOString(),
      cleaned: result.cleaned,
      inFlight: result.inFlight.map((b) => ({ branch: b.branch, state: b.state })),
      actionable: actionable.map((b) => b.branch),
      wip: result.wip.map((b) => b.branch),
      skipped: result.skipped,
      queued,
      // true only when the coordinator was queued AND the CoS runner will spawn it.
      coordinatorWillRun: queued && cosAutonomy === 'execute',
      cosAutonomy
    };
    lastRun = summary;
    console.log(`🔀 branch-reconcile: cleaned ${result.cleaned.length}, ${actionable.length} actionable, queued=${queued}, cosAutonomy=${cosAutonomy}`);
    return summary;
  } catch (err) {
    console.error(`❌ branch-reconcile run failed: ${err.message}`);
    lastRun = { at: new Date(now).toISOString(), error: err.message };
    return lastRun;
  }
}

/**
 * Register the daily cron. No-ops (leaves the job unregistered) when disabled;
 * the handler re-reads settings each run so action toggles take effect live, but
 * changing the cron expression itself needs a restart (matches backupScheduler).
 */
export async function startBranchReconcileScheduler() {
  const settings = await getSettings();
  const cfg = settings.branchReconcile || {};
  if (!cfg.enabled) {
    console.log('🔀 branch-reconcile scheduler: disabled in settings — skipping');
    return;
  }
  const cron = cfg.cron || '0 3 * * *';
  const timezone = await getUserTimezone();
  schedule({
    id: CRON_ID,
    type: 'cron',
    cron,
    timezone,
    handler: () => runBranchReconcile(),
    metadata: { source: 'branchReconcileScheduler' }
  });
  console.log(`🔀 branch-reconcile scheduler: registered at cron "${cron}"`);
}

export function stopBranchReconcileScheduler() {
  cancel(CRON_ID);
  console.log('🔀 branch-reconcile scheduler: stopped');
}

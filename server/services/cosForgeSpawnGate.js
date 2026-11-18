/**
 * CoS forge-reachability spawn gate (#5110).
 *
 * A task that promises a change request cannot finish while the forge is unreachable: `git push` fails,
 * finalize records `forge-unreachable`, and the retry ladder re-runs the whole agent against the same dead
 * network. So hold at dispatch instead (like the runner-down hold in subAgentSpawner's `task:ready` listener):
 * the task stays queued with no status write and no retry charged, and spawns after the outage. Retries pass
 * the same chokepoint, so one hold covers first dispatch and retries.
 *
 * Deliberate narrowings, because a wrong hold stalls the queue silently:
 *  - Only `unreachable` holds. `not-installed` / `not-authenticated` / `error` are durable LOCAL
 *    misconfigurations that don't clear on their own (this also keeps non-GitHub hosts out: a Bitbucket or
 *    Forgejo remote answers `gh api rate_limit` with a 404, classified `error`).
 *  - Only a `gh` forge is probed; `checkGhHealth` says nothing about GitLab and would hold it forever.
 *  - A one-shot re-dequeue arms the way out, since nothing else fires when the network returns.
 *  - The hold expires after `MAX_HOLD_MS`, so a permanently-broken remote still reaches the `blocked` card.
 *
 * No dequeue-side pre-filter: the probe spawns a process, and `checkGhHealth`'s 60s per-host cache makes the
 * chokepoint check ~free.
 */

import { emitLog, cosEvents } from './cosEvents.js';
import { checkGhHealth } from './github.js';
import { getAppWorkspace, isClaimFlowTask } from './agent/agentPromptBuilder.js';
import { isTruthyMeta } from './agent/agentState.js';
import { parseGitRemote, detectForgeCli } from '../lib/gitForge.js';
import { execGit } from '../lib/execGit.js';
import { PATHS } from '../lib/fileUtils.js';

// Just past `checkGhHealth`'s 60s cache so the re-dequeue's probe is fresh.
const FORGE_RECHECK_DELAY_MS = 65_000;

// How long one host may hold tasks; past it the outage is no longer "a condition that clears on its own", and a silent `pending` is worse than a Blocked card.
const MAX_HOLD_MS = 60 * 60_000;

// host -> { firstHeldAt, warned, expiredWarned }. Cleared when the host probes healthy so a later outage gets a fresh budget.
const heldHosts = new Map();

let recheckTimer = null;

/**
 * Does this task need the forge to finish? `openPR` must push and open a change request; a claim-flow task
 * must read the tracker to pick an issue. Everything else can complete with the forge down.
 */
export function taskNeedsForge(task) {
  return isTruthyMeta(task?.metadata?.openPR) || isClaimFlowTask(task, isTruthyMeta);
}

/**
 * The repo directory this task's agent will run against, resolved like `agentWorkspacePrep` so the gate
 * probes the host the run will push to. `null` (app did not resolve) means no hold: `agentWorkspacePrep`
 * already blocks that task with a message naming the app.
 */
async function resolveTaskRepoDir(task) {
  if (!task?.metadata?.app) return PATHS.root;
  return await getAppWorkspace(task.metadata.app).catch(() => null);
}

/**
 * The forge host in a repo's `origin` URL, or `null` when there is no origin, no repo, or an unparseable URL.
 * `null` means "cannot name a host" and must not collapse into "the host is down": the gate declines to hold.
 */
async function resolveForgeHost(dir) {
  const result = await execGit(['remote', 'get-url', 'origin'], dir, { ignoreExitCode: true })
    .catch(() => null);
  if (!result || result.exitCode !== 0) return null;
  return parseGitRemote((result.stdout || '').trim())?.host || null;
}

/**
 * Ask for one more dequeue once the probe cache has expired, so a held task spawns when the network returns.
 * One timer for the whole gate (a still-held task re-arms it). `unref` so it never holds the event loop open;
 * the emit is guarded because a timer callback runs outside the request lifecycle.
 */
function scheduleForgeRecheck() {
  if (recheckTimer) return;
  recheckTimer = setTimeout(() => {
    recheckTimer = null;
    try {
      cosEvents.emit('cos:dequeue-requested');
    } catch (err) {
      console.error(`❌ Forge re-check dequeue request failed: ${err.message}`);
    }
  }, FORGE_RECHECK_DELAY_MS);
  recheckTimer.unref?.();
}

/**
 * Should this task's dispatch be held because its forge is unreachable?
 *
 * @param {object} task - the task about to be dispatched
 * @param {{ now?: number }} [opts] - injectable clock for the hold-expiry budget
 * @returns {Promise<string|null>} a `holdTask` reason, or `null` to dispatch
 */
export async function forgeSpawnHoldReason(task, { now = Date.now() } = {}) {
  if (!taskNeedsForge(task)) return null;

  const dir = await resolveTaskRepoDir(task);
  if (!dir) return null;

  const host = await resolveForgeHost(dir);
  if (!host) return null;
  if (detectForgeCli(host) !== 'gh') return null;

  const health = await checkGhHealth({ hostname: host }).catch(() => null);
  if (health?.status !== 'unreachable') {
    // Any other answer, including a probe that itself blew up, ends the outage; the next one starts from zero.
    heldHosts.delete(host);
    return null;
  }

  const state = heldHosts.get(host) || { firstHeldAt: now, warned: false, expiredWarned: false };
  if (now - state.firstHeldAt > MAX_HOLD_MS) {
    if (!state.expiredWarned) {
      emitLog('warn', `⚠️ ${host} has been unreachable for over an hour — dispatching ${task.id} anyway so it fails visibly instead of waiting forever`, { taskId: task.id });
      heldHosts.set(host, { ...state, expiredWarned: true });
    }
    return null;
  }

  // Warned once per outage, not once per held task (same as the runner-down hold).
  if (!state.warned) {
    const detail = health.detail ? ` — ${String(health.detail).split('\n')[0].slice(0, 120)}` : '';
    // The hold is the handling; the one-hour escalation above is what warns.
    emitLog('info', `⏸️ Holding forge-dependent tasks: ${host} is unreachable${detail}`, { taskId: task.id });
  }
  heldHosts.set(host, { ...state, warned: true });
  scheduleForgeRecheck();

  return `${host} is unreachable`;
}

/** Test seam — drops the per-host hold ledger and any pending re-check. */
export function __resetForgeSpawnGate() {
  heldHosts.clear();
  if (recheckTimer) {
    clearTimeout(recheckTimer);
    recheckTimer = null;
  }
}

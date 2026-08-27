/**
 * CoS forge-reachability spawn gate (issue #5110)
 *
 * A task whose shape promises a change request cannot finish while the forge is
 * unreachable: the agent does the work, `git push` fails, and finalize records
 * `forge-unreachable`. That verdict is non-actionable, so `resolveFailedTaskDecision`
 * routes it into the ordinary retry ladder — and each retry re-runs the whole agent
 * against the same dead network. One VPN drop cost three consecutive runs (101 + 50 +
 * 23 minutes of Opus) to walk a single user task through its retry budget into
 * `blocked`, plus the `[Auto] Investigate` task that followed, for a branch that
 * already held all of its commits after run one and only ever needed a push.
 *
 * So hold at dispatch instead. Same posture as the runner-down hold beside it in
 * subAgentSpawner's `task:ready` listener, and for the same reason recorded there:
 * "a runner left off overnight walked every queued task through its retry budget
 * into `blocked`". The task stays queued — no status write, no retry charged — and
 * spawns on the far side of the outage. Retries funnel through the same chokepoint,
 * so one hold covers both the first dispatch and every retry.
 *
 * Four deliberate narrowings, because a hold that fires wrongly stalls the queue
 * silently:
 *
 *  - **Only `unreachable` holds.** `not-installed` / `not-authenticated` / `error`
 *    are durable LOCAL misconfigurations that will not clear on their own, and the
 *    chokepoint's contract is "a condition that clears on its own". They fall
 *    through and spawn exactly as they do today. (This is also what keeps a
 *    non-GitHub host out: a Bitbucket or Forgejo remote answers `gh api rate_limit`
 *    with an HTTP 404, which classifies as `error`, not `unreachable`.)
 *  - **Only a `gh` forge is probed.** `checkGhHealth` shells out to `gh`, which
 *    answers nothing about a GitLab remote — probing one would report every
 *    `gitlab.*` repo unreachable and hold it forever.
 *  - **A one-shot re-dequeue arms the way out.** Nothing else fires when a network
 *    comes back, so a held task would otherwise wait for an unrelated dequeue
 *    trigger. Mirrors the runner-reconnect re-dequeue.
 *  - **The hold expires.** A host that stays unreachable past `MAX_HOLD_MS` stops
 *    holding, so a permanently-broken remote still reaches the `blocked` card that
 *    tells the user about it rather than sitting `pending` in silence.
 *
 * No dequeue-side pre-filter (the second altitude cosLocalEndpointSlots.js has):
 * the probe spawns a process, so a per-task probe inside the dequeue loop would
 * cost more than the hold it avoids. `checkGhHealth`'s 60s per-host cache makes the
 * chokepoint check ~free instead.
 */

import { emitLog, cosEvents } from './cosEvents.js';
import { checkGhHealth } from './github.js';
import { getAppWorkspace, isClaimFlowTask } from './agentPromptBuilder.js';
import { isTruthyMeta } from './agentState.js';
import { parseGitRemote, detectForgeCli } from '../lib/gitForge.js';
import { execGit } from '../lib/execGit.js';
import { PATHS } from '../lib/fileUtils.js';

// Just past `checkGhHealth`'s 60s cache, so the re-dequeue's probe is a fresh one
// rather than the cached verdict that armed this timer.
const FORGE_RECHECK_DELAY_MS = 65_000;

// How long one host may hold tasks before the gate gives up on it. An outage that
// outlasts this is no longer "a condition that clears on its own" from the queue's
// point of view, and a silent `pending` task is worse than the Blocked card the
// pre-gate behavior produced.
const MAX_HOLD_MS = 60 * 60_000;

// host → { firstHeldAt, warned, expiredWarned }. Cleared as soon as the host probes
// healthy, so a later outage gets a fresh budget and a fresh warning.
const heldHosts = new Map();

let recheckTimer = null;

/**
 * Does this task need the forge to finish?
 *
 * `openPR` is the direct signal — the run must push and open a change request.
 * A claim-flow task needs the forge even earlier: it cannot pick an issue to work
 * on without reading the tracker.
 *
 * Everything else (a reasoning/discard run, a Creative Director deliverable, a
 * read-only audit) can complete with the forge down and is left alone.
 */
export function taskNeedsForge(task) {
  return isTruthyMeta(task?.metadata?.openPR) || isClaimFlowTask(task, isTruthyMeta);
}

/**
 * The repo directory this task's agent will run against — resolved the same way
 * `agentWorkspacePrep` resolves it, so the gate probes the host the run will
 * actually push to.
 *
 * `null` means the app did not resolve. The gate does not hold in that case:
 * `agentWorkspacePrep` already blocks that task with a message naming the app,
 * which is a far better answer than an indefinite silent hold.
 */
async function resolveTaskRepoDir(task) {
  if (!task?.metadata?.app) return PATHS.root;
  return await getAppWorkspace(task.metadata.app).catch(() => null);
}

/**
 * The forge host in a repo's `origin` URL, or `null` when there is no origin, the
 * directory is not a repo, or the URL does not parse. Every `null` path means "we
 * cannot name a host", which must not collapse into "the host is down" — the gate
 * declines to hold rather than guessing.
 */
async function resolveForgeHost(dir) {
  const result = await execGit(['remote', 'get-url', 'origin'], dir, { ignoreExitCode: true })
    .catch(() => null);
  if (!result || result.exitCode !== 0) return null;
  return parseGitRemote((result.stdout || '').trim())?.host || null;
}

/**
 * Ask for one more dequeue once the probe cache has expired, so a task held on a
 * network outage spawns on its own when the network returns.
 *
 * One timer for the whole gate, not one per task: the dequeue drains every queued
 * task, and a held task that is still held simply re-arms it. `unref` so it never
 * holds the event loop open, and the emit is guarded because a `setTimeout`
 * callback runs outside the request lifecycle — an uncaught throw there would take
 * the process down.
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
    // Any other answer — including a probe that itself blew up — ends the outage
    // as far as the gate is concerned, so the next one starts from zero.
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

  // Warned once per outage, not once per held task — the same discipline the
  // runner-down hold uses, so a queue full of forge-dependent tasks produces one
  // line naming the host rather than one per task.
  if (!state.warned) {
    const detail = health.detail ? ` — ${String(health.detail).split('\n')[0].slice(0, 120)}` : '';
    emitLog('warn', `⏸️ Holding forge-dependent tasks: ${host} is unreachable${detail}`, { taskId: task.id });
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

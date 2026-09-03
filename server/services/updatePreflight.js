import { ServerError } from '../lib/errorHandler.js';
import { persistentMindImageWorkGuard } from '../lib/persistentMind.js';
import { getActiveAgentIds, spawningTasks } from './agentState.js';
import { readPersistentMindStateForSafetyCheck } from './cosState.js';
import { filterLiveAgentIds } from './cosAgentLifecycle.js';
import * as updateChecker from './updateChecker.js';

// Shared refusal logic for the PortOS self-update path, called from both
// POST /api/update/execute (server/routes/update.js) and the app:update
// socket handler for the PortOS app record (server/sockets/apps.js) — the
// route previously ran these checks alone, leaving App Management's socket
// path free to restart PortOS out from under a live CoS agent (#5984).

// Count CoS agents a PortOS restart (update.sh → pm2 restart) would disrupt:
// live processes (direct + runner spawns) PLUS any task mid-spawn. During a
// spawn the task sits in `spawningTasks` while its child process is created and
// only THEN registered in the process maps (`withSpawnDedupGuard` holds the set
// across the whole launch) — so an agent that has already spawned a process but
// not yet registered it is invisible to getActiveAgentIds() alone. Summing both
// includes every distinct in-flight task in the count (a live agent plus two
// spawning tasks reads as 3, not 1). It can transiently over-report by 1 during
// the sub-second overlap where a single launching agent sits in BOTH sets, but
// the guard only needs `> 0` and the count is a near-exact upper bound shown in
// an advisory notice — an occasional +1 mid-launch is preferable to dropping
// the spawning tasks entirely.
//
// This still can't close the window where a NEW spawn begins AFTER a caller
// reads this but before update.sh's pm2 restart. The route's post-lock re-check
// narrows it further; fully closing it needs every CoS spawn engine to consult
// updateInProgress (tracked in #4124) — the orphan reaper bounds the residual.
//
// The map ids are filtered through PortOS's own durable records first
// (`filterLiveAgentIds`). Neither map is self-cleaning, and `syncRunnerAgents`
// adopts whatever the CoS Runner still advertises — so a TUI the runner failed
// to kill stayed "active" until the next PortOS restart, permanently blocking
// the one action that would have cleared it. A restart cannot sever a run this
// process has already finalized, so a finalized id must not gate the update.
export async function countActiveCosAgents() {
  const live = await filterLiveAgentIds(getActiveAgentIds());
  return live.length + spawningTasks.size;
}

// The 409 the update flow raises when a restart would sever a live/spawning
// agent — shared by the fast-fail pre-check and the post-lock re-check.
export function agentsActiveError(n) {
  return new ServerError(
    `${n} CoS agent${n === 1 ? ' is' : 's are'} running — updating would restart PortOS and ` +
    `sever ${n === 1 ? 'it' : 'them'}. Pause or wait for the agent${n === 1 ? '' : 's'} to finish, then update.`,
    { status: 409, code: 'AGENTS_ACTIVE' }
  );
}

export function persistentMindImageWorkError(guard) {
  const work = [
    guard.queuedImageMessages > 0
      ? `${guard.queuedImageMessages} queued image message${guard.queuedImageMessages === 1 ? '' : 's'}`
      : null,
    guard.activeImageMessage ? 'one active image turn' : null,
  ].filter(Boolean).join(' and ');
  return new ServerError(
    `Persistent Mind has ${work}. Drain the image-bearing work, or create a backup and retry ` +
    'with acknowledgePersistentMindImageBackup: true. Older source readers cannot preserve image references.',
    { status: 409, code: 'PERSISTENT_MIND_IMAGES_IN_FLIGHT' },
  );
}

export async function getPersistentMindImageWorkGuard() {
  const snapshot = await readPersistentMindStateForSafetyCheck();
  if (!snapshot.trusted) {
    return { safe: false, trusted: false, queuedImageMessages: 0, activeImageMessage: false };
  }
  return persistentMindImageWorkGuard(snapshot.persistentMind);
}

export const persistentMindStateUntrustedError = () => new ServerError(
  'Persistent Mind state could not be validated. Restore data/cos/state.json from backup before updating.',
  { status: 409, code: 'PERSISTENT_MIND_STATE_UNTRUSTED' },
);

export function forkSyncRequiredError(remote, status) {
  return new ServerError(
    `Running from a fork (${remote.fullName}). Sync your fork from ${status.upstream.fullName} ` +
    `first, or re-submit with acknowledgeFork: true to update from your fork's origin as-is.`,
    { status: 412, code: 'FORK_SYNC_REQUIRED' }
  );
}

/**
 * One-shot preflight for a PortOS self-update: refuses when a live CoS agent
 * would be severed, when Persistent Mind has unacknowledged image-bearing work,
 * or when running from a fork that hasn't been acknowledged/synced recently.
 * Throws a ServerError (409/412) to refuse; otherwise resolves with the
 * getUpdateStatus() snapshot so a caller that also needs it (the route's tag
 * resolution) isn't forced to fetch it twice.
 *
 * This covers exactly the PRE-lock checks `POST /api/update/execute` ran
 * before #5984 — the route still runs its own post-lock re-check (agents +
 * image guard, under `withStateLock`) separately, since that recheck's timing
 * is specific to the atomic `setUpdateInProgress` window around update.sh.
 */
export async function checkPortosUpdatePreflight({
  acknowledgeFork = false,
  acknowledgePersistentMindImageBackup = false,
} = {}) {
  const activeCosAgents = await countActiveCosAgents();
  if (activeCosAgents > 0) throw agentsActiveError(activeCosAgents);

  const imageCheck = await getPersistentMindImageWorkGuard();
  if (!imageCheck.trusted) throw persistentMindStateUntrustedError();
  if (!imageCheck.safe && !acknowledgePersistentMindImageBackup) {
    throw persistentMindImageWorkError(imageCheck);
  }

  const status = await updateChecker.getUpdateStatus();
  const remote = status.remoteInfo;
  if (remote?.isFork && !acknowledgeFork && !status.forkSyncFresh) {
    throw forkSyncRequiredError(remote, status);
  }

  return status;
}

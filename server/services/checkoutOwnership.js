/**
 * Checkout ownership for app checkout recovery (#16075).
 *
 * A recovery task works in an app's real checkout, so a live interactive agent
 * session with that checkout as its cwd is the operator's own work in progress.
 * Recovery cannot resolve that, and before this gate every attempt ended in the
 * same `blocked` outcome, which the bounded retry ladder re-dispatched with a
 * fresh high-effort run each time. The dispatch chokepoint now holds the task
 * while such a session is alive and the checkout still has work to account for,
 * and the prompt names that session and the commits PortOS made itself, so a run
 * that does start cannot blame PortOS's own commits on a foreign writer.
 *
 * Session evidence is the Claude Code session registry (`~/.claude/sessions/<pid>.json`,
 * one file per live CLI process with `pid`, `cwd`, `kind` and `status`). Other
 * harnesses publish no equivalent registry, so they are not detected here.
 */

import { isPidPossiblyAlive } from '../lib/processLiveness.js';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { emitLog, cosEvents } from './cos/cosEvents.js';
import { execGit } from '../lib/execGit.js';
import { PATHS } from '../lib/fileUtils.js';

const CHECKOUT_RECOVERY_WORKFLOW = 'app-checkout-recovery';
// Reflog action prefix stamped by `commit()` in services/git.js.
const PORTOS_COMMIT_ACTION_PREFIX = 'portos-commit-';

const OWNER_RECHECK_DELAY_MS = 60_000;
const REFLOG_SCAN_LIMIT = 50;

const defaultSessionsDir = () => join(homedir(), '.claude', 'sessions');

const resolveReal = (path) => realpath(path).catch(() => null);

async function gitOut(args, dir) {
  const result = await execGit(args, dir, { ignoreExitCode: true }).catch(() => null);
  return result?.exitCode === 0 ? (result.stdout || '').trim() : null;
}

/**
 * Live interactive sessions whose cwd belongs to this checkout's own worktree.
 * A cwd inside a linked worktree nested under the checkout (CoS worktrees live
 * under the PortOS root) belongs to that worktree, not this checkout.
 */
async function listCheckoutSessions(dir, { sessionsDir = defaultSessionsDir(), pidAlive = isPidPossiblyAlive } = {}) {
  const root = await resolveReal(dir);
  if (!root) return [];
  const names = await readdir(sessionsDir).catch(() => []);
  const sessions = [];
  for (const name of names.filter(n => n.endsWith('.json'))) {
    const record = await readFile(join(sessionsDir, name), 'utf8').then(JSON.parse).catch(() => null);
    if (!record || record.kind !== 'interactive' || typeof record.cwd !== 'string') continue;
    const pid = Number(record.pid);
    if (!pidAlive(pid)) continue;
    const cwd = await resolveReal(record.cwd);
    if (!cwd || (cwd !== root && !cwd.startsWith(root + sep))) continue;
    const top = cwd === root ? root : await resolveReal(await gitOut(['rev-parse', '--show-toplevel'], cwd) || cwd);
    if (top !== root) continue;
    sessions.push({
      pid,
      sessionId: typeof record.sessionId === 'string' ? record.sessionId : null,
      status: typeof record.status === 'string' ? record.status : 'unknown',
    });
  }
  return sessions.sort((a, b) => a.pid - b.pid);
}

/** Recent HEAD reflog commits that PortOS's own git service made. */
async function listPortosAuthoredCommits(dir, { limit = REFLOG_SCAN_LIMIT } = {}) {
  const out = await gitOut(['reflog', '-n', String(limit), '--format=%H%x00%gs', 'HEAD'], dir);
  if (!out) return [];
  const hashes = out.split('\n')
    .map(line => line.split('\0'))
    .filter(([, subject]) => subject?.startsWith(PORTOS_COMMIT_ACTION_PREFIX))
    .map(([hash]) => hash);
  return [...new Set(hashes)];
}

/**
 * Nothing left for recovery to account for: on the default branch with no
 * staged, unstaged, untracked or stashed work. Unknown state is not settled.
 */
async function isCheckoutSettled(dir) {
  const status = await gitOut(['status', '--porcelain', '--untracked-files=all'], dir);
  if (status === null || status) return false;
  const stash = await gitOut(['stash', 'list'], dir);
  if (stash === null || stash) return false;
  const branch = await gitOut(['symbolic-ref', '--short', 'HEAD'], dir);
  const originHead = await gitOut(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], dir);
  const defaultBranch = originHead ? originHead.replace(/^origin\//, '') : 'main';
  return Boolean(branch) && branch === defaultBranch;
}

function describeSession(session) {
  return `pid ${session.pid}, status ${session.status}${session.sessionId ? `, session ${session.sessionId}` : ''}`;
}

/** Server-observed ownership facts rendered into the recovery prompt. */
export async function describeCheckoutOwnership(dir, opts = {}) {
  const [sessions, portosCommits] = await Promise.all([
    listCheckoutSessions(dir, opts).catch(() => []),
    listPortosAuthoredCommits(dir).catch(() => []),
  ]);
  return { sessions, portosCommits };
}

export function isCheckoutRecoveryTask(task) {
  return task?.metadata?.analysisType === CHECKOUT_RECOVERY_WORKFLOW;
}

async function resolveCheckoutDir(task) {
  if (!task?.metadata?.app) return PATHS.root;
  const { getAppWorkspace } = await import('./agent/agentAppWorkspace.js');
  return getAppWorkspace(task.metadata.app).catch(() => null);
}

let recheckTimer = null;
// taskId → session signature already announced, so one hold logs once.
const announced = new Map();

// Nothing fires when an interactive CLI exits, so re-request a dequeue while held.
function scheduleOwnerRecheck() {
  if (recheckTimer) return;
  recheckTimer = setTimeout(() => {
    recheckTimer = null;
    try {
      cosEvents.emit('cos:dequeue-requested');
    } catch (err) {
      console.error(`❌ Checkout owner re-check dequeue request failed: ${err.message}`);
    }
  }, OWNER_RECHECK_DELAY_MS);
  recheckTimer.unref?.();
}

/**
 * Hold a checkout recovery dispatch while a live interactive session owns the
 * checkout and the checkout still has work. The task stays queued with no retry
 * charged, and spawns once the session exits or the checkout settles.
 *
 * @returns {Promise<string|null>} a hold reason, or `null` to dispatch
 */
export async function checkoutOwnerHoldReason(task, opts = {}) {
  if (!isCheckoutRecoveryTask(task)) return null;
  const dir = await resolveCheckoutDir(task);
  if (!dir) return null;
  const sessions = await listCheckoutSessions(dir, opts).catch(() => []);
  if (!sessions.length || await isCheckoutSettled(dir)) {
    announced.delete(task.id);
    return null;
  }
  const reason = `waiting on the operator's interactive agent session in this checkout (${sessions.map(describeSession).join('; ')})`;
  const signature = sessions.map(s => `${s.pid}:${s.status}`).join(',');
  if (announced.get(task.id) !== signature) {
    announced.set(task.id, signature);
    emitLog('info', `⏸️ Holding checkout recovery ${task.id}: ${reason}`, { taskId: task.id });
  }
  scheduleOwnerRecheck();
  return reason;
}

/** Test seam: drops announced holds and any pending re-check. */
export function __resetCheckoutOwnerGate() {
  announced.clear();
  if (recheckTimer) {
    clearTimeout(recheckTimer);
    recheckTimer = null;
  }
}

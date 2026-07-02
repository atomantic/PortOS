/**
 * Workspace Context Service (#902)
 *
 * Captures and restores a project's full *working context* so switching
 * between projects restores what you were doing — the active git branch,
 * the live shell session(s) you had open, and the CoS/PLAN tasks scoped to
 * that project.
 *
 * What a context record holds (one per app id):
 *   {
 *     appId,                       // the project's apps-registry id
 *     branch,                      // git branch captured at save time
 *     shellSessionIds: [...],      // live shell sessions whose cwd is in the repo
 *     taskIds: [...],              // CoS/user task ids scoped to this app
 *     savedAt                      // ISO timestamp of last save
 *   }
 *
 * STORAGE.md classification: machine-local `file-primary`. Shell sessions are
 * in-memory PTYs on THIS machine and repo paths are machine-specific, so a
 * context record is meaningless on a federated peer — it must not sync. A
 * single `data/workspace-contexts.json` keyed by app id is the right shape
 * (small records, no relational queries, no tombstones/sync cursor). Writes
 * are serialized through a single-tail queue because both the blur/save path
 * and an explicit restore can mutate the same file (CLAUDE.md: "serialize
 * writes server-side… collapse the queue to a single tail per shared file").
 *
 * This service is read-only with respect to user work: it NEVER stashes,
 * checks out, or otherwise mutates a repo's working tree. "Restore" reports
 * the saved git branch and surfaces tasks + re-attachable shell sessions; the
 * client drives any actual shell re-attach through the existing
 * single-subscriber attach/claim contract in services/shell.js. Auto-switching
 * branches / re-spawning dead shells is deliberately deferred (see #902 open
 * decisions and the follow-up issue) to avoid clobbering uncommitted work.
 */

import { join } from 'path';
import { atomicWrite, readJSONFile, ensureDir, PATHS } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { getAppById, getAllApps, PORTOS_APP_ID } from './apps.js';
import { getBranch, getStatus, isRepo } from './git.js';
import { listAllSessions } from './shell.js';
import { getAllTasks } from './cosTaskStore.js';

const CONTEXTS_FILE = join(PATHS.data, 'workspace-contexts.json');

// Single-tail write queue — both save and restore round-trip read→modify→write
// against the one shared file, so they must serialize.
const queueWrite = createFileWriteQueue();

/** Read the contexts map ({ [appId]: record }), tolerating a missing/blank file. */
async function loadContexts() {
  const data = await readJSONFile(CONTEXTS_FILE, { contexts: {} });
  if (!data || typeof data.contexts !== 'object' || data.contexts === null) {
    return { contexts: {} };
  }
  return data;
}

/**
 * Tasks (user + CoS internal) scoped to an app id via `metadata.app`. The
 * PortOS app is special-cased: CoS scopes its own-repo tasks as `_self` OR
 * leaves `metadata.app` absent, so the baseline PortOS context collects both.
 * Returns light task summaries — enough for the UI to list + deep-link, not
 * the full task body.
 */
function tasksForApp(allTasks, appId) {
  const flat = [
    ...(allTasks.user?.tasks || []),
    ...(allTasks.cos?.tasks || [])
  ];
  const isPortos = appId === PORTOS_APP_ID;
  return flat
    .filter(t => {
      const scoped = t.metadata?.app || null;
      if (isPortos) return scoped === null || scoped === '_self' || scoped === PORTOS_APP_ID;
      return scoped === appId;
    })
    .map(t => ({
      id: t.id,
      description: (t.description || '').split('\n')[0].slice(0, 200),
      status: t.status || null,
      priority: t.priority || null
    }));
}

/**
 * Live shell sessions whose cwd is inside the app's repo. Path containment
 * is prefix-based on a normalized (trailing-slash) repoPath so a sibling
 * directory sharing a name prefix (e.g. `/code/app` vs `/code/app-www`)
 * doesn't false-match. The repo root itself also matches.
 */
function shellSessionsForRepo(sessions, repoPath) {
  if (!repoPath) return [];
  const root = repoPath.replace(/\/+$/, '');
  const prefix = `${root}/`;
  return sessions.filter(s => {
    const cwd = (s.cwd || '').replace(/\/+$/, '');
    return cwd === root || cwd.startsWith(prefix);
  });
}

/**
 * Compute the *live* working context for an app WITHOUT persisting it —
 * the current git branch/dirty state, in-repo shell sessions, and scoped
 * tasks. Used both by `saveContext` (to snapshot) and `getContext` (to show
 * the live view alongside the last-saved snapshot).
 *
 * @param {string} appId
 * @returns {Promise<object|null>} null when the app id is unknown.
 */
export async function captureLiveContext(appId) {
  const app = await getAppById(appId);
  if (!app) return null;

  const repoPath = app.repoPath || null;
  // Git reads are best-effort — a missing/non-repo path yields nulls, not a throw.
  const repo = repoPath ? await isRepo(repoPath).catch(() => false) : false;
  const [rawBranch, status, allTasks] = await Promise.all([
    repo ? getBranch(repoPath).catch(() => null) : Promise.resolve(null),
    repo ? getStatus(repoPath).catch(() => null) : Promise.resolve(null),
    getAllTasks().catch(() => ({ user: { tasks: [] }, cos: { tasks: [] } }))
  ]);
  // `git rev-parse --abbrev-ref HEAD` returns the literal "HEAD" on a detached
  // checkout — that's not a branch name. Normalize to null so a later detached
  // checkout can't false-match a saved "HEAD" as branchMatches, and the UI
  // renders it as "(detached)" rather than a phantom branch named HEAD.
  const branch = rawBranch === 'HEAD' ? null : rawBranch;

  const sessions = shellSessionsForRepo(listAllSessions(), repoPath);
  const tasks = tasksForApp(allTasks, appId);

  return {
    appId,
    appName: app.name,
    repoPath,
    isRepo: repo,
    branch,
    dirty: status ? !status.clean : null,
    changedFileCount: status ? status.files.length : null,
    shellSessions: sessions.map(s => ({
      sessionId: s.sessionId,
      label: s.label,
      cwd: s.cwd,
      kind: s.kind,
      attached: s.attached
    })),
    tasks
  };
}

/** Get the saved context record for an app id (null if never saved). */
export async function getSavedContext(appId) {
  const { contexts } = await loadContexts();
  return contexts[appId] || null;
}

/**
 * Combined view for a single app: the live context plus whatever was last
 * saved. The UI shows "live now" and "as you left it" side by side.
 */
export async function getContext(appId) {
  const [live, saved] = await Promise.all([
    captureLiveContext(appId),
    getSavedContext(appId)
  ]);
  if (!live) return null;
  return { ...live, saved };
}

/**
 * Persist the current working context for an app. Snapshots branch + the ids
 * of in-repo shell sessions + scoped task ids so a later `restoreContext` can
 * reconcile them against what's still live.
 */
export async function saveContext(appId) {
  // The whole capture→write runs inside the queue so a concurrent delete can't
  // complete between this save's capture and its write and then be silently
  // resurrected (CLAUDE.md: serialize the full read→modify→write on the shared
  // file). Returns null (unknown app id) from inside the queue — fine, the
  // caller still gets the resolved value.
  return queueWrite(async () => {
    const live = await captureLiveContext(appId);
    if (!live) return null;

    const record = {
      appId,
      branch: live.branch,
      shellSessionIds: live.shellSessions.map(s => s.sessionId),
      taskIds: live.tasks.map(t => t.id),
      savedAt: new Date().toISOString()
    };

    const data = await loadContexts();
    data.contexts[appId] = record;
    await ensureDir(PATHS.data);
    await atomicWrite(CONTEXTS_FILE, data);
    console.log(`🗂️ Saved workspace context for ${appId} (branch=${record.branch || 'n/a'}, shells=${record.shellSessionIds.length}, tasks=${record.taskIds.length})`);
    return record;
  });
}

/**
 * Resolve a saved context against current reality. Reports which saved shell
 * sessions are still alive (re-attachable) vs gone, whether the saved branch
 * is still checked out, and the live task list. Does NOT mutate any repo or
 * spawn/attach shells — the client drives re-attach through the existing
 * shell attach/claim contract, and branch switching is left to the user so
 * uncommitted work is never clobbered (#902 hard constraints).
 *
 * @returns {Promise<object|null>} null when the app id is unknown.
 */
export async function restoreContext(appId) {
  const live = await captureLiveContext(appId);
  if (!live) return null;

  const saved = await getSavedContext(appId);
  if (!saved) {
    return { appId, saved: null, live, restorable: { shellSessions: [], missingShellSessionIds: [], branchMatches: null } };
  }

  const savedIds = new Set(saved.shellSessionIds || []);
  const liveSessionIds = new Set(live.shellSessions.map(s => s.sessionId));
  const missing = (saved.shellSessionIds || []).filter(id => !liveSessionIds.has(id));

  return {
    appId,
    saved,
    live,
    restorable: {
      // Live session details for the ids we saved and that still exist — the
      // client re-attaches these via shell.js's claim contract.
      shellSessions: live.shellSessions.filter(s => savedIds.has(s.sessionId)),
      missingShellSessionIds: missing,
      branchMatches: saved.branch == null ? null : saved.branch === live.branch
    }
  };
}

/** Delete a saved context record. Returns true if one existed. */
export async function deleteContext(appId) {
  return queueWrite(async () => {
    const data = await loadContexts();
    if (!data.contexts[appId]) return false;
    delete data.contexts[appId];
    await ensureDir(PATHS.data);
    await atomicWrite(CONTEXTS_FILE, data);
    console.log(`🗂️ Deleted workspace context for ${appId}`);
    return true;
  });
}

/**
 * List every active app with a compact context summary (live counts + last
 * saved-at). Powers the project switcher.
 */
export async function listContexts() {
  const [apps, { contexts }] = await Promise.all([
    getAllApps({ includeArchived: false }),
    loadContexts()
  ]);

  const sessions = listAllSessions();
  const allTasks = await getAllTasks().catch(() => ({ user: { tasks: [] }, cos: { tasks: [] } }));

  return apps.map(app => {
    const saved = contexts[app.id] || null;
    return {
      appId: app.id,
      appName: app.name,
      repoPath: app.repoPath || null,
      shellSessionCount: shellSessionsForRepo(sessions, app.repoPath).length,
      taskCount: tasksForApp(allTasks, app.id).length,
      savedAt: saved?.savedAt || null,
      savedBranch: saved?.branch || null
    };
  });
}

// In-memory tracker of the app id CoS (or the user, via workspace_switch) most
// recently began working in — the single "current workspace" notion in this
// single-user install. Intentionally NOT persisted: it models "where work is
// happening right now," which resets on restart, not durable state.
let currentWorkspaceAppId = null;

/**
 * Auto-snapshot hook for workspace/repo switches (#2035). When work moves to a
 * DIFFERENT app/repo than the one we were last in — a CoS coding-agent dispatch,
 * or a user `workspace_switch` — save a silent snapshot of the previous
 * ("current") app's workspace context first, so it can later be restored.
 *
 * Snapshot-only: it NEVER restores (restoring stays an explicit user action) and
 * makes NO LLM calls. Defensive by design — a missing/absent current workspace
 * (first switch) or a switch to the same repo is a no-op, not a throw; a failed
 * save is swallowed so it can't break the caller's dispatch/switch.
 *
 * @param {string|null} nextAppId - target app id (null ⇒ PortOS self)
 * @returns {Promise<object|null>} the saved snapshot record, or null when nothing
 *   was snapshotted (no prior workspace, same repo, or save failed).
 */
export async function snapshotOnRepoSwitch(nextAppId) {
  const target = nextAppId || PORTOS_APP_ID;
  // The read→update of the tracker is synchronous (no await between them), so
  // concurrent spawns can't tear it — each call atomically captures its own
  // `previous` and advances `current`. Only the subsequent file save awaits,
  // and saveContext already serializes writes through its own single-tail queue.
  const previous = currentWorkspaceAppId;
  currentWorkspaceAppId = target;
  // First switch (no prior workspace) or same repo ⇒ nothing to snapshot.
  if (!previous || previous === target) return null;
  const saved = await saveContext(previous).catch((err) => {
    console.warn(`⚠️ Workspace auto-snapshot for ${previous} failed: ${err?.message || err}`);
    return null;
  });
  if (saved) {
    console.log(`🗂️ Auto-snapshotted workspace context for ${previous} (switched to ${target})`);
  }
  return saved;
}

/** Read the current in-memory workspace tracker (exported for tests). */
export function getCurrentWorkspaceAppId() {
  return currentWorkspaceAppId;
}

/** Reset the in-memory workspace tracker — exported for unit tests. */
export function __resetWorkspaceTracker() {
  currentWorkspaceAppId = null;
}

// Exported for unit tests — pure helpers with no I/O.
export const __test = { tasksForApp, shellSessionsForRepo };

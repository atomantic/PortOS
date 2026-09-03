/**
 * Read-only leftover-branch idle detector for the operator-action ledger
 * (#5596, epic #5593).
 *
 * Surfaces local branches with no live owner while no CoS agents are running,
 * plus the last time the operator pressed Run Now on `branch-reconcile`.
 * NEVER invokes the branch reconciler or an on-demand schedule trigger — a finding is an insight,
 * not an automatic Run Now.
 *
 * `gatherBranchState` already talks to git; this module does not scrape git
 * itself and is not on the recorder hot path.
 */

import { PATHS } from '../lib/fileUtils.js';
import { PORTOS_APP_ID } from '../lib/appIdentity.js';
import { getActiveApps } from './apps.js';
import { getActiveAgentIds } from './agentState.js';
import { gatherBranchState, classifyBranches } from './branchReconcile.js';
import { getDefaultBranch } from './git.js';
import { listUserActions } from './userActions.js';

export const LEFTOVER_BRANCH_LOOKBACK_DAYS = 14;
export const LEFTOVER_BRANCH_CACHE_TTL_MS = 60_000;

let leftoverCache = { at: 0, findings: null };

export function __resetLeftoverBranchCache() {
  leftoverCache = { at: 0, findings: null };
}

const lastManualReconcile = (events, appId) => {
  const match = (events || []).find((event) => (
    event?.type === 'cos.schedule.trigger'
    && event.actor === 'user'
    && event.target === 'branch-reconcile'
    && (event.payload?.appId ?? event.targetName ?? null) === appId
  ));
  return match?.happenedAt ?? null;
};

async function computeIdleLeftoverBranches({
  now,
  getIds,
  getApps,
  gather,
  classify,
  getDefault,
  listActions,
  portosRoot,
}) {
  const activeAgentIds = getIds();
  if ((activeAgentIds || []).length > 0) return [];

  const apps = [...(await getApps())];
  if (!apps.some((app) => app.id === PORTOS_APP_ID)) {
    apps.unshift({ id: PORTOS_APP_ID, repoPath: portosRoot });
  }

  const from = new Date(now - LEFTOVER_BRANCH_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const triggers = await listActions({
    type: 'cos.schedule.trigger',
    actor: 'user',
    from,
    limit: 100,
  }).catch((error) => {
    console.error(`❌ leftover-branch detector: ledger read failed: ${error.message}`);
    return [];
  });

  const findings = [];
  for (const app of apps) {
    const repoPath = app.repoPath;
    if (!repoPath) continue;
    try {
      const defaultBranch = await getDefault(repoPath);
      const inputs = await gather(repoPath, { defaultBranch, activeAgentIds: [] });
      const leftoverCount = classify(inputs)
        .filter((row) => !row.liveOwnerReason)
        .length;
      if (leftoverCount === 0) continue;
      findings.push({
        appId: app.id,
        leftoverCount,
        lastUserReconcileAt: lastManualReconcile(triggers, app.id),
        agentsIdle: true,
      });
    } catch (error) {
      console.error(`❌ leftover-branch detector: skipped ${app.id}: ${error.message}`);
    }
  }
  return findings;
}

/**
 * @param {object} [deps] injectable for tests. Passing deps bypasses the TTL cache.
 * @returns {Promise<Array<{appId: string, leftoverCount: number, lastUserReconcileAt: string|null, agentsIdle: true}>>}
 */
export async function detectIdleLeftoverBranches(deps = null) {
  const useCache = deps == null;
  if (useCache && leftoverCache.findings && (Date.now() - leftoverCache.at) < LEFTOVER_BRANCH_CACHE_TTL_MS) {
    return leftoverCache.findings;
  }
  const now = deps?.now ?? Date.now();
  const findings = await computeIdleLeftoverBranches({
    now,
    getIds: deps?.getActiveAgentIds ?? getActiveAgentIds,
    getApps: deps?.getActiveApps ?? getActiveApps,
    gather: deps?.gatherBranchState ?? gatherBranchState,
    classify: deps?.classifyBranches ?? classifyBranches,
    getDefault: deps?.getDefaultBranch ?? getDefaultBranch,
    listActions: deps?.listUserActions ?? listUserActions,
    portosRoot: deps?.portosRoot ?? PATHS.root,
  });
  if (useCache) leftoverCache = { at: Date.now(), findings };
  return findings;
}

export function formatLeftoverBranchSnippet(findings) {
  if (!Array.isArray(findings) || findings.length === 0) return '';
  return findings.map((finding) => (
    `leftover-branches: app ${finding.appId} has ${finding.leftoverCount} local branches, agents idle, last manual reconcile ${finding.lastUserReconcileAt || 'never'}`
  )).join('\n');
}

export function formatUserActionDetectorBlock(findings) {
  const snippet = formatLeftoverBranchSnippet(findings);
  if (!snippet) return '';
  return [
    'Leftover-branch findings are READ-ONLY. They never run reconcile and never trigger a scheduled task. Propose a cadence or a Run Now — never enact.',
    '',
    snippet,
  ].join('\n');
}

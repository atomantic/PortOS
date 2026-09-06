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
/**
 * Branch names carried per app so the banner can name a few without unbounded
 * payload growth. They reach the local UI only — `formatLeftoverBranchSnippet`
 * below stays counts-only on purpose, so a branch name (which can carry a
 * private project or issue title) never rides into an agent prompt and out into
 * a filed issue.
 */
export const LEFTOVER_BRANCH_SAMPLE_LIMIT = 6;

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

/** `{ NEEDS_PR: 2, MERGED: 1 }` — what KIND of leftovers an app is holding. */
const countByState = (rows) => rows.reduce((counts, row) => {
  const state = row.state || 'UNKNOWN';
  counts[state] = (counts[state] || 0) + 1;
  return counts;
}, {});

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
    apps.unshift({ id: PORTOS_APP_ID, name: 'PortOS', repoPath: portosRoot });
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
      const leftovers = classify(inputs).filter((row) => !row.liveOwnerReason);
      if (leftovers.length === 0) continue;
      findings.push({
        appId: app.id,
        // The operator thinks in app NAMES, not registry ids — the insight card
        // has to answer "which app do I run this for?" without a second lookup.
        appName: app.name || app.id,
        leftoverCount: leftovers.length,
        states: countByState(leftovers),
        branches: leftovers.slice(0, LEFTOVER_BRANCH_SAMPLE_LIMIT).map((row) => row.branch).filter(Boolean),
        lastUserReconcileAt: lastManualReconcile(triggers, app.id),
        agentsIdle: true,
      });
    } catch (error) {
      console.error(`❌ leftover-branch detector: skipped ${app.id}: ${error.message}`);
    }
  }
  // Worst offender first: the card names one app up front and lists the rest.
  return findings.sort((a, b) => b.leftoverCount - a.leftoverCount);
}

/**
 * @param {object} [deps] injectable for tests. Passing deps bypasses the TTL cache.
 * @returns {Promise<Array<{appId: string, appName: string, leftoverCount: number, states: Record<string, number>, branches: string[], lastUserReconcileAt: string|null, agentsIdle: true}>>}
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

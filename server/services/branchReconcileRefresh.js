import { join } from 'path';
import { ServerError } from '../lib/errorHandler.js';
import { getAppById } from './apps.js';
import { getActiveAgentIds } from './agentState.js';
import { readClaimOwnershipAgents } from './cosClaimOwnership.js';
import { reconcile, buildActiveOwnerIds, describeIdleReconcilePark } from './branchReconcile.js';
import { recordBranchReconcileOutcome, getBranchReconcileInventory } from './taskSchedule.js';
import { cosEvents } from './cosEvents.js';

/**
 * Programmatically settle completed/integrated obligations and prune unneeded archives.
 */
export async function settleAndPruneBranchReconcileArchives(appId, repoPath, { defaultBranch = 'main', worktreeInventory = [] } = {}) {
  const [{ getBranchReconcileOutcome, recordBranchReconcileOutcome: recordOutcome }, { execGit }, { hasBranchMergeEvidence }, { PATHS }, { readdir, readFile, rm }] = await Promise.all([
    import('./taskSchedule.js'),
    import('../lib/execGit.js'),
    import('./git.js'),
    import('../lib/paths.js'),
    import('fs/promises'),
  ]);

  const outcome = await getBranchReconcileOutcome(appId);
  if (!outcome || !Array.isArray(outcome.retirementObligations) || !outcome.retirementObligations.length) {
    return outcome;
  }

  const roots = [
    join(PATHS.cos, 'held-checkout-archives'),
    join(PATHS.cos, 'branch-retirement-archives'),
  ];
  const diskArchives = [];
  for (const root of roots) {
    const names = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const d of names) {
      if (!d.isDirectory()) continue;
      const dir = join(root, d.name);
      try {
        const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
        if (manifest.repoPath === repoPath) {
          diskArchives.push({ dir, root, ...manifest });
        }
      } catch {}
    }
  }

  const existingLocalRefs = await execGit(['show-ref', '--heads'], repoPath)
    .then(r => r.stdout.split('\n').map(l => l.split(' ')[1]).filter(Boolean))
    .catch(() => []);
  const localRefNames = new Set(existingLocalRefs.map(ref => ref.replace(/^refs\/heads\//, '')));

  const survivingObligations = [];
  const settledReceipts = [];

  for (const obligation of outcome.retirementObligations) {
    const branchPresent = obligation.branch && localRefNames.has(obligation.branch);
    const checkoutPresent = obligation.path && worktreeInventory?.some(t => t.path === obligation.path);

    if (branchPresent || checkoutPresent) {
      survivingObligations.push(obligation);
      continue;
    }

    const alreadyReceipted = [...(outcome.retired || []), ...Object.values(outcome.retirementReceiptEvidence || {}), ...(outcome.recoveredPreservations || [])].some(r =>
      (obligation.branch && r.branch === obligation.branch) || (obligation.path && r.path === obligation.path) || (obligation.head && r.head === obligation.head)
    );
    if (alreadyReceipted) {
      settledReceipts.push(obligation);
      continue;
    }

    const matchingArchive = diskArchives.find(a =>
      (obligation.branch && a.branch === obligation.branch)
      || (obligation.path && a.path === obligation.path)
      || (obligation.head && (a.head === obligation.head || a.expectedHead === obligation.head))
    );
    if (matchingArchive) {
      settledReceipts.push(obligation);
      continue;
    }

    if (!obligation.head && !obligation.path) {
      settledReceipts.push(obligation);
      continue;
    }

    if (obligation.head && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(obligation.head)) {
      const commitExists = await execGit(['cat-file', '-e', `${obligation.head}^{commit}`], repoPath).then(() => true, () => false);
      if (commitExists) {
        const merged = await hasBranchMergeEvidence(repoPath, obligation.head, defaultBranch).catch(() => false);
        if (merged) {
          settledReceipts.push(obligation);
          continue;
        }
      }
    }

    survivingObligations.push(obligation);
  }

  if (settledReceipts.length > 0) {
    const { recordHeldCheckoutRetirement } = await import('./taskSchedule.js');
    for (const settled of settledReceipts) {
      const archiveDir = settled.archiveDir
        || settled.preservationReceipt?.archiveDir
        || diskArchives.find(a => (settled.branch && a.branch === settled.branch) || (settled.path && a.path === settled.path))?.dir
        || null;
      await recordHeldCheckoutRetirement(appId, {
        path: settled.path,
        branch: settled.branch,
        head: settled.head,
        branchDeleted: true,
        archiveDir,
        checkoutIdentity: settled.checkoutIdentity,
      }).catch(() => null);
    }
    const current = await getBranchReconcileOutcome(appId);
    if (current && (!current.remaining || !current.remaining.length) && (!current.retirementObligations || !current.retirementObligations.length)) {
      await recordOutcome(appId, {
        status: 'drained',
        reason: 'no-remaining-holds',
        retirementObligations: [],
        remaining: [],
        nextAction: null,
      });
    }
  }

  const survivingRefs = new Set();
  for (const ob of survivingObligations) {
    if (ob.preservationReceipt?.archiveDir) survivingRefs.add(ob.preservationReceipt.archiveDir);
    for (const a of ob.preservationEvidence?.archives || []) {
      if (a.archiveDir) survivingRefs.add(a.archiveDir);
    }
  }

  for (const archive of diskArchives) {
    if (!survivingRefs.has(archive.dir)) {
      await rm(archive.dir, { recursive: true, force: true }).catch(() => null);
    }
  }
}

/** Refresh evidence only: no cleanup, provider dispatch, or delivery recovery. */
export async function refreshBranchReconcileInventory(appId) {
  const app = await getAppById(appId);
  if (!app?.repoPath) throw new ServerError('Managed repository not found', { status: 404, code: 'NOT_FOUND' });
  const agents = await readClaimOwnershipAgents();
  if (!Array.isArray(agents)) throw new ServerError('Repository ownership state unavailable', { status: 503 });
  const result = await reconcile(app.repoPath, {
    appId, cleanup: false, reapSuperseded: false, reapRemotes: false,
    activeAgentIds: buildActiveOwnerIds(new Set(getActiveAgentIds()), agents),
    claimOwners: { agents, readAgents: readClaimOwnershipAgents },
    forgeAccount: app.forgeAccount || null,
  });
  // An unreadable scan must not replace the last inventory with a false zero.
  if (result.forgeUnavailable || result.prStateUnavailable || result.worktreeInventory == null || result.orphanRemotes?.remoteUnavailable) {
    throw new ServerError('Repository scan unavailable; previous inventory retained. Try refreshing again.', { status: 503, code: 'RECONCILE_SCAN_UNAVAILABLE' });
  }
  const inventory = describeIdleReconcilePark([
    ...(result.skipped || []),
    ...(result.inFlight || []).map(row => ({ ...row, reason: 'actionable' })),
  ], [], {
    wip: result.wip, detachedWorktrees: result.detachedWorktrees,
    superseded: result.superseded, claimMarkersHeld: result.claimMarkersHeld,
    worktreeInventory: result.worktreeInventory,
  });
  await recordBranchReconcileOutcome(appId, {
    status: inventory.remaining.length ? 'incomplete' : 'drained',
    reason: inventory.reason, remaining: inventory.remaining,
    remoteInventory: result.orphanRemotes ?? { reaped: [], reported: [] },
    nextAction: inventory.remaining.length ? 'Resolve the listed local holds, then refresh inventory.' : null,
  });
  await settleAndPruneBranchReconcileArchives(appId, app.repoPath, {
    defaultBranch: result.defaultBranch, worktreeInventory: result.worktreeInventory,
  });
  const outcome = await getBranchReconcileInventory(appId);
  cosEvents.emit('schedule:changed', { taskType: 'branch-reconcile', appId });
  return { appId, outcome };
}

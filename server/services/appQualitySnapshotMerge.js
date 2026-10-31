import { basename, join } from 'node:path';
import { readFile } from 'node:fs/promises';

/** Retained checkouts, found through Git's durable worktree inventory and their evidence file. */
async function listSnapshotCheckouts(app, deps) {
  const list = deps.listSnapshotMergeWorktrees || (await import('./worktreeManager.js')).listWorktrees;
  const read = deps.readMergeEvidence || readFile;
  const retained = [];
  for (const tree of await list(app.repoPath)) {
    if (!basename(tree.path).startsWith('portos-quality-')) continue;
    const body = await read(join(tree.path, '.cache', 'quality-snapshot-merge.json'), 'utf8')
      .catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (body === null) continue;
    const record = JSON.parse(body);
    // One drifted tree must not strand the settled ones; it stays in place.
    if (record.checkoutHead !== tree.head || !tree.detached || tree.branch || tree.locked) continue;
    retained.push({ ...tree, prUrl: record.prUrl });
  }
  return retained;
}

/** Remove verified snapshot checkouts in place. Nothing is copied into an archive. */
async function retireSnapshotTrees(app, deps, trees) {
  const { forceRemoveWorktreeDir, classifyWorktreeDirt } = await import('./worktreeManager.js');
  const { execGit } = await import('../lib/execGit.js');
  const { retireWithUnlockedArchive } = await import('./cosClaimOwnershipState.js');
  const checkOwner = deps.checkSnapshotPublicationOwnership
    || (await import('./cosClaimOwnership.js')).checkSnapshotPublicationOwnership;
  const held = [];
  for (const tree of trees) {
    const ownership = async () => (await checkOwner({ appId: app.id, branch: 'portos/quality-snapshot', prUrl: tree.prUrl }))?.admitted === true;
    const result = await retireWithUnlockedArchive({
      busy: () => ({ removed: false }),
      admit: async () => await ownership()
        ? { fence: { repoPath: app.repoPath, path: tree.path, branch: null } }
        : { result: { removed: false } },
      // The receipt binds this detached tree to `tree.head`; a MERGED PR (`mergedHead`) makes uncommitted files disposable.
      archive: async () => ({ archive: {
        verify: async holder => {
          if (!holder || holder.head !== tree.head || holder.branch || holder.detached !== true) return 'snapshot-checkout-changed';
          const status = await execGit(['status', '--porcelain'], tree.path).then(r => r.stdout, () => null);
          return status !== null && (classifyWorktreeDirt(status).clean || tree.mergedHead === holder.head) ? null : 'worktree-dirty';
        },
      } }),
      finish: async (_admitted, archive) => forceRemoveWorktreeDir(app.repoPath, tree.path, {
        verifyRemoval: async holder => await ownership() ? archive.verify(holder) : 'snapshot-owner-changed',
      }),
    }).catch(() => ({ removed: false }));
    if (!result.removed) held.push(tree.path);
  }
  return held;
}

/**
 * Before #14184 a deferred merged-tree-guarded snapshot merge kept its detached
 * checkout and `.cache/quality-snapshot-merge.json` evidence; nothing writes
 * either now. Retire those left behind once their PR is MERGED or CLOSED; an
 * unreadable state, drifted tree, or unverified local content keeps the tree.
 */
export async function sweepSettledSnapshotCheckouts(app, git, deps) {
  const trees = await listSnapshotCheckouts(app, deps);
  if (!trees.length) return [];
  const resolveForge = deps.resolveForgeForRepo || git.resolveForgeForRepo;
  const { cli, env } = await resolveForge(app.repoPath, { forgeAccount: app.forgeAccount || null });
  if (cli !== 'gh') return [];
  const execGh = deps.execGh || (await import('./github.js')).execGh;
  const settled = new Map();
  const isSettled = async prUrl => {
    if (!settled.has(prUrl)) {
      settled.set(prUrl, execGh(['pr', 'view', prUrl, '--json', 'state'], undefined, { cwd: app.repoPath, env })
        .then(raw => {
          const state = JSON.parse(raw)?.state;
          return ['MERGED', 'CLOSED'].includes(state) ? { merged: state === 'MERGED' } : null;
        }, () => null));
    }
    return settled.get(prUrl);
  };
  const done = [];
  for (const tree of trees) {
    const state = await isSettled(tree.prUrl);
    if (state) done.push({ ...tree, mergedHead: state.merged ? tree.head : null });
  }
  const held = new Set(await retireSnapshotTrees(app, deps, done));
  return done.map(tree => tree.path).filter(path => !held.has(path));
}

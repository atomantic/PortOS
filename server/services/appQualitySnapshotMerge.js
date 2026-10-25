import { basename, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { atomicWrite, execFileAsync } from '../lib/fileCore.js';

const GUARD_COMMAND = 'node scripts/pregate.js --guards-only';
const validSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);

async function gitText(git, repoPath, args) {
  const result = await git.execGit(args, repoPath);
  if (result?.exitCode !== 0 || typeof result.stdout !== 'string') throw new Error('merge-input-unreadable');
  return result.stdout.trim();
}

/** Only this fixed command opts a repository in; never execute arbitrary manifest text. */
async function advertisesGuards(git, repoPath, ref) {
  const path = await gitText(git, repoPath, ['ls-tree', '--name-only', ref, '--', 'package.json']);
  if (!path) return false;
  const manifest = JSON.parse(await gitText(git, repoPath, ['show', `${ref}:package.json`]));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('merge-guard-manifest-unreadable');
  const command = manifest?.scripts?.['pregate:merged'];
  if (command === undefined) return false;
  if (command !== GUARD_COMMAND) throw new Error('unsupported-merge-guard-command');
  return true;
}

async function readPr(app, pr, git, deps) {
  const resolveForge = deps.resolveForgeForRepo || git.resolveForgeForRepo;
  const { cli, env } = await resolveForge(app.repoPath, { forgeAccount: app.forgeAccount || null });
  if (cli !== 'gh') throw new Error('unsupported-merge-guard-forge');
  const execGh = deps.execGh || (await import('./github.js')).execGh;
  const raw = await execGh(['pr', 'view', String(pr.number), '--json',
    'state,isDraft,headRefOid,headRefName,baseRefName,isCrossRepository'], undefined, { cwd: app.repoPath, env });
  const state = JSON.parse(raw);
  if (state?.state !== 'OPEN' || state.isDraft !== false || state.isCrossRepository !== false
    || !validSha(state.headRefOid) || state.headRefName !== 'portos/quality-snapshot') {
    throw new Error('snapshot-merge-pr-unverified');
  }
  return state;
}

/** Resolve both full SHAs outside admission, including the already-open PR path. */
export async function readSnapshotMergeInputs(app, pr, defaultBranch, git, deps) {
  const evidence = { required: true, defaultBranch };
  try {
    if (!await advertisesGuards(git, app.repoPath, `origin/${defaultBranch}`)) return { required: false };
    if (pr.cli !== 'gh') throw new Error('unsupported-merge-guard-forge');
    await git.fetchOrigin(app.repoPath, { prune: true });
    evidence.baseSha = await gitText(git, app.repoPath, ['rev-parse', '--verify', `origin/${defaultBranch}^{commit}`]);
    if (!validSha(evidence.baseSha)) throw new Error('snapshot-merge-base-unverified');
    // A fetch can change the advertised contract too. Refuse rather than downgrade.
    if (!await advertisesGuards(git, app.repoPath, evidence.baseSha)) throw new Error('merge-guard-capability-changed');
    const state = await readPr(app, pr, git, deps);
    evidence.headSha = state.headRefOid;
    if (state.baseRefName !== defaultBranch) throw new Error('snapshot-merge-base-changed');
    const fetchedHead = await gitText(git, app.repoPath,
      ['rev-parse', '--verify', 'origin/portos/quality-snapshot^{commit}']);
    if (fetchedHead !== evidence.headSha) throw new Error('snapshot-merge-head-changed');
    return evidence;
  } catch (error) {
    return { ...evidence, reason: error.message };
  }
}

/** Retained beside the checkout on any refusal; never put guard output on the forge. */
export async function recordSnapshotMergeEvidence(pr, evidence, deps, details) {
  if (!evidence.worktreePath) return;
  evidence.evidencePath = join(evidence.worktreePath, '.cache', 'quality-snapshot-merge.json');
  const write = deps.writeMergeEvidence || atomicWrite;
  await write(evidence.evidencePath, { prUrl: pr.url, ...evidence, ...details });
}

export async function validateSnapshotMerge(app, pr, evidence, git, deps) {
  const cwd = evidence.worktreePath;
  const head = await gitText(git, cwd, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (head !== evidence.headSha) throw new Error('snapshot-merge-checkout-head-changed');
  if (await gitText(git, cwd, ['status', '--porcelain=v1', '--untracked-files=all'])) {
    throw new Error('snapshot-merge-checkout-dirty');
  }
  const link = deps.linkWorktreeDependencies || (await import('./worktreeManager.js')).linkWorktreeDependencies;
  await link(app.repoPath, cwd);
  await recordSnapshotMergeEvidence(pr, evidence, deps, { status: 'validating' });
  const exec = deps.execSnapshotMergeGuards || execFileAsync;
  const output = await exec(process.execPath,
    [join(cwd, 'scripts', 'pregate.js'), '--guards-only', '--merged-with', evidence.baseSha],
    { cwd, env: { ...process.env, PORTOS_TEST_MEMO: 'off' }, timeout: 600000, maxBuffer: 16 * 1024 * 1024 });
  if (await gitText(git, cwd, ['rev-parse', '--verify', 'HEAD^{commit}']) !== evidence.headSha
    || await gitText(git, cwd, ['status', '--porcelain=v1', '--untracked-files=all'])) {
    throw new Error('snapshot-merge-checkout-changed-during-validation');
  }
  await recordSnapshotMergeEvidence(pr, evidence, deps,
    { status: 'passed', stdout: output.stdout, stderr: output.stderr });
}

/** Git's durable checkout inventory plus our evidence survives publisher restarts. */
export async function retainedSnapshotMergeCheckouts(app, pr, deps) {
  const list = deps.listSnapshotMergeWorktrees || (await import('./worktreeManager.js')).listWorktrees;
  const read = deps.readMergeEvidence || readFile;
  const retained = [];
  for (const tree of await list(app.repoPath)) {
    if (!basename(tree.path).startsWith('portos-quality-')) continue;
    const body = await read(join(tree.path, '.cache', 'quality-snapshot-merge.json'), 'utf8')
      .catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (body === null) continue;
    const record = JSON.parse(body);
    if (record.prUrl !== pr.url) continue;
    if (record.checkoutHead !== tree.head || !tree.detached || tree.branch || tree.locked) {
      throw new Error('retained-snapshot-checkout-changed');
    }
    retained.push(tree);
  }
  return retained;
}

/** Remove verified snapshot checkouts in place. Nothing is copied into an archive. */
export async function retireSnapshotMergeCheckouts(app, pr, deps) {
  const { forceRemoveWorktreeDir } = await import('./worktreeManager.js');
  const { retireWithUnlockedArchive } = await import('./cosClaimOwnershipState.js');
  const checkOwner = deps.checkSnapshotPublicationOwnership
    || (await import('./cosClaimOwnership.js')).checkSnapshotPublicationOwnership;
  const held = [];
  for (const tree of await retainedSnapshotMergeCheckouts(app, pr, deps)) {
    const ownership = async () => (await checkOwner({ appId: app.id, branch: 'portos/quality-snapshot', prUrl: pr.url }))?.admitted === true;
    const result = await retireWithUnlockedArchive({
      busy: () => ({ removed: false }),
      admit: async () => await ownership()
        ? { fence: { repoPath: app.repoPath, path: tree.path, branch: null } }
        : { result: { removed: false } },
      archive: async () => {
        const { releaseCheckoutWithoutArchive } = await import('./heldCheckoutRecovery.js');
        const archive = await releaseCheckoutWithoutArchive({ repoPath: app.repoPath, path: tree.path }, async () => ({
          verify: async holder => (!holder || holder.head !== tree.head || holder.branch || holder.detached !== true)
            ? 'snapshot-checkout-changed' : null,
        }));
        return { archive };
      },
      finish: async (_admitted, archive) => forceRemoveWorktreeDir(app.repoPath, tree.path, {
        verifyRemoval: async holder => await ownership() ? archive.verify(holder) : 'snapshot-owner-changed',
      }),
    }).catch(() => ({ removed: false }));
    if (!result.removed) held.push(tree.path);
  }
  return held;
}

/** Called only inside admission. A moving base needs new guards, not a rebase. */
export async function verifySnapshotMergeInputs(app, pr, evidence, git, deps) {
  const state = await readPr(app, pr, git, deps);
  if (state.headRefOid !== evidence.headSha || state.baseRefName !== evidence.defaultBranch) {
    throw new Error('snapshot-merge-head-or-target-changed');
  }
  const remote = await gitText(git, app.repoPath,
    ['ls-remote', '--exit-code', 'origin', `refs/heads/${evidence.defaultBranch}`]);
  const [sha, ref, ...extra] = remote.split(/\s+/);
  if (extra.length || sha !== evidence.baseSha || ref !== `refs/heads/${evidence.defaultBranch}`) {
    throw new Error('snapshot-merge-base-changed');
  }
}

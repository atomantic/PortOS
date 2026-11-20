/** Read-only local branch and checkout observations for one repository pass.
 * Mutations still check live holders, ref identity and expected-head leases. */
import { execGit } from '../lib/execGit.js';
import { parseBranchVerboseLine } from '../lib/gitOutputParsers.js';
import { listWorktrees } from './worktreeManager.js';

const FORMAT = '%(HEAD)%00%(refname:lstrip=2)%00%(upstream:short)%00%(upstream:track)%00%(objecttype)%00%(objectname)';

// Read local objects even if the caller inherited a Git writer's quarantine.
export function repoObservationEnv() {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' };
  delete env.GIT_OBJECT_DIRECTORY;
  return env;
}

export async function readRepoBranchSnapshot(repoPath, { strict = true } = {}) {
  const inventory = listWorktrees(repoPath);
  const [refs, worktrees] = await Promise.all([
    execGit(['for-each-ref', `--format=${FORMAT}`, 'refs/heads/'], repoPath, { ignoreExitCode: !strict, env: repoObservationEnv() }),
    strict ? inventory : inventory.catch(() => []),
  ]);
  const branches = refs.stdout.split(/\r?\n/).filter(Boolean).map(parseBranchVerboseLine);
  return { branches, worktrees, tips: new Map(branches.map(branch => [branch.name, branch.tip])) };
}

/** Read-only local branch and checkout observations for one repository pass.
 * Mutations still check live holders, ref identity and expected-head leases. */
import { execGit } from '../lib/execGit.js';
import { parseBranchVerboseLine } from '../lib/gitOutputParsers.js';

const FORMAT = '%(HEAD)%00%(refname:lstrip=2)%00%(upstream:short)%00%(upstream:track)%00%(objecttype)%00%(objectname)';

// Read local objects even if the caller inherited a Git writer's quarantine.
export function repoObservationEnv() {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' };
  delete env.GIT_OBJECT_DIRECTORY;
  return env;
}

export async function readRepoBranchSnapshot(repoPath, { strict = true, comparisonBranch } = {}) {
  const readRefs = (format, ignoreExitCode) => execGit(
    ['for-each-ref', `--format=${format}`, 'refs/heads/'], repoPath, { ignoreExitCode, env: repoObservationEnv() },
  );
  // A ')' or '%' in a legal ref name is not safe to embed in a format atom.
  // A missing default ref (including an unborn repository) also falls back to plain inventory.
  const canCompare = comparisonBranch && !/[)%]/.test(comparisonBranch);
  const refsPromise = canCompare
    ? readRefs(`${FORMAT}%00%(ahead-behind:refs/heads/${comparisonBranch})`, true).catch(() => null)
      .then(result => result?.exitCode === 0 ? result : readRefs(FORMAT, !strict))
    : readRefs(FORMAT, !strict);
  const inventory = import('./worktreeManager.js').then(({ listWorktrees }) => listWorktrees(repoPath));
  const [refs, worktrees] = await Promise.all([refsPromise, strict ? inventory : inventory.catch(() => [])]);
  const counts = new Map();
  const branches = refs.stdout.split(/\r?\n/).filter(Boolean).map(line => {
    const branch = parseBranchVerboseLine(line);
    const match = canCompare && line.split('\0')[6]?.match(/^(\d+) (\d+)$/);
    if (branch.tip && match) counts.set(branch.name, { ahead: Number(match[1]), behind: Number(match[2]) });
    return branch;
  });
  const tips = new Map(branches.map(branch => [branch.name, branch.tip]));
  // The atom resolves its target separately from ref enumeration. Mutual
  // reachability (0/0) proves that the default row still names that same commit.
  const self = counts.get(comparisonBranch);
  if (!self || self.ahead !== 0 || self.behind !== 0) counts.clear();
  return { branches, worktrees, tips, counts };
}

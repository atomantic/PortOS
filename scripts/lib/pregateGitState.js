/** Read the Git worktree and branch inputs pregate validates, and check the worktree's dependency links. */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependencyConsistencyProblems } from './workspaceDependencies.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

const git = (args, cwd = REPO_ROOT, input) => execFileSync('git', args, {
  cwd, input, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
});
const gitPaths = (args, cwd, input) => git(args, cwd, input).split('\0').filter(Boolean);

/** Read HEAD, unmerged entries and all uncommitted paths from one porcelain walk. */
export function worktreeStatus(cwd = REPO_ROOT) {
  const entries = gitPaths(['status', '--porcelain=v2', '--branch', '--no-ahead-behind', '--no-renames',
    '--untracked-files=all', '--ignore-submodules=none', '-z'], cwd);
  const files = new Set();
  const conflicts = [];
  const indexAdds = new Set();
  const indexDeletes = new Set();
  let head;
  for (const entry of entries) {
    if (entry.startsWith('# branch.oid ')) head = entry.slice('# branch.oid '.length);
    else if (entry.startsWith('? ')) files.add(entry.slice(2));
    else if (entry.startsWith('1 ')) {
      const [, indexStatus, headMode, path] = /^1 (\S)\S \S+ (\S+) (?:\S+ ){4}([\s\S]+)$/.exec(entry);
      files.add(path);
      if (indexStatus === 'D') indexDeletes.add(path);
      // A zero HEAD mode also covers intent-to-add, which has index status '.'.
      else if (headMode === '000000') indexAdds.add(path);
    }
    else if (entry.startsWith('u ')) conflicts.push(entry.replace(/^u (?:\S+ ){9}/, ''));
  }
  return { head, files: [...files].sort(), conflicts: conflicts.sort(), indexAdds, indexDeletes };
}

/** Read the committed path inventory and the branch diff in one Git process. */
export function collectPregateInputs(baseSha, headTree, { cwd = REPO_ROOT, status = worktreeStatus(cwd) } = {}) {
  const emptyTree = createHash(headTree.length === 40 ? 'sha1' : 'sha256').update('tree 0\0').digest('hex');
  // In stdin mode Git echoes the tree pair, then prefixes the commit diff
  // with its SHA, even when that diff is empty (--always).
  const inventoryHeader = `${emptyTree} ${headTree}\n`;
  const output = git(['diff-tree', '--stdin', '--name-status', '-r', '-z', '--always',
    '--no-renames', '--ignore-submodules=none'], cwd, `${inventoryHeader}${status.head} ${baseSha}\n`);
  if (!output.startsWith(inventoryHeader)) throw new Error('Missing path inventory from git diff-tree.');
  const entries = output.slice(inventoryHeader.length).split('\0').filter(Boolean);
  const tracked = new Set(status.indexAdds);
  const changed = new Set(status.files);
  let branchDiff = false;
  for (let i = 0; i < entries.length;) {
    const marker = entries[i++];
    if (marker === status.head && !branchDiff) {
      branchDiff = true;
      continue;
    }
    const path = entries[i++];
    if (!path || !/^[ADMT]$/.test(marker)) throw new Error('Unexpected path inventory from git diff-tree.');
    if (branchDiff) changed.add(path);
    else if (!status.indexDeletes.has(path)) tracked.add(path);
  }
  if (!branchDiff) throw new Error('Missing branch diff from git diff-tree.');
  return {
    changedFiles: [...changed].sort(),
    trackedFiles: [...tracked].sort(),
    workingTreeFiles: status.files,
  };
}

/** Resolve repository and ref metadata together. origin/HEAD may be unset in a worktree or fork. */
export function repoState(base) {
  const args = ['rev-parse', '--path-format=absolute', '--git-path', 'index', '--git-common-dir', '--git-dir', 'HEAD', 'HEAD^{tree}'];
  const defaultRef = 'refs/remotes/origin/HEAD';
  args.push('--revs-only', `${base || defaultRef}...HEAD`);
  if (!base) args.push('--symbolic-full-name', defaultRef);
  const result = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  const [indexPath, commonDir, gitDir, head, tree, ...refs] = (result.stdout ?? '').trimEnd().split('\n');
  const remoteDefault = refs.find(ref => ref.startsWith('refs/remotes/'));
  // Some Git versions return a nonzero status for the optional trailing ref.
  // Trust the mandatory fields only if the command actually resolved them.
  const validObjects = [head, tree].every(id => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(id ?? ''));
  if (!indexPath || !commonDir || !gitDir || !validObjects || result.error || result.signal
    || (result.status !== 0 && result.status !== 128)) {
    throw new Error('Cannot resolve the Git worktree, index and HEAD tree for pregate.');
  }
  const baseRef = base || remoteDefault?.replace(/^refs\/remotes\//, '') || 'origin/main';
  const mergeBases = refs.filter(ref => ref.startsWith('^')).map(ref => ref.slice(1));
  // The three-dot range reports all merge bases. Keep Git's usual choice on
  // criss-cross histories and the origin/main fallback when origin/HEAD is unset.
  const baseSha = mergeBases.length === 1 ? mergeBases[0] : resolveMergeBase(baseRef, head);
  return { indexPath, commonDir, gitDir, head, tree, baseRef, baseSha };
}

function resolveMergeBase(baseRef, headSha) {
  const result = spawnSync('git', ['merge-base', baseRef, headSha], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(`❌ Cannot resolve a merge base with ${baseRef} — fetch it first (git fetch origin).`);
    process.exit(2);
  }
  return result.stdout.trim();
}

/**
 * A fresh `git worktree add` checkout has no node_modules. Creating the
 * symlinks is non-destructive (the linker never replaces a real dependency
 * directory) and is exactly what the diagnostic used to ask the agent to type,
 * so do it once and re-check. Never runs npm; stale versions stay diagnostics.
 */
function autoLinkWorktreeDependencies(problems, { commonDir, gitDir }, repoRoot) {
  if (!problems.some(({ linked, directoryAvailable }) => !linked || !directoryAvailable)) return problems;
  if (commonDir === gitDir) return problems;
  const primaryCheckout = resolve(commonDir, '..');
  const result = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'link-worktree-deps.js'), primaryCheckout, repoRoot], {
    cwd: repoRoot, encoding: 'utf8',
  });
  if (result.status !== 0) {
    console.log(`⚠️ Worktree dependency auto-link did not complete: ${(result.stderr || result.error?.message || '').trim()}`);
    return problems;
  }
  console.log('🔗 Linked worktree dependencies from the primary checkout');
  return dependencyConsistencyProblems(repoRoot);
}

/** Print each dependency-consistency problem with the re-link or reconcile hint that fits its checkout. */
function reportDependencyProblems(problems, { commonDir, gitDir }, warnOnly, repoRoot) {
  const primaryCheckout = commonDir === gitDir ? null : resolve(commonDir, '..');
  const print = warnOnly ? console.log : console.error;

  print(warnOnly
    ? '⚠️ Linked dependency version drift; continuing with the installed versions because the diff has no npm manifest or lockfile changes.'
    : '❌ Dependency consistency preflight failed; lint/tests have not run.');
  for (const { label, linked, owner, directoryAvailable, issues } of problems) {
    print(`  ${label} (${linked ? 'linked' : 'owned'} node_modules):\n${issues.map(issue => `    ${issue}`).join('\n')}`);
    if (primaryCheckout && (!linked || !directoryAvailable)) {
      print(`    Worktree dependency dir is missing or unlinked for ${label}. Re-link with: node scripts/link-worktree-deps.js ${primaryCheckout} ${repoRoot}`);
    } else {
      const home = homedir();
      const displayOwner = owner === home ? '~' : owner.startsWith(`${home}${sep}`) ? `~${owner.slice(home.length)}` : owner;
      print(linked
        ? `    Reconcile dependencies in the owning source checkout (${JSON.stringify(displayOwner)}), with a full development install (npm ci --include=dev), or validate in a separate clone with its own locked installs. Never run npm install/ci through worktree links.`
        : `    Reconcile this checkout's dependencies from its committed lockfiles (npm ci --include=dev in the owning workspace), then rerun pregate.`);
    }
  }
}

export function checkPregateDependencies(repoRoot, repo, changedFiles) {
  const dependencyProblems = autoLinkWorktreeDependencies(dependencyConsistencyProblems(repoRoot), repo, repoRoot);
  if (dependencyProblems.length > 0) {
    const dependencyFilesChanged = changedFiles.some(path => /(?:^|\/)(?:package(?:-lock)?|npm-shrinkwrap)\.json$/.test(path));
    const warnOnly = repo.commonDir !== repo.gitDir && !dependencyFilesChanged
      && dependencyProblems.every(({ linked, versionMismatchOnly }) => linked && versionMismatchOnly);
    reportDependencyProblems(dependencyProblems, repo, warnOnly, repoRoot);
    return warnOnly;
  }
  console.log('✅ Dependency consistency preflight passed (installed package versions match workspace locks).');
  return true;
}

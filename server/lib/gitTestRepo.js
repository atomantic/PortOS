/**
 * Shared real-git sandboxes for integration tests (#4394).
 *
 * Suites that pin git's own defaults (autoSetupMerge, cherry/patch-id,
 * worktree list spelling) must keep talking to a real repository — a mocked
 * `execGit` would only assert the author's belief. What they do NOT need is
 * to `init` + `config` + `commit` + optional `init --bare` + `push` in every
 * `beforeEach`. This module builds that template once per worker and
 * `fs.cp`s it into a fresh temp dir.
 *
 * Pure-logic tests should not call these helpers at all.
 */
import { mkdtemp, rm, writeFile, cp, mkdir, readdir } from 'fs/promises';
import { rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, basename } from 'path';
import { execGit } from './execGit.js';
import { assertTempPath } from './tempPathGuard.js';

export const SKIP_HEAVY_INTEGRATION = ['1', 'true', 'yes'].includes(
  String(process.env.VITEST_FAST || '').toLowerCase(),
) || process.env.npm_lifecycle_event === 'test:fast';

const TEMPLATE_PREFIX = 'portos-git-template-';
const DEFAULT_IDENTITY = Object.freeze({
  email: 'agent@example.com',
  name: 'Example Agent',
});

let templatePromise;

async function copyTree(src, dest) {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  await Promise.all(entries.map((entry) => cp(
    join(src, entry.name),
    join(dest, entry.name),
    { recursive: true, force: true },
  )));
}

async function configureIdentity(repo, identity = DEFAULT_IDENTITY) {
  assertTempPath(repo, 'git config on a fixture repo');
  await execGit(['config', 'user.email', identity.email], repo);
  await execGit(['config', 'user.name', identity.name], repo);
  await execGit(['config', 'commit.gpgsign', 'false'], repo);
}

async function stripOrigin(repo) {
  assertTempPath(repo, 'git remote surgery on a fixture repo');
  await execGit(['remote', 'remove', 'origin'], repo, { ignoreExitCode: true });
  await execGit(['branch', '--unset-upstream'], repo, { ignoreExitCode: true });
}

function wipeSync(scratch) {
  if (!scratch) return;
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* already gone */ }
}

// Vitest isolates the module cache per test file, so `buildTemplate` can
// run more than once in a worker. Track every template dir on globalThis
// and register a single process-exit hook — otherwise watch-mode reruns
// stack `process.on('exit')` listeners until MaxListenersExceededWarning.
const TEMPLATE_DIRS_KEY = '__portosGitTemplateDirs';
const TEMPLATE_HOOK_KEY = '__portosGitTemplateExitHooked';

function rememberTemplate(scratch) {
  const dirs = (globalThis[TEMPLATE_DIRS_KEY] ??= []);
  dirs.push(scratch);
  if (globalThis[TEMPLATE_HOOK_KEY]) return;
  globalThis[TEMPLATE_HOOK_KEY] = true;
  process.on('exit', () => {
    for (const dir of dirs) wipeSync(dir);
  });
}

async function buildTemplate() {
  const scratch = await mkdtemp(join(tmpdir(), TEMPLATE_PREFIX));
  const repo = join(scratch, 'primary');
  const origin = join(scratch, 'origin.git');
  assertTempPath(scratch, 'git init for the fixture template');
  await execGit(['init', '-b', 'main', repo], scratch);
  await configureIdentity(repo);
  await writeFile(join(repo, 'initial.txt'), 'initial');
  await execGit(['add', '-A'], repo);
  await execGit(['commit', '-m', 'initial'], repo);
  await execGit(['init', '--bare', '-b', 'main', origin], scratch);
  await execGit(['remote', 'add', 'origin', origin], repo);
  await execGit(['push', '-u', 'origin', 'main'], repo);
  // Copied sandboxes are torn down per-test; the template itself lives for
  // the worker. Wipe it on process exit so watch-mode / repeated runs do
  // not accumulate repos under os.tmpdir().
  rememberTemplate(scratch);
  return { scratch, repo, origin };
}

function getTemplate() {
  templatePromise ??= buildTemplate();
  return templatePromise;
}

/**
 * Fresh parent dir + working tree (`scratch/primary`), optionally with a
 * private bare origin at `scratch/origin.git`. The origin URL is rewritten
 * to the copy so two sandboxes never share a remote.
 */
export async function makeGitSandbox({
  origin = false,
  prefix = 'portos-git-',
  identity,
} = {}) {
  const template = await getTemplate();
  const scratch = await mkdtemp(join(tmpdir(), prefix));
  assertTempPath(scratch, 'git sandbox creation');
  const repo = join(scratch, 'primary');
  await cp(template.repo, repo, { recursive: true, force: true });
  if (identity) await configureIdentity(repo, identity);
  let originPath = null;
  if (origin) {
    originPath = join(scratch, 'origin.git');
    await cp(template.origin, originPath, { recursive: true, force: true });
    await execGit(['remote', 'set-url', 'origin', originPath], repo);
  } else {
    await stripOrigin(repo);
  }
  return { scratch, repo, origin: originPath };
}

/**
 * Attach a private bare origin at `scratch/origin.git` and push `main`.
 * Same shape the suites used to build with `init --bare` + `push -u`, so
 * tests that already call `addOrigin()` after extra local commits still
 * publish those commits.
 */
export async function attachBareOrigin(scratch, repo) {
  assertTempPath(scratch, 'bare-origin attach');
  assertTempPath(repo, 'bare-origin attach');
  const template = await getTemplate();
  const originPath = join(scratch, 'origin.git');
  await cp(template.origin, originPath, { recursive: true, force: true });
  await execGit(['remote', 'add', 'origin', originPath], repo);
  await execGit(['push', '-u', 'origin', 'main'], repo);
  return originPath;
}

/**
 * Copy the working-tree template *into* an existing directory (typically
 * the `mkdtemp` result). Used when the suite wants the repo root to BE the
 * temp dir — `git worktree list` spelling / realpath checks.
 */
export async function materializeGitRepo(dest, { identity } = {}) {
  assertTempPath(dest, 'git repo materialization');
  const template = await getTemplate();
  await copyTree(template.repo, dest);
  await stripOrigin(dest);
  if (identity) await configureIdentity(dest, identity);
  return dest;
}

/**
 * Restore `repo` to a known-clean state in place — for suites that share one
 * sandbox across a whole `describe` (built once in `beforeAll`) instead of
 * paying `makeGitSandbox()`'s fs.cp + `destroyGitSandbox()`'s recursive
 * delete on every test. Discards working-tree changes, deletes every branch
 * but `main`, resets `main` back to `initialHead`, drops the `origin` remote,
 * and (when `scratch` is given) wipes any sibling directory a test created
 * under it — a bare `origin.git` from `attachBareOrigin()`, or a contributor
 * clone from a pull/push helper — so the next test starts from a bare repo
 * again. `initialHead` is the sha `repo` was at right after it was built
 * (capture it once with `execGit(['rev-parse', 'HEAD'], repo)` in `beforeAll`,
 * before any test has run).
 *
 * `assertPath` (default `repo`) is what gets checked against `os.tmpdir()` —
 * pass the plain path a caller `mkdtemp()`'d rather than `repo` itself when
 * `repo` is git's OWN respelling of that same directory (e.g. from
 * `git rev-parse --show-toplevel`, as `worktreeReap.test.js`'s `initRepo()`
 * returns). On Windows those can disagree — `%TEMP%` is sometimes the 8.3
 * short form (`RUNNER~1`) while git always reports the long form
 * (`runneradmin`) — and `assertTempPath`'s realpath-based canonicalization
 * does not bridge that gap (nothing does but asking git; see the identical
 * problem worked around in `worktreeManager.js`'s `listWorktrees()`).
 */
export async function resetGitSandbox({ scratch, repo, initialHead, assertPath = repo }) {
  assertTempPath(assertPath, 'git sandbox reset');
  // A test can delete `repo` itself (simulating a checkout that vanished
  // mid-run) — rebuild it from the template rather than handing every git
  // call below a cwd that no longer exists. The template's own working copy
  // still has ITS `origin` pointing at the shared per-worker bare origin, so
  // strip it here too — leaving it would wire this sandbox at a remote every
  // other sandbox in the worker shares.
  if (!existsSync(repo)) {
    const template = await getTemplate();
    await copyTree(template.repo, repo);
    await stripOrigin(repo);
  }
  const gitDir = join(repo, '.git');
  // Every git subprocess costs real wall time (spawn overhead alone runs
  // tens of ms, worse on Windows) — skip the ones our own tests never
  // actually need instead of always paying for a no-op `--abort`/`remove`.
  if (existsSync(join(gitDir, 'MERGE_HEAD'))) {
    await execGit(['merge', '--abort'], repo, { ignoreExitCode: true });
  }
  if (existsSync(join(gitDir, 'CHERRY_PICK_HEAD'))) {
    await execGit(['cherry-pick', '--abort'], repo, { ignoreExitCode: true });
  }
  if (existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))) {
    await execGit(['rebase', '--abort'], repo, { ignoreExitCode: true });
  }
  await execGit(['checkout', '-f', 'main'], repo, { ignoreExitCode: true });
  await execGit(['clean', '-fdx'], repo);
  const { stdout } = await execGit(['branch', '--format=%(refname:short)'], repo);
  const branches = stdout.split('\n').map((b) => b.trim()).filter((b) => b && b !== 'main');
  if (branches.length) await execGit(['branch', '-D', ...branches], repo, { ignoreExitCode: true });
  await execGit(['reset', '--hard', initialHead], repo);
  let hasOrigin = false;
  try {
    hasOrigin = /\[remote "origin"\]/.test(readFileSync(join(gitDir, 'config'), 'utf8'));
  } catch { /* no config to read — nothing to remove */ }
  if (hasOrigin) await stripOrigin(repo);
  if (scratch) {
    const keep = basename(repo);
    const entries = await readdir(scratch, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries
      .filter((entry) => entry.name !== keep)
      .map((entry) => rm(join(scratch, entry.name), { recursive: true, force: true }).catch(() => {})));
  }
}

/**
 * Same contract as `resetGitSandbox()` — including the `assertPath` override
 * for a `repo` that's git's own respelling of an `mkdtemp()` path — plus
 * tearing down every real `git worktree add` checkout `repo` has grown since
 * the last reset (including a locked one), for suites whose tests exercise
 * worktree creation/removal directly rather than just branches and commits.
 */
export async function resetGitWorktreeSandbox(repo, initialHead, assertPath = repo) {
  assertTempPath(assertPath, 'git worktree sandbox reset');
  // A missing `repo` has no worktrees to list — let resetGitSandbox()'s own
  // rebuild-from-template handle it below instead of handing `worktree list`
  // a cwd that doesn't exist.
  if (existsSync(repo)) {
    const { stdout } = await execGit(['worktree', 'list', '--porcelain'], repo);
    // On Windows this output is CRLF (see listWorktrees() in worktreeManager.js
    // for the same fix) — a bare '\n' split leaves a trailing \r on `path`,
    // which then goes straight into `worktree remove <path>` and `rm(path)`.
    let current = null;
    const entries = [];
    for (const line of stdout.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) {
        current = { path: line.slice('worktree '.length), locked: false };
        entries.push(current);
      } else if (current && (line === 'locked' || line.startsWith('locked '))) {
        current.locked = true;
      }
    }
    // The first entry is always `repo` itself, never a grown worktree.
    for (const { path, locked } of entries.slice(1)) {
      if (locked) await execGit(['worktree', 'unlock', path], repo, { ignoreExitCode: true });
      await execGit(['worktree', 'remove', '--force', path], repo, { ignoreExitCode: true });
      await rm(path, { recursive: true, force: true }).catch(() => {});
    }
    if (entries.length > 1) await execGit(['worktree', 'prune'], repo, { ignoreExitCode: true });
  }
  await resetGitSandbox({ repo, initialHead, assertPath });
}

export async function destroyGitSandbox(scratch) {
  if (!scratch) return;
  assertTempPath(scratch, 'recursive sandbox delete');
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}

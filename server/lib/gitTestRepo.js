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
import { rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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

export async function destroyGitSandbox(scratch) {
  if (!scratch) return;
  assertTempPath(scratch, 'recursive sandbox delete');
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}

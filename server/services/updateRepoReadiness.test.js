import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { afterAll, beforeEach, describe, expect, it as vitestIt, vi } from 'vitest';

import { ownTestBodies } from '../lib/mockPathsDataRoot.js';

const owned = ownTestBodies(vitestIt);
const it = owned.it;

// The CoS agent registry is the one collaborator these fixtures cannot supply:
// the temp repos are not a PortOS install, so the live registry read fails
// closed and every verdict would come back blocked on it. Doubled as "no agents
// running" — the condition each case below is actually about.
vi.mock('./cosAgentLifecycle.js', () => ({ getAgents: async () => [] }));

// Otherwise real git repositories, not a mocked porcelain string: this module
// decides whether an UNATTENDED process may move a user's checkout, and the
// thing that would make that wrong is git behaving differently from the fixture.
const { checkUpdateRepoReadiness, prepareUpdateRepo } = await import('./updateRepoReadiness.js');

const repos = [];
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf-8' });

function makeRepo() {
  const origin = mkdtempSync(join(tmpdir(), 'portos-origin-'));
  const clone = mkdtempSync(join(tmpdir(), 'portos-clone-'));
  repos.push(origin, clone);
  git(origin, 'init', '--bare', '--initial-branch=main');
  git(process.cwd(), 'clone', origin, clone);
  git(clone, 'config', 'user.email', 'test@example.com');
  git(clone, 'config', 'user.name', 'Example Tester');
  writeFileSync(join(clone, 'README.md'), 'seed\n');
  writeFileSync(join(clone, 'package-lock.json'), '{"lockfileVersion":3}\n');
  git(clone, 'add', '-A');
  git(clone, 'commit', '-m', 'seed');
  git(clone, 'push', 'origin', 'main');
  git(clone, 'remote', 'set-head', 'origin', 'main');
  return clone;
}

function makeStaleSubmodule() {
  const dependency = makeRepo();
  const repo = makeRepo();
  const path = 'lib/dép with spaces';
  git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', dependency, path);
  git(repo, 'commit', '-am', 'add dependency');
  writeFileSync(join(dependency, 'README.md'), 'new dependency revision\n');
  git(dependency, 'commit', '-am', 'advance dependency');
  const pin = git(dependency, 'rev-parse', 'HEAD').trim();
  const checkout = join(repo, path);
  git(checkout, 'fetch', 'origin');
  // Same state as pulling a parent gitlink bump without updating submodules.
  git(repo, 'update-index', '--cacheinfo', `160000,${pin},${path}`);
  git(repo, 'commit', '-m', 'pin new dependency');
  git(repo, 'push', 'origin', 'main');
  return { repo, checkout, pin, path };
}

beforeEach(() => vi.restoreAllMocks());
// Fail-fast cancellation can finish Vitest's wrapper while its Git subprocess
// still owns the checkout. Drain those bodies before deleting the fixtures.
afterAll(async () => {
  try { await owned.drain(); } finally {
    repos.forEach((dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  }
});

describe('update repo readiness', () => {
  it('repairs a clean stale submodule without an agent, even with quoted paths', async () => {
    const { repo, checkout, pin, path } = makeStaleSubmodule();
    const before = await checkUpdateRepoReadiness({ repoPath: repo });
    expect(before).toMatchObject({ ready: false, needsAgent: false, reasons: [], repairable: ['update-submodules'], submodulePaths: [path] });
    const { verdict, actions } = await prepareUpdateRepo({ repoPath: repo });
    expect(verdict.ready).toBe(true);
    expect(actions).toEqual(['updated submodules to their pinned commits']);
    expect(git(checkout, 'rev-parse', 'HEAD').trim()).toBe(pin);
  });

  it('repairs a stale nested checkout without moving its already-pinned parent', async () => {
    const { repo: dependency, checkout, pin, path } = makeStaleSubmodule();
    const old = git(checkout, 'rev-parse', 'HEAD').trim();
    const repo = makeRepo();
    git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', dependency, 'lib/outer');
    git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive');
    git(repo, 'commit', '-am', 'add nested dependency');
    git(repo, 'push', 'origin', 'main');
    const outer = join(repo, 'lib/outer');
    const nested = join(outer, path);
    const outerHead = git(outer, 'rev-parse', 'HEAD');
    git(nested, 'checkout', old);
    const { verdict } = await prepareUpdateRepo({ repoPath: repo });
    expect(verdict).toMatchObject({ ready: true, needsAgent: false });
    expect(git(nested, 'rev-parse', 'HEAD').trim()).toBe(pin);
    expect(git(outer, 'rev-parse', 'HEAD')).toBe(outerHead);
  });

  for (const kind of ['edit', 'untracked', 'staged-pointer', 'local-commit']) it(`preserves submodule ${kind} as real work`, async () => {
    const { repo, checkout, pin, path } = makeStaleSubmodule();
    if (kind === 'edit') writeFileSync(join(checkout, 'README.md'), 'local edit\n');
    if (kind === 'untracked') writeFileSync(join(checkout, 'local.txt'), 'local file\n');
    if (kind === 'staged-pointer') git(repo, 'add', path);
    if (kind === 'local-commit') {
      git(checkout, 'checkout', pin);
      git(checkout, 'config', 'user.email', 'test@example.com');
      git(checkout, 'config', 'user.name', 'Example Tester');
      writeFileSync(join(checkout, 'README.md'), 'local commit\n');
      git(checkout, 'commit', '-am', 'unpublished dependency work');
    }
    const head = git(checkout, 'rev-parse', 'HEAD');
    const status = git(repo, 'status', '--porcelain');
    const { verdict, actions } = await prepareUpdateRepo({ repoPath: repo });
    expect(verdict).toMatchObject({ ready: false, needsAgent: true, reasons: ['uncommitted-changes'] });
    expect(actions).toEqual([]);
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repo, 'status', '--porcelain')).toBe(status);
  });

  it('reports a clean checkout on the default branch as ready', async () => {
    const verdict = await checkUpdateRepoReadiness({ repoPath: makeRepo() });
    expect(verdict).toMatchObject({ ready: true, needsAgent: false, branch: 'main', defaultBranch: 'main', reasons: [], repairable: [] });
  });

  // Uncommitted work is the case the whole gate exists for: update.sh would
  // stash it and print recovery instructions nobody is there to read.
  it('refuses uncommitted work and escalates it rather than repairing it', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'README.md'), 'edited by the user\n');
    const verdict = await checkUpdateRepoReadiness({ repoPath: repo });
    expect(verdict).toMatchObject({ ready: false, needsAgent: true });
    expect(verdict.reasons).toContain('uncommitted-changes');
    expect(verdict.repairable).toEqual([]);
  });

  it('refuses a local commit that is not on origin', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'README.md'), 'local work\n');
    git(repo, 'commit', '-am', 'local only');
    const verdict = await checkUpdateRepoReadiness({ repoPath: repo });
    expect(verdict).toMatchObject({ ready: false, needsAgent: true, ahead: 1 });
    expect(verdict.reasons).toContain('unpushed-commits');
  });

  it('refuses an interrupted merge', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, '.git', 'MERGE_HEAD'), 'deadbeef\n');
    const verdict = await checkUpdateRepoReadiness({ repoPath: repo });
    expect(verdict).toMatchObject({ ready: false, needsAgent: true, interrupted: 'merge' });
  });

  // A clean feature branch loses nothing when the checkout moves: the commits
  // stay on the branch ref. That is what makes this remedy safe unattended.
  it('switches a clean feature branch back to the default branch itself', async () => {
    const repo = makeRepo();
    git(repo, 'checkout', '-b', 'feature/example');
    writeFileSync(join(repo, 'README.md'), 'feature work\n');
    git(repo, 'commit', '-am', 'feature commit');

    const before = await checkUpdateRepoReadiness({ repoPath: repo });
    expect(before).toMatchObject({ ready: false, needsAgent: false });
    expect(before.repairable).toContain('checkout-default');

    const { verdict, actions } = await prepareUpdateRepo({ repoPath: repo });
    expect(actions).toContain('switched to main');
    expect(verdict).toMatchObject({ ready: true, branch: 'main' });
    // The branch — and its commit — still exist; nothing was discarded.
    expect(git(repo, 'branch', '--list', 'feature/example')).toContain('feature/example');
  });

  it('restores a rewritten lockfile without touching anything else', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'package-lock.json'), '{"lockfileVersion":3,"rewritten":true}\n');
    const before = await checkUpdateRepoReadiness({ repoPath: repo });
    expect(before).toMatchObject({ ready: false, needsAgent: false, reasons: [], repairable: ['restore-lockfiles'] });

    const { verdict, actions } = await prepareUpdateRepo({ repoPath: repo });
    expect(actions.join(' ')).toMatch(/lockfile/);
    expect(verdict.ready).toBe(true);
  });

  // The refusal a live agent in this very checkout earns: update.sh's pm2
  // restart, and the branch move, would both land on top of its work.
  it('refuses while a CoS agent is working in the checkout', async () => {
    const repo = makeRepo();
    const lifecycle = await import('./cosAgentLifecycle.js');
    vi.spyOn(lifecycle, 'getAgents').mockResolvedValue([
      { id: 'agent-1', status: 'running', metadata: { workspacePath: repo } },
    ]);
    const verdict = await checkUpdateRepoReadiness({ repoPath: repo });
    expect(verdict).toMatchObject({ ready: false, needsAgent: true });
    expect(verdict.reasons).toContain('agent-at-work');
  });

  // A dirty feature branch must NOT be silently moved — the checkout that would
  // carry the dirt along is exactly the surprise this gate prevents.
  it('does not move a dirty feature branch', async () => {
    const repo = makeRepo();
    git(repo, 'checkout', '-b', 'feature/dirty');
    writeFileSync(join(repo, 'README.md'), 'work in progress\n');
    const { verdict, actions } = await prepareUpdateRepo({ repoPath: repo });
    expect(actions).toEqual([]);
    expect(verdict).toMatchObject({ ready: false, needsAgent: true, branch: 'feature/dirty' });
  });
});

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

beforeEach(() => vi.restoreAllMocks());
afterAll(() => repos.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('update repo readiness', () => {
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

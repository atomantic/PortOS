import { beforeEach, describe, expect, it, vi } from 'vitest';

const execGitMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/execGit.js', () => ({ execGit: execGitMock }));

import { updateDefaultBranch } from './git.js';

const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr = '', exitCode = 1) => ({ stdout: '', stderr, exitCode });
const key = (args) => args.join(' ');
const commands = () => execGitMock.mock.calls.map(([args]) => key(args));

const base = {
  'fetch origin': ok(),
  'symbolic-ref --short refs/remotes/origin/HEAD': ok('origin/main'),
  'rev-parse --verify refs/remotes/origin/main': ok('a'.repeat(40)),
  'status --porcelain': ok(),
  'rev-parse --abbrev-ref HEAD': ok('feature/work'),
  'checkout main': ok('Switched to branch main'),
  'pull --ff-only origin main': ok('Already up to date')
};

const withGit = (overrides = {}) => {
  const table = { ...base, ...overrides };
  execGitMock.mockImplementation((args) => Promise.resolve(table[key(args)] ?? ok()));
};

beforeEach(() => {
  execGitMock.mockReset();
  withGit();
});

describe('updateDefaultBranch', () => {
  it('checks out origin default branch and fast-forwards it without a rebase', async () => {
    const result = await updateDefaultBranch('/repo');

    expect(result).toMatchObject({ success: true, branch: 'main', conflict: false });
    expect(commands()).toEqual(expect.arrayContaining([
      'fetch origin',
      'checkout main',
      'pull --ff-only origin main'
    ]));
    expect(commands().some(command => command.includes('rebase'))).toBe(false);
  });

  it('rebases with --autostash when the checkout is dirty or diverged', async () => {
    withGit({
      'status --porcelain': ok(' M package-lock.json'),
      'pull --ff-only origin main': fail('fatal: Not possible to fast-forward, aborting.')
    });

    const result = await updateDefaultBranch('/repo');

    expect(result).toMatchObject({ success: true, branch: 'main', conflict: false, rebased: true });
    expect(commands()).toContain('pull --rebase --autostash origin main');
    expect(commands()).toContain('diff --name-only --diff-filter=U');
    expect(commands()).not.toContain('rebase --abort');
  });

  it('reports a conflict and aborts the rebase when --autostash cannot reconcile', async () => {
    withGit({
      'pull --ff-only origin main': fail('fatal: Not possible to fast-forward, aborting.'),
      // Git splits a failed pull across both streams: fetch progress on stderr,
      // the lines naming the colliding files on stdout.
      'pull --rebase --autostash origin main': {
        stdout: 'CONFLICT (content): Merge conflict in server/index.js',
        stderr: 'From github.com:example/example\nerror: could not apply 1a2b3c4',
        exitCode: 1
      }
    });

    const result = await updateDefaultBranch('/repo');

    expect(result).toMatchObject({ success: false, branch: 'main', conflict: true });
    // The file that collided has to survive into the message — it is the whole
    // actionable content of the CoS task the caller queues from this.
    expect(result.error).toContain('CONFLICT (content): Merge conflict in server/index.js');
    expect(result.error).toContain('could not apply 1a2b3c4');
    expect(commands()).toContain('rebase --abort');
  });

  it('reports a conflict when the autostash re-apply collides, which git exits 0 on', async () => {
    // `--autostash` re-applies the stash AFTER the rebase finishes and git only
    // WARNS when that apply conflicts, so exit status alone would call this a
    // clean update and let the caller build and restart on a conflicted tree.
    withGit({
      'pull --ff-only origin main': fail('fatal: Not possible to fast-forward, aborting.'),
      'pull --rebase --autostash origin main': ok('Applying autostash resulted in conflicts.'),
      'diff --name-only --diff-filter=U': ok('server/index.js\nclient/src/App.jsx\n')
    });

    const result = await updateDefaultBranch('/repo');

    expect(result).toMatchObject({ success: false, branch: 'main', conflict: true });
    expect(result.error).toContain('server/index.js, client/src/App.jsx');
    // The rebase already completed, so there is nothing to abort.
    expect(commands()).not.toContain('rebase --abort');
  });

  it('reports a conflict when local changes block the branch switch', async () => {
    withGit({
      'checkout main': fail('error: Your local changes to the following files would be overwritten by checkout')
    });

    const result = await updateDefaultBranch('/repo');

    expect(result).toMatchObject({ success: false, branch: 'main', conflict: true });
    expect(result.error).toMatch(/local changes/);
    expect(commands()).not.toContain('pull --ff-only origin main');
    expect(commands()).not.toContain('rebase --abort');
  });
});

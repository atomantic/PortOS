import { beforeEach, describe, expect, it, vi } from 'vitest';

const execGitMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/execGit.js', () => ({ execGit: execGitMock }));

import { updateDefaultBranch } from './git.js';

const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
const key = (args) => args.join(' ');

beforeEach(() => {
  execGitMock.mockReset();
  execGitMock.mockImplementation((args) => Promise.resolve({
    'fetch origin': ok(),
    'symbolic-ref --short refs/remotes/origin/HEAD': ok('origin/main'),
    'rev-parse --verify refs/remotes/origin/main': ok('a'.repeat(40)),
    'status --porcelain': ok(),
    'rev-parse --abbrev-ref HEAD': ok('feature/work'),
    'checkout main': ok('Switched to branch main'),
    'pull --ff-only origin main': ok('Already up to date')
  }[key(args)] ?? ok()));
});

describe('updateDefaultBranch', () => {
  it('checks out origin default branch and fast-forwards it without a rebase', async () => {
    const result = await updateDefaultBranch('/repo');

    expect(result).toMatchObject({ success: true, branch: 'main' });
    expect(execGitMock.mock.calls.map(([args]) => key(args))).toEqual(expect.arrayContaining([
      'fetch origin',
      'checkout main',
      'pull --ff-only origin main'
    ]));
    expect(execGitMock.mock.calls.map(([args]) => key(args)).some(command => command.includes('rebase'))).toBe(false);
  });

  it('refuses to switch branches while the checkout has local changes', async () => {
    execGitMock.mockImplementation((args) => Promise.resolve({
      'fetch origin': ok(),
      'symbolic-ref --short refs/remotes/origin/HEAD': ok('origin/main'),
      'rev-parse --verify refs/remotes/origin/main': ok('a'.repeat(40)),
      'status --porcelain': ok(' M package-lock.json')
    }[key(args)] ?? ok()));

    await expect(updateDefaultBranch('/repo')).rejects.toThrow(/local changes/);
    expect(execGitMock.mock.calls.map(([args]) => key(args))).not.toContain('checkout main');
  });
});

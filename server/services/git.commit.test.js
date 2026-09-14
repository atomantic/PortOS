import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/execGit.js', () => {
  const execGit = vi.fn();
  return { execGit, execGitSafe: (...args) => execGit(...args) };
});

import { execGit } from '../lib/execGit.js';
import { commit } from './git.js';

beforeEach(() => {
  vi.clearAllMocks();
  execGit.mockResolvedValue({ stdout: '[main abc1234] chore: example\n', stderr: '', exitCode: 0 });
});

// Uniquely pins that an automated commit cannot sweep in files the user staged.
describe('commit', () => {
  it('scopes the commit to literal pathspecs when paths are given', async () => {
    await expect(commit('/repo/example-app', 'chore: example', { paths: ['.quality.json', 'app/[id].jsx'] }))
      .resolves.toEqual({ hash: 'abc1234', message: 'chore: example' });
    expect(execGit).toHaveBeenCalledWith(
      ['commit', '-m', 'chore: example', '--', ':(literal).quality.json', ':(literal)app/[id].jsx'],
      '/repo/example-app'
    );
  });

  it('commits the index unchanged when no paths are given and rejects unsafe ones', async () => {
    await commit('/repo/example-app', 'chore: example');
    expect(execGit).toHaveBeenCalledWith(['commit', '-m', 'chore: example'], '/repo/example-app');
    await commit('/repo/example-app', 'chore: example', {});
    expect(execGit).toHaveBeenLastCalledWith(['commit', '-m', 'chore: example'], '/repo/example-app');
    await expect(commit('/repo/example-app', 'chore: example', { paths: ['../escape.json'] })).rejects.toThrow('Invalid file path');
  });
});

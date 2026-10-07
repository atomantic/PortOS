import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'fs/promises';
import { makeGitSandbox } from '../lib/gitTestRepo.js';
import { execGit, suggestPRTitle } from './git.js';

let scratch;
afterEach(async () => { if (scratch) await rm(scratch, { recursive: true, force: true }); });

describe('PR title provenance with real git history', () => {
  it('excludes already-published commits despite stale local main and preserves quoted subjects', async () => {
    const fixture = await makeGitSandbox({ origin: true });
    scratch = fixture.scratch;
    const { repo } = fixture;
    await execGit(['checkout', '-b', 'audit'], repo);
    await execGit(['commit', '--allow-empty', '-m', 'chore: publish PortOS quality snapshot'], repo);
    await execGit(['push', 'origin', 'HEAD:main'], repo);
    await execGit(['commit', '--allow-empty', '-m', 'fix: preserve "unknown" call status'], repo);
    await execGit(['commit', '--allow-empty', '-m', 'test: cover follow-up'], repo);
    expect(await suggestPRTitle(repo, 'main', 'audit', 'fallback')).toBe('fix: preserve "unknown" call status');
  });

  it('supports local-only repositories and falls back when the branch has no commits', async () => {
    const fixture = await makeGitSandbox();
    scratch = fixture.scratch;
    const { repo } = fixture;
    expect(await suggestPRTitle(repo, 'main', 'main', 'Audit task\nMore detail')).toBe('Audit task');
    await execGit(['checkout', '-b', 'audit'], repo);
    await execGit(['commit', '--allow-empty', '-m', 'fix: local task'], repo);
    expect(await suggestPRTitle(repo, 'main', 'audit', 'fallback')).toBe('fix: local task');
  });
});

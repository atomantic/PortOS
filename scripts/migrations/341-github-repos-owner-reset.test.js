import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import migration from './341-github-repos-owner-reset.js';

describe('migration 341 — github-repos.json stale owner reset', () => {
  let rootDir;
  let reposPath;

  const writeRepos = (data) => {
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    writeFileSync(reposPath, `${JSON.stringify(data, null, 2)}\n`);
  };
  const readRepos = () => JSON.parse(readFileSync(reposPath, 'utf8'));

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-341-'));
    reposPath = join(rootDir, 'data', 'github-repos.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('skips a fresh install with no github-repos.json', async () => {
    await expect(migration.up({ rootDir })).resolves.toEqual({
      reset: false,
      reason: 'no readable github-repos.json',
    });
  });

  it('resets a cache still carrying the shipped default owner', async () => {
    writeRepos({
      repos: {
        'atomantic/portos': { fullName: 'atomantic/portos', flags: {}, managedSecrets: [] },
      },
      secrets: {},
      lastRepoSync: '2026-01-01T00:00:00.000Z',
      githubUser: 'atomantic',
    });

    await expect(migration.up({ rootDir })).resolves.toEqual({ reset: true });

    const data = readRepos();
    expect(data.githubUser).toBeNull();
    // The repo map is left alone — a real sync reattaches flags/managedSecrets
    // by fullName regardless of which account they were last tagged under.
    expect(data.repos['atomantic/portos']).toEqual({
      fullName: 'atomantic/portos',
      flags: {},
      managedSecrets: [],
    });
  });

  it('leaves an install alone once it has synced under a real, different account', async () => {
    writeRepos({
      repos: {},
      secrets: {},
      lastRepoSync: '2026-01-01T00:00:00.000Z',
      githubUser: 'example-user',
    });

    await expect(migration.up({ rootDir })).resolves.toEqual({
      reset: false,
      reason: 'githubUser is not the shipped default',
    });
    expect(readRepos().githubUser).toBe('example-user');
  });

  it('is idempotent — a second run on an already-reset cache is a no-op', async () => {
    writeRepos({ repos: {}, secrets: {}, lastRepoSync: null, githubUser: 'atomantic' });

    await migration.up({ rootDir });
    await expect(migration.up({ rootDir })).resolves.toEqual({
      reset: false,
      reason: 'githubUser is not the shipped default',
    });
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execGit } from '../lib/execGit.js';
import { inputsUnchangedSince, readHead } from './taskInputGate.js';

// Real git on a scratch repo: the pathspec and the failure-means-run contract
// are what the scheduler gate relies on.
describe('taskInputGate', () => {
  let repo;
  const commit = async (file, body) => {
    mkdirSync(join(repo, file, '..'), { recursive: true });
    writeFileSync(join(repo, file), body);
    await execGit(['add', '-A'], repo);
    await execGit(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', file], repo);
    return readHead(repo);
  };
  const paths = ['scripts/migrations/', 'server/services/backupRestore*'];

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'input-gate-'));
    await execGit(['init', '-q'], repo);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('is unchanged only while no declared path differs from the baseline', async () => {
    const base = await commit('scripts/migrations/001.js', 'a');
    await commit('docs/unrelated.md', 'x');
    expect(await inputsUnchangedSince({ repoPath: repo, lastCleanHead: base, inputPaths: paths })).toBe(true);
    await commit('server/services/backupRestoreFoo.js', 'y');
    expect(await inputsUnchangedSince({ repoPath: repo, lastCleanHead: base, inputPaths: paths })).toBe(false);
  });

  it('answers false (run the audit) on a missing, malformed or unknown baseline', async () => {
    for (const lastCleanHead of [null, '--output=x', 'f'.repeat(40)]) {
      expect(await inputsUnchangedSince({ repoPath: repo, lastCleanHead, inputPaths: paths })).toBe(false);
    }
  });
});

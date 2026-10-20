import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { materializeGitRepo } from '../lib/gitTestRepo.js';
import { readLocalBranchPresence, readCheckoutPathPresence } from './repoCleanupObservation.js';

const races = vi.hoisted(() => ({ afterLookup: null }));
vi.mock('../lib/execGit.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, execGit: async (...args) => {
    const result = await actual.execGit(...args);
    if (args[0][0] === 'show-ref' && races.afterLookup) await races.afterLookup();
    return result;
  } };
});

describe('exact local branch absence accounting', () => {
  let root;
  beforeEach(async () => {
    races.afterLookup = null;
    root = await mkdtemp(join(tmpdir(), 'portos-ref-observation-'));
    await materializeGitRepo(root, { identity: { name: 'Test', email: 'test@example.com' } });
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  it('recognizes a broken leaf symlink as occupied rather than removed', async () => {
    const link = join(root, 'vanished-checkout');
    await symlink(join(root, 'missing-target'), link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(await readCheckoutPathPresence(link)).toBe(true);
    expect(await readCheckoutPathPresence(join(root, 'absent'))).toBe(false);
  });

  it('distinguishes occupied, absent and malformed loose references without repairing them', async () => {
    expect(await readLocalBranchPresence(root, 'main')).toBe(true);
    expect(await readLocalBranchPresence(root, 'claim/absent')).toBe(false);
    await mkdir(join(root, '.git', 'refs', 'heads', 'claim'), { recursive: true });
    await writeFile(join(root, '.git', 'refs', 'heads', 'claim', 'absent'), 'invalid occupied ref\n');
    expect(await readLocalBranchPresence(root, 'claim/absent')).toBe(null);
  });
  it.each(['loose', 'packed'])('withholds absence if %s metadata changes during the final observation', async kind => {
    let count = 0;
    races.afterLookup = async () => {
      if (++count !== 2) return;
      if (kind === 'loose') {
        await mkdir(join(root, '.git', 'refs', 'heads', 'claim'), { recursive: true });
        await writeFile(join(root, '.git', 'refs', 'heads', 'claim', 'absent'), 'malformed late ref\n');
      } else await writeFile(join(root, '.git', 'packed-refs'), `${'a'.repeat(40)} refs/heads/claim/absent trailing-token\n`);
    };
    expect(await readLocalBranchPresence(root, 'claim/absent')).toBe(null);
    expect(count).toBe(2);
  });
  it.each([
    ['invalid ref grammar', Buffer.from(`${'a'.repeat(40)} refs/heads/a..b\n`)],
    ['invalid encoding', Buffer.concat([Buffer.from(`${'a'.repeat(40)} refs/heads/`), Buffer.from([0xff]), Buffer.from('\n')])],
    ['orphan peeled row', Buffer.from(`^${'a'.repeat(40)}\n`)],
  ])('keeps %s in packed refs unknown rather than proving absence', async (_name, bytes) => {
    await writeFile(join(root, '.git', 'packed-refs'), bytes);
    expect(await readLocalBranchPresence(root, 'claim/absent')).toBe(null);
  });

  it('refuses malformed packed metadata and unknown repository errors as absence proof', async () => {
    await writeFile(join(root, '.git', 'packed-refs'), `${'a'.repeat(40)} refs/heads/claim/absent trailing-token\n`);
    expect(await readLocalBranchPresence(root, 'claim/absent')).toBe(null);
    expect(await readLocalBranchPresence(join(root, 'missing'), 'claim/absent')).toBe(null);
    expect(await readLocalBranchPresence(root, '../bad')).toBe(null);
  });
});

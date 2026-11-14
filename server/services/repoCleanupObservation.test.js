import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { materializeGitRepo } from '../lib/gitTestRepo.js';
import { readLocalBranchPresence, readCheckoutPathPresence } from './repoCleanupObservation.js';

describe('exact local branch absence accounting', () => {
  let root;
  beforeEach(async () => {
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
  it('keeps a corrupt packed-refs file unknown rather than proving absence', async () => {
    await writeFile(join(root, '.git', 'packed-refs'), Buffer.from(`^${'a'.repeat(40)}\n`));
    expect(await readLocalBranchPresence(root, 'claim/absent')).toBe(null);
  });

  it('refuses unknown repository errors as absence proof', async () => {
    expect(await readLocalBranchPresence(join(root, 'missing'), 'claim/absent')).toBe(null);
    expect(await readLocalBranchPresence(root, '../bad')).toBe(null);
  });
});

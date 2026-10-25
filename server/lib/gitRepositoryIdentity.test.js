import { afterEach, describe, expect, it } from 'vitest';
import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { execGit } from './execGit.js';
import { makeGitSandbox, destroyGitSandbox } from './gitTestRepo.js';
import { readGitCommonDirectory } from './gitRepositoryIdentity.js';

let scratch;
afterEach(async () => { if (scratch) await destroyGitSandbox(scratch); });

describe('repository ownership identity', () => {
  it('shares identity across aliases and linked checkouts but never independent clones', async () => {
    const sandbox = await makeGitSandbox();
    scratch = sandbox.scratch;
    const { repo } = sandbox;
    const linked = join(scratch, 'linked');
    const clone = join(scratch, 'clone');
    const alias = join(scratch, 'alias');
    await execGit(['worktree', 'add', '--detach', linked, 'HEAD'], repo);
    await execGit(['clone', '--no-local', repo, clone], scratch);
    await symlink(repo, alias, 'junction');
    const identity = await readGitCommonDirectory(repo);
    expect(identity).toBeTruthy();
    expect(await readGitCommonDirectory(alias)).toBe(identity);
    expect(await readGitCommonDirectory(linked)).toBe(identity);
    const independent = await readGitCommonDirectory(clone);
    expect(independent).toBeTruthy();
    expect(independent).not.toBe(identity);
    expect(await readGitCommonDirectory(join(scratch, 'missing'))).toBeNull();
    expect(await readGitCommonDirectory(undefined)).toBeNull();
  });
});

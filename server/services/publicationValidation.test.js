import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { makeGitSandbox } from '../lib/gitTestRepo.js';
import { execGit } from '../lib/execGit.js';
import { validatePublication } from './publicationValidation.js';

let scratch;
afterEach(async () => { if (scratch) await rm(scratch, { recursive: true, force: true }); });
async function fixture(body = 'process.exit(0)') {
  const { repo, scratch: root } = await makeGitSandbox();
  scratch = root;
  await mkdir(join(repo, 'scripts'), { recursive: true });
  await writeFile(join(repo, 'scripts/pregate.js'), body);
  await execGit(['add', '.'], repo);
  await execGit(['commit', '-m', 'fixture validator'], repo);
  return { context: { agentId: 'agent-check', worktreePath: repo, sourceWorkspace: repo,
    originalTask: { metadata: { app: 'portos-default' } } }, deps: { getApp: async () => ({ repoPath: repo }) } };
}

describe('PortOS publication validation', () => {
  it('executes the fixed script and accepts a clean unchanged HEAD with its completion sentinel', async () => {
    const { context, deps } = await fixture();
    await writeFile(join(context.worktreePath, '.agent-done-agent-check'), 'done');
    expect(await validatePublication(context, deps)).toMatchObject({ status: 'passed', exitCode: 0 });
    await writeFile(join(context.worktreePath, 'untracked-work.txt'), 'preserve this');
    expect(await validatePublication(context, deps)).toMatchObject({ status: 'blocked', reason: 'uncommitted-work' });
  });
  it('preserves validation nonzero as a gate result rather than asserting tests failed', async () => {
    const { context, deps } = await fixture('console.error("lint or setup failure"); process.exit(2)');
    expect(await validatePublication(context, deps)).toMatchObject({ status: 'blocked', reason: 'pregate-nonzero', exitCode: 2 });
  });
  it('blocks validator-created work even when the script reports success', async () => {
    const { context, deps } = await fixture('require("node:fs").writeFileSync("generated.txt", "changed")');
    expect(await validatePublication(context, deps)).toMatchObject({ status: 'blocked', reason: 'worktree-changed' });
  });
  it('blocks a HEAD changed during validation', async () => {
    const { context, deps } = await fixture();
    deps.run = async () => {
      await execGit(['commit', '--allow-empty', '-m', 'concurrent change'], context.worktreePath);
      return { success: true, code: 0 };
    };
    expect(await validatePublication(context, deps)).toMatchObject({ status: 'blocked', reason: 'head-changed' });
  });
  it.each([
    [{ success: false, timedOut: true, code: -1 }, 'timeout'],
    [{ success: false, error: new Error('spawn failed'), code: -1 }, 'execution-failed'],
  ])('distinguishes execution failure from check failure', async (result, reason) => {
    const { context, deps } = await fixture();
    deps.run = vi.fn(async () => result);
    expect(await validatePublication(context, deps)).toMatchObject({ status: 'blocked', reason });
    expect(deps.run).toHaveBeenCalledWith(process.execPath, ['scripts/pregate.js'], expect.objectContaining({ shell: false, cwd: context.worktreePath }));
  });
  it('does not infer a command for other managed apps or run against a mismatched source', async () => {
    const { context, deps } = await fixture();
    deps.run = vi.fn();
    expect(await validatePublication({ ...context, originalTask: { metadata: { app: 'other-app' } } }, deps)).toEqual({ status: 'not-required' });
    deps.getApp = async () => ({ repoPath: scratch });
    expect(await validatePublication(context, deps)).toMatchObject({ status: 'blocked', reason: 'source-mismatch' });
    expect(deps.run).not.toHaveBeenCalled();
  });
});

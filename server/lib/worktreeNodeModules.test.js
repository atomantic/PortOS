import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  assertLinkWithinWorktree,
  provisionWorkspaceNodeModules,
  removeProvisionedNodeModules,
} from './worktreeNodeModules.js';

let root;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function fixture() {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'portos-worktree-nm-')));
  const source = join(root, 'source');
  const worktree = join(root, 'worktree');
  mkdirSync(join(source, 'node_modules', 'left-pad'), { recursive: true });
  mkdirSync(join(source, 'node_modules', '@acme'), { recursive: true });
  mkdirSync(join(source, 'packages', 'core'), { recursive: true });
  mkdirSync(join(worktree, 'packages', 'core'), { recursive: true });
  symlinkSync('../../packages/core', join(source, 'node_modules', '@acme', 'core'), 'dir');
  return { source, worktree };
}

describe('worktree node_modules provisioning', () => {
  it('creates nothing when the source has no workspace links', async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'portos-worktree-nm-')));
    mkdirSync(join(root, 'source', 'node_modules', 'left-pad'), { recursive: true });
    mkdirSync(join(root, 'worktree'));
    expect(await provisionWorkspaceNodeModules(join(root, 'source'), join(root, 'worktree'))).toBe(false);
    expect(existsSync(join(root, 'worktree', 'node_modules'))).toBe(false);
  });

  it('rejects a link that resolves outside the worktree', async () => {
    const { source, worktree } = fixture();
    mkdirSync(join(worktree, 'node_modules'));
    symlinkSync(join(source, 'packages', 'core'), join(worktree, 'node_modules', 'escaped'), 'dir');
    await expect(assertLinkWithinWorktree(worktree, join(worktree, 'node_modules', 'escaped'))).rejects.toThrow('outside the worktree');
  });

  it('removes only a provisioned directory, leaving a real install untouched', async () => {
    const { source, worktree } = fixture();
    expect(await provisionWorkspaceNodeModules(source, worktree)).toBe(true);
    await removeProvisionedNodeModules(source, worktree);
    expect(existsSync(join(worktree, 'node_modules'))).toBe(false);
    expect(existsSync(join(source, 'node_modules', '@acme', 'core'))).toBe(true);

    // An npm-installed tree has the same workspace links but no marker.
    mkdirSync(join(worktree, 'node_modules', '@acme'), { recursive: true });
    symlinkSync('../../packages/core', join(worktree, 'node_modules', '@acme', 'core'), 'dir');
    await removeProvisionedNodeModules(source, worktree);
    expect(lstatSync(join(worktree, 'node_modules', '@acme', 'core')).isSymbolicLink()).toBe(true);
  });

  it('keeps real packages added to a provisioned directory when it is removed', async () => {
    const { source, worktree } = fixture();
    await provisionWorkspaceNodeModules(source, worktree);
    rmSync(join(worktree, 'node_modules', 'left-pad'));
    mkdirSync(join(worktree, 'node_modules', 'left-pad'));
    writeFileSync(join(worktree, 'node_modules', 'left-pad', 'index.js'), '');
    await removeProvisionedNodeModules(source, worktree);
    expect(readdirSync(join(worktree, 'node_modules'))).toEqual(['left-pad']);
  });
});

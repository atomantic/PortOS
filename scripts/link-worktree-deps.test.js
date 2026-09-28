import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rmdir, stat, readlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { linkWorktreeDependencies } from '../server/services/worktreeManager.js';

describe('link-worktree-deps', () => {
  let tempDir;
  let sourceDir;
  let worktreeDir;

  beforeEach(async () => {
    // Create temporary directories for testing
    const timestamp = Date.now();
    tempDir = join(tmpdir(), `link-deps-test-${timestamp}`);
    sourceDir = join(tempDir, 'source');
    worktreeDir = join(tempDir, 'worktree');

    await mkdir(sourceDir, { recursive: true });
    await mkdir(join(sourceDir, 'client'), { recursive: true });
    await mkdir(join(sourceDir, 'server'), { recursive: true });
    await mkdir(join(sourceDir, 'node_modules'), { recursive: true });
    await mkdir(join(sourceDir, 'client', 'node_modules'), { recursive: true });
    await mkdir(join(sourceDir, 'server', 'node_modules'), { recursive: true });
    await mkdir(join(sourceDir, 'unrelated'), { recursive: true });

    // Create package.json files so the helper recognizes client/server as needing symlinks
    await Promise.all([
      writeFile(join(sourceDir, 'package.json'), '{}'),
      writeFile(join(sourceDir, 'client', 'package.json'), '{}'),
      writeFile(join(sourceDir, 'server', 'package.json'), '{}'),
    ]);

    await mkdir(worktreeDir, { recursive: true });
    await mkdir(join(worktreeDir, 'client'), { recursive: true });
    await mkdir(join(worktreeDir, 'server'), { recursive: true });

    await Promise.all([
      writeFile(join(worktreeDir, 'package.json'), '{}'),
      writeFile(join(worktreeDir, 'client', 'package.json'), '{}'),
      writeFile(join(worktreeDir, 'server', 'package.json'), '{}'),
    ]);
  });

  afterEach(async () => {
    // Cleanup
    if (tempDir) {
      try {
        execSync(`rm -rf "${tempDir}"`);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  it('creates symlinks for root, client, and server node_modules', async () => {
    await linkWorktreeDependencies(sourceDir, worktreeDir);

    // Verify symlinks were created
    const rootLink = await readlink(join(worktreeDir, 'node_modules'));
    expect(rootLink).toBe(join(sourceDir, 'node_modules'));

    const clientLink = await readlink(join(worktreeDir, 'client', 'node_modules'));
    expect(clientLink).toBe(join(sourceDir, 'client', 'node_modules'));

    const serverLink = await readlink(join(worktreeDir, 'server', 'node_modules'));
    expect(serverLink).toBe(join(sourceDir, 'server', 'node_modules'));
  });

  it('preserves pre-existing entries without modifying them', async () => {
    // Create a pre-existing directory (not a symlink) for client node_modules
    // This should be preserved
    await mkdir(join(worktreeDir, 'client', 'node_modules', 'existing-dep'), { recursive: true });

    // Run the link function
    await linkWorktreeDependencies(sourceDir, worktreeDir);

    // Verify the pre-existing directory structure in client/node_modules still exists
    const stat1 = await stat(join(worktreeDir, 'client', 'node_modules', 'existing-dep'));
    expect(stat1.isDirectory()).toBe(true);
    expect(stat1.isSymbolicLink()).toBe(false);

    // Server node_modules should have been created as a symlink (it wasn't pre-existing)
    const serverLink = await readlink(join(worktreeDir, 'server', 'node_modules'));
    expect(serverLink).toBe(join(sourceDir, 'server', 'node_modules'));
  });

  it('does not touch the primary checkout node_modules', async () => {
    const sourceNodeModulesStat = await stat(join(sourceDir, 'node_modules'));
    expect(sourceNodeModulesStat.isDirectory()).toBe(true);

    await linkWorktreeDependencies(sourceDir, worktreeDir);

    // Verify source is still an ordinary directory (not modified)
    const sourceNodeModuleStatAfter = await stat(join(sourceDir, 'node_modules'));
    expect(sourceNodeModuleStatAfter.isDirectory()).toBe(true);
    expect(sourceNodeModuleStatAfter.isSymbolicLink()).toBe(false);
  });

  it('skips missing source directories gracefully', async () => {
    // Remove the source node_modules (simulate a repo that doesn't have them)
    execSync(`rm -rf "${join(sourceDir, 'node_modules')}"`);

    // Should not throw
    await linkWorktreeDependencies(sourceDir, worktreeDir);

    // root node_modules should not exist in worktree since source doesn't have it
    const exists = await stat(join(worktreeDir, 'node_modules')).catch(() => null);
    expect(exists).toBeNull();
  });
});

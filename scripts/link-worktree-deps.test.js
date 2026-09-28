import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Drives the script the claim prompts run (#9052) end to end; the linking
// rules themselves are covered in server/services/worktreeManager.test.js.
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'link-worktree-deps.js');
const runScript = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

let root;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe('link-worktree-deps script', () => {
  it('links missing dependency dirs from the source checkout and keeps existing ones', () => {
    root = mkdtempSync(join(tmpdir(), 'portos-link-worktree-deps-'));
    const source = join(root, 'source');
    const worktree = join(root, 'worktree');
    for (const dir of ['node_modules', 'client/node_modules', 'server/node_modules']) {
      mkdirSync(join(source, dir), { recursive: true });
    }
    for (const pkg of ['client', 'server']) {
      mkdirSync(join(worktree, pkg), { recursive: true });
      writeFileSync(join(worktree, pkg, 'package.json'), '{}');
    }
    mkdirSync(join(worktree, 'client', 'node_modules'));

    const result = runScript(source, worktree);

    expect(result.status).toBe(0);
    expect(readlinkSync(join(worktree, 'node_modules'))).toBe(join(source, 'node_modules'));
    expect(readlinkSync(join(worktree, 'server', 'node_modules'))).toBe(join(source, 'server', 'node_modules'));
    expect(lstatSync(join(worktree, 'client', 'node_modules')).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(source, 'node_modules')).isSymbolicLink()).toBe(false);
  });

  it('exits non-zero without both paths', () => {
    const result = runScript('/only-one-path');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage');
  });
});

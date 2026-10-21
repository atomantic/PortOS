import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
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

  it('resolves workspace links inside the worktree, not the source checkout (#12633)', () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'portos-link-worktree-deps-')));
    const source = join(root, 'source');
    const worktree = join(root, 'worktree');
    // Source install: a registry package, a workspace scope next to a registry scope entry, a bin shim.
    const modules = join(source, 'node_modules');
    mkdirSync(join(modules, 'left-pad'), { recursive: true });
    mkdirSync(join(modules, '@acme'), { recursive: true });
    mkdirSync(join(modules, '@types', 'node'), { recursive: true });
    mkdirSync(join(modules, '.bin'), { recursive: true });
    mkdirSync(join(source, 'packages', 'core'), { recursive: true });
    mkdirSync(join(worktree, 'packages', 'core'), { recursive: true });
    writeFileSync(join(source, 'packages', 'core', 'marker.txt'), 'stale');
    writeFileSync(join(worktree, 'packages', 'core', 'marker.txt'), 'fresh');
    writeFileSync(join(modules, 'left-pad', 'index.js'), 'source');
    writeFileSync(join(modules, '@types', 'node', 'index.d.ts'), 'source');
    symlinkSync('../../packages/core', join(modules, '@acme', 'core'), 'dir');
    symlinkSync('../left-pad', join(modules, '.bin', 'left-pad'), 'dir');

    const result = runScript(source, worktree);

    expect(result.status).toBe(0);
    const linked = join(worktree, 'node_modules');
    expect(lstatSync(linked).isSymbolicLink()).toBe(false);
    // Windows reports the recreated relative target with backslashes.
    expect(readlinkSync(join(linked, '@acme', 'core')).replaceAll('\\', '/')).toBe('../../packages/core');
    expect(readFileSync(join(linked, '@acme', 'core', 'marker.txt'), 'utf8')).toBe('fresh');
    // Everything that is not a workspace link still shares the source's install.
    expect(readFileSync(join(linked, 'left-pad', 'index.js'), 'utf8')).toBe('source');
    expect(readFileSync(join(linked, '@types', 'node', 'index.d.ts'), 'utf8')).toBe('source');
    expect(existsSync(join(linked, '.bin', 'left-pad'))).toBe(true);

    // Already provisioned: a rerun leaves the directory exactly as it was.
    expect(runScript(source, worktree).status).toBe(0);
    expect(readFileSync(join(linked, '@acme', 'core', 'marker.txt'), 'utf8')).toBe('fresh');
  });

  it('replaces a cache-only root node_modules with a link to source dependencies', () => {
    root = mkdtempSync(join(tmpdir(), 'portos-link-worktree-deps-'));
    const source = join(root, 'source');
    const worktree = join(root, 'worktree');
    mkdirSync(join(source, 'node_modules'), { recursive: true });
    writeFileSync(join(source, 'node_modules', 'real-pkg.txt'), 'real');

    // Simulate vitest creating cache directories before linking
    mkdirSync(join(worktree, 'node_modules', '.vite'), { recursive: true });
    mkdirSync(join(worktree, 'node_modules', '.vitest-cache'), { recursive: true });
    mkdirSync(join(worktree, 'node_modules', '.cache'), { recursive: true });

    const result = runScript(source, worktree);

    expect(result.status).toBe(0);
    expect(lstatSync(join(worktree, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(worktree, 'node_modules'))).toBe(join(source, 'node_modules'));
    expect(readFileSync(join(worktree, 'node_modules', 'real-pkg.txt'), 'utf8')).toBe('real');
  });

  it('never removes a worktree node_modules holding real packages and logs a warning', () => {
    root = mkdtempSync(join(tmpdir(), 'portos-link-worktree-deps-'));
    const source = join(root, 'source');
    const worktree = join(root, 'worktree');
    mkdirSync(join(source, 'node_modules'), { recursive: true });
    writeFileSync(join(source, 'node_modules', 'source-pkg.txt'), 'source');

    // Real package directory inside worktree node_modules
    mkdirSync(join(worktree, 'node_modules', 'some-package'), { recursive: true });
    writeFileSync(join(worktree, 'node_modules', 'some-package', 'index.js'), 'custom');

    const result = runScript(source, worktree);

    expect(result.status).toBe(0);
    expect(lstatSync(join(worktree, 'node_modules')).isSymbolicLink()).toBe(false);
    expect(existsSync(join(worktree, 'node_modules', 'some-package', 'index.js'))).toBe(true);
    const output = (result.stderr || '') + (result.stdout || '');
    expect(output).toContain('⚠️');
    expect(output).toContain(join(worktree, 'node_modules'));
    // Source checkout real node_modules is never touched
    expect(existsSync(join(source, 'node_modules', 'source-pkg.txt'))).toBe(true);
  });

  it('exits non-zero without both paths', () => {
    const result = runScript('/only-one-path');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage');
  });
});

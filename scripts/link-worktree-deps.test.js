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

  it('reports a managed claim’s stale pnpm install without linking dependency paths', () => {
    root = mkdtempSync(join(tmpdir(), 'portos-link-worktree-deps-'));
    const source = join(root, 'source');
    const worktree = join(root, 'worktree');
    const receipt = join(source, 'node_modules', '.pnpm', 'lock.yaml');
    mkdirSync(dirname(receipt), { recursive: true });
    mkdirSync(worktree);
    const installed = "lockfileVersion: '9.0'\nimporters: {'.': {}}\n";
    writeFileSync(receipt, installed);
    writeFileSync(join(worktree, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nimporters: {'.': {dependencies: {example: 1.0.0}}}\n");

    const result = runScript(source, worktree, '--claim');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('node_modules stale in source');
    expect(result.stdout).toContain('install here with `pnpm install --frozen-lockfile`');
    expect(existsSync(join(worktree, 'node_modules'))).toBe(false);
    expect(readFileSync(receipt, 'utf8')).toBe(installed);
  });

  it('reports an unverified source when an installed managed root lacks a supported lockfile', () => {
    root = mkdtempSync(join(tmpdir(), 'portos-link-worktree-deps-'));
    const source = join(root, 'source');
    const worktree = join(root, 'worktree');
    mkdirSync(join(source, 'node_modules'), { recursive: true });
    mkdirSync(worktree);
    writeFileSync(join(worktree, 'yarn.lock'), '# yarn lockfile v1\n');

    const result = runScript(source, worktree, '--claim');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('source lockfile match unverified');
    expect(result.stdout).toContain('using the repository’s documented install procedure');
    expect(existsSync(join(worktree, 'node_modules'))).toBe(false);
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

describe('link-worktree-deps stale-install detection (#17511)', () => {
  const lock = version => JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/engine.io': { version } } });
  const setup = installed => {
    root = mkdtempSync(join(tmpdir(), 'portos-link-worktree-deps-'));
    const source = join(root, 'source');
    const worktree = join(root, 'worktree');
    mkdirSync(join(source, 'server', 'node_modules', 'engine.io'), { recursive: true });
    writeFileSync(join(source, 'server', 'node_modules', 'engine.io', 'package.json'), JSON.stringify({ version: installed }));
    mkdirSync(join(worktree, 'server'), { recursive: true });
    writeFileSync(join(worktree, 'server', 'package.json'), '{}');
    writeFileSync(join(worktree, 'server', 'package-lock.json'), lock('6.6.12'));
    return { source, worktree };
  };

  it('prints the stale packages without failing the link', () => {
    const { source, worktree } = setup('6.6.11');
    const result = runScript(source, worktree);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Worktree dependency consistency issues');
    expect(result.stdout).toContain('server: node_modules/engine.io: expected 6.6.12, installed 6.6.11');
    expect(result.stdout).toContain('Never run npm install/ci through the link');
  });

  it('stays quiet when the linked installs match the locks', () => {
    const { source, worktree } = setup('6.6.12');
    const result = runScript(source, worktree);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('Worktree dependency consistency issues');
  });
});

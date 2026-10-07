/**
 * Destructive-action guard for the clean-reinstall path (issue #5691).
 *
 * `cleanWorkspaceDeps` (and its `update.sh` / `update.ps1` twins) used to delete
 * `package-lock.json` whenever `git check-ignore` said the lockfile was ignored
 * — correct while the client and server locks were gitignored, dead since all
 * four workspace lockfiles became tracked. Restoring that delete would be silent
 * and dangerous: a `git pull` that changes a `package.json` would wipe the
 * committed lock and let `npm install` re-resolve transitive versions past the
 * `overrides` pins (which is how the node-tar / engine.io advisories are held
 * down), with no other detector in the suite.
 *
 * The behavioural test alone cannot catch that regression — the old code ran
 * `git check-ignore` with `cwd` pinned to the repo root, so it always answered
 * "not ignored" for a temp directory outside the checkout. So the premise (every
 * workspace lockfile is tracked) and the absence of the delete are asserted too.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, copyFileSync, utimesSync, renameSync, symlinkSync, lstatSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';
import { cleanWorkspaceDeps, WORKSPACES } from './ensure-deps.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every helper that wipes a workspace's installed deps before a reinstall. */
const REINSTALL_HELPERS = ['scripts/ensure-deps.js', 'update.sh', 'update.ps1'];

/** True when `source` can delete a workspace lockfile, or asks git whether it may. */
const deletesLockfile = (source) => (
  /check-ignore/.test(source)
  || /(rmSync|rm -f|rm -rf|Remove-Item)[^\n]*package-lock\.json/.test(source)
);

describe('clean reinstall keeps the committed lockfile (#5691)', () => {
  it('wipes node_modules and keeps the lockfile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'portos-ensure-deps-'));
    try {
      mkdirSync(join(dir, 'node_modules', 'left-over'), { recursive: true });
      writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3}');

      cleanWorkspaceDeps(dir);

      expect(existsSync(join(dir, 'node_modules'))).toBe(false);
      expect(existsSync(join(dir, 'package-lock.json'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The premise the deletion removal rests on. If a workspace lockfile is ever
  // untracked again, this fails first and says so — rather than the reinstall
  // path quietly reverting to a per-install lock nobody can reproduce.
  it('tracks a lockfile for every workspace ensure-deps cleans', () => {
    const tracked = new Set(
      execFileSync('git', ['ls-files', '*package-lock.json'], { cwd: REPO_ROOT, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
    );

    expect(WORKSPACES.length).toBeGreaterThan(0);
    for (const { dir, label } of WORKSPACES) {
      const lockPath = [relative(REPO_ROOT, dir), 'package-lock.json'].filter(Boolean).join('/');
      expect(tracked, `${label} lockfile must stay tracked`).toContain(lockPath);
    }
  });

  // The detector decides whether the scan below means anything, so it is
  // verified against both spellings of the removed path rather than trusted.
  it('deletesLockfile flags the removed delete path in every helper language', () => {
    expect(deletesLockfile("if (lockfileIsGitignored(dir)) rmSync(join(dir, 'package-lock.json'), { force: true });")).toBe(true);
    expect(deletesLockfile('if git check-ignore -q "$dir/package-lock.json"; then rm -f "$dir/package-lock.json"; fi')).toBe(true);
    expect(deletesLockfile('Remove-Item -Force "$Dir/package-lock.json" -ErrorAction SilentlyContinue')).toBe(true);
    expect(deletesLockfile("rmSync(join(dir, 'node_modules'), { recursive: true, force: true });")).toBe(false);
  });

  it('no reinstall helper deletes a workspace lockfile', () => {
    const offenders = REINSTALL_HELPERS.filter(
      (relativePath) => deletesLockfile(readFileSync(join(REPO_ROOT, relativePath), 'utf8'))
    );

    expect(offenders).toEqual([]);
  });
});

// Exercise the startup CLI against a disposable checkout. Only the npm process
// and native rebuild boundary are replaced; selection, cleanup and receipts use
// the real filesystem. No package manager touches this checkout's dependencies.
describe('startup dependency reconciliation', () => {
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'portos-deps-startup-'));
    mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
    mkdirSync(join(root, 'server', 'lib'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    copyFileSync(join(REPO_ROOT, 'scripts', 'ensure-deps.js'), join(root, 'scripts', 'ensure-deps.js'));
    copyFileSync(join(REPO_ROOT, 'scripts', 'lib', 'directInvocation.js'), join(root, 'scripts', 'lib', 'directInvocation.js'));
    writeFileSync(join(root, 'scripts', 'trusted-rebuilds.js'), `
      import { writeFileSync } from 'fs';
      import { join } from 'path';
      export const rebuildTrusted = () => true;
      export const patchInstalledDependencies = dir => writeFileSync(join(dir, 'node_modules', 'patch-applied'), 'patched');
    `);
    writeFileSync(join(root, 'server', 'lib', 'bufferedSpawn.js'), `
      import { fileURLToPath } from 'url';
      export const prepareCliSpawn = (command, args) => ({
        command: process.execPath,
        args: [fileURLToPath(new URL('../../fake-npm.js', import.meta.url)), ...args]
      });
    `);
    writeFileSync(join(root, 'fake-npm.js'), `
      import { mkdirSync, writeFileSync, readFileSync } from 'fs';
      import { join } from 'path';
      const dir = process.cwd();
      for (const file of ['pm2/package.json', 'vite/bin/vite.js', 'express/package.json', 'pg/package.json']) {
        mkdirSync(join(dir, 'node_modules', file, '..'), { recursive: true });
        writeFileSync(join(dir, 'node_modules', file), '{}');
      }
      writeFileSync(join(dir, 'node_modules', 'installed-lock.json'), readFileSync(join(dir, 'package-lock.json')));
      writeFileSync(join(dir, 'node_modules', '.package-lock.json'), '{}');
    `);
    for (const label of ['root', 'client', 'server', 'autofixer']) {
      const dir = label === 'root' ? root : join(root, label);
      mkdirSync(dir, { recursive: true });
      if (label !== 'root') writeFileSync(join(dir, 'package.json'), label === 'server' ? '{"type":"module"}' : '{}');
      writeFileSync(join(dir, 'package-lock.json'), '{"version":"old"}');
    }
    return {
      root,
      run: () => execFileSync(process.execPath, [join(root, 'scripts', 'ensure-deps.js')], { cwd: root, encoding: 'utf8', stdio: 'pipe' }),
      client: join(root, 'client'),
      receipt: join(root, 'data', 'deps-hashes.json'),
    };
  }

  // A worktree must never repair or patch dependencies owned by its source
  // checkout. Check all workspaces before touching even an earlier local tree.
  it.each(['warm', 'changed', 'missing-package', 'dangling'])('refuses %s shared dependencies before any startup mutation', (state) => {
    const f = fixture();
    try {
      f.run();
      const modules = join(f.root, 'server', 'node_modules');
      const shared = join(f.root, 'shared-server-deps');
      renameSync(modules, shared);
      if (state === 'changed') writeFileSync(join(f.root, 'server', 'package-lock.json'), '{"version":"new"}');
      if (state === 'missing-package') rmSync(join(shared, 'pg'), { recursive: true });
      rmSync(join(shared, 'patch-applied'));
      const target = state === 'dangling' ? join(f.root, 'absent-deps') : shared;
      symlinkSync(target, modules, process.platform === 'win32' ? 'junction' : 'dir');

      // root is visited before server: a per-workspace check inside the repair
      // loop would already destroy this tree and start npm before refusing.
      writeFileSync(join(f.root, 'package-lock.json'), '{"version":"new"}');
      writeFileSync(join(f.root, 'node_modules', 'keep'), 'original');
      const receipt = readFileSync(f.receipt, 'utf8');

      expect(f.run).toThrow(/Refusing dependency repair.*server.*node_modules.*linked/);
      expect(lstatSync(modules).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(f.root, 'node_modules', 'keep'), 'utf8')).toBe('original');
      expect(readFileSync(f.receipt, 'utf8')).toBe(receipt);
      expect(readFileSync(join(shared, 'installed-lock.json'), 'utf8')).toBe('{"version":"old"}');
      expect(existsSync(join(shared, 'patch-applied'))).toBe(false);
      if (state === 'missing-package') expect(existsSync(join(shared, 'pg'))).toBe(false);
      if (state === 'dangling') expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('installs a lockfile-only update once and preserves the committed inputs', () => {
    const f = fixture();
    try {
      f.run();
      const updated = '{"version":"new"}';
      writeFileSync(join(f.client, 'package-lock.json'), updated);
      writeFileSync(join(f.client, 'node_modules', 'stale'), 'old tree');
      f.run();
      expect(readFileSync(join(f.client, 'node_modules', 'installed-lock.json'), 'utf8')).toBe(updated);
      expect(existsSync(join(f.client, 'node_modules', 'stale'))).toBe(false);
      expect(readFileSync(join(f.client, 'package-lock.json'), 'utf8')).toBe(updated);
      expect(readFileSync(join(f.client, 'package.json'), 'utf8')).toBe('{}');
      writeFileSync(join(f.client, 'node_modules', 'keep'), 'unchanged tree');
      rmSync(join(f.client, 'node_modules', 'patch-applied'));
      expect(f.run()).not.toContain('reinstall');
      expect(existsSync(join(f.client, 'node_modules', 'keep'))).toBe(true);
      expect(readFileSync(join(f.client, 'node_modules', 'patch-applied'), 'utf8')).toBe('patched');
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('detects a newer lockfile without a receipt and upgrades legacy manifest-only receipts', () => {
    const f = fixture();
    try {
      f.run();
      rmSync(f.receipt);
      const updated = '{"version":"new"}';
      writeFileSync(join(f.client, 'package-lock.json'), updated);
      const oldTime = new Date('2020-01-01T00:00:00Z');
      const installTime = new Date('2020-01-02T00:00:00Z');
      const updateTime = new Date('2020-01-03T00:00:00Z');
      utimesSync(join(f.client, 'package.json'), oldTime, oldTime);
      utimesSync(join(f.client, 'node_modules', '.package-lock.json'), installTime, installTime);
      utimesSync(join(f.client, 'package-lock.json'), updateTime, updateTime);
      f.run();
      expect(readFileSync(join(f.client, 'node_modules', 'installed-lock.json'), 'utf8')).toBe(updated);

      // Old installs persist a bare SHA-256 of package.json. They cannot prove
      // which lockfile was installed, so reconcile once before trusting v2.
      const hashes = JSON.parse(readFileSync(f.receipt, 'utf8'));
      hashes.client = createHash('sha256').update('{}').digest('hex');
      writeFileSync(f.receipt, JSON.stringify(hashes));
      writeFileSync(join(f.client, 'node_modules', 'stale'), 'legacy tree');
      f.run();
      expect(existsSync(join(f.client, 'node_modules', 'stale'))).toBe(false);
      expect(f.run()).not.toContain('reinstall');
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});

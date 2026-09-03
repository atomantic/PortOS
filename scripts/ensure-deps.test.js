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
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'fs';
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

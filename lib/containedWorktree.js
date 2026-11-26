/** Git operations for the worktree explicitly selected by contained-run. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The repository root holding `cwd` (the mounted worktree), else `cwd` itself. */
export function resolveWorktree(cwd) {
  try {
    return realpathSync(execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {
    return realpathSync(cwd);
  }
}

/** `git apply` the returned patch in the worktree, checking it first so a bad patch never half-lands. */
export function applyPatch(worktree, patch) {
  const dir = mkdtempSync(join(tmpdir(), 'portos-contained-patch-'));
  const file = join(dir, 'changes.patch');
  try {
    writeFileSync(file, patch.endsWith('\n') ? patch : `${patch}\n`);
    execFileSync('git', ['-C', worktree, 'apply', '--check', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    execFileSync('git', ['-C', worktree, 'apply', file], { stdio: ['ignore', 'ignore', 'pipe'] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

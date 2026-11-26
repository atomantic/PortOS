/** Synchronous Git subprocesses scoped to a caller-supplied working directory. */
import { execFileSync, spawnSync } from 'node:child_process';

export function readWorktreeGit(cwd, args, options) {
  return execFileSync('git', args, { ...options, cwd });
}

export function runWorktreeGit(cwd, args, options) {
  return spawnSync('git', args, { ...options, cwd });
}

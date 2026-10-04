/**
 * Whether any process is sitting inside a worktree right now.
 *
 * The agent registry cannot see every owner of a `claim-*` tree: a swarm child or
 * a hand-run claim session cuts and works in a directory PortOS never provisioned.
 * A process whose current directory is inside the tree is checkout-specific
 * evidence of a live occupant, which the registry alone can never give.
 *
 * Read-only (`lsof` listing). Three answers, and the difference matters:
 * `true` — a process is inside; `false` — the listing ran and none is;
 * `null` — it could not be established (no `lsof`, Windows, timeout), which a
 * caller must treat as "unknown", never as "empty".
 */

import { realpath } from 'fs/promises';
import { resolve } from 'path';
import { commandOutput } from '../lib/commandExists.js';
import { isPathInsideDir } from '../lib/pathSafety.js';

/** Directories named by an `lsof -d cwd -Fn` listing (the `n` field lines). Pure. */
export function parseLsofCwdListing(output) {
  return String(output ?? '').split(/\r?\n/)
    .filter((line) => line.startsWith('n') && line.length > 1)
    .map((line) => line.slice(1));
}

export async function worktreeHasLiveProcess(worktreePath, { listCwds = defaultListCwds } = {}) {
  if (!worktreePath) return null;
  const cwds = await listCwds().catch(() => null);
  if (!cwds) return null;
  // lsof reports resolved paths, so compare against the resolved directory too.
  const roots = new Set([worktreePath]);
  const resolved = await realpath(worktreePath).catch(() => null);
  if (resolved) roots.add(resolved);
  return cwds.some((cwd) => [...roots].some((root) => resolve(cwd) === resolve(root) || isPathInsideDir(root, cwd)));
}

async function defaultListCwds() {
  if (process.platform === 'win32') return null;
  const output = await commandOutput('lsof', ['-d', 'cwd', '-Fn'], { timeoutMs: 10_000, maxBuffer: 16 * 1024 * 1024 });
  // `null` (could not run / non-zero exit) stays unknown; `''` means it ran and listed nothing.
  return output === null ? null : parseLsofCwdListing(output);
}

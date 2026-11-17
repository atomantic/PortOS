/**
 * Data-root resolution + worktree-checkout detection: `resolveInstallRoot()` pins the install root via
 * `PORTOS_DATA_ROOT`.
 *
 * `isWorktreeRoot()` lets boot migrations skip a CoS worktree, whose checkout lacks the gitignored `data/` tree,
 * instead of crashing (#1947).
 */
import { existsSync } from 'fs';
import { dirname, isAbsolute, join, resolve as resolvePath, sep } from 'path';
import { fileURLToPath } from 'url';

/** Env var a real launch sets to pin the install root (see ecosystem.config.cjs). */
export const DATA_ROOT_ENV = 'PORTOS_DATA_ROOT';

/** Marks an install root DISPOSABLE (throwaway harness tree, no live data); the one pin a worktree may honor. */
export const DISPOSABLE_ROOT_MARKER = '.portos-disposable-root';

/** True when `rootDir` carries the disposable-root marker. */
export const isDisposableRoot = (rootDir) => existsSync(join(rootDir, DISPOSABLE_ROOT_MARKER));

/**
 * The checkout root: two directories above the caller's `import.meta.url` (the one place that depth is assumed).
 *
 * @param {string} moduleUrl the caller's `import.meta.url`
 * @returns {string} absolute path two directories above the caller's file
 */
export function resolveCodeRootForModule(moduleUrl) {
  return join(dirname(fileURLToPath(moduleUrl)), '../..');
}

/**
 * The `PORTOS_DATA_ROOT` pin when set and non-blank, else `fallbackRoot` (from the caller's location).
 *
 * @param {string} fallbackRoot absolute path derived from the caller's location
 * @returns {string} the install root to use
 */
export function resolveInstallRoot(fallbackRoot) {
  // Leak-safety (#1947): the var can leak into agent child envs, so code living in a worktree
  // must NEVER honor a pin to the LIVE install; it stays on the worktree's own (empty) tree.
  // The exception is a DISPOSABLE root, which keeps `npm run smoke` hermetic from a worktree.
  const override = process.env[DATA_ROOT_ENV];
  if (typeof override !== 'string' || override.trim() === '') return fallbackRoot;
  const trimmed = override.trim();
  const resolved = isAbsolute(trimmed) ? trimmed : resolvePath(trimmed);
  // Never resolve INTO a worktree: it has no runtime data/ tree.
  if (isWorktreeRoot(resolved)) return fallbackRoot;
  if (isWorktreeRoot(fallbackRoot) && !isDisposableRoot(resolved)) return fallbackRoot;
  return resolved;
}

/**
 * True when `rootDir` is a CoS agent worktree checkout (path under `data/cos/worktrees/`), whose
 * missing `data/` tree must make boot migrations skip rather than crash on ENOENT.
 *
 * Keys ONLY on the path segment, never on `data/` existing: a worktree ships `data/.gitkeep` and
 * a fresh real install legitimately has an empty `data/`, so a presence check would skip its
 * migrations.
 *
 * @param {string} rootDir candidate install root
 * @returns {boolean}
 */
export function isWorktreeRoot(rootDir) {
  if (typeof rootDir !== 'string' || rootDir === '') return false;
  const normalized = resolvePath(rootDir);
  const segment = `${sep}${['data', 'cos', 'worktrees'].join(sep)}`;
  return normalized.includes(`${segment}${sep}`) || normalized.endsWith(segment);
}

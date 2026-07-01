/**
 * Data-root resolution + worktree-checkout detection.
 *
 * PortOS derives its "install root" (the directory that contains `data/`,
 * `data.reference/`, `scripts/`) from where the executing file lives
 * (`import.meta.url`). That silently breaks when a process boots from inside a
 * CoS agent's git worktree (`data/cos/worktrees/agent-<id>`): the checkout only
 * contains git-tracked files, so the gitignored `data/` runtime tree is empty,
 * and boot migrations resolve against a nonexistent path and crash (#1947).
 *
 * `resolveInstallRoot()` lets a real launch pin the root explicitly via the
 * `PORTOS_DATA_ROOT` env var, independent of the executing file's location, so
 * even a process booted from inside a worktree still resolves to the real
 * install. `isWorktreeRoot()` is the defensive backstop: detect a
 * worktree-rooted process so callers (boot migrations) can skip work that
 * assumes the real install tree instead of crashing.
 */
import { isAbsolute, resolve as resolvePath, sep } from 'path';

/** Env var a real launch sets to pin the install root (see ecosystem.config.cjs). */
export const DATA_ROOT_ENV = 'PORTOS_DATA_ROOT';

/**
 * Resolve the PortOS install root (the parent of `data/` and `data.reference/`).
 *
 * Prefers an explicit `PORTOS_DATA_ROOT` env var (set at real process launch)
 * over the caller's `import.meta.url`-derived fallback, so a process booted
 * from inside a git worktree still resolves to the real install. Returns
 * `fallbackRoot` unchanged when the env var is unset or blank — preserving the
 * existing behavior for installs that never set it (backward compatible).
 *
 * @param {string} fallbackRoot absolute path derived from the caller's location
 * @returns {string} the install root to use
 */
export function resolveInstallRoot(fallbackRoot) {
  const override = process.env[DATA_ROOT_ENV];
  if (typeof override === 'string' && override.trim() !== '') {
    const trimmed = override.trim();
    return isAbsolute(trimmed) ? trimmed : resolvePath(trimmed);
  }
  return fallbackRoot;
}

/**
 * True when `rootDir` is a CoS agent worktree checkout rather than the real
 * install — its path lives under `data/cos/worktrees/`. Such a checkout has no
 * gitignored `data/` runtime tree, so boot migrations (and any pass that
 * assumes the real install's `data/`/`data.reference/`) must skip it instead of
 * crashing on ENOENT.
 *
 * We key ONLY on the `data/cos/worktrees/` path segment, not on "does `data/`
 * exist" — a worktree checkout still ships `data/.gitkeep`, and a genuinely
 * fresh real install legitimately has an empty `data/` on first boot (the
 * migration runner creates it), so a presence check would false-positive on
 * fresh installs and skip their migrations.
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

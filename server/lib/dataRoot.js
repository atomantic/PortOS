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
 * Prefers an explicit `PORTOS_DATA_ROOT` env var (set at a real launch in
 * `ecosystem.config.cjs`) over the caller's `import.meta.url`-derived fallback,
 * pinning the primary install's root independent of the executing-file location.
 * Returns `fallbackRoot` unchanged when the env var is unset or blank —
 * preserving the existing behavior for installs that never set it (backward
 * compatible).
 *
 * The var is set ONLY on the `portos-server` app (not the shared `BASE_ENV`), so
 * the `portos-cos` runner — which spreads its `process.env` into agent CLI
 * children — never carries it into worktree agents. As belt-and-suspenders, this
 * resolver ALSO refuses the pin whenever the executing location (`fallbackRoot`)
 * is itself a worktree checkout: even a leaked `PORTOS_DATA_ROOT` can't make
 * worktree-version code resolve `PATHS.data` to the LIVE install and read/write
 * real data. In that case resolution stays on the worktree path, where the
 * migration backstop safely skips and `PATHS.data` points at the worktree's own
 * (empty) tree — no crash, no live-data corruption.
 *
 * @param {string} fallbackRoot absolute path derived from the caller's location
 * @returns {string} the install root to use
 */
export function resolveInstallRoot(fallbackRoot) {
  // Leak-safety (#1947): a process whose CODE physically lives inside a worktree
  // checkout must NEVER honor a PORTOS_DATA_ROOT pin. The var is inherited by
  // long-lived PM2 processes and can leak into agent child envs (spread of
  // process.env), so a worktree-launched command could otherwise resolve
  // PATHS.data to the LIVE install and let worktree-version code read/write real
  // data. When the fallback (the executing location) is itself a worktree, ignore
  // the override and stay on the worktree path — where the migration backstop
  // safely skips and PATHS.data points at the worktree's own (empty) tree.
  if (isWorktreeRoot(fallbackRoot)) return fallbackRoot;
  const override = process.env[DATA_ROOT_ENV];
  if (typeof override === 'string' && override.trim() !== '') {
    const trimmed = override.trim();
    const resolved = isAbsolute(trimmed) ? trimmed : resolvePath(trimmed);
    // Symmetric leak-safety: never let the data root resolve INTO a worktree,
    // whether the worktree path came from the executing location (above) or a
    // misconfigured override. A worktree has no runtime data/ tree, so honoring
    // such an override would strand the real process on an empty tree.
    if (isWorktreeRoot(resolved)) return fallbackRoot;
    return resolved;
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

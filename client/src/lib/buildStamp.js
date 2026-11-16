/**
 * Pure comparison of the BUNDLE this browser loaded against the SERVER build (#4694).
 *
 * Catches a `client/dist` built from one commit while the server
 * runs another. Why `version` can't answer this: see `server/lib/buildIdentity.js`.
 */

/**
 * The `__BUILD_STAMP__` Vite define, or null without the bundler (vitest). Read via
 * `typeof` since a bare undefined define throws at load; resolved once for a stable identity.
 */
export const BUNDLE_STAMP = typeof __BUILD_STAMP__ === 'undefined' ? null : __BUILD_STAMP__;

/**
 * The build id the server stamped into the served index.html, or null under
 * `npm run dev` (no meta tag injected). The gate for trusting `BUNDLE_STAMP`: the
 * Vite define is frozen at dev-server start, so under HMR it is stale.
 */
export const SERVED_BUILD_ID = (() => {
  if (typeof document === 'undefined') return null;
  const el = document.querySelector('meta[name="portos-build-id"]');
  return el ? el.getAttribute('content') : null;
})();

/** The bundle stamp only when trusted (see `SERVED_BUILD_ID`). */
export const TRUSTED_BUNDLE_STAMP = SERVED_BUILD_ID ? BUNDLE_STAMP : null;

/** Trim a stamp field to a usable value or null; never maps a placeholder string, which would swallow a real branch name. */
function normalizeStamp(value) {
  if (typeof value !== 'string') return null;
  return value.trim() || null;
}

// Commits compare case-insensitively; branch names do not.
const normalizeCommit = (value) => normalizeStamp(value)?.toLowerCase() ?? null;

/**
 * Compare a bundle stamp against the server's build identity.
 *
 * @param {{commit?: string|null, branch?: string|null, builtAt?: string}|null|undefined} bundle
 * @param {{commit?: string|null, shortCommit?: string|null, branch?: string|null, dirty?: boolean|null}|null|undefined} server
 * @returns {{state: 'match'|'mismatch'|'unknown', bundleCommit: string|null, serverCommit: string|null}}
 *   `serverCommit` is the short form when the server sent one, for display.
 */
export function compareBuildStamps(bundle, server) {
  const bundleCommit = normalizeCommit(bundle?.commit);
  const serverCommit = normalizeCommit(server?.shortCommit) ?? normalizeCommit(server?.commit);

  // Absent on either side is `unknown`: `match` would claim unperformed verification, `mismatch` cry wolf.
  if (!bundleCommit || !serverCommit) {
    return { state: 'unknown', bundleCommit, serverCommit };
  }

  // Prefix comparison: the bundle carries a 7-char commit, the server may send the full sha.
  const same = bundleCommit.startsWith(serverCommit) || serverCommit.startsWith(bundleCommit);
  return { state: same ? 'match' : 'mismatch', bundleCommit, serverCommit };
}

/** One-line summary (`abc1234 · main · uncommitted changes`), or null so callers can drop the row. */
export function describeBuild({ commit, branch, dirty } = {}) {
  const parts = [];
  const shortCommit = normalizeStamp(commit);
  if (shortCommit) parts.push(shortCommit.slice(0, 7));
  const cleanBranch = normalizeStamp(branch);
  if (cleanBranch) parts.push(cleanBranch);
  // Only `true` earns a badge: `null` means the check did not run. `dirty` is a boot-time snapshot.
  if (dirty === true) parts.push('uncommitted changes');
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Decide what the server's build signals mean for THIS tab (#4694):
 *   `'reload'` — the bundle on disk moved since this tab loaded; reload fixes it.
 *   `'drift'`  — this tab is current with dist, but dist was built from a different
 *     commit than the server runs; needs a rebuild or server restart.
 *   `null`     — nothing to say.
 *
 * The signals arrive separately: the bundle hash on the `build:id` socket frame, the
 * commit from `GET /api/system/build` (machine-local; see services/socket.js).
 * `embeddedBuildId` is null under `npm run dev`, which gates both checks (no dist
 * to be stale; the Vite define is frozen at start).
 *
 * @returns {'reload'|'drift'|null}
 */
export function resolveBuildFrame({ buildId, commit } = {}, { embeddedBuildId, bundle = TRUSTED_BUNDLE_STAMP } = {}) {
  if (!buildId || !embeddedBuildId) return null;
  if (buildId !== embeddedBuildId) return 'reload';
  return compareBuildStamps(bundle, { commit }).state === 'mismatch' ? 'drift' : null;
}

/**
 * The stateful half of the drift check: merge the two signals as they arrive,
 * decide once per kind, and clear a toast when its problem goes away. A factory
 * with injected effects because the wiring module opens a real Socket.IO
 * connection at import and can't load in a unit test.
 *
 * @param {object} deps
 * @param {string|null} deps.embeddedBuildId - see `SERVED_BUILD_ID`
 * @param {() => Promise<{commit?: string|null}|null>} deps.fetchIdentity
 * @param {(action: 'reload'|'drift') => void} deps.onShow
 * @param {(action: 'reload'|'drift') => void} deps.onClear
 */
export function createBuildDriftWatcher({ embeddedBuildId, fetchIdentity, onShow, onClear }) {
  const signals = { buildId: null, commit: null };
  const shown = { reload: false, drift: false };

  const evaluate = () => {
    const action = resolveBuildFrame(signals, { embeddedBuildId });

    // Both notices are sticky; clearing on the "problem gone" signal is the only way they come down.
    for (const kind of ['reload', 'drift']) {
      if (kind !== action && shown[kind]) {
        shown[kind] = false;
        onClear(kind);
      }
    }

    if (!action || shown[action]) return;
    shown[action] = true;
    onShow(action);
  };

  return {
    /** The pushed bundle hash. */
    onBuildId(buildId) {
      signals.buildId = buildId ?? null;
      evaluate();
    },
    /**
     * Re-read the server's commit on every (re)connect (a restart is a remedy).
     * Clears the previous commit FIRST so a slow or failed fetch (older server, no
     * route) never judges the new server by the old one's commit.
     */
    async refreshIdentity() {
      signals.commit = null;
      evaluate();
      const identity = await fetchIdentity().catch(() => null);
      signals.commit = identity?.commit ?? null;
      evaluate();
    }
  };
}

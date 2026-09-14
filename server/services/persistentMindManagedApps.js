/**
 * The managed apps a persistent-mind grant may target, with their work tracker
 * resolved once.
 *
 * Both mind grants that name a repository — CoS tasks and forge issues — need
 * the same three facts about every active app: is it runnable, is it in the
 * user's allowlist, and what does its work tracker resolve to. Resolving that
 * tracker is not free: `resolveAppForgeTarget` shells out to `git` for the
 * origin remote (twice, once per resolver), and this list is rebuilt on EVERY
 * persistent-mind wake as well as on every settings-page load. Two readers
 * deriving it separately meant up to 50 apps × 2 resolutions per wake, and two
 * places where "which forge is this app on" could drift.
 *
 * So there is one roster, one cache, and one resolution serving both grants.
 * Each caller projects the fields it needs.
 */

import { resolveAppForgeTarget } from '../lib/workTracker.js';
import { getActiveApps } from './apps.js';
import { loadState } from './cosState.js';
import { normalizePersistentMindCapabilities } from '../lib/persistentMindCapabilities.js';

const MAX_ROSTER_APPS = 50;
const APP_ID_CHARS = 128;
const RESOLVE_CACHE_TTL_MS = 30_000;
const FORGE_TRACKERS = new Set(['github', 'gitlab']);

// Promise-valued, so concurrent builders share one in-flight resolution rather
// than each spawning their own `git`.
const resolveCache = new Map();

const cachedResolve = (app) => {
  const key = `${app.id}\0${app.repoPath}\0${app.workTracker || 'auto'}`;
  const cached = resolveCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  const promise = resolveAppForgeTarget(app).catch(() => ({ tracker: null, target: null }));
  resolveCache.set(key, { expiresAt: Date.now() + RESOLVE_CACHE_TTL_MS, promise });
  return promise;
};

const isRunnableApp = (app) => typeof app?.id === 'string' && app.id
  && app.id.length <= APP_ID_CHARS
  && typeof app?.repoPath === 'string' && app.repoPath.trim().length > 0;

/**
 * Every runnable active app, annotated with what each grant needs to know.
 *
 * - `planOnly` — the tracker is a forge, so the task grant may use its
 *   issue-only "Plan & File Issue" mode.
 * - `forge` — the tracker is a forge AND the app's remote actually resolves to
 *   that forge, so an issue can be filed against it. Null otherwise, including
 *   for an app explicitly pinned to one forge from the other's remote: nothing
 *   there could be filed, so the issue grant must not offer it. `fullName`,
 *   `repoSpec` (gh's host-qualified selector) and `apiHost` ride with it, so a
 *   caller never re-resolves the target just to address it.
 * - `granted` — the app is in the mind's `allowedAppIds` allowlist. Always true
 *   when no allowlist is stored, which is the legacy grant to every app.
 *
 * Revoked apps are included: the settings page must see one to offer it back,
 * and the allowlist it edits is shared by both grants, so filtering the roster
 * per grant would let one editor silently narrow the other. Model-facing
 * callers filter for themselves.
 */
export async function readPersistentMindManagedApps({ allowedAppIds } = {}) {
  const [root, apps] = await Promise.all([loadState(), getActiveApps()]);
  const capabilities = normalizePersistentMindCapabilities(root.config?.persistentMindCapabilities);
  const effectiveAllowed = Array.isArray(allowedAppIds) ? allowedAppIds : capabilities.allowedAppIds;
  const allowed = Array.isArray(effectiveAllowed) ? new Set(effectiveAllowed) : null;
  const runnable = apps.filter(isRunnableApp).slice(0, MAX_ROSTER_APPS);
  return Promise.all(runnable.map(async (app) => {
    const { tracker, target } = await cachedResolve(app);
    const onForge = FORGE_TRACKERS.has(tracker);
    const filable = onForge && target?.forge === tracker;
    return {
      id: app.id,
      name: String(app.name || app.id).slice(0, 100),
      repoPath: app.repoPath,
      workTracker: app.workTracker,
      planOnly: onForge,
      forge: filable ? tracker : null,
      fullName: filable ? target.fullName || null : null,
      repoSpec: filable ? target.repoSpec || null : null,
      apiHost: filable ? target.apiHost || null : null,
      granted: !allowed || allowed.has(app.id),
    };
  }));
}

export const __testing = { resolveCache };

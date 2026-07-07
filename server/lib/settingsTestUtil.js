/**
 * Test-only helpers for suites that write `data/settings.json` DIRECTLY on disk
 * (bypassing `saveSettings`/`updateSettings`).
 *
 * Why this exists: `getSettings()` in `server/services/settings.js` memoizes the
 * parsed settings.json in a module-level cache and only refreshes it off the
 * `settings:updated` event that `save()`/`updateSettings()`/`updateSettingsWith()`
 * emit. A test that writes settings.json directly (e.g. to flip `apiAccess`,
 * seed `secrets`, or reset to `{}`) does NOT go through `save()`, so any prior
 * `getSettings()` — commonly warmed by a `setPassword()` call — leaves the cache
 * stale and the code under test reads pre-write values. Route every direct write
 * through this helper so the cache is dropped in one place and future
 * direct-writers get correct invalidation for free. This mirrors the production
 * `reloadSettings()` contract (re-sync the cache after an out-of-band write) —
 * see the read-cache comment block in `server/services/settings.js`.
 *
 * `__resetSettingsCache` is loaded via a DYNAMIC import inside each helper, NOT
 * a static top-of-file import: suites `vi.resetModules()` between builds, so the
 * app under test binds a FRESH `settings.js` instance each time. A static import
 * here would bind to a stale pre-reset instance whose cache the app never reads,
 * making the reset a silent no-op.
 *
 * `bindSettingsFile(dataRoot)` binds the temp data dir (from `mockPathsDataRoot`)
 * once and returns `{ writeSettingsFile, mergeSettingsFile }` so call sites stay
 * short. This is a dedicated util rather than a method on `mockPathsDataRoot` so
 * the generic path-mock harness stays decoupled from the settings service.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const settingsPath = (dataRoot) => join(dataRoot, 'settings.json');

// Serialize with a trailing newline to match `save()`'s on-disk format.
const persist = (dataRoot, obj) => {
  writeFileSync(settingsPath(dataRoot), JSON.stringify(obj, null, 2) + '\n');
};

const dropCache = async () => {
  const { __resetSettingsCache } = await import('../services/settings.js');
  __resetSettingsCache();
};

/**
 * Bind a temp data root to the settings direct-write helpers.
 * @param {string} dataRoot - the temp dir standing in for `PATHS.data`.
 * @returns {{ writeSettingsFile: (obj: object) => Promise<void>,
 *             mergeSettingsFile: (patch: object) => Promise<void> }}
 */
export function bindSettingsFile(dataRoot) {
  // Write the FULL settings object, then invalidate the read cache.
  const writeSettingsFile = async (obj) => {
    persist(dataRoot, obj);
    await dropCache();
  };
  // Shallow-merge `patch` over the current on-disk settings (read-modify-write),
  // then invalidate — for suites that flip one top-level key (e.g. `apiAccess`)
  // while preserving secrets a prior `setPassword()` wrote to the same file.
  const mergeSettingsFile = async (patch) => {
    const raw = JSON.parse(readFileSync(settingsPath(dataRoot), 'utf-8'));
    persist(dataRoot, { ...raw, ...patch });
    await dropCache();
  };
  return { writeSettingsFile, mergeSettingsFile };
}

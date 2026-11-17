/**
 * Test-only helpers for suites that write `data/settings.json` DIRECTLY on disk (bypassing `saveSettings`/`updateSettings`).
 *
 * `bindSettingsFile(dataRoot)` → `{ writeSettingsFile, mergeSettingsFile }` that also drop the `getSettings()` read cache. `getSettings()` (`server/services/settings.js`) memoizes the parsed file and refreshes only off the `settings:updated` event `save()`/`updateSettings()`/`updateSettingsWith()` emit, so a direct write (to flip `apiAccess`, seed `secrets`, reset to `{}`) leaves a cache warmed earlier (commonly by `setPassword()`) stale; routing every direct write here drops it in one place, mirroring production `reloadSettings()` (see the read-cache block in settings.js). `__resetSettingsCache` loads via a DYNAMIC import inside each helper: suites `vi.resetModules()` between builds so the app binds a FRESH `settings.js`, and a static import would bind a stale instance whose cache the app never reads (a silent no-op). A dedicated util, not a `mockPathsDataRoot` method, so the path-mock harness stays decoupled from the settings service.
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
 *
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
  // Shallow-merge `patch` over the current on-disk settings (read-modify-write), then invalidate: for suites flipping one top-level key (e.g. `apiAccess`) while keeping secrets a prior `setPassword()` wrote.
  const mergeSettingsFile = async (patch) => {
    const raw = JSON.parse(readFileSync(settingsPath(dataRoot), 'utf-8'));
    persist(dataRoot, { ...raw, ...patch });
    await dropCache();
  };
  return { writeSettingsFile, mergeSettingsFile };
}

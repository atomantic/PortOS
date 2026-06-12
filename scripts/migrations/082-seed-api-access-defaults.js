/**
 * Migration 082 — seed the `apiAccess` settings key for existing installs.
 *
 * The public API surface (server/lib/apiRegistry.js) reads per-API exposure
 * flags from `settings.apiAccess.{voice,sdapi}`. Fresh installs get the block
 * from data.reference/settings.json, but `scripts/setup-data.js` only merges
 * NEW keys into a handful of structured JSONs (stage-config, variables,
 * providers) — NOT settings.json. So an existing install would never gain the
 * key from setup-data alone.
 *
 * This migration adds the default `apiAccess` block (both APIs not-exposed +
 * passwordless) when it's absent, so the Settings UI renders a clean persisted
 * state. The registry already falls back to the same defaults when the key is
 * missing, so behavior is correct even before this runs — this is purely about
 * materializing the key on disk.
 *
 * Idempotent: if `apiAccess` already exists (any value), it's left untouched.
 * ENOENT (no settings.json yet) → skip; a fresh install copies the seeded file
 * from data.reference. Runs in the boot-time migration runner before the
 * service layer is wired, so it reads/writes settings.json directly.
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

export const API_ACCESS_DEFAULTS = Object.freeze({
  voice: { exposed: false, requireAuth: false },
  sdapi: { exposed: false, requireAuth: false },
});

/**
 * Pure transform, exported for tests. Returns `{ settings, changed }`.
 * Adds the default `apiAccess` block only when absent. Never overwrites an
 * existing value (even a partial / hand-edited one).
 */
export function computeApiAccessSeed(settings) {
  if (!settings || typeof settings !== 'object') return { settings, changed: false };
  if (settings.apiAccess !== undefined) return { settings, changed: false };
  return {
    settings: { ...settings, apiAccess: { ...API_ACCESS_DEFAULTS } },
    changed: true,
  };
}

export async function up({ rootDir }) {
  const settingsPath = join(rootDir, 'data', 'settings.json');
  if (!existsSync(settingsPath)) {
    console.log('🔌 api-access-seed: no settings.json yet — fresh install seeds from data.reference.');
    return { ok: true, reason: 'no-state' };
  }

  const raw = await readFile(settingsPath, 'utf-8').catch(() => null);
  if (raw == null) {
    console.log('🔌 api-access-seed: settings.json unreadable — skipping.');
    return { ok: false, reason: 'unreadable' };
  }

  let settings;
  try {
    settings = JSON.parse(raw);
  } catch {
    console.log('🔌 api-access-seed: settings.json is not valid JSON — skipping.');
    return { ok: false, reason: 'invalid-json' };
  }

  const { settings: next, changed } = computeApiAccessSeed(settings);
  if (!changed) {
    console.log('🔌 api-access-seed: apiAccess already present — no-op.');
    return { ok: true, reason: 'already-present' };
  }

  await writeFile(settingsPath, JSON.stringify(next, null, 2) + '\n');
  console.log('🔌 api-access-seed: added default apiAccess block (voice + sdapi, not-exposed + passwordless).');
  return { ok: true, reason: 'seeded' };
}

export default { up };

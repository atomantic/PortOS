import { EventEmitter } from 'node:events';
import { DIRECT_HARNESS_ID, PROVIDER_HARNESSES, harnessById } from '../lib/providerHarnesses.js';
import { isPlainObject } from '../lib/objects.js';
import { PROVIDER_RUNTIMES, peekProviderRuntimeStatuses } from './providerRuntimeInstaller.js';
import { getSettings, settingsEvents, updateSettingsWith } from './settings.js';

/**
 * Per-HARNESS enablement (#7564, epic #7561) — the harness axis of "an enabled
 * harness × an enabled service is runnable".
 *
 * A harness is enabled by, in order:
 *   1. an explicit `settings.harnesses[id].enabled` (the user's word);
 *   2. otherwise, whether its binary was DETECTED on PATH by the runtime
 *      probe's cache (`peekProviderRuntimeStatuses`, cache-only: a probe that
 *      has not run yet reads as "unknown", which enables — the same permissive
 *      posture `providerPrerequisites.js` takes, because an un-probed harness
 *      must route exactly as it did before the probe existed);
 *   3. `direct` — PortOS's own HTTP client — is always enabled: there is no
 *      binary to detect and nothing to disable.
 *
 * Settings-only. Nothing here spawns a probe or contacts a provider; the
 * detection it reads is whatever the runtime installer's TTL cache already
 * holds (AGENTS.md "No cold-bootstrap LLM calls").
 */

/** Emits `changed` whenever the enablement inputs move (a settings save). */
export const harnessEnablementEvents = new EventEmitter();

/** Bumped on every settings write; the composite resolver keys its cache on it. */
let settingsRevision = 0;
settingsEvents.on('settings:updated', () => {
  settingsRevision += 1;
  harnessEnablementEvents.emit('changed');
});
settingsEvents.on('settings:invalidated', () => {
  settingsRevision += 1;
  harnessEnablementEvents.emit('changed');
});

/** The revision the composite cache compares against. */
export const harnessSettingsRevision = () => settingsRevision;

/** The runtime row a harness is installed as — `PROVIDER_RUNTIMES` keys rows by vendor, which is the harness id. */
const runtimeForHarness = (harnessId) => PROVIDER_RUNTIMES.find((row) => row.vendor === harnessId) ?? null;

/**
 * Whether `harnessId`'s binary is on PATH, per the runtime probe's CACHE:
 * `true` / `false` when probed within the TTL, `null` when not probed (or the
 * harness has no installable runtime row). `direct` is always `true`.
 *
 * @param {string} harnessId
 * @param {Record<string, {installed?: boolean, version?: string|null}>} [runtimes] — injectable for tests
 * @returns {{detected: boolean|null, version: string|null}}
 */
export function harnessDetection(harnessId, runtimes = peekProviderRuntimeStatuses()) {
  if (harnessId === DIRECT_HARNESS_ID) return { detected: true, version: null };
  const runtime = runtimeForHarness(harnessId);
  const status = runtime ? runtimes?.[runtime.id] : null;
  if (!status) return { detected: null, version: null };
  return { detected: status.installed === true, version: status.version ?? null };
}

/** The explicit setting for a harness, or `null` when the user has not said. */
const explicitEnablement = (settings, harnessId) => {
  const entry = settings?.harnesses?.[harnessId];
  return typeof entry?.enabled === 'boolean' ? entry.enabled : null;
};

/**
 * The pure verdict: enabled, and why.
 *
 * @param {string} harnessId
 * @param {{settings?: object, runtimes?: object}} [inputs]
 * @returns {{enabled: boolean, source: 'always'|'setting'|'detected'|'default', detected: boolean|null, version: string|null}|null}
 *   `null` for an id the registry does not know.
 */
export function harnessEnablementFrom(harnessId, { settings = {}, runtimes = undefined } = {}) {
  if (!harnessById(harnessId)) return null;
  const { detected, version } = harnessDetection(harnessId, runtimes);
  if (harnessId === DIRECT_HARNESS_ID) return { enabled: true, source: 'always', detected, version };
  const explicit = explicitEnablement(settings, harnessId);
  if (explicit !== null) return { enabled: explicit, source: 'setting', detected, version };
  if (detected === null) return { enabled: true, source: 'default', detected, version };
  return { enabled: detected, source: 'detected', detected, version };
}

/** Whether `harnessId` may compose into a runnable composite right now. */
export async function harnessEnabled(harnessId) {
  return harnessEnablementFrom(harnessId, { settings: await getSettings() })?.enabled === true;
}

/**
 * Every registry harness with its enablement verdict — the `harnesses` half
 * of `GET /api/providers/catalog`. Cache-only detection; no probe is started.
 */
export async function listHarnessEnablement() {
  const settings = await getSettings();
  const runtimes = peekProviderRuntimeStatuses();
  return PROVIDER_HARNESSES.map((harness) => ({
    id: harness.id,
    label: harness.label,
    modes: [...harness.modes],
    ...harnessEnablementFrom(harness.id, { settings, runtimes }),
  }));
}

/**
 * Record the user's explicit word on one harness. `direct` cannot be disabled
 * (nothing to disable) and an unknown id is refused, so the slice can only
 * ever hold rules something reads.
 */
export async function setHarnessEnabled(harnessId, enabled) {
  if (!harnessById(harnessId) || harnessId === DIRECT_HARNESS_ID) {
    const err = new Error(`"${harnessId}" is not a harness whose enablement can be set`);
    err.status = 400;
    err.code = 'HARNESS_UNKNOWN';
    throw err;
  }
  await updateSettingsWith((current) => ({
    ...current,
    harnesses: { ...normalizeHarnessSettings(current.harnesses), [harnessId]: { enabled: Boolean(enabled) } },
  }));
  return harnessEnablementFrom(harnessId, { settings: await getSettings() });
}

/**
 * The slice with every entry that names no registry harness — or carries no
 * boolean — dropped. Pure; `reconcileHarnessEnablement` persists the result.
 */
export function normalizeHarnessSettings(raw) {
  if (!isPlainObject(raw)) return {};
  return Object.fromEntries(Object.entries(raw)
    .filter(([id, entry]) => harnessById(id) && id !== DIRECT_HARNESS_ID && typeof entry?.enabled === 'boolean')
    .map(([id, entry]) => [id, { enabled: entry.enabled }]));
}

/**
 * Idempotent: bring `settings.harnesses` to its normalized shape, writing only
 * when something changed. Called at boot (after the database phase, beside the
 * provider-graph reconcile) and safe to call from any path that moves the
 * gate. A second call plans nothing.
 *
 * @returns {Promise<{changed: boolean, harnesses: object}>}
 */
export async function reconcileHarnessEnablement() {
  const settings = await getSettings();
  const raw = settings.harnesses;
  const normalized = normalizeHarnessSettings(raw);
  const same = raw === undefined
    ? Object.keys(normalized).length === 0
    : isPlainObject(raw) && JSON.stringify(raw) === JSON.stringify(normalized);
  if (same) return { changed: false, harnesses: normalized };
  await updateSettingsWith((current) => {
    const next = { ...current };
    if (Object.keys(normalized).length === 0) delete next.harnesses;
    else next.harnesses = normalized;
    return next;
  });
  console.log(`🔧 Normalized harness enablement settings (${Object.keys(normalized).length} explicit)`);
  return { changed: true, harnesses: normalized };
}

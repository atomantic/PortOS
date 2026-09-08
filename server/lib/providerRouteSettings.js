import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ROUTE_MODES, providerRouteMode } from './providerHarnesses.js';

/**
 * The MODE-OVERRIDE half of a provider route (#6369).
 *
 * `providerConnections.js` splits a provider record into the values a shared
 * backend owns (endpoint, credentials, transport env vars). This module names
 * what is left that a human actually tunes per execution mode: the arguments
 * that mode launches with, how long it may run, its reasoning effort, and the
 * model each dispatch tier resolves to.
 *
 * The set is not invented here. `sharedModeUpdates` in the vendored toolkit
 * already declares exactly these mode-specific — "Arguments, timeouts, routing
 * consent and model pins remain mode-specific" — which is why a write built
 * from this table must go through `applyProviderPatches` (no sibling fan-out)
 * rather than `updateProvider`: a CLI route's `--effort` is not the TUI
 * route's, and spreading one onto the other would be the opposite of an
 * override. Execution CONSENT (`enabled`, the transport opt-ins) is deliberately
 * absent: granting it stays on `PATCH /api/providers/:id`.
 *
 * Pure: no I/O, no clock, no provider call.
 */

/** Nullable free-text: `null` is "unpinned", never the empty string. */
const nullableText = z.string().nullable();

/**
 * key → { modes, schema, read }.
 *
 * `modes` is honest about reach rather than about what the record schema
 * tolerates: `args` is a spawn concern, so an `api` route neither publishes nor
 * accepts one. `read` normalizes a stored value into the DTO shape, because an
 * absent key and a cleared pin must both read as `null` — a record that never
 * had a `heavyModel` and one whose pin was removed are the same state to a
 * human, and publishing `undefined` for one would make the fingerprint below
 * depend on key presence rather than on value.
 */
export const ROUTE_SETTING_FIELDS = Object.freeze({
  args: Object.freeze({
    modes: Object.freeze(['cli', 'tui']),
    schema: z.array(z.string()),
    read: (value) => (Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : []),
  }),
  timeout: Object.freeze({
    modes: ROUTE_MODES,
    schema: z.number().int().nullable(),
    read: (value) => (Number.isInteger(value) ? value : null),
  }),
  effort: Object.freeze({
    modes: ROUTE_MODES,
    schema: nullableText,
    read: (value) => (typeof value === 'string' && value !== '' ? value : null),
  }),
  defaultModel: Object.freeze({ modes: ROUTE_MODES, schema: nullableText, read: readPin }),
  lightModel: Object.freeze({ modes: ROUTE_MODES, schema: nullableText, read: readPin }),
  mediumModel: Object.freeze({ modes: ROUTE_MODES, schema: nullableText, read: readPin }),
  heavyModel: Object.freeze({ modes: ROUTE_MODES, schema: nullableText, read: readPin }),
  ultraModel: Object.freeze({ modes: ROUTE_MODES, schema: nullableText, read: readPin }),
});

function readPin(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Every override key, in the order a route publishes them. */
export const ROUTE_SETTING_KEYS = Object.freeze(Object.keys(ROUTE_SETTING_FIELDS));

/** The keys that reach `mode`. An unknown mode reaches none. */
export const routeSettingKeys = (mode) =>
  ROUTE_SETTING_KEYS.filter((key) => ROUTE_SETTING_FIELDS[key].modes.includes(mode));

/** The DTO shape a route's `settings` takes on the wire. */
export const routeSettingsSchema = z.object(
  Object.fromEntries(ROUTE_SETTING_KEYS.map((key) => [key, ROUTE_SETTING_FIELDS[key].schema.optional()])),
).strict();

/**
 * The override values a provider record currently carries, for its own mode.
 *
 * A record whose `type` names no executable mode yields `{}` rather than a
 * guess: it is not a route, so it has no overrides to publish or accept.
 */
export function routeSettingsFor(provider) {
  const mode = providerRouteMode(provider);
  return Object.fromEntries(routeSettingKeys(mode)
    .map((key) => [key, ROUTE_SETTING_FIELDS[key].read(provider?.[key])]));
}

/**
 * A stale-edit fingerprint of one route's overrides.
 *
 * Deliberately a hash of the VALUES rather than a `revision` column on
 * `ai_route_bindings`. These fields live in `data/providers.json`, which the
 * route editor, a model refresh, a migration and a downgraded release all
 * write without touching the graph — so a row revision would only ever notice
 * a graph write and would sail straight past the edit a human is most likely to
 * collide with. Hashing what is actually on disk catches every writer.
 *
 * Truncated: this is a collision-detection token compared against a value taken
 * seconds earlier by the same install, not a content address.
 */
export const routeSettingsRevision = (settings) => createHash('sha256')
  .update(JSON.stringify(Object.entries(settings || {}).sort(([a], [b]) => a.localeCompare(b))))
  .digest('hex')
  .slice(0, 16);

/** Keys a caller sent that this route's mode does not accept. */
export const unsupportedRouteSettings = (mode, patch) =>
  Object.keys(patch || {}).filter((key) => !routeSettingKeys(mode).includes(key));

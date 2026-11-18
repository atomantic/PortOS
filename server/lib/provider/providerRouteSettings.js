/**
 * Mode-override half of a provider route: the per-execution-mode fields (`args`, `timeout`, `effort`,
 * default/light/medium/heavy models) and their handling.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ROUTE_MODES, providerRouteMode } from './providerHarnesses.js';

/**
 * The MODE-OVERRIDE half of a provider route (#6369): what remains, after `providerConnections.js` splits off the shared-backend values (endpoint, credentials, transport env vars), that a human tunes per execution mode: the launch arguments, run timeout, reasoning effort and the model each dispatch tier resolves to.
 * The set is the vendored toolkit's `sharedModeUpdates` ("Arguments, timeouts, routing consent and model pins remain mode-specific"), so a write built from this table goes through `applyProviderPatches` (no sibling fan-out), not `updateProvider` (a CLI route's `--effort` is not the TUI route's).
 * Execution CONSENT (`enabled`, the transport opt-ins) is deliberately absent: it stays on `PATCH /api/providers/:id`. Pure: no I/O, clock or provider call.
 */

/** Nullable free-text: `null` is "unpinned", never the empty string. */
const nullableText = z.string().nullable();

/**
 * key → { modes, schema, read }. `modes` is honest about reach, not what the record schema tolerates (`args` is a spawn concern, so an `api` route neither publishes nor accepts one). `read` normalizes a stored value into the DTO shape: an absent key and a cleared pin both read `null`
 * (a record that never had a `heavyModel` and one whose pin was removed are the same state; publishing `undefined` for one would make the fingerprint below depend on key presence, not value).
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

/** The override values a provider record currently carries, for its own mode; a record whose `type` names no executable mode yields `{}` (not a route, so nothing to publish or accept). */
export function routeSettingsFor(provider) {
  const mode = providerRouteMode(provider);
  return Object.fromEntries(routeSettingKeys(mode)
    .map((key) => [key, ROUTE_SETTING_FIELDS[key].read(provider?.[key])]));
}

/**
 * A stale-edit fingerprint of one route's overrides: a hash of the VALUES, not a `revision` column on `ai_route_bindings`, since these fields live in `data/providers.json`, which the route editor, a model refresh, a migration and a downgraded release all write without touching the graph (a row revision would miss the edit a human is most likely to collide with).
 * Truncated: a collision-detection token compared against a value taken seconds earlier by the same install, not a content address.
 */
export const routeSettingsRevision = (settings) => createHash('sha256')
  .update(JSON.stringify(Object.entries(settings || {}).sort(([a], [b]) => a.localeCompare(b))))
  .digest('hex')
  .slice(0, 16);

/** Keys a caller sent that this route's mode does not accept. */
export const unsupportedRouteSettings = (mode, patch) =>
  Object.keys(patch || {}).filter((key) => !routeSettingKeys(mode).includes(key));

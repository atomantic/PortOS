/** HAND-AUTHORED canonical→executable model aliases for one provider route (#6369), the correction surface for a `modelMap` a refresh could only fill with what it could VERIFY. */

import { routeSettingsRevision } from './providerRouteSettings.js';
import { isNonBlankStr } from '../textUtils.js';

/**
 * A route's `modelMap` answers: what does THIS harness have to be sent for a canonical backend model. `resolveRouteModels` derives it by round-tripping each stored model string through the harness's adapter and reports (not rewrites) a string no
 * candidate reproduces, so an OpenCode route with a bare `example-model` where the harness needs `<namespace>/example-model` resolves to nothing and no harness menu can offer it. This module is the correction: the user names the pair by hand, and it wins.
 *
 * **The merge rule:** observed and overridden aliases are stored separately and merged on read, never on write. `model_map` is what the last refresh OBSERVED (rewritten wholesale; a dropped model leaves it); `model_alias_overrides` is what the USER wrote
 * (no refresh touches it; only an explicit edit does). Effective map = `{ ...observed, ...overrides }`, so an override wins a collision and survives every refresh. An override for a model the route no longer lists is kept and reported stale
 * (as model pins and a binding's narrowed subset do: silently dropping a saved value makes a human's choice vanish unnoticed). Pure: no I/O, no clock, no provider call.
 */

/** A stored alias map with unusable entries dropped. Read defensively since these maps outlive the build that wrote them (a hand-edited psql column or an older-release backup must not put a `null` executable into a DTO the schema then refuses to publish). */
export const sanitizeModelAliases = (aliases) => Object.fromEntries(
  Object.entries(aliases && typeof aliases === 'object' ? aliases : {})
    .filter(([canonical, executable]) => isNonBlankStr(canonical) && isNonBlankStr(executable))
    .map(([canonical, executable]) => [canonical.trim(), executable.trim()]),
);

/** The alias map a route actually resolves through: observed with the user's overrides laid over the top; spreading overrides last is the whole contract that lets a hand-authored alias outlast the next refresh. */
export const effectiveModelAliases = (observed, overrides) => ({
  ...sanitizeModelAliases(observed),
  ...sanitizeModelAliases(overrides),
});

/**
 * Overrides whose executable spelling this route no longer lists. An alias claims "this route spells canonical X as Y" and goes stale when Y leaves the record's model list (not when X leaves the catalog: X reaching it is the alias's purpose).
 * A route listing NO models makes no staleness claim: `[]` can't distinguish "never fetched" from "fetched and empty" (as a record's catalog reads `unknown`), and flagging every alias on a never-refreshed install would warn about nothing.
 *
 * @param {Record<string,string>} overrides
 * @param {string[]|null|undefined} storedModels - the record's `models`
 * @returns {string[]} canonical names, in the order the overrides were stored
 */
export function staleModelAliases(overrides, storedModels) {
  const stored = Array.isArray(storedModels) ? storedModels.filter(isNonBlankStr) : [];
  if (stored.length === 0) return [];
  return Object.entries(sanitizeModelAliases(overrides))
    .filter(([, executable]) => !stored.includes(executable))
    .map(([canonical]) => canonical);
}

/** Stale-edit fingerprint of one route's overrides. `ai_route_bindings` has no revision column, so this reuses the hash `routeSettingsRevision` computes over a sorted entry list (as the mode overrides do): it catches every writer, where a row counter only notices those through the graph. */
export const modelAliasRevision = (overrides) => routeSettingsRevision(sanitizeModelAliases(overrides));


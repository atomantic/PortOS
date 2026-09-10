import { routeSettingsRevision } from './providerRouteSettings.js';
import { isNonBlankStr } from './textUtils.js';

/**
 * Hand-authored model aliases for one provider route (#6369).
 *
 * A route's `modelMap` answers one question: what does THIS harness have to be
 * sent for a given canonical backend model. `resolveRouteModels` derives it by
 * round-tripping every stored model string through the harness's own adapter,
 * and a string no candidate reproduces is reported rather than rewritten — an
 * OpenCode route carrying a bare `example-model` where the harness needs
 * `<namespace>/example-model` resolves to nothing at all. Nothing then puts
 * that model into the shared catalog, so no harness model menu can offer it.
 *
 * This module is the correction: the user names the pair by hand, and it wins.
 *
 * **The merge rule.** Observed and overridden aliases are stored separately and
 * merged on read, never merged on write:
 *
 *   - `model_map` is what the last refresh OBSERVED, rewritten wholesale by
 *     each refresh. A model the backend dropped leaves it, as it should.
 *   - `model_alias_overrides` is what the USER wrote. No refresh reads or
 *     writes it; only an explicit edit adds or removes an entry.
 *   - The effective map is `{ ...observed, ...overrides }`, so an override wins
 *     a key collision and survives every subsequent refresh.
 *
 * An override for a model the route no longer lists is kept and reported
 * stale — the same rule the model pins and a binding's narrowed subset already
 * follow, because silently dropping a saved value is how a human's choice
 * disappears with nobody deciding to remove it.
 *
 * Pure: no I/O, no clock, no provider call.
 */

/** Bounds shared by the row sanitizer and the request schema. */
export const MODEL_ALIAS_LIMITS = Object.freeze({ maxEntries: 200, maxLength: 512 });

/**
 * A stored alias map with unusable entries dropped.
 *
 * A row is read defensively because these maps outlive the build that wrote
 * them: a column hand-edited in psql, or restored from a backup taken by an
 * older release, must not be able to put a `null` executable into a DTO the
 * schema then refuses to publish.
 */
export const sanitizeModelAliases = (aliases) => Object.fromEntries(
  Object.entries(aliases && typeof aliases === 'object' ? aliases : {})
    .filter(([canonical, executable]) => isNonBlankStr(canonical) && isNonBlankStr(executable))
    .map(([canonical, executable]) => [canonical.trim(), executable.trim()]),
);

/**
 * The alias map a route actually resolves through: observed, with the user's
 * overrides laid over the top.
 *
 * Order is the whole contract — spreading overrides last is what makes a
 * hand-authored alias outlast the next refresh.
 */
export const effectiveModelAliases = (observed, overrides) => ({
  ...sanitizeModelAliases(observed),
  ...sanitizeModelAliases(overrides),
});

/**
 * Apply one edit to a route's overrides.
 *
 * `null` DELETES a key; a string sets it. Absent keys are preserved, so a panel
 * that read three aliases and changed one sends one. That three-valued shape is
 * the same one connection credentials use, for the same reason: the caller must
 * be able to change one entry without restating the rest.
 *
 * @returns {{aliases: Record<string,string>, removed: string[]}}
 */
export function applyModelAliasPatch(current, patch) {
  const aliases = sanitizeModelAliases(current);
  const removed = [];
  for (const [rawCanonical, value] of Object.entries(patch || {})) {
    const canonical = String(rawCanonical).trim();
    if (canonical === '') continue;
    if (value === null) {
      if (Object.hasOwn(aliases, canonical)) removed.push(canonical);
      delete aliases[canonical];
      continue;
    }
    aliases[canonical] = String(value).trim();
  }
  return { aliases, removed };
}

/**
 * Overrides whose executable spelling this route no longer lists.
 *
 * An alias claims "this route spells canonical X as Y". It goes stale when Y
 * leaves the record's model list — the backend dropped it — not when X leaves
 * the catalog, because X reaching the catalog is precisely what the alias is
 * for.
 *
 * A route listing NO models makes no staleness claim. `[]` on a provider record
 * cannot distinguish "never fetched" from "fetched and legitimately empty" (the
 * same reason a record's catalog reads `unknown` rather than `known: []`), and
 * reporting every alias as stale on a never-refreshed install would be a
 * warning about nothing.
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

/**
 * Stale-edit fingerprint of one route's overrides.
 *
 * `ai_route_bindings` carries no revision column, so this reuses the hash
 * `routeSettingsRevision` already computes over a sorted entry list — the same
 * technique the mode overrides use, and for the same reason: a fingerprint of
 * the values catches every writer, where a row counter would only notice the
 * ones that go through the graph.
 */
export const modelAliasRevision = (overrides) => routeSettingsRevision(sanitizeModelAliases(overrides));

/**
 * The canonical model names a connection's routes resolve, across all of them.
 *
 * The shared catalog is exactly this union, which is why an alias write
 * recomputes it: an override that adds a canonical name has not corrected
 * anything until the model menus can offer it. Derived from the maps already
 * stored — it probes nothing.
 *
 * @param {{modelMap?: object, modelAliasOverrides?: object}[]} routes
 */
export const connectionCatalogModels = (routes) => [...new Set((routes || [])
  .flatMap((route) => Object.keys(effectiveModelAliases(route?.modelMap, route?.modelAliasOverrides))))];

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { REDACTED_CREDENTIAL, providerConnectionProfile } from './providerConnections.js';
import {
  PROVIDER_GRAPH_SCHEMA_VERSION,
  buildProviderGraphPreview,
} from './providerGraphPreview.js';
import { PROVIDER_HARNESS_IDS, ROUTE_MODES, providerRouteMode } from './providerHarnesses.js';
import {
  effectiveModelAliases,
  modelAliasRevision,
  sanitizeModelAliases,
  staleModelAliases,
} from './providerModelAliases.js';
import { routeSettingsRevision, routeSettingsSchema } from './providerRouteSettings.js';

// `PROVIDER_GRAPH_SCHEMA_VERSION` is deliberately NOT re-exported: it is one
// wire version shared with the preview, and two flat `export *` modules in this
// directory publishing one identifier is exactly what the barrel's collision
// detector refuses. Import it from `providerGraphPreview.js`.

/**
 * The DURABLE half of the provider connection graph (#6367, design record
 * `docs/plans/2026-09-06-provider-connections-and-harnesses.md`).
 *
 * `providerGraphPreview.js` (#6366) answers "what WOULD an import create?" from
 * provider records alone. This module owns the records that survive a restart:
 * how a preview becomes durable rows, how those rows are sanitized for a
 * client, how they are materialized back into `data/providers.json`, and — the
 * load-bearing part — how a persisted graph is RECONCILED against a provider
 * file that may have moved underneath it.
 *
 * Everything here is pure. No database handle, no file I/O, no clock beyond the
 * injected id minter, so the reconciliation contract (which is where the data
 * loss lives) is testable without a Postgres or a temp directory.
 *
 * The three states a route's connection-owned values can be in:
 *
 *   - `projected` — last snapshot ACKNOWLEDGED as present in providers.json.
 *   - `pending`   — committed to the DB, not yet acknowledged as written.
 *   - the file's ACTUAL values, read fresh at reconcile time.
 *
 * Keeping both snapshots is what makes a crash between the DB commit and the
 * file write recoverable, and what stops a retry from clobbering a third value
 * some other writer put there — see {@link planGraphReconciliation}.
 */

// --- durable row DTOs --------------------------------------------------------
// `.strict()` for the same reason the preview DTOs are strict: a field added to
// a row must never ride out to a client because a mapper forgot to drop it.

const catalogSchema = z.object({
  state: z.enum(['unknown', 'known', 'failed']),
  models: z.array(z.string()),
  // Why the last refresh failed, already stripped of credential material
  // (#6369). Optional so rows written before the field existed still parse, and
  // nullable so a later SUCCESS can clear it without deleting the key.
  error: z.string().nullable().optional(),
}).strict();

const connectionDtoSchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().positive(),
  kind: z.string().min(1),
  label: z.string(),
  transports: z.record(z.string(), z.object({ baseUrl: z.string().min(1) }).strict()),
  hasCredentials: z.boolean(),
  catalog: catalogSchema,
}).strict();

const bindingDtoSchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().positive(),
  connectionId: z.string().min(1),
  harnessId: z.enum(PROVIDER_HARNESS_IDS).nullable(),
  variantKey: z.string().min(1),
  label: z.string(),
  enabled: z.boolean(),
  selectedModels: z.array(z.string()),
  // Derived, never stored: a binding whose route projection is unresolved
  // refuses further graph mutations until reconciliation repairs it.
  blocked: z.boolean(),
}).strict();

const routeDtoSchema = z.object({
  providerId: z.string().min(1),
  bindingId: z.string().min(1),
  mode: z.enum(ROUTE_MODES),
  // The EFFECTIVE alias map: what the last refresh observed, with the user's
  // hand-authored overrides laid over the top (#6369).
  modelMap: z.record(z.string(), z.string()),
  // The override half on its own, so the panel can say which aliases a human
  // wrote and offer to remove them, plus the fingerprint an edit must send
  // back. `ai_route_bindings` has no revision column, so the stale check is a
  // hash of these values — the same technique the mode overrides use.
  modelAliasOverrides: z.record(z.string(), z.string()),
  modelAliasRevision: z.string().min(1),
  // Overrides naming a spelling the record no longer lists. Reported, never
  // repaired: a saved alias is only ever removed by the person who wrote it.
  staleModelAliases: z.array(z.string()),
  // Presence only — the snapshots themselves can carry secrets.
  projectionPending: z.boolean(),
  // This mode's own overrides, and the fingerprint a write must send back
  // (#6369). Route-owned by construction: nothing here is connection state, so
  // editing it moves no other harness.
  settings: routeSettingsSchema,
  settingsRevision: z.string().min(1),
  // The effort ladder this route's harness actually accepts, or `null` for one
  // that takes no effort flag at all. Published rather than re-derived in the
  // browser so a renamed or path-configured binary still offers the right
  // levels — and so "no control" stays distinct from "an empty list".
  effortLevels: z.array(z.string()).nullable(),
  // Display half of the Shell hand-off, present only on a launchable TUI route.
  // The launch itself re-resolves this AND the provider's secret env server-side
  // (`shell:start { providerId }`), so the command line is never the contract.
  tuiCommandLine: z.string().optional(),
}).strict();

/** The full `GET /api/providers/management` body. */
export const managementGraphSchema = z.object({
  schemaVersion: z.literal(PROVIDER_GRAPH_SCHEMA_VERSION),
  activeProvider: z.string().nullable(),
  connections: z.array(connectionDtoSchema),
  bindings: z.array(bindingDtoSchema),
  routes: z.array(routeDtoSchema),
}).strict();

/**
 * The sanitized, validated body a client receives.
 *
 * Credentials, projection snapshots and raw provider records never appear: the
 * browser is told only WHETHER a connection has credentials and whether a
 * route's projection is settled. Every identity decision was already made
 * server-side on real values.
 *
 * `routeSettings` carries the per-route mode overrides the service resolved
 * from the live executable records (#6369). It arrives pre-resolved rather than
 * being read here because the TUI command line it also carries needs the host's
 * shell resolution, and this module stays pure. A route with no entry — a graph
 * row whose record is mid-removal — publishes an empty override set rather than
 * an absent field, so the client never has to branch on presence.
 *
 * A route entry also carries `storedModels` — the record's own model list — used
 * only to decide which hand-authored aliases have gone stale. It is read here
 * rather than from the graph row because `providers.json` is what a run
 * actually executes, so the file is the honest thing to check an alias against.
 *
 * @param {{routeSettings?: Map<string, object>}} input
 */
export function toManagementGraphDto({ connections, bindings, routes, activeProvider = null, routeSettings = new Map() }) {
  const blocked = new Set(routes.filter((route) => route.pending).map((route) => route.bindingId));
  return managementGraphSchema.parse({
    schemaVersion: PROVIDER_GRAPH_SCHEMA_VERSION,
    activeProvider: typeof activeProvider === 'string' ? activeProvider : null,
    connections: connections.map(({ id, revision, kind, label, transports, credentials, catalog }) => ({
      id,
      revision,
      kind,
      label,
      transports,
      hasCredentials: Object.keys(credentials || {}).length > 0,
      catalog,
    })),
    bindings: bindings.map(({ id, revision, connectionId, harnessId, variantKey, label, enabled, selectedModels }) => ({
      id, revision, connectionId, harnessId, variantKey, label, enabled, selectedModels, blocked: blocked.has(id),
    })),
    routes: routes.map(({ providerId, bindingId, mode, modelMap, modelAliasOverrides, pending }) => {
      const {
        settings = {}, effortLevels = null, tuiCommandLine = null, storedModels = null,
      } = routeSettings.get(providerId) || {};
      const overrides = sanitizeModelAliases(modelAliasOverrides);
      return {
        providerId,
        bindingId,
        mode,
        modelMap: effectiveModelAliases(modelMap, overrides),
        modelAliasOverrides: overrides,
        modelAliasRevision: modelAliasRevision(overrides),
        staleModelAliases: staleModelAliases(overrides, storedModels),
        projectionPending: Boolean(pending),
        settings,
        settingsRevision: routeSettingsRevision(settings),
        effortLevels,
        // Omitted rather than nulled: "not a launchable TUI" is the absence of
        // the affordance, not an empty command.
        ...(tuiCommandLine ? { tuiCommandLine } : {}),
      };
    }),
  });
}

// --- import ------------------------------------------------------------------

/** The connection-owned half of one provider record, as stored in a snapshot. */
export const connectionOwnedSnapshot = (provider) => providerConnectionProfile(provider).owned;

/** The identity a connection row asserts, secrets included. Server-side only. */
const identityKey = ({ kind, transports, credentials }) => JSON.stringify([
  kind,
  Object.entries(transports || {}).sort(([a], [b]) => a.localeCompare(b)),
  Object.entries(credentials || {}).sort(([a], [b]) => a.localeCompare(b)),
]);

/**
 * Mint durable rows from a read-only preview.
 *
 * Preview ids (`conn:…`, `binding:…`) are display scaffolding derived from a
 * provider id, so they would change the moment a record is renamed. Durable
 * rows get UUIDs, which is what lets a link survive a rename. Routes keep their
 * EXECUTABLE provider ids untouched — those are the saved-selection contract.
 *
 * A preview route with no binding (an isolated legacy record) gets no row at
 * all: it stays a valid legacy route the graph simply does not manage.
 *
 * @param {object} preview - from `buildProviderGraphPreview`
 * @param {() => string} [mintId] - injected for deterministic tests
 */
export function graphFromPreview(preview, mintId = randomUUID) {
  const connectionIds = new Map();
  const connections = preview.connections.map((connection) => {
    const id = mintId();
    connectionIds.set(connection.id, id);
    return {
      id,
      revision: 1,
      kind: connection.kind,
      label: connection.label,
      transports: connection.transports,
      credentials: connection.profile.credentials,
      catalog: connection.catalog,
    };
  });

  const bindingIds = new Map();
  const bindings = preview.bindings.map((binding) => {
    const id = mintId();
    bindingIds.set(binding.id, id);
    return {
      id,
      revision: 1,
      connectionId: connectionIds.get(binding.connectionId),
      harnessId: binding.harnessId,
      variantKey: binding.variantKey,
      label: binding.label,
      enabled: binding.enabled,
      selectedModels: binding.selectedModels,
    };
  });

  const routes = preview.routes.filter((route) => route.bindingId).map((route) => ({
    providerId: route.providerId,
    bindingId: bindingIds.get(route.bindingId),
    mode: route.mode,
    modelMap: route.modelMap,
    projected: route.owned,
    pending: null,
    pendingRevision: null,
  }));

  return { connections, bindings, routes };
}

/** Build the durable graph an install's current provider records imply. */
export const importGraphFromProviders = (data, mintId = randomUUID) =>
  graphFromPreview(buildProviderGraphPreview(data), mintId);

// --- reconciliation ----------------------------------------------------------

/**
 * Reconcile a persisted graph against the provider file as it ACTUALLY is.
 *
 * One function serves three callers, because they are the same problem:
 *
 *   - **boot** — the file may have been edited by a downgraded release, or a
 *     crash may have landed a DB commit without its file write;
 *   - **after a legacy write** — an old client's `PATCH /api/providers/:id`
 *     changed a connection-owned field with no idea a graph exists;
 *   - **after a restore** — half a backup can arrive without the other half.
 *
 * The rules, in the order they are applied per route:
 *
 *   1. The record is GONE → drop its row. A deleted provider is never
 *      resurrected; any saved selection naming it stays a visibly unresolved
 *      pin, and an emptied binding/connection is kept for explicit cleanup
 *      rather than deleted or auto-refilled.
 *   2. A `pending` snapshot exists and the file matches it → the write landed;
 *      acknowledge it.
 *   3. A `pending` snapshot exists and the file still matches `projected` → the
 *      write did not land; retry it.
 *   4. A `pending` snapshot exists and the file matches NEITHER → a third
 *      writer changed it. Refuse: never overwrite, keep the row's last valid
 *      executable values readable, and report the binding as blocked.
 *   5. Otherwise the file's values are authoritative. Routes are regrouped by
 *      the connection they actually describe: an unchanged group keeps its
 *      UUIDs; a changed group whose connection is SHARED with another binding
 *      clones it (detach) rather than editing a value another harness relies
 *      on; a changed group on an exclusive connection updates it in place; and
 *      a binding whose routes now disagree with each other splits.
 *   6. A provider record the graph has no row for is imported independently,
 *      as its own fragment — never auto-linked into an existing connection.
 *
 * @param {{connections:object[], bindings:object[], routes:object[]}} graph
 * @param {object[]} providers - current executable records
 * @param {{mintId?: () => string}} [options]
 */
export function planGraphReconciliation(graph, providers, { mintId = randomUUID } = {}) {
  const records = new Map(
    (Array.isArray(providers) ? providers : [])
      .filter((provider) => provider && typeof provider === 'object' && provider.id)
      .map((provider) => [provider.id, provider]),
  );
  const bindingsById = new Map(graph.bindings.map((binding) => [binding.id, binding]));
  const connectionsById = new Map(graph.connections.map((connection) => [connection.id, connection]));
  const bindingsPerConnection = new Map();
  for (const binding of graph.bindings) {
    bindingsPerConnection.set(binding.connectionId, (bindingsPerConnection.get(binding.connectionId) || 0) + 1);
  }

  const plan = {
    acknowledgements: [], // { providerId }               — pending landed; promote it to projected
    retries: [], // { providerId, owned }                 — rewrite these values into providers.json
    conflicts: [], // { providerId, bindingId, reason }   — refuse; the binding stays blocked
    removals: [], // providerId[]                         — drop the row, never resurrect
    regroups: [], // see below                            — detach / split / in-place update
    snapshots: [], // { providerId, owned }               — record the file's values as projected
    imports: { connections: [], bindings: [], routes: [] }, // rows for records with no mapping yet
  };

  const routesByBinding = new Map();
  for (const route of graph.routes) {
    if (!records.has(route.providerId)) {
      plan.removals.push(route.providerId);
      continue;
    }
    const provider = records.get(route.providerId);
    const owned = connectionOwnedSnapshot(provider);

    if (route.pending) {
      if (isDeepStrictEqual(owned, route.pending)) {
        plan.acknowledgements.push({ providerId: route.providerId });
      } else if (isDeepStrictEqual(owned, route.projected)) {
        plan.retries.push({ providerId: route.providerId, owned: route.pending });
      } else {
        plan.conflicts.push({ providerId: route.providerId, bindingId: route.bindingId, reason: 'external-change' });
      }
      // A route with an unsettled projection is deliberately excluded from the
      // regrouping below: its own values are exactly what is in dispute, and
      // regrouping on them would bake the disputed state into the graph.
      continue;
    }

    const list = routesByBinding.get(route.bindingId) || [];
    list.push({ route, provider, owned, profile: providerConnectionProfile(provider) });
    routesByBinding.set(route.bindingId, list);
  }

  for (const [bindingId, entries] of routesByBinding) {
    const binding = bindingsById.get(bindingId);
    if (!binding) continue;
    const stored = connectionsById.get(binding.connectionId) || null;
    const storedKey = stored ? identityKey(stored) : null;
    const shared = (bindingsPerConnection.get(binding.connectionId) || 0) > 1;

    // Group this binding's routes by the connection each one now describes.
    const groups = new Map();
    for (const entry of entries) {
      const key = identityKey(entry.profile);
      groups.set(key, [...(groups.get(key) || []), entry]);
    }

    // The group that KEEPS this binding is the one still matching the stored
    // connection; failing that, the largest, so the fewest routes are moved.
    const ordered = [...groups.values()].sort((a, b) => b.length - a.length);
    const keeperIndex = Math.max(0, ordered.findIndex((group) => identityKey(group[0].profile) === storedKey));
    const [keeper] = ordered.splice(keeperIndex, 1);

    for (const [index, group] of [keeper, ...ordered].entries()) {
      const isKeeper = index === 0;
      const lead = group[0];
      const unchanged = isKeeper && storedKey === identityKey(lead.profile);
      // A clone is required whenever the values changed AND the connection row
      // is shared: editing it in place would silently repoint another harness.
      const action = unchanged ? 'unchanged' : (isKeeper && !shared ? 'update' : 'clone');
      const models = [...new Set(group.flatMap((entry) => Object.keys(entry.route.modelMap)))];

      plan.regroups.push({
        routeIds: group.map((entry) => entry.route.providerId),
        // `null` means "mint this binding" — a split.
        bindingId: isKeeper ? bindingId : null,
        binding: isKeeper ? null : {
          id: mintId(),
          revision: 1,
          harnessId: binding.harnessId,
          // A split binding is a NEW configuration of the same harness on a
          // different backend, so it gets its own labeled variant rather than
          // colliding with the original's `default`.
          variantKey: `variant:${lead.route.providerId}`,
          label: String(lead.provider.name || lead.provider.id),
          // OR across the group, exactly as import does. Consent flags stay
          // per-route and never participate.
          enabled: group.some((entry) => entry.provider.enabled === true),
          selectedModels: models,
        },
        connectionAction: action,
        connection: {
          id: action === 'clone' ? mintId() : binding.connectionId,
          kind: lead.profile.kind,
          label: stored && isKeeper ? stored.label : String(lead.provider.name || lead.provider.id),
          transports: lead.profile.transports,
          credentials: lead.profile.credentials,
          catalog: unchanged ? stored.catalog : { state: models.length > 0 ? 'known' : 'unknown', models },
        },
      });

      for (const entry of group) {
        if (!isDeepStrictEqual(entry.owned, entry.route.projected)) {
          plan.snapshots.push({ providerId: entry.route.providerId, owned: entry.owned });
        }
      }
    }
  }

  const mapped = new Set(graph.routes.map((route) => route.providerId));
  const unmapped = [...records.values()].filter((provider) => !mapped.has(provider.id));
  if (unmapped.length > 0) plan.imports = importGraphFromProviders({ providers: unmapped }, mintId);

  return plan;
}

/** Whether a plan asks for any write at all. Lets boot skip a no-op pass. */
export const reconciliationIsNoop = (plan) =>
  plan.acknowledgements.length === 0
  && plan.retries.length === 0
  && plan.removals.length === 0
  && plan.snapshots.length === 0
  && plan.imports.routes.length === 0
  && plan.regroups.every((regroup) => regroup.connectionAction === 'unchanged' && regroup.bindingId);

// --- explicit management edits (#6369) ---------------------------------------

/**
 * Merge a credential patch into a connection's stored credentials.
 *
 * Three distinct inputs, three distinct outcomes — the sentinel-vs-empty rule
 * from AGENTS.md, applied to secrets, where conflating them silently destroys
 * one:
 *
 *   - key ABSENT  → preserve the stored secret (the client never had it)
 *   - value `null`→ an explicit clear
 *   - a string    → set it
 *
 * A client can only have learned `REDACTED_CREDENTIAL` by reading a sanitized
 * response, so echoing it back is never an intentional value. It is reported as
 * `rejected` rather than written, because storing `'***'` as the real secret
 * would break execution in a way no later edit could distinguish from a typo.
 *
 * @param {Record<string,string>} current
 * @param {Record<string,string|null>|undefined} patch
 * @returns {{credentials: Record<string,string>, rejected: string[]}}
 */
export function mergeConnectionCredentials(current, patch) {
  const credentials = { ...(current || {}) };
  const rejected = [];
  for (const [name, value] of Object.entries(patch || {})) {
    if (value === null) {
      delete credentials[name];
      continue;
    }
    if (value === REDACTED_CREDENTIAL) {
      rejected.push(name);
      continue;
    }
    credentials[name] = value;
  }
  return { credentials, rejected };
}

/** Bound on a persisted refresh error, so one runaway provider message cannot bloat a row. */
const CATALOG_ERROR_MAX = 300;

/**
 * A refresh failure reduced to something safe to persist and show.
 *
 * Provider errors routinely echo the request that produced them, so the
 * connection's OWN credential values are replaced before anything is stored —
 * an exact match on known secrets, not a guess at what a secret looks like.
 *
 * @param {unknown} error
 * @param {Record<string,string>} credentials - the connection's raw secrets
 * @returns {string}
 */
export function sanitizeCatalogError(error, credentials = {}) {
  const raw = (error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error || ''))
    || 'The model refresh failed';
  const redacted = Object.values(credentials)
    .filter((secret) => typeof secret === 'string' && secret.length > 0)
    .reduce((text, secret) => text.split(secret).join(REDACTED_CREDENTIAL), raw);
  return redacted.length > CATALOG_ERROR_MAX ? `${redacted.slice(0, CATALOG_ERROR_MAX)}…` : redacted;
}

/**
 * The catalog a refresh should leave behind.
 *
 * The rule that matters is the one this whole feature exists to protect: a
 * FAILED probe keeps the models it already knew. Only a successful probe writes
 * a model list, and a successful probe returning nothing writes `known` with an
 * empty list — a real answer from a backend whose last model was deleted, not
 * the same state as "never asked".
 *
 * A PARTIAL result — some harnesses on the backend answered, others did not —
 * is `known` (the models it lists really were observed) that KEEPS the error,
 * because reporting it as clean would hide a harness that cannot reach the
 * backend behind the models of one that can.
 *
 * @param {{state:string, models:string[]}} current - the stored catalog
 * @param {{refreshed: boolean, models?: string[], error?: string|null}} outcome
 * @returns {{state:'unknown'|'known'|'failed', models:string[], error:string|null}}
 */
export function nextConnectionCatalog(current, outcome) {
  const models = Array.isArray(current?.models) ? current.models : [];
  if (!outcome?.refreshed) {
    return { state: 'failed', models, error: outcome?.error ?? 'The model refresh failed' };
  }
  return { state: 'known', models: [...new Set(outcome.models || [])], error: outcome.error ?? null };
}

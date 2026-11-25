/**
 * The DURABLE half of the provider connection graph (#6367) — the pure record layer over
 * `ai_connections` / `ai_harness_bindings` / `ai_route_bindings`.
 */

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { REDACTED_CREDENTIAL, providerConnectionProfile } from './providerConnections.js';
import { buildProviderGraphPreview } from './providerGraphPreview.js';
import { sanitizeModelAliases } from './providerModelAliases.js';
import { SERVICE_CREDENTIAL_VIAS, SERVICE_PLANS } from '../serviceDefinitions.js';
import { isNonBlankStr } from '../textUtils.js';

/**
 * The DURABLE half of the provider connection graph (#6367, design record
 * `docs/plans/archive/2026-09-06-provider-connections-and-harnesses.md`).
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
  // Per-model facts a listing declared (#7563) and when it was last asked.
  // Optional for the same reason `error` is: older rows carry neither.
  capabilities: z.record(z.string(), z.object({ contextWindow: z.number().optional() }).strict()).optional(),
  refreshedAt: z.string().optional(),
}).strict();

/** One connection row as every management surface publishes it — exported so the service DTO extends it. */
export const connectionDtoSchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().positive(),
  kind: z.string().min(1),
  label: z.string(),
  transports: z.record(z.string(), z.object({ baseUrl: z.string().min(1) }).strict()),
  hasCredentials: z.boolean(),
  catalog: catalogSchema,
  // `slug` / `definitionId` are null on a row the boot backfill has not named.
  slug: z.string().nullable(),
  definitionId: z.string().nullable(),
  plan: z.enum(SERVICE_PLANS),
  enabled: z.boolean(),
  credentialVia: z.enum(SERVICE_CREDENTIAL_VIAS),
}).strict();

/**
 * The `credentials` key a service's credential pool (#17384) is stored under —
 * the one entry of that map that is not itself a secret string. Its shape and
 * rules live in `credentialPool.js`; it is declared here, with the other facts
 * about a connection's `credentials` map, so this boot-path module need not
 * load the pool logic.
 */
export const CREDENTIAL_POOL_KEY = 'credentialPool';

/** The stored pool keys' values, for redaction — tolerant of a hand-edited row. */
const pooledSecrets = (credentials) => {
  const entries = credentials?.[CREDENTIAL_POOL_KEY]?.entries;
  return Array.isArray(entries) ? entries.map((entry) => entry?.apiKey) : [];
};

/**
 * Whether a row holds a secret. Only a `stored` instance does (#7563): a
 * `bootstrap` one is supplied at spawn and an `env` / `cli-login` one is
 * held by something else, so a key left on such a row is not the credential.
 * The credential pool (#17384) holds EXTRA keys beside the primary, so a row
 * carrying only a pool still has no key of its own to run under.
 */
export const connectionHasCredentials = ({ credentials, credentialVia = 'stored' }) =>
  credentialVia === 'stored' && Object.keys(credentials || {}).some((name) => name !== CREDENTIAL_POOL_KEY);

/** Publish connection metadata without stored credentials. */
export const toConnectionDto = ({
  id, revision, kind, label, transports, credentials, catalog,
  slug = null, definitionId = null, plan = 'paid', enabled = true, credentialVia = 'stored',
}) => connectionDtoSchema.parse({
  id,
  revision,
  kind,
  label,
  transports,
  hasCredentials: connectionHasCredentials({ credentials, credentialVia }),
  catalog,
  slug,
  definitionId,
  plan,
  enabled,
  credentialVia,
});

// --- import ------------------------------------------------------------------

/** The connection-owned half of one provider record, as stored in a snapshot. */
export const connectionOwnedSnapshot = (provider) => providerConnectionProfile(provider).owned;

/**
 * The identity one ROUTE's profile asserts, secrets included. Server-side only.
 *
 * Two routes sharing this key describe the same backend as each other, which is
 * what keeps a binding's modes together and splits them once they diverge.
 * Whether a route still belongs on a STORED connection is a different question
 * — see {@link routeBelongsOnConnection}.
 */
const identityKey = ({ kind, transports, credentials }) => JSON.stringify([
  kind,
  Object.entries(transports || {}).sort(([a], [b]) => a.localeCompare(b)),
  Object.entries(credentials || {}).sort(([a], [b]) => a.localeCompare(b)),
]);

/**
 * Whether a route of backend kind `routeKind` may sit on a connection of
 * `connectionKind`. Equal kinds, plus one widening: a direct `api` record reads
 * back as kind `api` even when its endpoint IS a hosted gateway's (the shipped
 * `nvidia-nim` record holds the key its OpenCode wrappers use), so a `gateway:`
 * service instance may hold it. The transport and credential checks below still
 * have to pass — the kind alone never places a route.
 */
const routeKindFitsConnection = (routeKind, connectionKind) => routeKind === connectionKind
  || (routeKind === 'api' && typeof connectionKind === 'string' && connectionKind.startsWith('gateway:'));

/**
 * Whether a stored connection still CONTAINS the backend a route describes.
 *
 * A provider record names exactly one endpoint, so a route's profile always
 * reports exactly one transport — while a connection a human linked across
 * protocols declares one per protocol (an Ollama daemon reached by Claude on
 * its Anthropic port and by Codex on its `/v1` port is ONE backend). Demanding
 * {@link identityKey} equality here would therefore match none of a
 * multi-transport row's own routes and clone every binding off it, silently
 * undoing the explicit link the connection graph exists to hold.
 *
 * Containment, precisely:
 *
 *   - `kind` matches — a route never migrates between backend kinds, save a
 *     direct `api` record on a `gateway:` instance ({@link routeKindFitsConnection}).
 *   - The route's transport protocol is DECLARED by the connection at the same
 *     `baseUrl`. A route declaring no transport at all matches only a
 *     connection that declares none either: "names no endpoint" must never
 *     collapse into "sits on whichever backend you like".
 *   - The route's credentials are a SUBSET of the connection's, with every
 *     shared key equal. A row carrying one key per protocol is normal (Claude
 *     sends a token where OpenCode sends none); disagreeing on a key they share
 *     is a real move, and still detaches.
 *
 * `sameConnectionIdentity` stays strict on purpose: it answers "are these two
 * records the same backend?" at IMPORT time, where equality is what stops an
 * accidental merge. This is the looser question reconciliation asks about a
 * binding on an existing connection.
 */
export function routeBelongsOnConnection(profile, connection) {
  if (!connection || !routeKindFitsConnection(profile.kind, connection.kind)) return false;
  const declared = connection.transports || {};
  const transports = Object.entries(profile.transports || {});
  if (transports.length === 0) return Object.keys(declared).length === 0;
  // Both sides must name a real URL. A row hand-edited into `{ anthropic: {} }`
  // has no endpoint, and letting two absent values compare equal is exactly the
  // collapse of "not set" into "matches" this rule exists to prevent.
  const declaresSameEndpoint = ([protocol, transport]) => {
    const url = declared[protocol]?.baseUrl;
    return typeof url === 'string' && url !== '' && url === transport?.baseUrl;
  };
  if (!transports.every(declaresSameEndpoint)) return false;
  const secrets = connection.credentials || {};
  return Object.entries(profile.credentials || {}).every(([name, value]) => secrets[name] === value);
}

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

// --- derived presets (#7565) ---------------------------------------------------

/**
 * Whether a record is a DERIVED preset: one carrying the three structural keys
 * — `harnessId`, `method`, `serviceId` — that name the service instance its
 * connection-owned values are materialized from. Lives here (not in
 * `providerPresets.js`, which imports this module) because reconciliation is
 * the first reader.
 */
export const isDerivedPreset = (record) => Boolean(record) && typeof record === 'object'
  && [record.harnessId, record.method, record.serviceId].every(isNonBlankStr);

/**
 * Whether a derived preset DECLARES it sits on this connection — its
 * `serviceId` is the row's slug. A declaration outranks the profile
 * containment test: "derived from service X" is a fact the record states, not
 * one reconciliation infers, so a direct-API preset on a gateway instance
 * (whose profile reads back as kind `api`, not `gateway:<id>`) stays on the row
 * it names instead of being cloned onto a fragment of its own every pass.
 */
export const presetDeclaresConnection = (record, connection) =>
  isDerivedPreset(record) && typeof connection?.slug === 'string' && connection.slug === record.serviceId;

/**
 * Import derived presets ONTO the connections they declare, rather than as
 * fragments of their own. The preview's own grouping (mode siblings, identity
 * buckets) still decides which records share one binding; only the connection
 * edge is retargeted, and the binding takes the first free variant key on its
 * target so the database's uniqueness rules hold.
 *
 * A declared preset whose profile the preview isolates (a reason on it) gets
 * no route row, exactly as any other isolated record.
 */
function importDeclaredPresets(records, graph, bySlug, mintId) {
  const byId = new Map(records.map((record) => [record.id, record]));
  const fragment = importGraphFromProviders({ providers: records }, mintId);
  const variantKey = (connectionId, harnessId, key) => JSON.stringify([connectionId, harnessId ?? null, key]);
  const taken = new Set(graph.bindings.map((binding) => variantKey(binding.connectionId, binding.harnessId, binding.variantKey)));
  const bindings = [];
  const routes = [];
  for (const binding of fragment.bindings) {
    const own = fragment.routes.filter((route) => route.bindingId === binding.id);
    const target = bySlug.get(byId.get(own[0]?.providerId)?.serviceId);
    if (!target) continue;
    const key = taken.has(variantKey(target.id, binding.harnessId, 'default')) ? `variant:${own[0].providerId}` : 'default';
    taken.add(variantKey(target.id, binding.harnessId, key));
    bindings.push({ ...binding, connectionId: target.id, variantKey: key });
    routes.push(...own);
  }
  return { connections: [], bindings, routes };
}

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
    const shared = (bindingsPerConnection.get(binding.connectionId) || 0) > 1;

    // Routes the stored connection still CONTAINS stay on it together, whether
    // or not they describe it identically — that is what keeps a cross-protocol
    // link alive. Every other route regroups by the backend it now names.
    const onStored = [];
    const moved = new Map();
    for (const entry of entries) {
      if (presetDeclaresConnection(entry.provider, stored) || routeBelongsOnConnection(entry.profile, stored)) {
        onStored.push(entry);
        continue;
      }
      const key = identityKey(entry.profile);
      moved.set(key, [...(moved.get(key) || []), entry]);
    }

    // The group that KEEPS this binding is the one still on the stored
    // connection; failing that, the largest, so the fewest routes are moved.
    const ordered = [...moved.values()].sort((a, b) => b.length - a.length);
    if (onStored.length > 0) ordered.unshift(onStored);

    for (const [index, group] of ordered.entries()) {
      const isKeeper = index === 0;
      const lead = group[0];
      const unchanged = isKeeper && onStored.length > 0;
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
          // An unchanged row is republished exactly AS STORED rather than
          // narrowed to the single transport this route happens to name —
          // otherwise "nothing moved" would still describe a backend the other
          // harness on it cannot reach.
          transports: unchanged ? stored.transports : lead.profile.transports,
          credentials: unchanged ? stored.credentials : lead.profile.credentials,
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
  // A derived preset naming an existing instance is imported ONTO it (#7565);
  // everything else is its own fragment, never auto-linked.
  const bySlug = new Map(graph.connections.filter((connection) => connection.slug).map((connection) => [connection.slug, connection]));
  const declared = [];
  const fragments = [];
  for (const provider of unmapped) {
    (isDerivedPreset(provider) && bySlug.has(provider.serviceId) ? declared : fragments).push(provider);
  }
  if (fragments.length > 0) plan.imports = importGraphFromProviders({ providers: fragments }, mintId);
  if (declared.length > 0) {
    const onto = importDeclaredPresets(declared, graph, bySlug, mintId);
    plan.imports.bindings.push(...onto.bindings);
    plan.imports.routes.push(...onto.routes);
  }

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
  const redacted = [...Object.values(credentials), ...pooledSecrets(credentials)]
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
 * Every refresh stamps `refreshedAt` (#7563) — a failure too, so "last asked"
 * and "last answered" stay distinct facts — and a success records the
 * per-model `capabilities` its listing declared (today the context window),
 * while a failure keeps the previous ones with the previous models.
 *
 * @param {{state:string, models:string[], capabilities?: object}} current - the stored catalog
 * @param {{refreshed: boolean, models?: string[], error?: string|null, contextWindows?: Record<string, number>|null}} outcome
 * @param {{now?: () => string}} [options] - injected clock, for tests
 * @returns {{state:'unknown'|'known'|'failed', models:string[], error:string|null, capabilities?: object, refreshedAt: string}}
 */
export function nextConnectionCatalog(current, outcome, { now = () => new Date().toISOString() } = {}) {
  const models = Array.isArray(current?.models) ? current.models : [];
  if (!outcome?.refreshed) {
    return {
      state: 'failed',
      models,
      error: outcome?.error ?? 'The model refresh failed',
      ...(current?.capabilities ? { capabilities: current.capabilities } : {}),
      refreshedAt: now(),
    };
  }
  const next = [...new Set(outcome.models || [])];
  const windows = outcome.contextWindows && typeof outcome.contextWindows === 'object' ? outcome.contextWindows : {};
  const capabilities = Object.fromEntries(next
    .filter((model) => Number.isFinite(windows[model]))
    .map((model) => [model, { contextWindow: windows[model] }]));
  return { state: 'known', models: next, error: outcome.error ?? null, capabilities, refreshedAt: now() };
}

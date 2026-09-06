/**
 * Reading the provider connection graph (#6369).
 *
 * `GET /api/providers/management` returns three flat lists — connections,
 * harness bindings and executable routes. Every management screen needs the
 * same joined shape and the same three questions answered about it, so the
 * joining lives here rather than inside a component:
 *
 *   - which harnesses share this backend, and through which executable routes;
 *   - which routes a shared-model choice would affect;
 *   - which saved model pins the current subset no longer covers.
 *
 * Pure and side-effect-free. The graph is already sanitized server-side (a
 * connection reports `hasCredentials`, never a secret), so nothing here has to
 * redact — but nothing here may start inventing identity either: two
 * connections are the same only when the server says they share an id.
 */

import { harnessLabel } from '../utils/providerHarnesses.js';

/** Route modes in the order a human reads them: run it, watch it, call it. */
export const ROUTE_MODE_ORDER = Object.freeze(['cli', 'tui', 'api']);

const byModeOrder = (a, b) => ROUTE_MODE_ORDER.indexOf(a.mode) - ROUTE_MODE_ORDER.indexOf(b.mode);

/**
 * The graph joined into one row per connection.
 *
 * A connection with no bindings is KEPT, not filtered away: reconciliation
 * deliberately preserves an emptied connection for explicit cleanup, so hiding
 * it here would make the only row a user can act on invisible. Same for a
 * binding whose routes have all been deleted.
 *
 * @param {{connections?:object[], bindings?:object[], routes?:object[]}} graph
 * @returns {{connection:object, bindings:{binding:object, label:string, routes:object[]}[], routes:object[]}[]}
 */
export function groupGraphByConnection(graph) {
  const bindings = Array.isArray(graph?.bindings) ? graph.bindings : [];
  const routes = Array.isArray(graph?.routes) ? graph.routes : [];
  const routesByBinding = new Map();
  for (const route of routes) {
    const list = routesByBinding.get(route.bindingId) || [];
    list.push(route);
    routesByBinding.set(route.bindingId, list);
  }

  return (Array.isArray(graph?.connections) ? graph.connections : []).map((connection) => {
    const attached = bindings
      .filter((binding) => binding.connectionId === connection.id)
      .map((binding) => ({
        binding,
        label: binding.label || harnessLabel(binding.harnessId),
        routes: [...(routesByBinding.get(binding.id) || [])].sort(byModeOrder),
      }));
    return {
      connection,
      bindings: attached,
      routes: attached.flatMap((entry) => entry.routes),
    };
  });
}

/** One connection's joined row, or `null` — never a partial match on a label. */
export const findConnectionGroup = (groups, connectionId) =>
  groups.find((group) => group.connection.id === connectionId) || null;

/**
 * The models a binding offers, and where each one came from.
 *
 * An EMPTY `selectedModels` means "the whole shared catalog", not "nothing":
 * an imported binding has never been narrowed, and reading that as an empty
 * offer would blank every model menu on the install the moment the graph turned
 * on. Narrowing to nothing is expressed by the UI refusing to save it, not by a
 * value that also means "untouched".
 *
 * @returns {{model:string, selected:boolean}[]} catalog order, never reordered by state
 */
export function bindingModelOffer(connection, binding) {
  const catalog = Array.isArray(connection?.catalog?.models) ? connection.catalog.models : [];
  const chosen = Array.isArray(binding?.selectedModels) ? binding.selectedModels : [];
  const narrowed = chosen.length > 0;
  return catalog.map((model) => ({ model, selected: !narrowed || chosen.includes(model) }));
}

/**
 * Models a binding still names that the shared catalog no longer offers.
 *
 * Reported rather than repaired. A pin outside the catalog is the single most
 * common thing a refresh produces — the backend dropped a model — and silently
 * dropping it from the binding is how a saved selection disappears without
 * anyone deciding to remove it.
 */
export function staleSelectedModels(connection, binding) {
  const catalog = new Set(Array.isArray(connection?.catalog?.models) ? connection.catalog.models : []);
  return (Array.isArray(binding?.selectedModels) ? binding.selectedModels : [])
    .filter((model) => !catalog.has(model));
}

/**
 * How to describe a connection's catalog, keeping the three states distinct.
 *
 * `known` with zero models is a real answer from a backend with no models
 * installed; `unknown` is "never asked"; `failed` keeps the models it already
 * had. Collapsing any two of those into "0 models" is the exact bug the catalog
 * state field exists to prevent.
 */
export function catalogSummary(catalog) {
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  if (catalog?.state === 'failed') {
    return {
      tone: 'error',
      text: models.length > 0
        ? `Last refresh failed — showing ${models.length} previously known model${models.length === 1 ? '' : 's'}`
        : 'Last refresh failed — no models known yet',
      detail: catalog.error || null,
    };
  }
  if (catalog?.state === 'known') {
    return {
      tone: models.length > 0 ? 'ok' : 'warn',
      text: models.length > 0
        ? `${models.length} model${models.length === 1 ? '' : 's'}`
        : 'No models installed on this backend',
      detail: null,
    };
  }
  return { tone: 'muted', text: 'Not refreshed yet', detail: null };
}

// --- route mode overrides (#6369) --------------------------------------------
//
// A route's `settings` are the fields that belong to ONE execution mode: its
// args, its timeout, its effort and its model pins. The server decides which
// keys a mode publishes, so these two helpers never name a field — they walk
// whatever the route was given, and a mode that gains or loses a setting needs
// no client change.

/** The draft an override form edits: every published setting as text. */
export const routeOverrideDraft = (settings) => Object.fromEntries(
  Object.entries(settings || {}).map(([key, value]) => [
    key,
    key === 'args' ? (Array.isArray(value) ? value : []).join('\n') : (value == null ? '' : String(value)),
  ]),
);

/**
 * The CHANGED keys between a route's saved settings and its draft.
 *
 * Only differences travel, so a save cannot rewrite a field the human never
 * touched — which matters here because these values are also edited from the
 * route editor and by model refresh.
 *
 * Two normalizations, both deliberate:
 *
 *   - a blank text field is `null` (unpinned), never `''`. The server reads an
 *     empty pin as unset too, so treating them as different values would make
 *     every form dirty on open.
 *   - a blank `timeout` is NO CHANGE rather than a clear. The executable
 *     record's schema has no null timeout, so clearing one is the route
 *     editor's job; silently sending `null` here would break its next save.
 */
export function routeOverridePatch(settings, draft) {
  const patch = {};
  for (const [key, current] of Object.entries(settings || {})) {
    const typed = draft?.[key] ?? '';
    if (key === 'args') {
      const next = String(typed).split('\n').map((line) => line.trim()).filter(Boolean);
      const before = Array.isArray(current) ? current : [];
      if (next.length !== before.length || next.some((arg, index) => arg !== before[index])) patch.args = next;
      continue;
    }
    if (key === 'timeout') {
      const next = Number(String(typed).trim());
      if (String(typed).trim() !== '' && Number.isInteger(next) && next !== current) patch.timeout = next;
      continue;
    }
    const next = String(typed).trim() === '' ? null : String(typed).trim();
    if (next !== (current ?? null)) patch[key] = next;
  }
  return patch;
}

// --- route model aliases (#6369) ---------------------------------------------
//
// A route's `modelMap` says what THIS harness has to be sent for a given
// canonical backend model. A refresh can only record the aliases it verifies,
// so a spelling the harness adapter cannot reproduce is missing from it — and
// the shared catalog, and therefore every model menu. The panel lets a human
// supply the pair, which the server stores apart from what it observed so the
// correction outlives the next refresh.

/**
 * One row per alias the route resolves through, ready to render.
 *
 * Sorted by canonical name so the list does not reshuffle when an entry moves
 * between observed and manual. `manual` is what the user wrote (and may remove);
 * `stale` is a manual alias naming a spelling the route no longer lists — shown,
 * never dropped, exactly like a model pin outside the catalog.
 *
 * @returns {{canonical:string, executable:string, manual:boolean, stale:boolean}[]}
 */
export function routeModelAliasRows(route) {
  const effective = route?.modelMap && typeof route.modelMap === 'object' ? route.modelMap : {};
  const overrides = route?.modelAliasOverrides && typeof route.modelAliasOverrides === 'object'
    ? route.modelAliasOverrides
    : {};
  const stale = new Set(Array.isArray(route?.staleModelAliases) ? route.staleModelAliases : []);
  return Object.entries(effective)
    .map(([canonical, executable]) => ({
      canonical,
      executable,
      manual: Object.hasOwn(overrides, canonical),
      stale: stale.has(canonical),
    }))
    .sort((a, b) => a.canonical.localeCompare(b.canonical));
}

// --- creating a backend and a harness on it (#6369) --------------------------
//
// The two questions the create controls ask of a graph response. Both are
// answered from what the SERVER published (`creatableHarnesses`,
// `creatableConnectionKinds`), never from a table mirrored into the browser:
// which harnesses carry a command recipe, and which backend kinds a minted
// route can honestly describe, are server decisions.

/** The one transport protocol a connection declares, or `null`. */
export const connectionProtocol = (connection) => Object.keys(connection?.transports || {})[0] || null;

/**
 * Transport protocols a new backend may declare, each with the programs that
 * speak it, so the form can say what the choice is FOR.
 *
 * @returns {{protocol:string, drivers:string[]}[]}
 */
export function transportProtocolOptions(graph) {
  const harnesses = Array.isArray(graph?.creatableHarnesses) ? graph.creatableHarnesses : [];
  const byProtocol = new Map();
  for (const harness of harnesses) {
    byProtocol.set(harness.protocol, [...(byProtocol.get(harness.protocol) || []), harness.label]);
  }
  // A direct API route has no harness and speaks the OpenAI-compatible wire, so
  // that protocol is offerable even on a build shipping no OpenAI harness.
  byProtocol.set('openai', [...(byProtocol.get('openai') || []), 'Direct API']);
  return [...byProtocol.entries()]
    .map(([protocol, drivers]) => ({ protocol, drivers }))
    .sort((a, b) => a.protocol.localeCompare(b.protocol));
}

/**
 * The harnesses that can be added to THIS backend, plus the direct API option.
 *
 * Filtered by the backend's declared protocol rather than offered and then
 * refused: the server rejects a harness that does not speak it, and an option
 * whose only outcome is a 409 is not an option. `needsCredential` is why an
 * otherwise-valid choice will still be refused, so the row can say so before
 * the click rather than after it.
 *
 * @returns {{harnessId:string|null, label:string, modes:string[], needsCredential:string|null}[]}
 */
export function harnessOptionsFor(graph, connection) {
  const protocol = connectionProtocol(connection);
  const harnesses = (Array.isArray(graph?.creatableHarnesses) ? graph.creatableHarnesses : [])
    .filter((harness) => harness.protocol === protocol)
    .map((harness) => ({
      harnessId: harness.id,
      label: harness.label,
      modes: harness.modes,
      needsCredential: harness.credentialRequired && !connection?.hasCredentials ? harness.credentialKey : null,
    }));
  return protocol === 'openai'
    ? [...harnesses, { harnessId: null, label: 'Direct API', modes: ['api'], needsCredential: null }]
    : harnesses;
}

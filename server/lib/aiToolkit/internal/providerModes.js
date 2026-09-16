// Keep execution IDs stable: saved tasks and older peers still select a mode.
// Pair only conventional sibling IDs with the same harness and connection.
import { isDeepStrictEqual } from 'node:util';
import { hasCredentialBootstrap } from './credentialBootstrap.js';

const MODE_KEY_DEFAULTS = { endpoint: '', apiKey: '', envVars: {}, credentialBootstrap: null };

/**
 * The fields two records must AGREE on to be one harness in two modes.
 *
 * Exported because it is a constraint on writers, not just a detail of the
 * reader below: anything a pair minter varies per mode has to stay clear of
 * this list, or it mints a pair this function then refuses to group — the exact
 * failure a dual-mode create exists to prevent. `command` is checked separately
 * (it has no empty-value default).
 *
 * DERIVED from `MODE_KEY_DEFAULTS` rather than restated, because the pairing
 * test and `sharedModeUpdates`' fan-out list are one list seen from two sides:
 * a key that says "these two describe the same connection" but is NOT fanned
 * out when it changes splits the card on the very edit that changed it, and
 * leaves the mode the editor did not open pointed at the old backend. Adding a
 * key to the defaults above therefore opts it into both.
 */
export const MODE_GROUPED_KEYS = Object.freeze(Object.keys(MODE_KEY_DEFAULTS));

/** True when a record NAMES a connection-identity value rather than leaving it at the empty default. */
function namesModeValue(provider, key) {
  if (key === 'credentialBootstrap') return hasCredentialBootstrap(provider);
  const value = provider?.[key];
  if (typeof value === 'string') return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return false;
}

/** A fanned-out value must not ALIAS one object across two stored records. */
const detachModeValue = value => (value && typeof value === 'object' ? structuredClone(value) : value);

export function providerModeGroups(providers) {
  const byId = new Map(providers.map(provider => [provider.id, provider]));
  const paired = new Set();
  const groups = [];
  for (const tui of providers.filter(provider => provider.type === 'tui' && /-tui(?:-|$)/.test(provider.id))) {
    const stem = tui.id.replace(/-tui(?=-|$)/, '');
    const cli = [byId.get(stem), byId.get(`${stem}-cli`)].find(provider => provider?.type === 'cli');
    if (!cli || paired.has(cli.id) || !cli.command || cli.command !== tui.command) continue;
    // Backend, credential and environment: siblings naming DIFFERENT ones are
    // two connections, not one. A pair where only one names a value is the
    // asymmetry `unifyProviderModes` converges, so it does not reach here as a
    // lasting split.
    if (!MODE_GROUPED_KEYS.every(key =>
      isDeepStrictEqual(cli[key] || MODE_KEY_DEFAULTS[key], tui[key] || MODE_KEY_DEFAULTS[key]))) continue;
    groups.push([cli, tui]);
    paired.add(cli.id);
    paired.add(tui.id);
  }
  return [...groups, ...providers.filter(provider => !paired.has(provider.id)).map(provider => [provider])];
}

export function sharedModeUpdates(updates, sibling) {
  // Arguments, timeouts, routing consent and model pins remain mode-specific.
  //
  // Every `MODE_GROUPED_KEYS` field is shared for the reason the pairing
  // test above keys on it: endpoint, API key, env vars and bootstrap describe
  // the CONNECTION, not a mode's argv. The editor opens the group's
  // representative (the CLI mode), so any of them saved there and not fanned
  // out leaves the TUI mode — the one "Launch in Shell" resolves its command
  // line and env from — pointed at the old backend with the old credential,
  // and splits the one card in two on the next load. `unifyProviderModes`
  // converges a pair that arrived asymmetric by some other route.
  const shared = Object.fromEntries(['enabled', 'models', 'modelContextWindows', ...MODE_GROUPED_KEYS]
    .filter(key => Object.hasOwn(updates, key))
    .map(key => [key, detachModeValue(updates[key])]));
  // A caller deliberately repicking a default with a new catalog (the editor
  // or harness discovery) must repair a removed sibling default too. Ordinary
  // catalog probes omit defaultModel and retain their existing pin semantics.
  if (Array.isArray(updates.models) && Object.hasOwn(updates, 'defaultModel') && sibling?.defaultModel && !updates.models.includes(sibling.defaultModel)) {
    shared.defaultModel = updates.models[0] ?? null;
  }
  return shared;
}

/**
 * Give a mode sibling the connection-identity values its pair already carries.
 *
 * Grouped over a projection with every {@link MODE_GROUPED_KEYS} field ERASED,
 * because an asymmetric pair is invisible to the real rule — the unfanned key
 * is exactly the value it disagrees on, and an edit that changed two of them at
 * once (an endpoint AND its API key) disagrees on two. Only this fill uses the
 * loose grouping; the enablement/model convergence below keeps the strict one.
 *
 * Only a pair that is INCOMPLETE is repaired, under two conditions that
 * together mean the result is one mode's connection rather than a blend of two.
 * Either failing disqualifies the whole group, not just the offending key.
 *
 * It must not CONTRADICT — a key two modes both name with different values is a
 * deliberate configuration (two connections that happen to share a command),
 * and picking a winner between two endpoints or two credentials is nobody's
 * call to make silently.
 *
 * And every fill must come from the SAME donor mode. Two modes naming DISJOINT
 * halves of a connection contradict nowhere, so the check above waves them
 * through — yet merging them mints a hybrid neither record described: a CLI
 * mode holding only an API key beside a TUI mode holding only an endpoint would
 * hand that credential to a backend it was never entered for. With one donor,
 * every key the recipient does name already equals the donor's, so the repaired
 * pair is exactly the donor's connection — which is what "the editor wrote one
 * mode and the sibling never got it" actually looks like.
 */
function fillModeSiblingIdentity(providers) {
  const byId = new Map(providers.map(provider => [provider.id, provider]));
  const erased = Object.fromEntries(MODE_GROUPED_KEYS.map(key => [key, undefined]));
  let changed = false;
  for (const group of providerModeGroups(providers.map(provider => ({ ...provider, ...erased })))) {
    if (group.length < 2) continue;
    const modes = group.map(({ id }) => byId.get(id)).filter(Boolean);
    const namers = MODE_GROUPED_KEYS.map(key => [key, modes.filter(mode => namesModeValue(mode, key))]);
    if (namers.some(([key, named]) => named.some(mode => !isDeepStrictEqual(mode[key], named[0][key])))) continue;
    const fills = namers.filter(([, named]) => named.length === 1);
    if (new Set(fills.map(([, named]) => named[0].id)).size > 1) continue;
    for (const [key, named] of fills) {
      for (const mode of modes) {
        if (namesModeValue(mode, key)) continue;
        mode[key] = detachModeValue(named[0][key]);
        changed = true;
      }
    }
  }
  return changed;
}

export function unifyProviderModes(data) {
  const providers = Object.values(data.providers || {});
  // Identity FIRST: a pair split only by an unfanned connection field is
  // rejoined here, so the convergence below sees the one connection it is.
  let changed = fillModeSiblingIdentity(providers);
  for (const group of providerModeGroups(providers)) {
    if (group.length < 2) continue;
    const enabled = group.some(provider => provider.enabled === true);
    const models = [...new Set(group.flatMap(provider => provider.models || []))];
    for (const provider of group) {
      if (provider.enabled !== enabled || !isDeepStrictEqual(provider.models, models)) {
        Object.assign(provider, { enabled, models: [...models] });
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * The id and display name a harness's TUI sibling takes.
 *
 * `providerModeGroups` above pairs `<stem>` with `<stem>-tui`, so this is the
 * WRITE side of the rule it reads: mint a sibling any other way and the two
 * records stop being one harness. Declared here, beside the reader, and used by
 * every minter — `expandModePair` below, `mintRouteIds` and `createBinding`
 * for connection-backed routes — so the convention has one spelling.
 *
 * A distinct name matters as much as a distinct id: two identically-named rows
 * in the provider list are indistinguishable.
 */
export const modeSiblingId = (stem, mode) => (mode === 'tui' ? `${stem}-tui` : stem);
export const modeSiblingName = (name, mode) => (mode === 'tui' ? `${name} TUI` : name);

/**
 * Split one dual-mode create body into its per-mode create payloads, or `null`
 * when the body declares no `modes`.
 *
 * A program that runs both headlessly and interactively is one program on one
 * backend, but a record stores exactly one `type` — so configuring both used to
 * mean adding the same command twice and hoping the two records happened to
 * satisfy the pairing rule above. This mints them in that shape by
 * construction: every {@link MODE_GROUPED_KEYS} field (and `command`) comes
 * from the shared body, and only `id`, `name`, `type` and the mode's own
 * declared overrides differ.
 *
 * @param {{modes?:Record<string,object>, id?:string, name:string}} providerData
 * @returns {object[]|null} one create payload per mode, CLI first
 */
export function expandModePair(providerData) {
  const modes = providerData?.modes;
  if (!modes || typeof modes !== 'object') return null;

  const { modes: _modes, ...shared } = providerData;
  const stem = shared.id || String(shared.name).toLowerCase().replace(/[^a-z0-9]/g, '-');

  return ['cli', 'tui'].map((mode) => ({
    ...shared,
    ...modes[mode],
    id: modeSiblingId(stem, mode),
    name: modeSiblingName(shared.name, mode),
    type: mode,
  }));
}

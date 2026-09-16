// Keep execution IDs stable: saved tasks and older peers still select a mode.
// Pair only conventional sibling IDs with the same harness and connection.
import { isDeepStrictEqual } from 'node:util';

const MODE_KEY_DEFAULTS = { endpoint: '', apiKey: '', envVars: {}, credentialBootstrap: null };

/**
 * The fields two records must AGREE on to be one harness in two modes.
 *
 * Exported because it is a constraint on writers, not just a detail of the
 * reader below: anything a pair minter varies per mode has to stay clear of
 * this list, or it mints a pair this function then refuses to group — the exact
 * failure a dual-mode create exists to prevent. `command` is checked separately
 * (it has no empty-value default).
 */
export const MODE_GROUPED_KEYS = Object.freeze(['endpoint', 'apiKey', 'envVars', 'credentialBootstrap']);

export function providerModeGroups(providers) {
  const byId = new Map(providers.map(provider => [provider.id, provider]));
  const paired = new Set();
  const groups = [];
  for (const tui of providers.filter(provider => provider.type === 'tui' && /-tui(?:-|$)/.test(provider.id))) {
    const stem = tui.id.replace(/-tui(?=-|$)/, '');
    const cli = [byId.get(stem), byId.get(`${stem}-cli`)].find(provider => provider?.type === 'cli');
    if (!cli || paired.has(cli.id) || !cli.command || cli.command !== tui.command) continue;
    // `credentialBootstrap` is the connection's auth when there is no apiKey,
    // so siblings that disagree on it are two connections, not one.
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
  const shared = Object.fromEntries(['enabled', 'models', 'modelContextWindows'].filter(key => Object.hasOwn(updates, key)).map(key => [key, updates[key]]));
  // A caller deliberately repicking a default with a new catalog (the editor
  // or harness discovery) must repair a removed sibling default too. Ordinary
  // catalog probes omit defaultModel and retain their existing pin semantics.
  if (Array.isArray(updates.models) && Object.hasOwn(updates, 'defaultModel') && sibling?.defaultModel && !updates.models.includes(sibling.defaultModel)) {
    shared.defaultModel = updates.models[0] ?? null;
  }
  return shared;
}

export function unifyProviderModes(data) {
  let changed = false;
  for (const group of providerModeGroups(Object.values(data.providers || {}))) {
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

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
 */
export const MODE_GROUPED_KEYS = Object.freeze(['endpoint', 'apiKey', 'envVars', 'credentialBootstrap']);

/**
 * Fields belonging to the CLI mode ALONE, which must not ride the shared body
 * to the TUI sibling {@link expandModePair} mints beside it.
 *
 * `headlessArgs` is the non-interactive argv — a flag list handed to a program
 * being driven without a terminal, meaningless to a PTY launch, and already
 * declared mode-specific by `PROVIDER_MODE_OVERRIDE_KEYS`.
 *
 * Deliberately NOT here: `textTransport` and its consents. A record ADVERTISING
 * the Codex app-server transport is not a record permitted to use it — the two
 * explicit consents are, and they are never fanned out (see
 * `sharedModeUpdates`). The shipped Codex pair declares the transport on BOTH
 * modes, so dropping it would make a hand-minted pair differ from the seeded
 * one for the same program.
 *
 * Every key here must stay clear of {@link MODE_GROUPED_KEYS} — dropping one of
 * those would mint a pair `providerModeGroups` then refuses to group.
 */
export const CLI_ONLY_KEYS = Object.freeze(['headlessArgs']);

export function providerModeGroups(providers) {
  const byId = new Map(providers.map(provider => [provider.id, provider]));
  const paired = new Set();
  const groups = [];
  for (const tui of providers.filter(provider => provider.type === 'tui' && /-tui(?:-|$)/.test(provider.id))) {
    const stem = tui.id.replace(/-tui(?=-|$)/, '');
    const cli = [byId.get(stem), byId.get(`${stem}-cli`)].find(provider => provider?.type === 'cli');
    if (!cli || paired.has(cli.id) || !cli.command || cli.command !== tui.command) continue;
    // `credentialBootstrap` is the connection's auth when there is no apiKey,
    // so siblings naming DIFFERENT ones are two connections, not one. A pair
    // where only one names a bootstrap is the asymmetry `unifyProviderModes`
    // converges, so it does not reach here as a lasting split.
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
  // `credentialBootstrap` is shared for the same reason the pairing test above
  // keys on it: it is the connection's AUTH, not a mode's argv. The editor opens
  // the group's representative (the CLI mode), so a bootstrap saved there and
  // not fanned out leaves the TUI mode — the one "Launch in Shell" launches —
  // spawning a bare harness that falls through to ambient vendor auth, and
  // splits the one card in two. `unifyProviderModes` converges a pair that
  // arrived asymmetric by some other route.
  const shared = Object.fromEntries(['enabled', 'models', 'modelContextWindows', 'credentialBootstrap'].filter(key => Object.hasOwn(updates, key)).map(key => [key, updates[key]]));
  // A caller deliberately repicking a default with a new catalog (the editor
  // or harness discovery) must repair a removed sibling default too. Ordinary
  // catalog probes omit defaultModel and retain their existing pin semantics.
  if (Array.isArray(updates.models) && Object.hasOwn(updates, 'defaultModel') && sibling?.defaultModel && !updates.models.includes(sibling.defaultModel)) {
    shared.defaultModel = updates.models[0] ?? null;
  }
  return shared;
}

/**
 * Give a mode sibling the credential bootstrap its pair already carries.
 *
 * Grouped over a projection with `credentialBootstrap` ERASED, because an
 * asymmetric pair is invisible to the real rule — the bootstrap is exactly the
 * value it disagrees on. Only this fill uses the loose grouping; the
 * enablement/model convergence below keeps the strict one.
 *
 * Exactly one named bootstrap is repaired. Two different ones are a deliberate
 * configuration (two connections), and picking a winner between two credentials
 * is nobody's call to make silently.
 */
function fillModeSiblingBootstrap(providers) {
  const byId = new Map(providers.map(provider => [provider.id, provider]));
  let changed = false;
  for (const group of providerModeGroups(providers.map(provider => ({ ...provider, credentialBootstrap: undefined })))) {
    if (group.length < 2) continue;
    const modes = group.map(({ id }) => byId.get(id)).filter(Boolean);
    const named = modes.filter(hasCredentialBootstrap);
    if (named.length !== 1) continue;
    for (const mode of modes) {
      if (hasCredentialBootstrap(mode)) continue;
      mode.credentialBootstrap = structuredClone(named[0].credentialBootstrap);
      changed = true;
    }
  }
  return changed;
}

export function unifyProviderModes(data) {
  const providers = Object.values(data.providers || {});
  // Bootstrap FIRST: a pair split only by an unfanned bootstrap is rejoined
  // here, so the convergence below sees the one connection it actually is.
  let changed = fillModeSiblingBootstrap(providers);
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
 * ONE mode's create payload, derived from the body both modes share.
 *
 * The single writer of the pair convention: every {@link MODE_GROUPED_KEYS}
 * field (and `command`) comes from the shared body, and only `id`, `name`,
 * `type`, the {@link CLI_ONLY_KEYS} the TUI half must not inherit, and this
 * mode's own declared overrides differ. Mint a sibling any other way and
 * `providerModeGroups` stops seeing one harness.
 *
 * The shared body is the CLI mode's, so the drop is one-sided — and a value
 * declared explicitly in `overrides` still wins, because it lands after.
 *
 * @param {{id?:string, name:string}} shared - the body both modes are built from
 * @param {'cli'|'tui'} mode
 * @param {object} [overrides] - this mode's own fields (argv, prompt delay)
 */
export function modeSiblingPayload(shared, mode, overrides = {}) {
  const stem = shared.id || String(shared.name).toLowerCase().replace(/[^a-z0-9]/g, '-');
  const inherited = mode === 'tui'
    ? Object.fromEntries(Object.entries(shared).filter(([key]) => !CLI_ONLY_KEYS.includes(key)))
    : shared;

  return {
    ...inherited,
    ...overrides,
    id: modeSiblingId(stem, mode),
    name: modeSiblingName(shared.name, mode),
    type: mode,
  };
}

/**
 * Split one dual-mode create body into its per-mode create payloads, or `null`
 * when the body declares no `modes`.
 *
 * A program that runs both headlessly and interactively is one program on one
 * backend, but a record stores exactly one `type` — so configuring both used to
 * mean adding the same command twice and hoping the two records happened to
 * satisfy the pairing rule above. This mints them in that shape by
 * construction, through {@link modeSiblingPayload}.
 *
 * @param {{modes?:Record<string,object>, id?:string, name:string}} providerData
 * @returns {object[]|null} one create payload per mode, CLI first
 */
export function expandModePair(providerData) {
  const modes = providerData?.modes;
  if (!modes || typeof modes !== 'object') return null;

  const { modes: _modes, ...shared } = providerData;
  return ['cli', 'tui'].map((mode) => modeSiblingPayload(shared, mode, modes[mode]));
}

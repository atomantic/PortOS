// Keep execution IDs stable: saved tasks and older peers still select a mode.
// Pair only conventional sibling IDs with the same harness and connection.
import { isDeepStrictEqual } from 'node:util';

export function providerModeGroups(providers) {
  const byId = new Map(providers.map(provider => [provider.id, provider]));
  const paired = new Set();
  const groups = [];
  for (const tui of providers.filter(provider => provider.type === 'tui' && /-tui(?:-|$)/.test(provider.id))) {
    const stem = tui.id.replace(/-tui(?=-|$)/, '');
    const cli = [byId.get(stem), byId.get(`${stem}-cli`)].find(provider => provider?.type === 'cli');
    if (!cli || paired.has(cli.id) || !cli.command || cli.command !== tui.command) continue;
    if (!['endpoint', 'apiKey', 'envVars'].every(key =>
      isDeepStrictEqual(cli[key] || (key === 'envVars' ? {} : ''), tui[key] || (key === 'envVars' ? {} : '')))) continue;
    groups.push([cli, tui]);
    paired.add(cli.id);
    paired.add(tui.id);
  }
  return [...groups, ...providers.filter(provider => !paired.has(provider.id)).map(provider => [provider])];
}

export function sharedModeUpdates(updates) {
  // Arguments, timeouts, routing consent and model pins remain mode-specific.
  return Object.fromEntries(['enabled', 'models', 'modelContextWindows'].filter(key => Object.hasOwn(updates, key)).map(key => [key, updates[key]]));
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

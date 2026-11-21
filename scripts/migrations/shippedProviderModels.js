import { join } from 'node:path';
import { readJsonOrNull, readProvidersDoc, writeJsonAtomic } from './_lib.js';

/** Add shipped IDs to installed presets after the historical migration chain. */
export async function reconcileShippedProviderModels({ rootDir }) {
  const shipped = await readJsonOrNull(join(rootDir, 'data.reference', 'providers.json'));
  if (!shipped?.providers) return;
  const installed = await readProvidersDoc({ rootDir });
  if (!installed.ok) return;

  let changed = false;
  for (const [id, reference] of Object.entries(shipped.providers)) {
    if (!Array.isArray(reference?.models) || reference.models.length === 0) continue;
    if (!Object.hasOwn(installed.providers, id)) continue;
    const provider = installed.providers[id];
    // An execution alias inherits its catalog. A derived preset's explicit
    // allowlist is already a stronger form of curation than individual removals.
    if (!Array.isArray(provider?.models) || provider.type !== reference.type
      || provider.executionSourceProviderId || Array.isArray(provider.catalogNarrowing)) continue;
    const removed = new Set(Array.isArray(provider.removedModels) ? provider.removedModels : []);
    const offered = new Set(provider.models);
    const added = [...new Set(reference.models)].filter(model => !offered.has(model) && !removed.has(model));
    // A historical migration still pending on an older install can reinsert an
    // opted-out ID. Apply the opt-out after the chain, including when it did so.
    const kept = provider.models.filter(model => !removed.has(model));
    if (added.length === 0 && kept.length === provider.models.length) continue;
    provider.models = [...kept, ...added];
    changed = true;
  }
  if (changed) await writeJsonAtomic(installed.path, installed.config);
}

#!/usr/bin/env node
/**
 * Rewrite `data.reference/model-comparison.json` down to the models PortOS can
 * actually dispatch.
 *
 * A full Artificial Analysis sync returns the whole public index — 600+ rows
 * covering retired generations (claude-2.0, palm-2, llama-2), research
 * checkpoints, and models behind harnesses PortOS does not ship. None of that
 * belongs in the repo: the seed exists so a fresh install opens the comparison
 * chart on the models it can select in Settings > AI Providers > Models, and
 * anyone who wants the rest of the index syncs it into their own
 * `data/model-comparison.json` with an API key.
 *
 * Scope is derived from `data.reference/providers.json` rather than a hand-kept
 * list, so adding a model to a shipped provider and re-running this script is
 * all it takes to bring its benchmark rows along. `FRONTIER_ANCHORS` adds the
 * few families the chart is read against even when no shipped provider config
 * names them yet.
 *
 * Usage: node scripts/prune-model-comparison-seed.js [--check]
 *   --check  exit non-zero if the seed is not already pruned (CI/test use)
 */

import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { providerCatalogSlugs } from '../server/lib/comparisonModelScope.js';
import { filterSelectableModels } from '../server/lib/providerModels.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const seedPath = join(root, 'data.reference/model-comparison.json');
const providersPath = join(root, 'data.reference/providers.json');

/**
 * Families the comparison is anchored on regardless of provider config — the
 * current frontier a user reads their own model choice against. Kept short on
 * purpose; this is not a place to re-accumulate the full index.
 */
export const FRONTIER_ANCHORS = ['claude-fable-5.1', 'claude-fable-5'];

export async function inScopeModels() {
  const providers = JSON.parse(await readFile(providersPath, 'utf8'));
  const inventory = Object.values(providers.providers || {}).map(provider => ({
    models: filterSelectableModels((provider.models || []).map(model => (typeof model === 'string' ? model : model?.id))),
  }));
  const scope = providerCatalogSlugs(inventory);
  for (const model of FRONTIER_ANCHORS) scope.add(model);
  return scope;
}

/** `{ pruned, originalCount }` from a single read of the seed. */
export async function prunedSeed() {
  const scope = await inScopeModels();
  const catalog = JSON.parse(await readFile(seedPath, 'utf8'));
  return {
    pruned: { ...catalog, observations: catalog.observations.filter(row => scope.has(row.model)) },
    originalCount: catalog.observations.length,
  };
}

if (isDirectlyInvoked(import.meta.url)) {
  const { pruned, originalCount } = await prunedSeed();
  const models = new Set(pruned.observations.map(row => row.model)).size;
  if (process.argv.includes('--check')) {
    if (originalCount !== pruned.observations.length) {
      console.error(`❌ Seed carries ${originalCount} observations; ${pruned.observations.length} are in provider scope`);
      process.exit(1);
    }
    console.log(`✅ Seed is in scope: ${pruned.observations.length} observations across ${models} models`);
  } else {
    await writeFile(seedPath, `${JSON.stringify(pruned, null, 2)}\n`);
    console.log(`✂️  Pruned seed to ${pruned.observations.length} observations across ${models} models (was ${originalCount})`);
  }
}

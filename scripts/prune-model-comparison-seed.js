#!/usr/bin/env node
/**
 * Keep `data.reference/model-comparison.json` scoped to dispatched models and
 * publicly sourced benchmark and token-price observations. Keep benchmark calibration
 * cohorts and OpenRouter route prices even for models not yet installed. PortOS task
 * benchmark runs remain machine-local under Models → Performance.
 *
 * Scope is derived from `data.reference/providers.json` rather than a hand-kept
 * list, so adding a model to a shipped provider and re-running this script is
 * all it takes to bring its reference rows along. `FRONTIER_ANCHORS` adds a
 * few current models even when no shipped provider config names them yet.
 *
 * Usage: node scripts/prune-model-comparison-seed.js [--check]
 *   --check  exit non-zero if the seed is not already pruned (CI/test use)
 */

import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { localCatalogBenchmarkModels, providerCatalogSlugs } from '../server/lib/comparisonModelScope.js';
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
export const FRONTIER_ANCHORS = [
  'claude-fable-5.1', 'claude-fable-5', 'claude-opus-5.5', 'gpt-6-luna', 'gpt-6-sol',
];



export async function inScopeModels() {
  const providers = JSON.parse(await readFile(providersPath, 'utf8'));
  const inventory = Object.values(providers.providers || {}).map(provider => ({
    models: filterSelectableModels((provider.models || []).map(model => (typeof model === 'string' ? model : model?.id))),
  }));
  const scope = providerCatalogSlugs(inventory);
  // The other half of "models PortOS can dispatch": the shipped `ollama` and
  // `lmstudio` records carry an EMPTY model list — the real list is whatever the
  // user pulled — so providers.json alone excludes every model PortOS ships an
  // installer for. Only DECLARED equivalences widen the keep-set, so retaining a
  // row stays a reviewed decision rather than a side effect of a similar name.
  for (const model of localCatalogBenchmarkModels()) scope.add(model);
  // Endpoint pricing belongs to the exact serving tier, including aliases
  // that deliberately cannot resolve to another public model identity.
  for (const { models } of inventory) {
    for (const model of models) {
      scope.add(model);
      if (model.startsWith('opencode/')) scope.add(model.slice('opencode/'.length));
    }
  }
  for (const model of FRONTIER_ANCHORS) scope.add(model);
  return scope;
}

/** `{ pruned, originalCount }` from a single read of the seed. */
export async function prunedSeed() {
  const scope = await inScopeModels();
  const catalog = JSON.parse(await readFile(seedPath, 'utf8'));
  return {
    pruned: {
      ...catalog,
      observations: catalog.observations.filter(row => (scope.has(row.model) || Boolean(row.quality) || ['OpenRouter', 'OpenCode Zen'].includes(row.provider))),
    },
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

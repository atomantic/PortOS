#!/usr/bin/env node
/**
 * Command-line entry point for the agent-free resilience assay (#7460, part
 * of epic #7453). Runs a candidate Eidoverse world contribution through
 * `runResilienceAssay()` (server/services/eidoverseResilienceAssay.js) and
 * prints a readable pass/fail per disturbance scenario.
 *
 * Usage:
 *   node scripts/eidoverse-resilience-assay.js
 *     Runs every reference contribution module under
 *     server/services/eidoverseResilienceAssayFixtures/*.contribution.js.
 *     (The deliberately-failing fixture in that directory is named
 *     `*.failing.fixture.js` on purpose, so it is exercised only by
 *     eidoverseResilienceAssay.test.js and never trips this default run.)
 *
 *   node scripts/eidoverse-resilience-assay.js <module-path> [...more]
 *     Runs the assay against specific contribution modules instead. Each
 *     module must have a default export, or a single named export, that is
 *     a zero-argument factory returning `{ id, createSandbox, invariants? }`
 *     — see server/services/eidoverseResilienceAssayFixtures/beaconRelay.contribution.js.
 *     This is the shape the promote path (#7455, not yet built) is expected
 *     to call with each candidate contribution's module path, or it may
 *     import `runResilienceAssay` directly instead of shelling out here.
 *
 * Exits 0 when every contribution passes, 1 otherwise. Makes no network,
 * filesystem-beyond-the-fixtures, provider, or agent call.
 */
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runResilienceAssay } from '../server/services/eidoverseResilienceAssay.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURES_DIR = join(__dirname, '..', 'server', 'services', 'eidoverseResilienceAssayFixtures');

function defaultContributionModulePaths() {
  return readdirSync(DEFAULT_FIXTURES_DIR)
    .filter((file) => file.endsWith('.contribution.js'))
    .sort()
    .map((file) => join(DEFAULT_FIXTURES_DIR, file));
}

async function loadContribution(modulePath) {
  const mod = await import(pathToFileURL(modulePath).href);
  const factory = mod.default || Object.values(mod).find((value) => typeof value === 'function');
  if (typeof factory !== 'function') {
    throw new Error(`${modulePath} does not export a contribution factory function`);
  }
  return factory();
}

function printResult(modulePath, result) {
  const icon = result.pass ? '✅' : '❌';
  console.log(`${icon} ${result.contributionId} (${modulePath})`);
  for (const reason of result.reasons) {
    console.log(`   - ${reason}`);
  }
}

export async function runAssayCli(args) {
  const modulePaths = args.length > 0
    ? args.map((path) => resolve(process.cwd(), path))
    : defaultContributionModulePaths();

  if (modulePaths.length === 0) {
    console.log('ℹ️ No resilience-assay contributions to run.');
    return 0;
  }

  let allPassed = true;
  for (const modulePath of modulePaths) {
    const contribution = await loadContribution(modulePath);
    const result = runResilienceAssay(contribution);
    printResult(modulePath, result);
    if (!result.pass) allPassed = false;
  }
  return allPassed ? 0 : 1;
}

if (isDirectlyInvoked(import.meta.url)) {
  runAssayCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`❌ Resilience assay script failed: ${error.message}`);
      process.exit(1);
    });
}

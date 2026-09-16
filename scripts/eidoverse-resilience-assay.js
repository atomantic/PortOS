#!/usr/bin/env node
/**
 * Command-line entry point for the agent-free resilience assay (#7460, part
 * of epic #7453). Runs a candidate Eidoverse world contribution through
 * `runResilienceAssay()` (server/services/eidoverseResilienceAssay.js) and
 * prints a readable pass/fail per disturbance scenario.
 *
 * Usage:
 *   node scripts/eidoverse-resilience-assay.js
 *     Runs every registered contribution module (see
 *     server/services/eidoverseResilienceContributions.js, which the promote
 *     path in eidoverseFoundationLedger.js resolves through as well, by
 *     contribution id rather than by path).
 *
 *   node scripts/eidoverse-resilience-assay.js <module-path> [...more]
 *     Runs the assay against specific contribution modules instead. Each
 *     module must have a default export, or a single named export, that is
 *     a zero-argument factory returning `{ id, createSandbox, invariants? }`
 *     — see server/services/eidoverseResilienceAssayFixtures/beaconRelay.contribution.js.
 *
 * Exits 0 when every contribution passes, 1 otherwise. Makes no network,
 * filesystem-beyond-the-fixtures, provider, or agent call.
 */
import { resolve } from 'node:path';
import { runResilienceAssay } from '../server/services/eidoverseResilienceAssay.js';
import { listContributionModulePaths, loadContributionModule } from '../server/services/eidoverseResilienceContributions.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';

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
    : await listContributionModulePaths();

  if (modulePaths.length === 0) {
    console.log('ℹ️ No resilience-assay contributions to run.');
    return 0;
  }

  let allPassed = true;
  for (const modulePath of modulePaths) {
    const contribution = await loadContributionModule(modulePath);
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

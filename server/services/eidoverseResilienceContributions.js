/**
 * Where the agent-free resilience assay finds the contributions it replays.
 *
 * One resolver shared by the CLI (`scripts/eidoverse-resilience-assay.js`) and the
 * promote path (`eidoverseFoundationLedger.js`), so they cannot disagree about what
 * a registered contribution is. Sources: the fixture directory (#7460) and the fixed
 * registry of executable world controllers (#7456), so a `controller` foundation can
 * name its controller's id as its `contributionId`.
 *
 * Resolution is by CONTRIBUTION ID against a fixed directory, never a caller path:
 * the promote path is reached from an HTTP body, and importing a request-named
 * module is arbitrary code execution. `loadContributionModule()` takes a path only
 * because the CLI is a local developer tool.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CONTRIBUTIONS_DIR = fileURLToPath(new URL('./eidoverseResilienceAssayFixtures/', import.meta.url));

// `*.failing.fixture.js` is exercised only by the assay's own test, never registered as promotable.
const CONTRIBUTION_SUFFIX = '.contribution.js';

/** Absolute paths of every registered contribution module, in stable order. */
export async function listContributionModulePaths() {
  const files = await readdir(CONTRIBUTIONS_DIR);
  return files.filter((file) => file.endsWith(CONTRIBUTION_SUFFIX)).sort().map((file) => join(CONTRIBUTIONS_DIR, file));
}

/**
 * Import one contribution module and invoke its factory: a default (or single
 * named) zero-argument export returning `{ id, createSandbox, invariants? }`.
 */
export async function loadContributionModule(modulePath) {
  const mod = await import(pathToFileURL(modulePath).href);
  // A lone named export stands in for a default; SEVERAL do not (picking "the first function" could call a non-factory).
  const named = Object.values(mod).filter((value) => typeof value === 'function');
  const factory = typeof mod.default === 'function' ? mod.default : (named.length === 1 ? named[0] : null);
  if (!factory) throw new Error(`${modulePath} must export a default contribution factory, or exactly one named function (found ${named.length})`);
  return factory();
}

/**
 * Every registered contribution, from both sources, fixtures first then controllers.
 * `label` is for CLI output (a module path, or `controller:<id>`). The controller
 * registry is a dynamic import so the STATIC graph stays one-way.
 */
export async function listRegisteredContributions() {
  const fixtures = [];
  for (const modulePath of await listContributionModulePaths()) {
    fixtures.push({ label: modulePath, contribution: await loadContributionModule(modulePath) });
  }
  const { controllerAssayContributions } = await import('./eidoverseControllerRegistry.js');
  const controllers = (await controllerAssayContributions())
    .map((contribution) => ({ label: `controller:${contribution.id}`, contribution }));
  return [...fixtures, ...controllers];
}

/**
 * The registered contribution with this id, or `null` (not a throw, so the promote
 * path reports it as one refusal reason rather than a 500).
 */
export async function findContributionById(contributionId) {
  for (const { contribution } of await listRegisteredContributions()) {
    if (contribution?.id === contributionId) return contribution;
  }
  return null;
}

/**
 * The id of every registered contribution, in stable order. Authoring surfaces need
 * the real list; ids only, so module paths stay behind this resolver.
 */
export async function listRegisteredContributionIds() {
  return (await listRegisteredContributions())
    .map(({ contribution }) => contribution?.id)
    .filter((id) => typeof id === 'string' && id.length > 0);
}

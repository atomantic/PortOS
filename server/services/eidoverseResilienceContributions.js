/**
 * Where the agent-free resilience assay finds the contributions it replays.
 *
 * `eidoverseResilienceAssay.js` is deliberately I/O-free — it is handed a
 * contribution and runs it. Something still has to turn "the foundation named
 * `beacon-relay-demo`" into that object, and both the CLI
 * (`scripts/eidoverse-resilience-assay.js`) and the promote path
 * (`eidoverseFoundationLedger.js`) need the same answer. This module is that
 * one resolver, so the two cannot drift into disagreeing about what a
 * registered contribution is.
 *
 * Resolution is by CONTRIBUTION ID against a fixed directory, never by a
 * caller-supplied path: the promote path reaches this from an HTTP body, and
 * "import the module this request names" is arbitrary code execution wearing a
 * feature's clothes. `loadContributionModule()` still takes a path because the
 * CLI is a local developer tool being handed one on purpose.
 *
 * Today the directory holds the two reference fixtures shipped with #7460. When
 * executable world controllers land (#7456) their registry becomes a second
 * source here, and neither caller changes.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CONTRIBUTIONS_DIR = fileURLToPath(new URL('./eidoverseResilienceAssayFixtures/', import.meta.url));

// The deliberately-failing fixture beside them is named `*.failing.fixture.js`
// so it is exercised only by the assay's own test and never registers as a
// promotable contribution.
const CONTRIBUTION_SUFFIX = '.contribution.js';

/** Absolute paths of every registered contribution module, in stable order. */
export async function listContributionModulePaths() {
  const files = await readdir(CONTRIBUTIONS_DIR);
  return files.filter((file) => file.endsWith(CONTRIBUTION_SUFFIX)).sort().map((file) => join(CONTRIBUTIONS_DIR, file));
}

/**
 * Import one contribution module and invoke its factory.
 *
 * A module must export a default (or a single named) zero-argument factory
 * returning `{ id, createSandbox, invariants? }` — the shape
 * `runResilienceAssay()` consumes.
 */
export async function loadContributionModule(modulePath) {
  const mod = await import(pathToFileURL(modulePath).href);
  // A lone named export stands in for a default; SEVERAL do not. Picking "the
  // first function" out of an ordinary multi-export module would silently call
  // something that is not a factory at all and hand back its return value.
  const named = Object.values(mod).filter((value) => typeof value === 'function');
  const factory = typeof mod.default === 'function' ? mod.default : (named.length === 1 ? named[0] : null);
  if (!factory) throw new Error(`${modulePath} must export a default contribution factory, or exactly one named function (found ${named.length})`);
  return factory();
}

/**
 * The registered contribution with this id, or `null` when none matches.
 *
 * Returning null rather than throwing is what lets the promote path report
 * "nothing is registered under that id" as one refusal reason beside the
 * others instead of as a 500.
 */
export async function findContributionById(contributionId) {
  for (const modulePath of await listContributionModulePaths()) {
    const contribution = await loadContributionModule(modulePath);
    if (contribution?.id === contributionId) return contribution;
  }
  return null;
}

/**
 * The id of every registered contribution, in stable order.
 *
 * A foundation is promotable only once it names a contribution the assay can
 * replay, so the authoring surfaces (the Eidoverse promote panel, a mind
 * deciding what to package) need the real list rather than a free-text field
 * that only reports its mistake at the promote gate. Ids only — module paths
 * stay behind this resolver, both because a caller must never hand one back as
 * a path and because a filesystem path is not something a UI or a prompt needs.
 */
export async function listRegisteredContributionIds() {
  const ids = [];
  for (const modulePath of await listContributionModulePaths()) {
    const contribution = await loadContributionModule(modulePath);
    if (typeof contribution?.id === 'string' && contribution.id) ids.push(contribution.id);
  }
  return ids;
}

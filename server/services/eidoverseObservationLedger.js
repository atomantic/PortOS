/**
 * The install-local visit marker behind observation-first discovery (#7457, epic
 * #7453): persistence, clock and collection around the pure report builder in
 * `server/lib/eidoverseObservation.js`. The marker must persist because each mind
 * wake is a new process, and the in-memory cursors do not survive that boundary.
 *
 * Storage: `file-primary` (`data/eidoverse/observation.json`), machine-local, never
 * federated. No seed or migration: an absent file (or one from a newer PortOS) is
 * "never observed", reported as `firstObservation: true`.
 */

import { join } from 'node:path';
import { PATHS, atomicWrite, readJSONFile } from '../lib/fileUtils.js';
import { createMutex } from '../lib/asyncMutex.js';
import { extractEidoverseDesignOverrides, resolveEidoverseDesign } from '../lib/eidoverseWorldDesign.js';
import { summarizeControllerInstall } from '../lib/eidoverseControllers.js';
import {
  EIDOVERSE_OBSERVATION_SCHEMA_VERSION,
  buildEidoverseObservation,
} from '../lib/eidoverseObservation.js';

// Read through `PATHS` per call, not `dataPath()`: suites redirect the data root by proxying this module's `fileUtils` import, which `dataPath()` never sees.
const markerFile = () => join(PATHS.data, 'eidoverse', 'observation.json');

// Re-entrancy guard: one turn can call `eidoverse.observe` twice, and read-marker → diff → write-marker must not interleave.
const withMarkerLock = createMutex();

/**
 * Strict read: an unparseable `observation.json` must NOT read as "never observed"
 * (the next observation would report the whole world as new); an ABSENT file is `null`.
 */
async function readMarker() {
  const raw = await readJSONFile(markerFile(), null, { allowArray: false, strict: true });
  if (!raw || typeof raw !== 'object' || !raw.marker || typeof raw.marker !== 'object') return null;
  // A marker from a NEWER PortOS degrades to "never observed"; older markers stay readable (new fields are optional in the differ).
  if (Number(raw.marker.schemaVersion) > EIDOVERSE_OBSERVATION_SCHEMA_VERSION) return null;
  return raw.marker;
}

async function writeMarker(marker) {
  await atomicWrite(markerFile(), { schemaVersion: EIDOVERSE_OBSERVATION_SCHEMA_VERSION, marker });
}

/**
 * The install's resolved design, so the report names the districts the world actually
 * renders. An unreadable recipe falls back to the shipped default design.
 */
async function resolveDesign() {
  const recipe = await import('./eidoverseWorld.js')
    .then((module) => module.readEidoverseWorldRecipe())
    .catch(() => null);
  const design = resolveEidoverseDesign(extractEidoverseDesignOverrides(recipe), recipe?.assets || {});
  return { districts: design.districts, includes: design.includes };
}

/**
 * Observe the world: collect live PortOS signals, the foundation ledger, installed
 * controllers and the resolved design; diff against the last visit marker; commit a new one.
 *
 * Observing advances the marker (so it is not idempotent, and the tool is a `write`);
 * pass `{ commit: false }` to look without stamping. Pass `source` when the caller
 * already collected the world-signal projection this turn (#7630): collecting fans
 * out across ~20 service reads. Travel destinations are not collected here (they are
 * already in `source.peers[].travelAvailable`). A collection failure degrades to an
 * unavailable section, never an empty one (`readSource` in the pure lib).
 */
export async function observeEidoverseWorld({ signal, commit = true, source: collectedSource = null, now = () => new Date().toISOString() } = {}) {
  const [source, ledger, controllers, design] = await Promise.all([
    collectedSource ?? import('./eidoverseWorldSources.js')
      .then((module) => module.collectEidoverseWorldSources({ signal, includeAttentionReasons: true }))
      .catch(() => ({})),
    import('./eidoverseFoundationLedger.js')
      .then((module) => module.listEidoverseFoundations())
      .catch(() => null),
    import('./eidoverseControllerRuntime.js')
      .then((module) => module.listEidoverseControllers())
      .catch(() => null),
    resolveDesign(),
  ]);

  return withMarkerLock(async () => {
    const marker = await readMarker();
    const { report, marker: nextMarker } = buildEidoverseObservation({
      source,
      districts: design.districts,
      includes: design.includes,
      // `null`, NOT `[]`, on a failed collection: `[]` would report every foundation gone then new; the builder carries an unavailable section forward.
      foundations: Array.isArray(ledger?.foundations) ? ledger.foundations : null,
      foundationCounts: ledger?.counts ?? null,
      // Summarized: the pure lib reads `lastTickOk`/`lastTickReason`, which only exist on this projection.
      controllerInstalls: Array.isArray(controllers?.installs)
        ? controllers.installs.map((install) => summarizeControllerInstall(install))
        : null,
      controllerCounts: controllers?.counts ?? null,
      marker,
      observedAt: now(),
    });
    if (commit) await writeMarker(nextMarker);
    return report;
  });
}

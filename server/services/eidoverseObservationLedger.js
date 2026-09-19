/**
 * The install-local visit marker behind observation-first discovery (#7457,
 * epic #7453) — the persistence, clock, and collection shell around the pure
 * report builder in `server/lib/eidoverseObservation.js`.
 *
 * **Why a marker has to persist at all.** "What is new since I last looked" is
 * the stigmergic half of the slice: a mind wakes, observes, acts, and ends its
 * turn, and the next wake is a different process with no memory of the last
 * one. The in-memory things that already resemble this are not substitutes —
 * the world chat cursor lives in a 100-entry ring buffer that a restart
 * empties, and `lastOfferingListHash` in the peer sync is content-change
 * detection for a background sweep, per-peer and also in memory. Neither
 * survives a wake boundary, which is exactly the boundary this has to cross.
 *
 * Storage is `data/eidoverse/observation.json` — `file-primary` and MACHINE
 * LOCAL, the same class as `foundations.json` and `controllers.json` beside it
 * (`docs/STORAGE.md`). It never federates: a marker is a record of what THIS
 * install's mind has looked at, which is the install's own behavior, and the
 * machine-local privacy ADR keeps that off the federation layer. There is no
 * `data.reference/` seed and no migration is owed — an absent file IS the
 * "never observed" state every install starts from, and that state is
 * deliberately distinguishable from an empty one: a first observation reports
 * `firstObservation: true` rather than declaring a months-old world new.
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

// Read through `PATHS` per call rather than `dataPath()`, for the same reason
// the foundation ledger does: a suite redirects the data root by proxying this
// module's `fileUtils` import, and `dataPath()` resolves against `paths.js`'s
// own binding, which that proxy never sees.
const markerFile = () => join(PATHS.data, 'eidoverse', 'observation.json');

// A re-entrancy guard, NOT a defense against competing actors (AGENTS.md's
// trust model rules those out): one turn can call `eidoverse.observe` more
// than once, and read-marker → diff → write-marker is a read-modify-write that
// must not interleave with itself or the second call would diff against a
// marker the first already replaced.
const withMarkerLock = createMutex();

/**
 * Strict read: an `observation.json` this process cannot parse must NOT read
 * as "never observed", because the next observation would then report a whole
 * settled world as new. `strict: true` throws on unreadable bytes, while a
 * genuinely ABSENT file still reads as the `null` marker it is.
 */
async function readMarker() {
  const raw = await readJSONFile(markerFile(), null, { allowArray: false, strict: true });
  if (!raw || typeof raw !== 'object' || !raw.marker || typeof raw.marker !== 'object') return null;
  // A marker written by a NEWER PortOS is not something this build can diff
  // against safely, so it degrades to "never observed" (one honest
  // `firstObservation`) instead of silently diffing against fields it does not
  // understand. Older markers stay readable: every field added since is
  // optional in the differ.
  if (Number(raw.marker.schemaVersion) > EIDOVERSE_OBSERVATION_SCHEMA_VERSION) return null;
  return raw.marker;
}

async function writeMarker(marker) {
  await atomicWrite(markerFile(), { schemaVersion: EIDOVERSE_OBSERVATION_SCHEMA_VERSION, marker });
}

/**
 * The install's resolved design, so the report names the districts the world
 * actually renders. Resolving the stored recipe (rather than reaching for the
 * shipped constant) is what keeps a mind from describing a V2 "Federation
 * Harbor" that V3 renamed to the Federation Terminal, or a district a user's
 * overrides moved. A recipe that cannot be read falls back to the shipped
 * default design, never to an older one.
 */
async function resolveDesign() {
  const recipe = await import('./eidoverseWorld.js')
    .then((module) => module.readEidoverseWorldRecipe())
    .catch(() => null);
  const design = resolveEidoverseDesign(extractEidoverseDesignOverrides(recipe), recipe?.assets || {});
  return { districts: design.districts, includes: design.includes };
}

/**
 * Observe the world: collect the live PortOS signals a projection would place,
 * the foundation ledger, the installed controllers, and the install's resolved
 * design; diff them against the last visit marker; and commit a new one.
 *
 * **Observing advances the marker**, which is the whole point — the trail a
 * mind leaves is what makes the NEXT observation's `changes` mean anything. So
 * this is not idempotent, and the tool is declared a `write` rather than a
 * read. Pass `{ commit: false }` to look without stamping.
 *
 * Pass a `source` when the caller has ALREADY collected the world-signal
 * projection this turn (the playbook phase picker does, #7630):
 * `collectEidoverseWorldSources()` fans out across ~20 service reads, and
 * collecting it twice in one wake doubles that for a projection already in
 * hand.
 *
 * Travel destinations are deliberately NOT collected here:
 * `collectEidoverseWorldSources()` already resolves them and folds the result
 * into `source.peers[].travelAvailable`, and `listEidoverseDestinations()`
 * probes `/capabilities` on every online peer — asking again would double that
 * outbound fan-out to recompute a field already in hand.
 *
 * Every collection failure degrades to an unavailable section rather than
 * failing the observation: a mind that cannot read its controller list should
 * still get to see its districts. `null` sections are reported as unavailable,
 * never as empty (`readSource` in the pure lib).
 */
export async function observeEidoverseWorld({ signal, commit = true, source: collectedSource = null, now = () => new Date().toISOString() } = {}) {
  const [source, ledger, controllers, design] = await Promise.all([
    collectedSource ?? import('./eidoverseWorldSources.js')
      .then((module) => module.collectEidoverseWorldSources({ signal }))
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
      // `null`, NOT `[]`, when the collection failed: an empty list would report
      // every foundation as gone and then as new again next time, because the
      // marker is rewritten from the same list. The builder carries an
      // unavailable section forward instead.
      foundations: Array.isArray(ledger?.foundations) ? ledger.foundations : null,
      foundationCounts: ledger?.counts ?? null,
      // Summarized, never raw: the pure lib reads `lastTickOk`/`lastTickReason`,
      // which only exist on this projection — a raw record carries them inside
      // `lastOutcome`, so handing one over would silently report every
      // controller as never-ticked.
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

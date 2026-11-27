/** Bind pre-route storage checks and the ordered database migration, recovery, and warm-up steps. */

import { join } from 'path';
import { resolveInstallRoot } from '../../lib/dataRoot.js';
import { tightenSecureFile } from '../../lib/secureAuthStore.js';
import { verifyCollectionVersions } from '../../lib/collectionStore.js';
import { conflictJournalStore } from '../../lib/conflictJournal.js';
import { setUserCatalogTypes } from '../../lib/catalog/catalogTypes.js';
import { runMigrations } from '../../../scripts/run-migrations.js';
import { runDatabasePhase, gateOnDatabase, runDbAndCatalogMigrations, warmMandatoryStores } from '../bootstrapSequence.js';
import { loadUsage } from '../usage.js';
import { markCosAgentMigrationsSettled } from '../cos/cosState.js';
import { readUserTypes as readUserTypeSlice } from '../catalogUserTypes/store.js';
import { reconcileStackerNewsSchedulers } from '../stackerNewsScheduler.js';
import { initProviderGraph } from '../provider/providerGraph.js';
import { brainCollectionStores } from '../brainStorage.js';
import { universeStore } from '../universeBuilder.js';
import { seriesStore } from '../pipeline/series.js';
import { issueStore } from '../pipeline/issues.js';
import { storyBuilderStore } from '../storyBuilder.js';
import { writersRoomStore } from '../writersRoom/store.js';
import { mediaCollectionStore } from '../mediaCollections.js';
import { rapidReaderLibraryStore } from '../rapidReaderLibrary.js';
import { commissionStore } from '../creativeCommissions/store.js';
import { outcomesStore as liOutcomesStore } from '../layeredIntelligenceOutcomes.js';
import * as gameStore from '../games/store.js';
import * as fableLoomStore from '../fableLoom/store.js';
import { listProjects } from '../creativeDirector/local.js';
import { isFileBackend } from '../../lib/pgFileFacade.js';
import { checkHealth, ensureSchema } from '../../lib/db.js';
import { initializeMessageDrafts } from '../messageDrafts.js';

export const preRouteStorageSteps = ({ serverDir, dataDir, smokeBoot, exit }) => ({
  // Apply pending data migrations BEFORE the AI toolkit reads stage-config.json
  // and providers.json. Without this, a plain pull-and-restart (no update.sh)
  // leaves new prompt stages and other shipped data changes unregistered —
  // existing installs hit "Stage X not found" until the user manually runs
  // `npm run migrations` or `npm run update`. Idempotent and cheap when the
  // applied-list is already current.
  // Prefer PORTOS_DATA_ROOT (set at real launch in ecosystem.config.cjs) over the
  // import.meta.url-derived path so a server booted from inside a CoS agent
  // worktree still resolves to the real install; runMigrations also skips a
  // worktree-rooted path as a backstop (#1947).
  applyDataMigrations: async () => {
    try {
      await runMigrations({ rootDir: resolveInstallRoot(join(serverDir, '..')) });
    } catch (err) {
      // Boot normally logs this and keeps going, which would let the smoke
      // report readiness after abandoning its migration sweep.
      if (!smokeBoot) throw err;
      console.error(`❌ Smoke boot: migration run failed, refusing to report ready: ${err?.stack ?? err}`);
      return exit(1);
    } finally {
      // An upgrade or older snapshot can leave credential stores at their
      // previous default mode even when no application write is pending.
      await Promise.all(['settings.json', 'managed-visitor-credentials.json'].map(file =>
        tightenSecureFile(join(dataDir, file)).catch(error => {
          console.warn(`⚠️ Could not restrict permissions on ${file}: ${error.code || 'error'}`);
        })
      ));
    }
    // Local recovery only: no mail, browser, or LLM provider calls.
    await initializeMessageDrafts();
  },

  // Normalize existing usage.json with the file migrations before the
  // usage store imports it.
  loadUsage,

  // Verify every registered collection's on-disk type-level schemaVersion
  // matches what the code expects. Mismatches mean a migration didn't run (or
  // the user rolled the code back below a forward-only migration) — log loudly
  // but DO NOT crash the server. PortOS is single-user (AGENTS.md "Security
  // Model"); a hard exit on startup is worse than a noisy log the user can act
  // on. Returns per-store statuses for downstream telemetry; we discard them.
  verifyCollections: () => verifyCollectionVersions([universeStore(), seriesStore(), issueStore(), conflictJournalStore(), storyBuilderStore(), mediaCollectionStore(), rapidReaderLibraryStore, liOutcomesStore(), commissionStore(), gameStore, fableLoomStore, ...brainCollectionStores()]),
});

/**
 * The database phase's dependencies. `runDatabasePhase` (bootstrapSequence.js)
 * owns the gate → migrate → warm → arm ordering; this supplies the real db.js,
 * the real migration scripts, and the real stores.
 *
 * Escape hatches for the health gate (dev/tests only, UNSUPPORTED for
 * production): `MEMORY_BACKEND=file` (explicit file backend) and test runners
 * (test suites boot without a database). Both downgrade "PostgreSQL is required"
 * from a fail-fast to a warning.
 *
 * Every migration/warm step is imported lazily, at the moment it runs, exactly
 * as before the extraction — nothing in this phase is pulled into the module
 * graph on a boot that never reaches it.
 */
export const runDatabaseBootPhase = () => runDatabasePhase({
  gate: async () => {
    const { dbReady } = await gateOnDatabase({
      checkHealth,
      ensureSchema,
      escapeHatch: isFileBackend()
    });
    // ensureSchema is threaded through to the migrations below so the phase
    // resolves the db.js module exactly once.
    return { dbReady, ensureSchema };
  },

  // Releases CoS reads that wait on the agent-record migrations (020/021) once the
  // runner has had its turn — a failed migration exits the process instead.
  migrate: ({ dbReady, ensureSchema }) => runDbAndCatalogMigrations({
    dbReady,
    ensureSchema,
    // Versioned DB-migration runner (#1029): ordered schema-DELTA migrations
    // (renames / type changes / data transforms / embedding-dim changes) that
    // ensureSchema()'s additive IF NOT EXISTS gates can't express. Loading the
    // runner is a separate step from running it because only the latter is
    // fatal — a module that won't load falls to the group's log-and-continue.
    loadDbMigrationRunner: async () => (await import('../../scripts/run-db-migrations.js')).runDbMigrations,
    migrateBibleToCatalog: async () => (await import('../../scripts/migrateBibleToCatalog.js')).migrateBibleToCatalog(),
    // One-time data repair: rewrite legacy machine universe tags
    // (`from-universe`, `universe:<id>`) on backfilled rows into the friendly
    // universe NAME tag. Marker-gated in data/catalog-universe-tags.applied.json.
    repairUniverseTags: async () => (await import('../../scripts/repairUniverseTags.js')).repairUniverseTags(),
    // Per-record catalog payload-shape migration — walks rows whose stored
    // payload.schemaVersion lags the registry-current and applies registered
    // upgraders. No-ops via marker once an install is at the high-water version.
    migrateCatalogPayload: async () => (await import('../../scripts/migrateCatalogPayload.js')).migrateCatalogPayload(),
    // One-time canon↔catalog reconciliation: collapse any pre-existing
    // divergence between an embedded universe-canon entry and its catalog row
    // (they were copy-on-write mirrors before the bidirectional projection
    // landed). LWW on updatedAt; writes the winner to both sides. Marker-gated
    // in data/catalog-canon-reconcile.applied.json.
    reconcileCanonCatalog: async () => (await import('../../scripts/reconcileCanonCatalog.js')).reconcileCanonCatalog(),
    // Media asset index (#1000): ensure its schema + subscribe the
    // generation-completed hooks. The full reconcile of the derived media_assets
    // table against on-disk images/videos runs after listen() (#16556).
    initMediaAssetIndex: async () => (await import('../mediaAssetIndex/index.js')).initMediaAssetIndex()
  }).finally(markCosAgentMigrationsSettled),

  warmStores: () => warmMandatoryStores({
    // Universe Builder PG warm (#1014): listIds() is the cheapest call that
    // forces backend selection + the migrateUniversesToDB import.
    warmUniverses: () => universeStore().listIds(),
    // Pipeline series + issues PG warm (#1015): same contract.
    warmSeries: () => seriesStore().listIds(),
    warmIssues: () => issueStore().listIds(),
    // Story Builder sessions PG warm (#1016): same contract.
    warmStoryBuilder: () => storyBuilderStore().listIds(),
    // Writers Room PG warm (#1017): listWorkIds() forces backend selection +
    // migrateWritersRoomToDB. Draft .md bodies stay on disk (file-primary);
    // only the metadata migrates.
    warmWritersRoom: () => writersRoomStore().listWorkIds(),
    // Authoritative catalog user-type warm (#1001): load the registry from the
    // catalog_user_types store (runs the one-time settings→DB import on first
    // access), so a normal install always serves with the registry warm even if
    // the early fire-and-forget warm raced a cold DB.
    warmCatalogUserTypes: async () => {
      const warmTypes = await readUserTypeSlice();
      setUserCatalogTypes(Array.isArray(warmTypes) ? warmTypes : []);
    },
    // Creative Director PG warm (#997): unlike the other stores, CD's file→DB
    // import is triggered lazily on first backend access; at boot the only other
    // trigger is a NOT-awaited fire-and-forget recoverInFlightProjects() in an
    // earlier step, so it can still be in flight here. listProjects() forces
    // selectBackend() → the (idempotent, marker-gated) import to completion,
    // which the prune below depends on.
    warmCreativeDirector: async () => listProjects(),
    // Legacy artifact prune: removes the `.imported` / `.bak-NNN` recovery
    // copies the migrators parked aside, but ONLY when the live row count
    // matches the marker's recorded import (a wiped/restored DB keeps the
    // recovery files). Marker-gated in data/legacy-prune.applied.json.
    pruneLegacyFiles: async () => (await import('../../scripts/pruneImportedLegacyFiles.js')).pruneImportedLegacyFiles()
  }),

  // Provider connection graph (#6367): first run imports every provider record
  // into ai_connections / ai_harness_bindings / ai_route_bindings; later runs
  // reconcile against providers.json. Reads and writes local state only.
  reconcileProviderGraph: async () => {
    await initProviderGraph();
    // Per-harness enablement (#7564): normalize the settings slice and prime
    // the composite cache's revision. Settings-only — no provider is contacted.
    await (await import('../harnessEnablement.js')).reconcileHarnessEnablement();
  },

  reconcileStackerNews: reconcileStackerNewsSchedulers
});

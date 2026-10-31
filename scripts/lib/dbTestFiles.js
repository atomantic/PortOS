import { posix } from 'node:path';

/**
 * The DB-backed test files, relative to the Vitest root (server/). Exported
 * as the single source of truth: the DB config's `include` uses it, and the drift
 * guard in lib/db.guards.test.js imports it to assert no checkHealth()-gated
 * suite is left out. `**\/db.test.js` only matches a file named exactly
 * `db.test.js` — a `<name>.db.test.js` suite is NOT auto-included and must be
 * listed explicitly below (the drift guard fails the build if you forget).
 */
export const DB_TEST_INCLUDE = [
  'services/catalogDB.merge.db.test.js',
  'services/catalogIdentity/protocol.db.test.js',
  'services/catalogDB.identityIntegration.db.test.js',
  'services/trackAlbumMembership.db.test.js',
  'services/stackerNews.db.test.js',
  'services/peerExecutionLedger.db.test.js',
  'services/voice/profiles.db.test.js',
  'services/voice/studio.db.test.js',
  '../scripts/perf/collectionFixture.db.test.js',
  '../scripts/recover-synced-test-fixtures.db.test.js',
  'services/appQuality.db.test.js',
  'services/deepAudit.db.test.js',
  '**/db.test.js',
  'services/codeAnimation/stages.db.test.js',
  'services/codeAnimation/sound.db.test.js',
  'services/codeAnimation/acceptance.db.test.js',
  'services/codeAnimation/stages.realBrowser.db.test.js',
  'services/mediaAssetIndex/galleryCollections.db.test.js',
  'services/dbAdmin.db.test.js',
  'services/backup.db.test.js',
  'services/catalogDB.test.js',
  'services/catalogDB.facets.db.test.js',
  'services/catalogDB/listIngredients.db.test.js',
  'services/catalogDB/payloadKey.db.test.js',
  'services/catalogDB.media.db.test.js',
  'services/catalogPrimitiveUsage.db.test.js',
  'services/catalogStories.db.test.js',
  'services/catalogUniverseFiling.db.test.js',
  'services/catalogSync.tombstoneRevival.db.test.js',
  'services/catalogSync.changeClock.db.test.js',
  'services/catalogSync.pendingParents.db.test.js',
  'services/humanActivity.db.test.js',
  'services/postRunDb.db.test.js',
  'services/userActions.db.test.js',
  'services/memoryDB.db.test.js',
  'services/memorySync.db.test.js',
  'services/privacySubjects.db.test.js',
  'services/privacyVault.db.test.js',
  'services/privacyOrgs.db.test.js',
  'services/privacyChanges.db.test.js',
  'services/privacyBrokers.db.test.js',
  'services/privacyOptOut.db.test.js',
  'services/providerGraphStore.db.test.js',
  'services/catalogCanonProjection.test.js',
  'services/catalogRefResolver.test.js',
  'lib/db/schema/beeper.db.test.js',
  'lib/db/schema/catalogMediaLibrarySeed.db.test.js',
  'services/beeperConversations.db.test.js',
  'services/beeperTribe.db.test.js',
  'services/tribe.db.test.js',
  'services/tribePurge.db.test.js',
  'services/accountErasure.db.test.js',
  'services/beeperSync.db.test.js',
  'services/githubNotifications.db.test.js',
  'services/creativeDirector/projectsDB.test.js',
  'services/musicVideo/projectsDB.test.js',
  'routes/catalog.test.js',
  'routes/catalogOwnedPrimitive.db.test.js',
  'routes/mindToolRecipes.db.test.js',
  'routes/decks.db.test.js',
  'services/decksSync.db.test.js',
  'services/modelPinRecords.db.test.js',
  'scripts/run-db-migrations.test.js',
  'scripts/migrateMemoryToPg.db.test.js',
  'lib/db/schema/audit.db.test.js',
  'lib/db/schema/syncFeed.db.test.js',
  'services/cosTaskRepository.db.test.js',
  'services/releaseSynchronizationStore.db.test.js',
  'scripts/db-migrations/018-cos-tasks-from-files.db.test.js',
  'services/cosAgentRepository.db.test.js',
  'scripts/db-migrations/020-cos-agents-from-state.db.test.js',
  'scripts/db-migrations/022-unlock-canon-joined-records.db.test.js',
  'scripts/db-migrations/023-owned-records-join-universe-canon.db.test.js',
  'scripts/db-migrations/024-scrap-canon-entries.db.test.js',
  'scripts/db-migrations/025-drop-replicated-brain-bridge-memories.db.test.js',
];

const patterns = DB_TEST_INCLUDE.map((pattern) => posix.normalize(posix.join('server', pattern)));
const exactFiles = new Set(patterns.filter((pattern) => !pattern.includes('*')));
const globs = patterns.filter((pattern) => pattern.includes('*'));

/** Resolve the canonical, server-rooted include patterns without loading Vitest. */
export const resolveDbTestFiles = (files) => files.filter((file) => {
  const serverPath = file.startsWith('server/') ? file : posix.normalize(posix.join('server', file));
  return exactFiles.has(file) || exactFiles.has(serverPath)
    || globs.some((pattern) => posix.matchesGlob(file, pattern) || posix.matchesGlob(serverPath, pattern));
});

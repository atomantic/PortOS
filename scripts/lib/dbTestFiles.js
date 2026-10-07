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
  'services/peerExecutionLedger.db.test.js',
  'services/voice/profiles.db.test.js',
  'services/voice/studio.db.test.js',
  '../scripts/perf/collectionFixture.db.test.js',
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
  'services/catalogDB.media.db.test.js',
  'services/catalogSync.tombstoneRevival.db.test.js',
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
  'services/beeperConversations.db.test.js',
  'services/beeperTribe.db.test.js',
  'services/tribe.db.test.js',
  'services/tribePurge.db.test.js',
  'services/beeperSync.db.test.js',
  'services/creativeDirector/projectsDB.test.js',
  'services/musicVideo/projectsDB.test.js',
  'routes/catalog.test.js',
  'routes/mindToolRecipes.db.test.js',
  'routes/decks.db.test.js',
  'services/decksSync.db.test.js',
  'services/modelPinRecords.db.test.js',
  'scripts/run-db-migrations.test.js',
  'scripts/migrateMemoryToPg.db.test.js',
  'lib/db/schema/audit.db.test.js',
  'lib/db/schema/syncFeed.db.test.js',
];

const patterns = DB_TEST_INCLUDE.map((pattern) => posix.normalize(posix.join('server', pattern)));
const exactFiles = new Set(patterns.filter((pattern) => !pattern.includes('*')));
const globs = patterns.filter((pattern) => pattern.includes('*'));

/** Resolve the canonical, server-rooted include patterns without loading Vitest. */
export const resolveDbTestFiles = (files) => files.filter((file) => (
  exactFiles.has(file) || globs.some((pattern) => posix.matchesGlob(file, pattern))
));

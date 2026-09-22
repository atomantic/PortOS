/**
 * Explicit release step: no provider calls and no peer evidence.
 *
 * PortOS publishes its own `.quality.json` through the same publisher every other
 * managed app uses — this command is the manual trigger, equivalent to the audit
 * hook the app's `publishQualitySnapshot` toggle automates. The publisher opens
 * a merge-on-green pull request rather than committing on the live checkout.
 *
 * `--migrate` rewrites a v1 file, or a historical `quality-snapshot.json`, to
 * canonical schema v2 using only the rows already in the file. It does not read
 * audit measurements and does not invent any.
 */
import { getAppById, PORTOS_APP_ID } from '../server/services/apps.js';
import {
  publishAppQualitySnapshot, migrateAppQualitySnapshot, APP_QUALITY_SNAPSHOT_FILENAME,
} from '../server/services/appQualitySnapshotFile.js';

const migrate = process.argv.includes('--migrate');
const { close } = await import('../server/lib/db.js');
await (async () => {
  const app = await getAppById(PORTOS_APP_ID);
  if (!app) throw new Error('PortOS app record not found; cannot publish a quality snapshot');
  const result = migrate ? await migrateAppQualitySnapshot(app) : await publishAppQualitySnapshot(app);
  // `no-changes` is a success: the committed snapshot already matches.
  // `no-legacy-file` is a success for `--migrate`: there was nothing to convert.
  const quiet = new Set(['no-changes', 'no-legacy-file']);
  if (!result.published && !quiet.has(result.reason)) {
    throw new Error(`Nothing published (${result.reason}); existing ${APP_QUALITY_SNAPSHOT_FILENAME} preserved`);
  }
})().finally(close);

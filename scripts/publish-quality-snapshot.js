/**
 * Explicit release step: no provider calls and no peer evidence.
 *
 * PortOS publishes its own `.quality.json` through the same publisher every other
 * managed app uses — this command is the manual trigger, equivalent to the audit
 * hook the app's `publishQualitySnapshot` toggle automates. The publisher opens
 * a merge-on-green pull request rather than committing on the live checkout.
 */
import { getAppById, PORTOS_APP_ID } from '../server/services/apps.js';
import { publishAppQualitySnapshot, APP_QUALITY_SNAPSHOT_FILENAME } from '../server/services/appQualitySnapshotFile.js';

const { close } = await import('../server/lib/db.js');
await (async () => {
  const app = await getAppById(PORTOS_APP_ID);
  if (!app) throw new Error('PortOS app record not found; cannot publish a quality snapshot');
  const result = await publishAppQualitySnapshot(app);
  // `no-changes` is a success: the committed snapshot already matches the evidence.
  if (!result.published && result.reason !== 'no-changes') {
    throw new Error(`Nothing published (${result.reason}); existing ${APP_QUALITY_SNAPSHOT_FILENAME} preserved`);
  }
})().finally(close);

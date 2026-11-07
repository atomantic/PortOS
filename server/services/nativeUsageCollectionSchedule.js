import { schedule } from './eventScheduler.js';

const EVENT_ID = 'native-usage-daily-collection';

/** Keeps a retention sweep from removing usage nobody happened to read. A cron has no
 * boot run and this has no missed-slot catch-up, so starting the server scans nothing.
 * Reads local files only: no inference, Codex account read or peer contact.
 */
export function startNativeUsageCollectionSchedule() {
  schedule({
    id: EVENT_ID, type: 'cron', cron: '17 4 * * *',
    handler: async () => {
      const { NATIVE_USAGE_DASHBOARD_LIMITS } = await import('./nativeUsageReport.js');
      const { collectNativeUsageSources } = await import('./nativeUsageCollection.js');
      const { stats } = await collectNativeUsageSources({ limits: NATIVE_USAGE_DASHBOARD_LIMITS });
      console.log(`📊 Native usage collected: ${stats.saved} sources read, ${stats.unchanged} unchanged`);
    },
    metadata: { description: 'Daily native usage collection' },
  });
}

/**
 * Seed the Open Threads brain widget (#7664) into the built-in Everything
 * layout. It lists the open loops from the Brain bullet journal with the next
 * action on each, so an existing install gets it where a fresh one does.
 */

import { makeWidgetSeedMigration } from './_lib.js';

export default makeWidgetSeedMigration({
  label: 'migration 396',
  widgetId: 'open-threads',
  layoutIds: ['default'],
  cell: { w: 4, h: 4 },
  logLine: '🧵 migration 396: seeded Open Threads widget in',
});

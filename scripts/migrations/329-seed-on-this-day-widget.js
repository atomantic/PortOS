/**
 * Seed the On This Day brain widget into the built-in Everything and Morning
 * Review layouts. The widget is gated on having past-year Brain captures for
 * today's date, so installs without history see no change.
 */

import { makeWidgetSeedMigration } from './_lib.js';

export default makeWidgetSeedMigration({
  label: 'migration 329',
  widgetId: 'on-this-day',
  cell: { w: 4, h: 4 },
  logLine: '🗓️ migration 329: seeded On This Day widget in',
});

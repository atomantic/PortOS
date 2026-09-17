/**
 * Remove the retired `data/cos/productivity.json` aggregate (#7599).
 *
 * The store backed the CoS Productivity page and the dashboard heatmap, but it
 * had no automatic writer — nothing in the server called its incremental
 * updater, so the file only changed when a human opened that page and pressed
 * Refresh. Both surfaces now read agent history directly
 * (`server/services/cosActivityCalendar.js`), so the file is orphaned.
 *
 * Safe to delete: every field in it was DERIVED from the agent records in
 * `data/cos/agents/`, which this migration does not touch. Nothing reads the
 * file after this release, so leaving it would only strand a stale copy of
 * counts the live stores already hold.
 */

import { unlink } from 'fs/promises';
import { join } from 'path';

export default {
  async up({ rootDir }) {
    const file = join(rootDir, 'data', 'cos', 'productivity.json');
    const removed = await unlink(file).then(() => true, (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });

    if (!removed) return { updated: 0, reason: 'no-productivity-store' };
    console.log('🧹 migration 393: removed the retired data/cos/productivity.json aggregate');
    return { updated: 1 };
  },
};

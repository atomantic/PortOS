/**
 * Backfill Eidoverse Video as a managed companion checkout. Fresh installs
 * already register this field; the migration gives installs created by older
 * PortOS versions the same two-repository update behavior after upgrading.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { atomicWrite, safeJSONParse } from '../../server/lib/fileUtils.js';

const EIDOVERSE_PROCESS_NAME = 'eidoverse-worlds';

export default {
  async up({ rootDir }) {
    const appsPath = join(rootDir, 'data', 'apps.json');
    const raw = await readFile(appsPath, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (raw == null) return { updated: 0, reason: 'no-apps' };

    const doc = safeJSONParse(raw, null, { logError: false });
    if (!doc || typeof doc.apps !== 'object' || doc.apps === null || Array.isArray(doc.apps)) {
      console.warn('⚠️ migration 325: skipped invalid apps registry; Eidoverse companion management was not changed');
      return { updated: 0, reason: 'invalid-apps' };
    }

    const videoPath = join(rootDir, 'data', 'repos', 'anima-research', 'eidoverse-video');
    let updated = 0;
    const apps = Object.fromEntries(Object.entries(doc.apps).map(([id, app]) => {
      if (!app?.pm2ProcessNames?.includes(EIDOVERSE_PROCESS_NAME)) return [id, app];
      const companions = Array.isArray(app.companionRepoPaths)
        ? app.companionRepoPaths.filter((path) => typeof path === 'string' && path.trim())
        : [];
      if (companions.includes(videoPath)) return [id, app];
      updated += 1;
      return [id, {
        ...app,
        companionRepoPaths: [...new Set([...companions, videoPath])],
      }];
    }));

    if (updated === 0) return { updated: 0, reason: 'already-applied' };
    await atomicWrite(appsPath, { ...doc, apps });
    console.log(`🌐 migration 325: registered Eidoverse Video with ${updated} managed app${updated === 1 ? '' : 's'}`);
    return { updated };
  },
};

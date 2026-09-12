import { isTestRunner } from '../../lib/runtimeEnv.js';
import { listAssets, countAssets } from './db.js';

/** Bounded gallery reads. Disk remains the reconcile authority and test escape hatch. */
export async function listGalleryPage({ limit = 60, offset = 0, q = '', hidden } = {}, diskReader) {
  const filters = { kind: 'image', q, hidden };
  if (process.env.MEMORY_BACKEND === 'file' || isTestRunner()) {
    const read = diskReader || (await import('../imageGen/local.js')).listGallery;
    const tokens = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const items = (await read()).filter(item =>
      (hidden === undefined || !!item.hidden === hidden)
      && tokens.every(token => JSON.stringify(item).toLowerCase().includes(token)));
    return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
  }
  const [items, total] = await Promise.all([
    listAssets({ ...filters, limit, offset }), countAssets(filters),
  ]);
  return { items, total, limit, offset };
}

import { isTestRunner } from '../../lib/runtimeEnv.js';
import { listAssets, countAssets } from './db.js';

/** Bounded gallery reads. Disk remains the reconcile authority and test escape hatch. */
export async function listGalleryPage({
  limit = 60, offset = 0, q = '', hidden, filename, starred = false, summary = false,
} = {}, diskReader) {
  // Favorites belong to the local author, not to any peer who starred an image.
  const annotations = starred ? await (await import('../mediaAnnotations.js')).listAnnotations() : null;
  const mediaKeys = annotations
    ? Object.entries(annotations).filter(([, entry]) => entry.own?.starred).map(([key]) => key)
    : undefined;
  const filters = { kind: 'image', q, hidden, filename, mediaKeys };
  if (process.env.MEMORY_BACKEND === 'file' || isTestRunner()) {
    const read = diskReader || (await import('../imageGen/local.js')).listGallery;
    const tokens = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (await read()).filter(item =>
      (filename === undefined || item.filename === filename)
      && (mediaKeys === undefined || mediaKeys.includes(`image:${item.filename}`))
      && tokens.every(token => JSON.stringify(item).toLowerCase().includes(token)));
    const items = matches.filter(item => hidden === undefined || !!item.hidden === hidden);
    return {
      items: items.slice(offset, offset + limit), total: items.length, limit, offset,
      ...(summary ? { hiddenTotal: matches.filter(item => !!item.hidden).length } : {}),
    };
  }
  const [items, total, hiddenTotal] = await Promise.all([
    listAssets({ ...filters, limit, offset }), countAssets(filters),
    summary ? countAssets({ ...filters, hidden: true }) : undefined,
  ]);
  return { items, total, limit, offset, ...(summary ? { hiddenTotal } : {}) };
}

/**
 * Pure plan for repairing Antigravity image usage that was not recorded in the ledger.
 *
 * Saved gallery outputs are added as image units. Transcript planner requests
 * do not prove execution or output and cannot establish measured image usage.
 */

import { AGY_IMAGEGEN_IMAGE_MODEL } from '../lib/imageGenCapabilities.js';

function dayFromIso(iso) {
  const ms = Date.parse(iso || '');
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

export function galleryAgyImageUsageEvent(meta) {
  if (!meta || meta.mode !== 'agy' || !meta.id) return null;
  const day = dayFromIso(meta.createdAt);
  if (!day) return null;
  const refs = Array.isArray(meta.referenceImageFilenames) ? meta.referenceImageFilenames.length : 0;
  return {
    id: `gallery:${meta.id}`,
    day,
    model: meta.imageModel || AGY_IMAGEGEN_IMAGE_MODEL,
    images: 1,
    inputImages: (meta.initImageFilename ? 1 : 0) + refs,
    videoSeconds: 0,
    source: 'measured',
  };
}

/**
 * @param {{ media?: object[], repairIds?: string[], providerId?: string }} input
 * @returns {{ additions: object[], notes: string[] }}
 */
export function planAgyUsageRepair({
  media = [], repairIds = [], providerId = 'antigravity-cli',
} = {}) {
  const known = new Set(repairIds.filter((id) => typeof id === 'string' && id));
  const additions = [];
  const notes = ['Antigravity transcript image requests are not counted without verified completion evidence. Saved gallery outputs are counted.'];
  for (const item of media) {
    if (!item?.id || !item.day || known.has(item.id)) continue;
    known.add(item.id);
    additions.push({
      repairId: item.id,
      day: item.day,
      record: {
        providerId,
        model: item.model || AGY_IMAGEGEN_IMAGE_MODEL,
        messages: 0,
        images: item.images || 0,
        videoSeconds: 0,
        inputImages: item.inputImages || 0,
        source: item.source || 'measured',
      },
    });
  }
  return { additions, notes };
}

/** Counts for the reconcile status line. */
export function summarizeAgyRepairAdditions(additions = []) {
  const summary = { added: 0, images: 0 };
  for (const item of additions) {
    summary.added += 1;
    summary.images += item?.record?.images || 0;
  }
  return summary;
}

/**
 * Pure plan for repairing Antigravity image usage that was not recorded in the ledger.
 *
 * Media recovered from the gallery is added as image units.
 * Session tool calls inside a PortOS `portos-agy-scratch-` directory are
 * omitted so a gallery job is not billed twice.
 */

import { parseJsonLines } from '../lib/providerTranscriptUsage.js';
import { AGY_IMAGEGEN_IMAGE_MODEL } from '../lib/imageGenCapabilities.js';

function isPortosAgyScratch(cwd) {
  return String(cwd || '').includes('portos-agy-scratch-');
}

function dayFromIso(iso) {
  const ms = Date.parse(iso || '');
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

function inputImageCount(args) {
  if (!args || typeof args !== 'object') return 0;
  const paths = args.ImagePaths || args.imagePaths || args.image_paths || args.images;
  if (Array.isArray(paths)) return paths.length;
  if (typeof paths === 'string' && paths) return 1;
  return 0;
}

/**
 * Image generation tool calls from an Antigravity transcript outside PortOS render scratch.
 */
export function imagineEventsFromAgyTranscript({
  transcriptText = '', sessionId = 'unknown', cwd = null, day = null,
} = {}) {
  if (isPortosAgyScratch(cwd)) return [];
  const events = [];
  let index = 0;
  for (const entry of parseJsonLines(transcriptText)) {
    if (entry?.type !== 'PLANNER_RESPONSE' || !Array.isArray(entry?.tool_calls)) continue;
    const entryDay = dayFromIso(entry?.created_at) || day;
    if (!entryDay) continue;
    for (const call of entry.tool_calls) {
      const name = String(call?.name || '').toLowerCase();
      if (name !== 'generate_image') continue;
      const id = `session-image:${sessionId}:${index}`;
      index += 1;
      events.push({
        id,
        day: entryDay,
        model: AGY_IMAGEGEN_IMAGE_MODEL,
        images: 1,
        inputImages: inputImageCount(call?.args),
        videoSeconds: 0,
        source: 'measured',
      });
    }
  }
  return events;
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
  const notes = [];
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

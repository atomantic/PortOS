// Opt-in query form of GET /api/video-gen/history (#12996). No query keeps the
// legacy full array; callers that migrated ask for a bounded page and/or the
// stat-free compact projection instead.
import { z } from 'zod';
import { compactGalleryRecord } from '../mediaAssetIndex/logic.js';
import { withMediaFileSizes } from '../../lib/mediaFileInfo.js';

const queryShape = {
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  q: z.string().max(500).default(''),
  hidden: z.enum(['true', 'false']).optional().transform(v => v === undefined ? undefined : v === 'true'),
  compact: z.enum(['true', 'false']).optional().transform(v => v === 'true'),
};

export const historyListQuerySchema = z.object(queryShape).refine(v => v.offset === undefined || v.limit !== undefined, { message: 'offset requires limit', path: ['offset'] });

export const isHistoryListQuery = query =>
  Object.keys(queryShape).some(key => query[key] !== undefined);

// The shared card projection plus the two lineage/ownership scalars the timeline
// surfaces read (the gallery's compact source drops them).
const catalogRow = entry => ({
  ...compactGalleryRecord(entry),
  ...(entry.timelineProjectId ? { timelineProjectId: entry.timelineProjectId } : {}),
  ...(entry.trimmedFrom ? { trimmedFrom: entry.trimmedFrom } : {}),
});

// Mirrors client lib/mediaSearch.js buildMediaHaystack: field-scoped, so a token
// like "prompt" or "true" cannot match JSON key names or flags.
const haystack = entry => [
  entry.prompt, entry.metadata?.prompt, entry.negativePrompt, entry.negative_prompt, entry.modelId, entry.model,
  entry.filename, entry.id, entry.seed != null ? `seed ${entry.seed}` : '',
  entry.width && entry.height ? `${entry.width}x${entry.height}` : '',
  ...[entry.loraFilenames, entry.lora_filenames].flatMap(v => Array.isArray(v) ? v : []),
  entry.universeName, entry.entryName, entry.entryLabel, entry.entryCategory, entry.entryKind,
  entry.extractedFromVideoId ? 'extracted frame' : '', entry.stitchedFrom ? 'stitched' : '',
  entry.upscaledFrom ? 'upscaled 2x' : '',
].filter(v => typeof v === 'string' || typeof v === 'number').join(' ').toLowerCase();

const time = value => Date.parse(value) || 0;

/**
 * Always an array, like the legacy list. `limit`/`offset` bound it to one
 * newest-first page; without `limit` it is every matching row in stored order
 * (callers that need every clip, e.g. the timeline editor). Only the returned
 * rows are `stat`ed, and compact rows are never `stat`ed.
 */
export async function listVideoHistoryQuery({ limit, offset = 0, q, hidden, compact }, history) {
  const tokens = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matching = (Array.isArray(history) ? history : []).filter(entry => entry
    && (hidden === undefined || !!entry.hidden === hidden)
    && (!tokens.length || (text => tokens.every(token => text.includes(token)))(haystack(entry))));
  const paged = limit !== undefined;
  const ordered = paged
    ? [...matching].sort((a, b) => time(b.createdAt) - time(a.createdAt) || String(a.id).localeCompare(String(b.id)))
    : matching;
  const rows = paged ? ordered.slice(offset, offset + limit) : ordered;
  const items = compact ? rows.map(catalogRow) : await withMediaFileSizes(rows, 'video');
  return items;
}

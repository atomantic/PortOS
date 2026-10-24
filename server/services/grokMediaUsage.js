/**
 * Ledger writes for an accepted Grok Imagine image or video.
 *
 * Counts go in usage.json and are priced at read time. A repair id written in
 * the same save keeps the historical backfill from adding the job again.
 * Provider lookup prefers the configured Grok CLI so the row sits with the
 * token usage the interactive scan already attributes there, and falls back
 * to the id `grok` when this install has no Grok provider.
 */

import { familyForProvider } from '../lib/providerFamilies.js';
import {
  GROK_IMAGINE_IMAGE_MODEL,
  GROK_IMAGINE_VIDEO_MODEL,
} from '../lib/modelPricing.js';

function dayKey(iso) {
  const ms = Date.parse(iso || '');
  const when = Number.isFinite(ms) ? new Date(ms) : new Date();
  return when.toISOString().slice(0, 10);
}

async function grokUsageProviderId() {
  try {
    const { listProviders } = await import('./providers.js');
    const list = await listProviders();
    return grokUsageProviderIdFromList(list);
  } catch (err) {
    console.error(`❌ Grok usage provider lookup failed: ${err.message}`);
    return 'grok';
  }
}

/** CLI, then TUI, then any Grok family record, else the id `grok`. */
export function grokUsageProviderIdFromList(providers) {
  const grok = (providers || []).filter((provider) => (
    provider && provider.enabled !== false && familyForProvider(provider) === 'grok'
  ));
  const preferred = grok.find((provider) => provider.type === 'cli')
    || grok.find((provider) => provider.type === 'tui')
    || grok[0];
  return preferred?.id || 'grok';
}

async function record(day, record, repairId) {
  const { addDatedUsage } = await import('./usage.js');
  await addDatedUsage(day, record, { repairId, flush: true });
}

/**
 * One accepted gallery image. `inputImages` is the init image plus references
 * that were actually passed to the tool.
 */
export async function recordGrokImageUsage({
  jobId, createdAt, inputImages = 0, providerId = null, repairId = null,
} = {}) {
  if (!jobId) return;
  const id = repairId || `gallery:${jobId}`;
  await record(dayKey(createdAt), {
    providerId: providerId || await grokUsageProviderId(),
    model: GROK_IMAGINE_IMAGE_MODEL,
    messages: 0,
    images: 1,
    inputImages: Math.max(0, inputImages || 0),
    source: 'measured',
  }, id);
}

/**
 * One accepted video. `images: 1` is the hidden text-to-video base still,
 * recorded as its own image-model row (`video-base:<jobId>`).
 */
export async function recordGrokVideoUsage({
  jobId, createdAt, videoSeconds = 0, images = 0, inputImages = 0, providerId = null,
} = {}) {
  if (!jobId) return;
  const resolved = providerId || await grokUsageProviderId();
  const day = dayKey(createdAt);
  await record(day, {
    providerId: resolved,
    model: GROK_IMAGINE_VIDEO_MODEL,
    messages: 0,
    videoSeconds: Math.max(0, videoSeconds || 0),
    inputImages: Math.max(0, inputImages || 0),
    source: 'measured',
  }, `video:${jobId}`);
  if (images > 0) {
    await record(day, {
      providerId: resolved,
      model: GROK_IMAGINE_IMAGE_MODEL,
      messages: 0,
      images: 1,
      source: 'measured',
    }, `video-base:${jobId}`);
  }
}

/**
 * Ledger writes for an accepted Antigravity Image Gen image.
 *
 * Counts go in usage.json and are priced at read time. A repair id written in
 * the same save keeps the historical backfill from adding the job again.
 * Provider lookup prefers the configured Antigravity CLI so the row sits with the
 * token usage the interactive scan already attributes there, and falls back
 * to the id `antigravity-cli` when this install has no Antigravity provider.
 */

import { familyForProvider } from '../lib/providerFamilies.js';
import { AGY_IMAGEGEN_IMAGE_MODEL } from '../lib/imageGenCapabilities.js';

function dayKey(iso) {
  const ms = Date.parse(iso || '');
  const when = Number.isFinite(ms) ? new Date(ms) : new Date();
  return when.toISOString().slice(0, 10);
}

async function agyUsageProviderId() {
  try {
    const { listProviders } = await import('./providers.js');
    const list = await listProviders();
    return agyUsageProviderIdFromList(list);
  } catch (err) {
    console.error(`❌ Antigravity usage provider lookup failed: ${err.message}`);
    return 'antigravity-cli';
  }
}

/** CLI, then TUI, then any agy family record, else the id `antigravity-cli`. */
export function agyUsageProviderIdFromList(providers) {
  const agy = (providers || []).filter((provider) => (
    provider && provider.enabled !== false && familyForProvider(provider) === 'agy'
  ));
  const preferred = agy.find((provider) => provider.type === 'cli')
    || agy.find((provider) => provider.type === 'tui')
    || agy[0];
  return preferred?.id || 'antigravity-cli';
}

async function record(day, recordData, repairId) {
  const { addDatedUsage } = await import('./usage.js');
  await addDatedUsage(day, recordData, { repairId, flush: true });
}

/**
 * One accepted gallery image. `inputImages` is the init image plus references
 * that were actually passed to the tool.
 */
export async function recordAgyImageUsage({
  jobId, createdAt, inputImages = 0, providerId = null, repairId = null, model = null,
} = {}) {
  if (!jobId) return;
  const id = repairId || `gallery:${jobId}`;
  await record(dayKey(createdAt), {
    providerId: providerId || await agyUsageProviderId(),
    model: model || AGY_IMAGEGEN_IMAGE_MODEL,
    messages: 0,
    images: 1,
    inputImages: Math.max(0, inputImages || 0),
    source: 'measured',
  }, id);
}

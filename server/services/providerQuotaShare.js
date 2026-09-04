/**
 * This install's last-known subscription-quota readings, persisted so they can
 * be federated.
 *
 * The quota cards themselves live in an in-memory stale-while-revalidate cache
 * (see `providerUsage.js`) because reading one costs a 10-20s CLI/TUI spawn.
 * That cache cannot be shared: it dies with the process, and the `usage` sync
 * category's checksum is invalidated by FILE fingerprints, so a reading that
 * exists only in memory would never move the checksum and would never reach a
 * peer. Writing the cards to `data/provider-quotas.json` fixes both — and
 * survives a restart, so a card is not blank until the next scrape.
 *
 * AI Provider Usage Policy: nothing here reads a provider. It only records what
 * a user-triggered reading already produced, and serves it back.
 */

import { join } from 'path';
import { atomicWrite, readJSONFile, PATHS } from '../lib/fileUtils.js';
import { isPlainObject } from '../lib/objects.js';
import { createMutex } from '../lib/asyncMutex.js';
import { sanitizeQuotaCards, latestFetchedAt } from '../lib/fleetQuotas.js';

export const PROVIDER_QUOTAS_FILE = join(PATHS.data, 'provider-quotas.json');

const withLock = createMutex();

/** The cards this instance last read, newest-known per family. Never throws. */
export async function readLocalQuotaCards() {
  const raw = await readJSONFile(PROVIDER_QUOTAS_FILE, null);
  const quotas = sanitizeQuotaCards(isPlainObject(raw) ? raw.quotas : null);
  return { quotas, capturedAt: latestFetchedAt(quotas) };
}

/**
 * What a stored card claims, ignoring WHEN it was read.
 *
 * A card whose only difference is its `fetchedAt` is the same reading: some
 * adapters stamp the current clock on every call (the image-gen card is derived
 * on read, not scraped), so comparing whole cards would rewrite this file — and
 * invalidate the `usage` sync checksum — on every page poll, handing peers a
 * new slot to pull that says nothing new.
 */
const claimOf = ({ fetchedAt, ...rest }) => JSON.stringify(rest);

/**
 * Merge a batch of freshly-read cards into the store, keyed by family.
 *
 * MERGE, not replace: a read narrowed to one family (`?family=`) must not
 * retire the other families' stored readings, or a per-card Refresh would drop
 * this machine out of the fleet view for every provider the user didn't click.
 *
 * The write is skipped when no card's claim changed. Every write invalidates
 * the `usage` sync category's checksum, and a page poll that re-serves
 * identical cached cards is not new information for a peer to pull.
 */
export async function recordLocalQuotaCards(cards) {
  const incoming = sanitizeQuotaCards(cards);
  if (!incoming.length) return null;
  return withLock(async () => {
    const raw = await readJSONFile(PROVIDER_QUOTAS_FILE, null);
    const stored = sanitizeQuotaCards(isPlainObject(raw) ? raw.quotas : null);
    const byFamily = new Map(stored.map((card) => [card.family, card]));
    let changed = false;
    for (const card of incoming) {
      const incumbent = byFamily.get(card.family);
      if (incumbent && claimOf(incumbent) === claimOf(card)) continue;
      byFamily.set(card.family, card);
      changed = true;
    }
    const quotas = [...byFamily.values()];
    if (!changed) return { quotas, changed: false };
    await atomicWrite(PROVIDER_QUOTAS_FILE, { quotas });
    return { quotas, changed: true };
  });
}

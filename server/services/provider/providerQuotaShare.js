/**
 * This install's last-known subscription-quota readings, persisted so they can
 * be federated.
 *
 * The quota cards live in an in-memory cache (`providerUsage.js`; a read costs a
 * 10-20s CLI/TUI spawn) that dies with the process and never moves the `usage` sync
 * checksum (invalidated by FILE fingerprints), so it would never reach a peer.
 * Writing to `data/provider-quotas.json` fixes both and survives restart.
 *
 * AI Provider Usage Policy: nothing here reads a provider; it records what a
 * user-triggered reading produced.
 */

import { join } from 'path';
import { atomicWrite, readJSONFile, PATHS } from '../../lib/fileUtils.js';
import { isPlainObject } from '../../lib/objects.js';
import { createMutex } from '../../lib/asyncMutex.js';
import { sanitizeQuotaCards, latestFetchedAt } from '../../lib/fleetQuotas.js';
import { compareNewerWins, parseTsMs } from '../../lib/lwwTimestamp.js';
import { isNonBlankStr } from '../../lib/textUtils.js';

export const PROVIDER_QUOTAS_FILE = join(PATHS.data, 'provider-quotas.json');

const withLock = createMutex();

/**
 * The cards this instance last read, newest-known per family, plus WHEN THIS STORE
 * LAST CHANGED. Never throws.
 *
 * `capturedAt` is the federated slot's LWW stamp and manifest fingerprint
 * (`buildSelfEntry` in services/peerUsage.js), so it is the WRITE clock, not the
 * freshest card's `fetchedAt`: an adapter reporting older telemetry (Codex) would
 * pin it and no peer would pull the correction. Stores predating `capturedAt` fall
 * back to the old derivation.
 */
export async function readLocalQuotaCards() {
  // Read-only projection; this fallback is never used by the merge writer below.
  const raw = await readJSONFile(PROVIDER_QUOTAS_FILE, null);
  const quotas = sanitizeQuotaCards(isPlainObject(raw) ? raw.quotas : null);
  const capturedAt = isNonBlankStr(raw?.capturedAt) ? raw.capturedAt : latestFetchedAt(quotas);
  return { quotas, capturedAt, reported: raw?.complete === true };
}

/**
 * What a stored card claims, ignoring WHEN it was read: image-gen is derived on every
 * read, and a real provider can reconfirm an unchanged allowance later.
 */
const claimOf = ({ fetchedAt, ...rest }) => JSON.stringify(rest);

/**
 * Is `card` a reading taken STRICTLY BEFORE `incumbent`? The shared LWW predicate
 * reversed, so this guard and the federated merge (`lib/fleetQuotas.js`) rank by one
 * rule. Equal stamps with different claims are a correction and still apply.
 */
const isOlderReading = (card, incumbent) => compareNewerWins(incumbent?.fetchedAt, card?.fetchedAt);

/** Next strictly-increasing write stamp after `prior` (the clock can stall or go back across NTP). */
function nextStamp(prior) {
  const nowMs = Date.now();
  const priorMs = parseTsMs(prior);
  return new Date(priorMs !== null && nowMs <= priorMs ? priorMs + 1 : nowMs).toISOString();
}

/**
 * Merge freshly-read cards into the store, keyed by family. MERGE, not replace: a
 * `?family=` read must not retire other families' readings. The write is skipped when
 * no claim or provider-observation time changed (image-gen's derived read clock and
 * unsupported placeholders don't invalidate the usage sync).
 */
export async function recordLocalQuotaCards(cards, { families = null, complete = null } = {}) {
  const incoming = sanitizeQuotaCards(cards);
  if (!incoming.length && !families) return null;
  return withLock(async () => {
    const raw = await readJSONFile(PROVIDER_QUOTAS_FILE, null, { strict: true });
    const stored = sanitizeQuotaCards(isPlainObject(raw) ? raw.quotas : null);
    const byFamily = new Map(stored.map((card) => [card.family, card]));
    let changed = false;
    if (families) {
      const enabled = new Set(families);
      for (const id of byFamily.keys()) if (!enabled.has(id)) { byFamily.delete(id); changed = true; }
    }
    for (const card of incoming) {
      const incumbent = byFamily.get(card.family);
      if (incumbent && claimOf(incumbent) === claimOf(card)
        && (card.family === 'imagegen' || card.supported === false || !compareNewerWins(card.fetchedAt, incumbent.fetchedAt))) continue;
      // A reading taken EARLIER than the one on file is not an update (a lagging
      // source like Codex rollout telemetry can arrive late); federation ranks by
      // `fetchedAt`, so it would hand peers a superseded reading.
      if (incumbent && isOlderReading(card, incumbent)) continue;
      byFamily.set(card.family, card);
      changed = true;
    }
    const quotas = [...byFamily.values()];
    const isComplete = complete === null ? raw?.complete === true : complete;
    if (isComplete !== (raw?.complete === true)) changed = true;
    const storedAt = isNonBlankStr(raw?.capturedAt) ? raw.capturedAt : latestFetchedAt(quotas);
    if (!changed) return { quotas, capturedAt: storedAt, changed: false };
    // Stamped on the WRITE (see readLocalQuotaCards) and forced STRICTLY forward: peers
    // compare newer-wins, so two writes in one millisecond would never be pulled.
    const capturedAt = nextStamp(storedAt);
    await atomicWrite(PROVIDER_QUOTAS_FILE, { capturedAt, quotas, complete: isComplete });
    return { quotas, capturedAt, changed: true };
  });
}

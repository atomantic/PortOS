/**
 * The dedicated inference host's inbound usage record — the answer to "is
 * someone using this machine, and who?".
 *
 * `lib/fleetHostUsage.js` is the bounded ledger and the token parser; this is
 * the side of it that has a disk and a peer list. Three jobs:
 *
 *   - **Own the singleton.** One ledger per process, shared by the gateway that
 *     writes it and the route that reads it. Hydrated from disk on first touch
 *     so the totals survive a restart — the operator's question is "who has
 *     been using my GPU", which a counter that resets with PM2 cannot answer.
 *   - **Persist it, coalesced.** A busy host completes a request every few
 *     seconds; each one would otherwise be a file write. Writes are debounced
 *     and serialized through one tail, and a failure is logged and dropped
 *     rather than thrown — this is a report, and losing a minute of it must
 *     never fail a generation that already succeeded.
 *   - **Name the callers.** The gateway authenticates every client with the one
 *     shared host key, so the ledger can only key on the socket's remote
 *     address. A federated peer record (or the tailnet's own node list) turns
 *     that address into a name, at REPORT time — so a peer renamed today reads
 *     correctly against traffic from last week, and a peer deleted today still
 *     shows its address rather than vanishing from the history.
 *
 * Nothing here is federated. This records which machines connected to THIS
 * host; it is network and identity information about the user's own devices,
 * and it stays in the local `data/` file alongside the rest of the host's
 * machine-local deployment state (`docs/STORAGE.md`).
 */

import { dataPath } from '../lib/paths.js';
import { atomicWrite, readJSONFile } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { createFleetHostUsageLedger, normalizeClientAddress } from '../lib/fleetHostUsage.js';
import { getTailscaleStatus } from '../lib/tailscale.js';

const USAGE_FILE = dataPath('fleet-host-usage.json');

/**
 * Long enough that a steady stream of requests costs one write per window,
 * short enough that a page opened right after a generation shows it.
 */
const PERSIST_DEBOUNCE_MS = 5_000;

const queue = createFileWriteQueue();

let ledger = null;
let hydrating = null;
let persistTimer = null;

/** The process-wide ledger, hydrated from disk exactly once. */
export async function getFleetHostUsageLedger() {
  if (ledger) return ledger;
  if (!hydrating) {
    const next = createFleetHostUsageLedger();
    hydrating = readJSONFile(USAGE_FILE, null, { logError: false }).then((stored) => {
      next.hydrate(stored);
      ledger = next;
      return next;
    });
  }
  return hydrating;
}

async function writeLedger() {
  if (!ledger) return;
  const payload = ledger.toJSON();
  await queue(() => atomicWrite(USAGE_FILE, JSON.stringify(payload, null, 2)))
    // Outside the request lifecycle (a debounce timer), so a throw here would
    // take the process down rather than reach any error middleware.
    .catch((err) => console.error(`❌ Could not persist fleet host usage: ${err.message}`));
}

/** Schedule a coalesced write of the current ledger. */
export function scheduleFleetHostUsagePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    writeLedger();
  }, PERSIST_DEBOUNCE_MS);
  // Never hold the process open for a usage report.
  persistTimer.unref?.();
}

/** Write immediately — used when the host is being stopped. */
export async function flushFleetHostUsage() {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  await writeLedger();
}

/** Test seam: drop the singleton so the next read re-hydrates. */
export function __resetFleetHostUsage() {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  ledger = null;
  hydrating = null;
}

/**
 * Address → the friendliest name this install can give it.
 *
 * A configured federated peer wins over a bare tailnet node: the peer record
 * carries the name the user chose for that machine in PortOS, while the tailnet
 * only knows its MagicDNS name. A caller matching neither is reported by
 * address alone, flagged `known: false` — an unrecognized machine holding the
 * host key is exactly the thing this report exists to surface.
 */
async function buildAddressIndex() {
  const index = new Map();

  const tailnet = await getTailscaleStatus().catch(() => null);
  for (const node of Array.isArray(tailnet?.peers) ? tailnet.peers : []) {
    for (const ip of Array.isArray(node?.ips) ? node.ips : []) {
      const key = normalizeClientAddress(ip);
      if (key) index.set(key, { label: node.dnsName || ip, source: 'tailnet', peerId: null });
    }
  }

  const { getPeers } = await import('./instances.js').catch(() => ({ getPeers: async () => [] }));
  for (const peer of await getPeers().catch(() => [])) {
    const key = normalizeClientAddress(peer?.address);
    if (!key) continue;
    index.set(key, { label: peer.name || peer.host || peer.address, source: 'peer', peerId: peer.id || null });
  }

  return index;
}

/**
 * The full report: every client that has used this host, what it spent, and
 * what it is doing right now.
 *
 * `queue` is the gateway's live admission state, passed in rather than imported
 * so this module does not depend on the host service that depends on it.
 */
export async function getFleetHostUsageReport({ queue: queueStatus = null } = {}) {
  const current = await getFleetHostUsageLedger();
  const snapshot = current.snapshot();
  const index = await buildAddressIndex();

  const decorate = (key) => index.get(key) || { label: null, source: 'unknown', peerId: null };

  return {
    since: snapshot.since,
    activeRequests: snapshot.activeRequests,
    queue: queueStatus,
    totals: snapshot.totals,
    clients: snapshot.clients.map((client) => {
      const identity = decorate(client.key);
      return {
        ...client,
        address: client.key,
        label: identity.label,
        source: identity.source,
        peerId: identity.peerId,
        known: identity.source !== 'unknown',
        // Sorted so the report can chart a series without re-sorting an object.
        days: Object.entries(client.days)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([day, bucket]) => ({ day, ...bucket })),
      };
    }),
    recent: snapshot.recent.map((event) => ({
      ...event,
      label: decorate(event.clientKey).label,
      address: event.clientKey,
    })),
  };
}

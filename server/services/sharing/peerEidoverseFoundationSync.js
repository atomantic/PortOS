/**
 * Federated peer-sync — Eidoverse foundation pull/inherit transport.
 *
 * The wire between two existing, tested gates:
 *
 *   - `verifyFoundationCandidate()` (lib/eidoverseFoundations.js) — run by a sender on its
 *     own envelope and by a receiver on one it was handed.
 *   - `recordEidoverseFoundationInheritance()` (services/eidoverseFoundationLedger.js) — the
 *     accept side: re-runs the whole gate, refuses a self-referential pull, and stores the
 *     acceptance under a `peer:<originInstanceId>:<foundationId>` key disjoint from local ids.
 *
 * It owns no policy about WHICH foundations an install offers (`listPromotedFoundationCandidates()`)
 * or accepts (the accept-side gate); only the payload wrapper, version gate, caps and sweep.
 *
 * Mirrors the `cos-tasks` receiver-pull sweep (peerCosSync.js): the sender advertises at
 * `GET /api/peer-sync/eidoverse-foundations`; a receiver (only for peers it flags `fullSync`)
 * fetches it, byte-caps it, validates the wrapper, version-gates it, short-circuits on an
 * unchanged content-addressed `listHash`, and applies per candidate. Every guard RETURNS
 * rather than throws — a sweep is best-effort and idempotent.
 *
 * **What crosses.** Only the promote envelope, which has no `style` layer by construction:
 * an inheriting peer gets the substance and keeps its own cosmetics. The ADR
 * (docs/decisions/2026-09-18-federated-eidoverse-foundations.md) authorizes exactly this
 * envelope, and the federation-safety scan REFUSES a payload carrying machine identity, PII
 * or credentials rather than redacting it, on both sides (a peer's payload is untrusted and
 * this install's ledger is human-editable).
 *
 * **The offering also RETRACTS.** The payload carries `tombstones: [{ fingerprint, deletedAt }]`
 * beside `candidates`, in a separately-capped array so the entry cap can never displace a
 * retraction to make room for a publication. Both lists feed the `listHash`, so a withdrawal
 * with no other change still breaks the receiver's short-circuit. A tombstone names one
 * published body by content-addressed fingerprint without re-transmitting it.
 */
import { createHash } from 'crypto';
import { isPlainObject } from '../../lib/objects.js';
import { isStr } from '../../lib/textUtils.js';
import { peerBaseUrl } from '../../lib/peerUrl.js';
import { fetchPeerJsonEnvelope } from './peerEnvelopePull.js';
import { PLATFORM_SCHEMA_VERSIONS } from '../../lib/schemaVersions/platform.js';
import { peerEidoverseFoundationsSchema } from '../../lib/peerSyncValidation.js';
import { getInstanceId, UNKNOWN_INSTANCE_ID } from '../instanceIdentity.js';
import { getPeers } from '../instances.js';
import { FORCE_REVALIDATE_EVERY } from './peerSyncShared.js';

/**
 * A foundation body caps at 16 KiB, so the offering cap keeps the whole payload inside the
 * byte cap even at the entry cap. The sender truncates at the entry cap; the receiver
 * rejects an over-cap response on its content-length check.
 */
const OFFERING_ENTRY_CAP = 500;
const OFFERING_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Tombstones cap on their OWN budget, never against `OFFERING_ENTRY_CAP`: a shared cap would
 * let a large promoted population truncate retractions (publishing crowding out recall). A
 * tombstone is two short strings; the ledger caps its stored list at the same order and drops
 * the OLDEST deletion first, which has long since reached every peer.
 */
const TOMBSTONE_ENTRY_CAP = 500;

/**
 * Deliberately NOT `ASSET_PULL_TIMEOUT_MS`: that is sized for streaming media bytes, and
 * importing it would drag `peerSyncAssets.js` and its whole asset graph into this module's
 * closure for one number. An offering is a small capped JSON document; a peer that cannot
 * produce one in 30s is unreachable for this purpose.
 */
const OFFERING_PULL_TIMEOUT_MS = 30_000;

/**
 * The Eidoverse feature and the foundation ledger sit behind dynamic imports: this module is
 * in `peerSync.js`'s static import chain, and the Eidoverse graph (assay harness,
 * contribution registry, controller runtime) should not be instantiated by the many suites
 * reaching peer-sync for unrelated reasons. A failed import degrades to "offer nothing /
 * inherit nothing" rather than taking the sweep down.
 */
const ledger = () => import('../eidoverseFoundationLedger.js').catch(() => null);
const eidoverseEnabled = async () => {
  const mod = await import('../instanceFeatures.js').catch(() => null);
  return (await mod?.isInstanceFeatureEnabled?.('eidoverse').catch(() => false)) === true;
};

const peerLabel = (peer) => peer.name || peer.instanceId;

/** Content-address the offering so a receiver can short-circuit an unchanged one. Each
 * envelope carries a sha256 of its own body and the list is sorted by it, so hashing the
 * fingerprints alone is sufficient and order-independent.
 *
 * Tombstones hash in too, under a separator that cannot appear in either list: a retraction
 * is often the ONLY delta on its tick, and hashing candidates alone would hide it until the
 * next forced re-pull. `deletedAt` is included because re-withdrawing a fingerprint refreshes
 * the stamp, a real change to what the sender asserts. */
const offeringListHash = (candidates, tombstones) => createHash('sha256')
  .update(candidates.map((candidate) => String(candidate.fingerprint)).join('\n'))
  .update('\n--tombstones--\n')
  .update(tombstones.map((entry) => `${entry.fingerprint}@${entry.deletedAt}`).join('\n'))
  .digest('hex');

/**
 * Build the foundation offering this instance advertises to peers.
 *
 * Empty (not an error) when the Eidoverse feature is off (the install is not participating
 * in the shared baseline, either direction) or the ledger module can't load.
 *
 * @returns {Promise<{ schemaVersion:number, listHash:string, candidates:Array }>}
 */
export async function buildEidoverseFoundationOffering() {
  const offering = (candidates, tombstones = []) => ({
    schemaVersion: PLATFORM_SCHEMA_VERSIONS.eidoverseFoundations,
    listHash: offeringListHash(candidates, tombstones),
    candidates,
    tombstones,
  });
  if (!(await eidoverseEnabled())) return offering([]);
  const mod = await ledger();
  if (!mod?.listPromotedFoundationCandidates || !mod?.listWithdrawnFoundationTombstones) return offering([]);
  const candidates = await mod.listPromotedFoundationCandidates();
  const tombstones = await mod.listWithdrawnFoundationTombstones();
  if (tombstones.length > TOMBSTONE_ENTRY_CAP) {
    console.log(`⚠️ peerSync: eidoverse-foundations offering hit the ${TOMBSTONE_ENTRY_CAP}-tombstone cap — truncating`);
  }
  if (candidates.length > OFFERING_ENTRY_CAP) {
    console.log(`⚠️ peerSync: eidoverse-foundations offering hit the ${OFFERING_ENTRY_CAP}-entry cap — truncating`);
  }
  // Each list slices against its OWN cap, so a full candidate list can never
  // cost a retraction its slot.
  return offering(candidates.slice(0, OFFERING_ENTRY_CAP), tombstones.slice(0, TOMBSTONE_ENTRY_CAP));
}

// Receiver-side bookkeeping — mirrors the cos-tasks sweep.
const lastOfferingListHash = new Map(); // peerInstanceId → listHash
const offeringUnchangedSkips = new Map(); // peerInstanceId → count
const offeringSweepInFlight = new Set(); // peerInstanceId

/** Test-support: forget the per-peer short-circuit state. */
export function __resetEidoverseFoundationSweepForTests() {
  lastOfferingListHash.clear();
  offeringUnchangedSkips.clear();
  offeringSweepInFlight.clear();
}

/**
 * Pull ONE full-sync peer's foundation offering and inherit what passes the accept-side
 * gate. Best-effort + idempotent; no-op for a non-full-sync peer.
 *
 * Every candidate goes through `recordEidoverseFoundationInheritance()`, which re-runs the
 * ENTIRE gate (envelope schema, fingerprint, embedded assay evidence, federation-safety scan)
 * and writes nothing on failure. Nothing here re-runs the resilience assay or executes the
 * contribution: replaying controller code pulled from a peer is what the agent-free harness
 * keeps off every other install.
 *
 * A candidate whose fingerprint this install already holds is skipped, so the periodic forced
 * re-pull (which lets a LOCAL deletion self-heal) doesn't rewrite `inheritedAt` and churn the ledger.
 *
 * @param {object} peer a peer entry from getPeers()
 * @returns {Promise<{ inherited:number, refused?:number, skipped?:string }>}
 */
export async function syncEidoverseFoundationsFromPeer(peer) {
  if (!isPlainObject(peer) || peer.fullSync !== true || !isStr(peer.instanceId)) {
    return { inherited: 0, skipped: 'not-fullsync' };
  }
  // Claimed synchronously, BEFORE the first await: a re-entrancy guard taken
  // after one would let two sweep ticks past it and double-apply an offering.
  if (offeringSweepInFlight.has(peer.instanceId)) return { inherited: 0, skipped: 'in-flight' };
  offeringSweepInFlight.add(peer.instanceId);
  try {
    if (!(await eidoverseEnabled())) return { inherited: 0, skipped: 'feature-disabled' };
        // `getInstanceId`, not `ensureInstanceId`: a background sweep must not mint this install's
        // durable federation identity. Without one the accept gate cannot check for a
        // self-referential pull anyway.
    const localInstanceId = await getInstanceId().catch(() => null);
    if (!isStr(localInstanceId) || localInstanceId === UNKNOWN_INSTANCE_ID) {
      return { inherited: 0, skipped: 'no-local-identity' };
    }
    const url = `${peerBaseUrl(peer)}/api/peer-sync/eidoverse-foundations`;
    const envelope = await fetchPeerJsonEnvelope(peer, url, {
      maxBytes: OFFERING_MAX_BYTES, timeoutMs: OFFERING_PULL_TIMEOUT_MS,
      schema: peerEidoverseFoundationsSchema, label: 'eidoverse-foundations offering', peerName: peerLabel(peer),
    });
    if (!envelope.ok) return { inherited: 0, skipped: envelope.skipped };
    const payload = envelope.data;
        // Schema gate — GENTLE skip, not a rejection: wait for the local PortOS to upgrade rather
        // than store a foundation shape it cannot interpret (the ledger has no re-fetch path to
        // correct a mis-applied envelope later).
    if (payload.schemaVersion > PLATFORM_SCHEMA_VERSIONS.eidoverseFoundations) {
      console.log(`⏸️ peerSync: ${peerLabel(peer)} eidoverse-foundations offering is schema v${payload.schemaVersion} > local v${PLATFORM_SCHEMA_VERSIONS.eidoverseFoundations} — skipping until this instance updates`);
      return { inherited: 0, skipped: 'schema-ahead' };
    }
        // Unchanged short-circuit with a periodic forced re-pull, so a LOCAL loss (hand-deleted
        // ledger entry) self-heals even while the peer's offering stays put.
    if (lastOfferingListHash.get(peer.instanceId) === payload.listHash) {
      const skips = (offeringUnchangedSkips.get(peer.instanceId) || 0) + 1;
      if (skips < FORCE_REVALIDATE_EVERY) {
        offeringUnchangedSkips.set(peer.instanceId, skips);
        return { inherited: 0, skipped: 'unchanged' };
      }
      offeringUnchangedSkips.set(peer.instanceId, 0); // forced re-pull — fall through
    }
    const applied = await applyOffering(payload.candidates, payload.tombstones, { peer, localInstanceId });
        // Remember the offering only once applied: recording the hash after a
        // `ledger-unavailable` pass would short-circuit later ticks on work that never happened.
    if (!applied.skipped) lastOfferingListHash.set(peer.instanceId, payload.listHash);
    if (applied.inherited > 0) {
      console.log(`📥 peerSync: eidoverse-foundations sweep from ${peerLabel(peer)} — inherited ${applied.inherited} foundation(s)`);
    }
    if (applied.refused > 0) {
      console.log(`⚠️ peerSync: eidoverse-foundations sweep from ${peerLabel(peer)} — refused ${applied.refused} candidate(s) at the accept-side gate`);
    }
    if (applied.removed > 0) {
      console.log(`🗑️ peerSync: eidoverse-foundations sweep from ${peerLabel(peer)} — dropped ${applied.removed} withdrawn foundation(s)`);
    }
    return applied;
  } finally {
    offeringSweepInFlight.delete(peer.instanceId);
  }
}

/**
 * Reconcile this install against the peer's offering in BOTH directions: drop what the peer
 * withdrew, then inherit what it newly offers, skipping candidates already held at the same
 * fingerprint.
 *
 * **Retractions apply FIRST**, before `held` is read. The sender clears a tombstone when it
 * re-promotes that exact body, so the lists do not normally overlap, but a hand-edited sender
 * ledger could send both; reaping first makes the CANDIDATE list the survivor. That is the safe
 * order: a re-inherited foundation is re-verified through the whole accept gate, whereas the
 * opposite order would leave a retracted body with nothing to re-check it.
 *
 * Sequential on purpose: `recordEidoverseFoundationInheritance` serializes on the ledger's own
 * mutex, so `Promise.all` buys only a deeper queue.
 */
async function applyOffering(candidates, tombstones, { peer, localInstanceId }) {
  const mod = await ledger();
  if (!mod?.recordEidoverseFoundationInheritance || !mod?.listEidoverseFoundations || !mod?.applyEidoverseFoundationTombstones) {
    return { inherited: 0, refused: 0, removed: 0, skipped: 'ledger-unavailable' };
  }
  const { removed = 0 } = (await mod.applyEidoverseFoundationTombstones(tombstones, {
    sourceInstanceId: peer.instanceId,
  }).catch((err) => {
        // Counted as "reaped nothing" and pressed on: the sender keeps advertising the tombstone
        // until its candidate returns, so a failed retraction retries on the next sweep.
    console.log(`⚠️ peerSync: eidoverse-foundations retraction from ${peerLabel(peer)} failed: ${err.message}`);
    return null;
  })) || {};
  const held = new Set((await mod.listEidoverseFoundations()).foundations
    .filter((entry) => entry.inheritance)
    .map((entry) => entry.inheritance.fingerprint));
  let inherited = 0;
  let refused = 0;
  for (const candidate of candidates) {
    if (held.has(candidate.fingerprint)) continue;
    const result = await mod.recordEidoverseFoundationInheritance(candidate, {
      sourceInstanceId: peer.instanceId,
      localInstanceId,
    }).catch((err) => {
      console.log(`⚠️ peerSync: eidoverse-foundations inherit from ${peerLabel(peer)} failed: ${err.message}`);
      return null;
    });
    if (result?.outcome === 'inherited') inherited += 1;
    else refused += 1;
  }
  return { inherited, refused, removed };
}

/**
 * Periodic driver: pull the foundation offering from every full-sync peer. Each peer's sweep
 * is independent + best-effort.
 */
export async function syncEidoverseFoundationsWithAllPeers() {
  const peers = await getPeers().catch(() => []);
  for (const peer of peers.filter((p) => p?.fullSync === true && p?.enabled !== false && isStr(p.instanceId))) {
    await syncEidoverseFoundationsFromPeer(peer).catch((err) => {
      console.log(`⚠️ peerSync: eidoverse-foundations sweep for ${peerLabel(peer)} failed: ${err.message}`);
    });
  }
}

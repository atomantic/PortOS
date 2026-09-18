/**
 * Federated peer-sync — Eidoverse foundation pull/inherit transport (#7455,
 * provenance edges #7461, epic #7453).
 *
 * "Fork locally, contribute foundations globally" needs a wire. The two gates
 * already existed and were already tested; nothing connected them:
 *
 *   - `verifyFoundationCandidate()` (lib/eidoverseFoundations.js) — the gate a
 *     sender runs on its own envelope and a receiver runs on one it was handed.
 *   - `recordEidoverseFoundationInheritance()` (services/eidoverseFoundationLedger.js)
 *     — the accept side, which re-runs that whole gate on receipt, refuses a
 *     self-referential pull, and stores the acceptance under a
 *     `peer:<originInstanceId>:<foundationId>` key disjoint from local ids.
 *
 * This module is that wire, and nothing more. It owns no policy about WHICH
 * foundations an install offers (that is `listPromotedFoundationCandidates()`
 * in the ledger) and no policy about which it accepts (that is the accept-side
 * gate). It owns the payload wrapper, the version gate, the caps, and the
 * sweep.
 *
 * Shape mirrors the `cos-tasks` receiver-pull sweep (peerCosSync.js), the
 * closest existing precedent: the sender advertises at
 * `GET /api/peer-sync/eidoverse-foundations`; a receiver (only for peers it
 * flags `fullSync`) fetches it, byte-caps it, validates the wrapper,
 * version-gates it, short-circuits on an unchanged content-addressed
 * `listHash`, and applies per candidate. Every guard RETURNS rather than
 * throws — a sweep is best-effort and idempotent.
 *
 * **What crosses.** Only the promote envelope, which has no `style` layer by
 * construction: an inheriting peer gets the substance and keeps its own
 * cosmetics. The machine-local privacy ADR authorizes exactly this one
 * Eidoverse artifact to cross, and the federation-safety scan REFUSES a
 * payload carrying machine identity, PII or credentials rather than redacting
 * it — on both sides, because a peer's payload is untrusted input and this
 * install's own ledger is a file a human can edit.
 *
 * **The offering also RETRACTS (#7632).** It used to converge only upward: a
 * receiver applied what the sender listed and never reconciled what it held
 * against what the sender had stopped listing, so a promoted foundation could
 * never be recalled from an install that had pulled it. The payload now carries
 * `tombstones: [{ fingerprint, deletedAt }]` beside `candidates`, in its own
 * separately-capped array — a retraction must never be displaced by the entry
 * cap to make room for a publication. Both lists feed the `listHash`, so a
 * withdrawal with no other change still breaks the receiver's short-circuit.
 * A tombstone carries a content-addressed fingerprint and nothing else: it
 * names one published body without re-transmitting any of it.
 */
import { createHash } from 'crypto';
import { isPlainObject } from '../../lib/objects.js';
import { isStr } from '../../lib/textUtils.js';
import { peerBaseUrl } from '../../lib/peerUrl.js';
import { peerFetch } from '../../lib/peerHttpClient.js';
import { withAbortTimeout } from '../../lib/abortTimeout.js';
import { PORTOS_SCHEMA_VERSIONS } from '../../lib/schemaVersions.js';
import { peerEidoverseFoundationsSchema } from '../../lib/validation.js';
import { getInstanceId, UNKNOWN_INSTANCE_ID } from '../instanceIdentity.js';
import { getPeers } from '../instances.js';
import { FORCE_REVALIDATE_EVERY } from './peerSyncShared.js';

/**
 * A foundation body caps at 16 KiB, so the offering cap keeps the whole payload
 * comfortably inside the byte cap even at the entry cap. Both are generous
 * against any realistic promoted population; the sender truncates at the entry
 * cap and the receiver rejects an over-cap response on its content-length check.
 */
const OFFERING_ENTRY_CAP = 500;
const OFFERING_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Tombstones cap on their OWN budget, never against `OFFERING_ENTRY_CAP`
 * (#7632). Sharing one cap would let a large promoted population silently
 * truncate the retractions — publishing crowding out recall, which is the one
 * trade this feature must never make. A tombstone is two short strings, so
 * 500 of them is a rounding error against a 16 KiB body; the ledger caps the
 * stored list at the same order and drops the OLDEST deletion first, which by
 * then has long since reached every peer.
 */
const TOMBSTONE_ENTRY_CAP = 500;

/**
 * Deliberately NOT `ASSET_PULL_TIMEOUT_MS`: that constant is sized for
 * streaming media bytes, and importing it would drag `peerSyncAssets.js` — and
 * with it the authors/artists/albums/tracks/creative-director/mood-board/
 * writers-room graph — into this module's closure for one number. An offering
 * is a small capped JSON document; a peer that cannot produce one in 30s is
 * unreachable for this purpose.
 */
const OFFERING_PULL_TIMEOUT_MS = 30_000;

/**
 * The Eidoverse feature and the foundation ledger both sit behind dynamic
 * imports: this module is in `peerSync.js`'s static import chain (the sweep
 * driver and the route both reach it), and the Eidoverse graph — the assay
 * harness, the contribution registry, the controller runtime — has no business
 * being instantiated in the ~hundreds of suites that reach peer-sync for
 * unrelated reasons. Mirrors `buildCosTasksPayload`'s import of `cosTaskStore`.
 * A failed import degrades to "offer nothing / inherit nothing" rather than
 * taking the sweep down.
 */
const ledger = () => import('../eidoverseFoundationLedger.js').catch(() => null);
const eidoverseEnabled = async () => {
  const mod = await import('../instanceFeatures.js').catch(() => null);
  return (await mod?.isInstanceFeatureEnabled?.('eidoverse').catch(() => false)) === true;
};

const peerLabel = (peer) => peer.name || peer.instanceId;

/** Content-address the offering so a receiver can short-circuit an unchanged
 * one. Each envelope already carries a sha256 of its own body, and the list is
 * sorted by it, so hashing the fingerprints alone is both sufficient and
 * order-independent.
 *
 * The tombstones hash in too (#7632), under a separator that cannot appear in
 * either list, so a withdrawal is never mistaken for "nothing changed": a
 * retraction is usually the ONLY delta on the tick it lands (the candidate left
 * the offering at the same moment, but a receiver that had already skipped
 * would not look), and hashing candidates alone would hide it until the next
 * forced re-pull. `deletedAt` is included because re-withdrawing a fingerprint
 * refreshes the stamp and is a real change to what the sender is asserting. */
const offeringListHash = (candidates, tombstones) => createHash('sha256')
  .update(candidates.map((candidate) => String(candidate.fingerprint)).join('\n'))
  .update('\n--tombstones--\n')
  .update(tombstones.map((entry) => `${entry.fingerprint}@${entry.deletedAt}`).join('\n'))
  .digest('hex');

/**
 * Build the foundation offering this instance advertises to peers.
 *
 * Empty (not an error) when the Eidoverse feature is off: an install that
 * turned the feature off is not participating in the shared baseline, in
 * either direction. Also empty when the ledger module can't load.
 *
 * @returns {Promise<{ schemaVersion:number, listHash:string, candidates:Array }>}
 */
export async function buildEidoverseFoundationOffering() {
  const offering = (candidates, tombstones = []) => ({
    schemaVersion: PORTOS_SCHEMA_VERSIONS.eidoverseFoundations,
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
 * Pull ONE full-sync peer's foundation offering and inherit what passes the
 * accept-side gate. Best-effort + idempotent; no-op for a non-full-sync peer.
 *
 * Every candidate goes through `recordEidoverseFoundationInheritance()`, which
 * re-runs the ENTIRE gate — envelope schema, content-addressed fingerprint,
 * the embedded assay evidence, and the federation-safety scan — and refuses
 * (writing nothing) on any failure. Nothing here re-runs the resilience assay
 * or executes the contribution: that ran on the author's install, and
 * replaying arbitrary controller code pulled from a peer is exactly what the
 * agent-free harness exists to keep off every OTHER install.
 *
 * A candidate whose fingerprint this install already holds is skipped rather
 * than re-applied, so the periodic forced re-pull (which exists so a LOCAL
 * deletion self-heals) doesn't rewrite `inheritedAt` on every unchanged copy
 * and churn the ledger.
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
    // `getInstanceId`, not `ensureInstanceId`: a background sweep must not mint
    // this install's durable federation identity as a side effect. Without one
    // the accept-side gate cannot check for a self-referential pull anyway, so
    // there is nothing useful to do.
    const localInstanceId = await getInstanceId().catch(() => null);
    if (!isStr(localInstanceId) || localInstanceId === UNKNOWN_INSTANCE_ID) {
      return { inherited: 0, skipped: 'no-local-identity' };
    }
    const url = `${peerBaseUrl(peer)}/api/peer-sync/eidoverse-foundations`;
    const res = await withAbortTimeout(OFFERING_PULL_TIMEOUT_MS, (signal) =>
      peerFetch(url, { signal, maxBytes: OFFERING_MAX_BYTES }, peer))
      .catch(() => null);
    if (!res || !res.ok) return { inherited: 0, skipped: 'unreachable' };
    const declaredLen = Number(res.headers?.get?.('content-length'));
    if (Number.isFinite(declaredLen) && declaredLen > OFFERING_MAX_BYTES) {
      console.log(`⚠️ peerSync: eidoverse-foundations offering from ${peerLabel(peer)} too large (${declaredLen} > ${OFFERING_MAX_BYTES}) — skipping`);
      return { inherited: 0, skipped: 'too-large' };
    }
    const parsed = peerEidoverseFoundationsSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) {
      console.log(`⚠️ peerSync: eidoverse-foundations offering from ${peerLabel(peer)} failed validation — skipping`);
      return { inherited: 0, skipped: 'invalid' };
    }
    const payload = parsed.data;
    // Schema gate — GENTLE skip, not a rejection: wait for the local PortOS to
    // upgrade rather than store a foundation shape it cannot interpret. The
    // ledger has no re-fetch path that would correct a mis-applied envelope
    // later, so "apply now, fix on upgrade" is not available here.
    if (payload.schemaVersion > PORTOS_SCHEMA_VERSIONS.eidoverseFoundations) {
      console.log(`⏸️ peerSync: ${peerLabel(peer)} eidoverse-foundations offering is schema v${payload.schemaVersion} > local v${PORTOS_SCHEMA_VERSIONS.eidoverseFoundations} — skipping until this instance updates`);
      return { inherited: 0, skipped: 'schema-ahead' };
    }
    // Unchanged short-circuit with a periodic forced re-pull, so a LOCAL loss
    // (a hand-deleted ledger entry) self-heals even while the peer's offering
    // stays put.
    if (lastOfferingListHash.get(peer.instanceId) === payload.listHash) {
      const skips = (offeringUnchangedSkips.get(peer.instanceId) || 0) + 1;
      if (skips < FORCE_REVALIDATE_EVERY) {
        offeringUnchangedSkips.set(peer.instanceId, skips);
        return { inherited: 0, skipped: 'unchanged' };
      }
      offeringUnchangedSkips.set(peer.instanceId, 0); // forced re-pull — fall through
    }
    const applied = await applyOffering(payload.candidates, payload.tombstones, { peer, localInstanceId });
    // Only remember the offering once it was actually applied: recording the
    // hash after a `ledger-unavailable` pass would short-circuit the next
    // FORCE_REVALIDATE_EVERY ticks on work that never happened.
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
 * Reconcile this install against the peer's offering in BOTH directions:
 * drop what the peer withdrew, then inherit what it newly offers, skipping the
 * candidates this install already holds at the same content-addressed
 * fingerprint.
 *
 * **Retractions apply FIRST**, before `held` is read. The sender clears a
 * fingerprint's tombstone when it re-promotes that exact body, so the two lists
 * do not normally overlap — but a sender whose ledger was hand-edited could
 * send both, and reaping first means the survivor is whatever the CANDIDATE
 * list says. That is the safe order: a re-inherited foundation is re-verified
 * through the whole accept-side gate on its way back in, while the opposite
 * order would leave a retracted body in place with nothing to re-check it.
 *
 * Sequential on purpose: `recordEidoverseFoundationInheritance` serializes on
 * the ledger's own mutex, so a `Promise.all` here would buy nothing but a
 * deeper queue and a less readable failure.
 */
async function applyOffering(candidates, tombstones, { peer, localInstanceId }) {
  const mod = await ledger();
  if (!mod?.recordEidoverseFoundationInheritance || !mod?.listEidoverseFoundations || !mod?.applyEidoverseFoundationTombstones) {
    return { inherited: 0, refused: 0, removed: 0, skipped: 'ledger-unavailable' };
  }
  const { removed = 0 } = (await mod.applyEidoverseFoundationTombstones(tombstones, {
    sourceInstanceId: peer.instanceId,
  }).catch((err) => {
    // Counted as "reaped nothing" and pressed on: the sender keeps advertising
    // the tombstone until its candidate comes back, so a failed retraction
    // retries on the next sweep rather than being lost.
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
 * Periodic driver: pull the foundation offering from every full-sync peer.
 * Each peer's sweep is independent + best-effort.
 */
export async function syncEidoverseFoundationsWithAllPeers() {
  const peers = await getPeers().catch(() => []);
  for (const peer of peers.filter((p) => p?.fullSync === true && p?.enabled !== false && isStr(p.instanceId))) {
    await syncEidoverseFoundationsFromPeer(peer).catch((err) => {
      console.log(`⚠️ peerSync: eidoverse-foundations sweep for ${peerLabel(peer)} failed: ${err.message}`);
    });
  }
}

/**
 * Federated AI-usage metrics.
 *
 * PortOS installs are commonly several machines federated as sync peers, and
 * "how much AI did I burn?" is a question about the FLEET, not about whichever
 * box the user happens to have open. This service is the `usage` sync
 * category's store: each instance publishes a digest of its own
 * `data/usage.json` (aggregate counters only — see `buildUsageDigest`) and
 * keeps every peer's digest side by side under `data/peer-usage.json`.
 *
 * Two invariants make that safe to run continuously:
 *
 *  - **Never merged into local usage.** A peer's counters live in their own
 *    per-instance slot. Summing them into `usage.json` would double-count on
 *    the very next round trip (our snapshot would ship the inflated total back)
 *    and would corrupt this machine's own history irreversibly.
 *  - **Idempotent, per-instance LWW.** A digest is replaced whole, keyed by its
 *    origin instanceId and stamped with `capturedAt`. Re-applying the same
 *    snapshot is a no-op, and a node forwards what it knows about third
 *    instances, so a chain (A↔B↔C) converges without A and C ever talking.
 *
 * Privacy: the digest carries provider ids, model ids, token/session/message
 * counts, day+month buckets and an instance name. No prompts, no transcripts,
 * no record contents, no PII — see
 * `docs/decisions/2026-09-01-federated-usage-metrics.md`.
 */

import { join } from 'path';
import { atomicWrite, readJSONFile, dataPath, PATHS } from '../lib/fileUtils.js';
import { isPlainObject } from '../lib/objects.js';
import { createMutex } from '../lib/asyncMutex.js';
import { compareNewerWins, parseTsMs } from '../lib/lwwTimestamp.js';
import { mergeTombstones, normalizeTombstones, recordTombstone, isTombstoned } from '../lib/tombstones.js';
import { canonicalSnapshotChecksum } from '../lib/snapshotChecksum.js';
import { roundCents } from '../lib/subscriptionSavings.js';
import { buildUsageDigest, buildUsageReport, getUsage, USAGE_FILE } from './usage.js';

const PEER_USAGE_FILE = join(PATHS.data, 'peer-usage.json');

// Upper bound on stored peer digests. A home federation runs a handful of
// machines; the cap only stops an unbounded file if a peer ever forwards a long
// tail of instance ids that no longer exist. Oldest `capturedAt` is evicted.
const MAX_INSTANCES = 64;

// Structural bounds on ONE peer-supplied digest. The wire shape is fixed and
// shallow (day → provider → model), so it is normalized field-by-field rather
// than stored as it arrived: `canonicalStringify` (used for this category's
// checksum) is a recursive JS function with a far smaller depth budget than
// native JSON.stringify, so a digest nested deeply enough to pass `atomicWrite`
// but blow that recursion would 500 the snapshot endpoint for every peer,
// permanently and across restarts. The caps also stop one peer from growing
// `peer-usage.json` without bound inside its single slot.
const MAX_DAY_BUCKETS = 800;
const MAX_MONTH_BUCKETS = 400;
const MAX_PROVIDERS_PER_BUCKET = 100;
const MAX_MODELS_PER_PROVIDER = 400;

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_KEY_RE = /^\d{4}-\d{2}$/;

const isNonEmptyStr = (v) => typeof v === 'string' && v.length > 0;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v, max) => (isNonEmptyStr(v) ? v.slice(0, max) : null);

const COUNT_FIELDS = ['sessions', 'messages', 'tokens', 'tokensIn', 'tokensOut', 'cacheReadTokens', 'cacheWriteTokens'];

function takeCounts(source, target) {
  for (const field of COUNT_FIELDS) {
    if (typeof source?.[field] === 'number') target[field] = num(source[field]);
  }
  return target;
}

function sanitizeModelBucket(raw) {
  const out = takeCounts(raw, {});
  const source = str(raw?.source, 20);
  if (source) out.source = source;
  return out;
}

function sanitizeProviderBucket(raw) {
  const out = takeCounts(raw, {});
  const name = str(raw?.name, 120);
  if (name) out.name = name;
  const source = str(raw?.source, 20);
  if (source) out.source = source;
  if (isPlainObject(raw?.byModel)) {
    out.byModel = {};
    for (const [model, mRaw] of Object.entries(raw.byModel).slice(0, MAX_MODELS_PER_PROVIDER)) {
      if (!isNonEmptyStr(model)) continue;
      out.byModel[model.slice(0, 200)] = sanitizeModelBucket(mRaw);
    }
  }
  return out;
}

function sanitizeActivityBucket(raw) {
  const out = takeCounts(raw, {});
  if (isPlainObject(raw?.byProvider)) {
    out.byProvider = {};
    for (const [pid, pRaw] of Object.entries(raw.byProvider).slice(0, MAX_PROVIDERS_PER_BUCKET)) {
      if (!isNonEmptyStr(pid)) continue;
      out.byProvider[pid.slice(0, 200)] = sanitizeProviderBucket(pRaw);
    }
  }
  return out;
}

function sanitizeActivityMap(raw, keyRe, limit) {
  const out = {};
  if (!isPlainObject(raw)) return out;
  for (const [key, bucket] of Object.entries(raw).slice(0, limit)) {
    if (!keyRe.test(key)) continue;
    out[key] = sanitizeActivityBucket(bucket);
  }
  return out;
}

/**
 * Rebuild a peer's digest to the known wire shape, dropping anything else. Depth
 * is therefore fixed by construction — see the bounds above for why that
 * matters more than it looks.
 */
function sanitizeDigest(raw) {
  const hourly = Array.isArray(raw?.hourlyActivity) ? raw.hourlyActivity : [];
  return {
    totalSessions: num(raw?.totalSessions),
    totalMessages: num(raw?.totalMessages),
    totalToolCalls: num(raw?.totalToolCalls),
    totalTokens: { input: num(raw?.totalTokens?.input), output: num(raw?.totalTokens?.output) },
    dailyActivity: sanitizeActivityMap(raw?.dailyActivity, DAY_KEY_RE, MAX_DAY_BUCKETS),
    monthlyActivity: sanitizeActivityMap(raw?.monthlyActivity, MONTH_KEY_RE, MAX_MONTH_BUCKETS),
    hourlyActivity: Array.from({ length: 24 }, (_, i) => num(hourly[i])),
    earliestActivityDay: str(raw?.earliestActivityDay, 10),
    lastUpdated: str(raw?.lastUpdated, 40),
  };
}

const withLock = createMutex();

/**
 * This machine's federation identity. Dynamically imported so `dataSync` →
 * `peerUsage` doesn't drag `services/instances.js` (peer socket relay,
 * federated-media consumer, tailscale) into dataSync's module-load path — the
 * same reason dataSync defers `sharing/peerSync.js`.
 */
async function readSelfIdentity() {
  const { getSelf, UNKNOWN_INSTANCE_ID } = await import('./instances.js');
  const self = await getSelf().catch(() => null);
  const instanceId = isNonEmptyStr(self?.instanceId) && self.instanceId !== UNKNOWN_INSTANCE_ID
    ? self.instanceId
    : null;
  return { instanceId, name: isNonEmptyStr(self?.name) ? self.name : null };
}

async function readStore() {
  // Non-strict: this file is entirely derived, replicated state. A corrupt read
  // self-heals on the next sync cycle, which beats throwing on every poll.
  const raw = await readJSONFile(PEER_USAGE_FILE, null);
  return {
    instances: isPlainObject(raw?.instances) ? raw.instances : {},
    tombstones: normalizeTombstones(raw?.tombstones, 'instanceId'),
  };
}

/**
 * Coerce one wire entry into a stored entry, or null when it can't be trusted.
 * Pins identity (the entry must belong to the map key it arrived under),
 * orderability (a parseable stamp), and shape (`sanitizeDigest`).
 */
function sanitizeEntry(entry, expectedId) {
  if (!isPlainObject(entry) || !isPlainObject(entry.usage)) return null;
  // A digest may omit its own id (the key is authoritative), but it may never
  // claim a DIFFERENT one — that would let a peer smuggle a digest in under our
  // id, or overwrite a third instance's slot.
  if (isNonEmptyStr(entry.instanceId) && entry.instanceId !== expectedId) return null;
  if (parseTsMs(entry.capturedAt) === null) return null;
  return {
    instanceId: expectedId,
    name: isNonEmptyStr(entry.name) ? entry.name.slice(0, 120) : expectedId,
    capturedAt: entry.capturedAt,
    usage: sanitizeDigest(entry.usage),
  };
}

// The self digest is a pure function of (usage counters, today's date) — the
// date because the wire rollup's cutoff moves at midnight. `saveUsage` stamps
// `lastUpdated` on every write, so it doubles as the cache key. Without this
// memo the deep clone + rollup re-ran on every checksum-cache miss AND once per
// probing peer, all producing the identical byte-for-byte digest.
let digestMemo = null;
function selfDigest(usageData) {
  const key = `${usageData?.lastUpdated ?? ''}|${new Date().toISOString().slice(0, 10)}`;
  if (digestMemo?.key !== key) digestMemo = { key, digest: buildUsageDigest(usageData) };
  return digestMemo.digest;
}

/** This instance's own live entry, rebuilt from `usage.json` on every read. */
async function buildSelfEntry() {
  const { instanceId, name } = await readSelfIdentity();
  if (!instanceId) return null;
  const usage = selfDigest(getUsage());
  return { instanceId, name: name || instanceId, capturedAt: usage.lastUpdated, usage };
}

/**
 * Every instance we can report on: the peer digests we hold, plus our own live
 * entry. Our own slot is always regenerated — a stale copy of us that came back
 * from a peer never wins. A digest with no activity yet has a null
 * `lastUpdated` and is dropped from the wire rather than shipped unorderable.
 */
async function entriesWithSelf() {
  const [store, self] = await Promise.all([readStore(), buildSelfEntry()]);
  const peers = Object.values(store.instances).filter((e) => isPlainObject(e) && isPlainObject(e.usage));
  const publishable = self && isNonEmptyStr(self.capturedAt) ? self : null;
  return {
    self: publishable,
    peers: peers.filter((e) => e.instanceId !== self?.instanceId),
    tombstones: store.tombstones,
  };
}

/**
 * dataSync `getSnapshot` for the `usage` category: our own live digest plus
 * every peer digest we hold, so a third instance reachable only through us
 * still propagates.
 */
export async function getUsageSnapshot() {
  const { self, peers, tombstones } = await entriesWithSelf();
  const instances = Object.fromEntries(peers.map((e) => [e.instanceId, e]));
  if (self) instances[self.instanceId] = self;
  // Tombstones ride the snapshot so a retirement propagates: an add-only merge
  // alone would let any peer that still holds the digest hand it straight back.
  const data = { instances, tombstones };
  // CANONICAL: the payload is a map keyed by instance ids arriving over the
  // wire, so two converged peers would otherwise hash differently purely from
  // the order they happened to learn each other — which the sync UI reads as
  // "behind" forever.
  return { data, checksum: canonicalSnapshotChecksum(data) };
}

/**
 * dataSync `applyRemote` for the `usage` category. Per-instance LWW on
 * `capturedAt`; our own slot is skipped outright (we are the authority on our
 * own counters), and nothing is ever summed into `data/usage.json`.
 */
export async function applyUsageRemote(remoteData) {
  const incoming = isPlainObject(remoteData?.instances) ? remoteData.instances : null;
  if (!incoming) return { applied: false, count: 0 };

  const { instanceId: selfId } = await readSelfIdentity();

  return withLock(async () => {
    const store = await readStore();
    // Union the deletion list in BOTH directions, so retiring an instance on one
    // machine retires it everywhere instead of being undone by the next peer that
    // still forwards it.
    const { merged, changed: tombstonesChanged } = mergeTombstones(store.tombstones, remoteData?.tombstones, { keyField: 'instanceId' });
    store.tombstones = merged;
    let changed = 0;

    for (const [key, rawEntry] of Object.entries(incoming)) {
      if (!isNonEmptyStr(key) || key === selfId) continue;
      const entry = sanitizeEntry(rawEntry, key);
      if (!entry) continue;
      // A digest CAPTURED after the deletion is a machine that came back, and
      // supersedes the tombstone. An older one is the retired machine echoing
      // back via a peer that hasn't seen the removal yet.
      if (isTombstoned(store.tombstones, key, entry.capturedAt, 'instanceId')) continue;
      if (!compareNewerWins(entry.capturedAt, store.instances[key]?.capturedAt)) continue;
      store.instances[key] = entry;
      changed++;
    }

    // Adopting a peer's tombstone also retires the local digest it covers.
    for (const key of Object.keys(store.instances)) {
      if (!isTombstoned(store.tombstones, key, store.instances[key]?.capturedAt, 'instanceId')) continue;
      delete store.instances[key];
      changed++;
    }

    if (changed === 0) {
      // A tombstone learned from a peer is still state worth persisting, even
      // when it retired nothing here — otherwise we re-learn it every cycle.
      if (tombstonesChanged) await atomicWrite(PEER_USAGE_FILE, store);
      return { applied: false, count: 0 };
    }

    const ids = Object.keys(store.instances);
    if (ids.length > MAX_INSTANCES) {
      const oldestFirst = ids.sort((a, b) => (parseTsMs(store.instances[a].capturedAt) ?? 0) - (parseTsMs(store.instances[b].capturedAt) ?? 0));
      for (const id of oldestFirst.slice(0, ids.length - MAX_INSTANCES)) delete store.instances[id];
    }

    await atomicWrite(PEER_USAGE_FILE, store);
    console.log(`🔄 Usage sync: updated ${changed} instance digest${changed === 1 ? '' : 's'}`);
    return { applied: true, count: changed };
  });
}

/**
 * Fleet-wide usage for a report window: one row per known instance plus the
 * combined totals.
 *
 * Every row goes through the SAME pure `buildUsageReport` the single-instance
 * page uses, so per-instance and fleet figures are priced identically — and
 * THIS machine's row reads the live activity maps, not its own wire digest. The
 * digest folds days past the wire-retention window into whole months, and
 * `buildUsageReport` includes a month bucket whole whenever its month overlaps
 * the window; routing our own row through it would make the "This machine" row
 * disagree with the headline directly above it on a narrow historical range.
 *
 * Peer rows are as fresh as the last sync, so `capturedAt` is surfaced for the
 * UI to age them rather than implying they are live.
 *
 * `apiBilledInstanceIds` are instances the viewer marked as paying API rates
 * rather than subscriptions. They stay in `instances` (the spend is real) with
 * `usesSubscriptions: false`, but they do not feed the combined `totals`.
 */
/**
 * Keep only month buckets the window covers END TO END. `buildUsageReport`
 * includes an overlapping month whole, so a month the range only clips would
 * contribute days outside it. Unbounded on a side means that side covers
 * everything, so a bucket is dropped only where the given bound cuts into it.
 */
function dropPartiallyCoveredMonths(monthlyActivity, from, to) {
  if (!isPlainObject(monthlyActivity)) return {};
  if (!from && !to) return monthlyActivity;
  const out = {};
  for (const [month, bucket] of Object.entries(monthlyActivity)) {
    // A month is fully covered when the window starts on or before its 1st and
    // ends on or after its last day.
    if (from && from > month + '-01') continue;
    if (to) {
      const [y, m] = month.split('-').map(Number);
      const lastDay = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      if (to < lastDay) continue;
    }
    out[month] = bucket;
  }
  return out;
}

function sumFleetTotals(rows) {
  // Derived from the report's own totals rather than a second hardcoded field
  // list, so a field added to `buildUsageReport` can't silently sum to zero here.
  const totals = rows.reduce((acc, r) => {
    for (const [field, value] of Object.entries(r.totals || {})) {
      if (typeof value === 'number') acc[field] = (acc[field] || 0) + value;
    }
    return acc;
  }, {});
  totals.estimatedCost = roundCents(totals.estimatedCost || 0);
  return totals;
}

export async function getFleetUsage({ from = null, to = null, providers = [], apiBilledInstanceIds = [] } = {}) {
  const { self, peers } = await entriesWithSelf();
  if (peers.length === 0) return { instances: [], totals: null };

  // Instances the viewer marked as paying API rates (not subscriptions). They
  // stay in `instances` so the spend is still visible, but they do not feed
  // the combined total. Default ON (not in the set) — a missing id counts.
  const apiBilled = new Set(Array.isArray(apiBilledInstanceIds) ? apiBilledInstanceIds : []);

  const row = ({ instanceId, name, capturedAt, activity, isSelf }) => {
    const report = buildUsageReport(activity.dailyActivity || {}, {
      from,
      to,
      providers,
      // A month bucket is folded in WHOLE whenever its month overlaps the window
      // — fine locally, where months only exist past the 400-day daily retention
      // and so can't land inside a range anyone asks for. A peer's digest rolls
      // up at 120 days, well inside a reachable range, so an explicit narrow
      // from/to over a rolled-up month would silently count days outside it.
      // Drop the partially-covered months rather than over-report; the row's
      // whole-month periods are unaffected.
      monthlyActivity: dropPartiallyCoveredMonths(activity.monthlyActivity, from, to),
      // Same rule as the single-instance summary: the all-time (unbounded)
      // window folds in legacy totals no bucket represents; a bounded window
      // must not, or it attributes all-time residue to the range.
      totalTokens: from || to ? null : activity.totalTokens,
    });
    return {
      instanceId,
      name: name || instanceId,
      self: isSelf,
      capturedAt,
      totals: report.totals,
      usesSubscriptions: !apiBilled.has(instanceId),
    };
  };

  const rows = peers.map((e) => row({ ...e, activity: e.usage, isSelf: false }));
  if (self) rows.unshift(row({ ...self, activity: getUsage(), isSelf: true }));

  rows.sort((a, b) => (b.self ? 1 : 0) - (a.self ? 1 : 0) || b.totals.estimatedCost - a.totals.estimatedCost);

  const included = rows.filter((r) => r.usesSubscriptions);
  return { instances: rows, totals: sumFleetTotals(included) };
}

/**
 * Retire an instance's usage digest — called when the user removes that peer.
 *
 * A plain delete is not enough: our snapshot forwards every digest we hold, so a
 * surviving peer would hand the row straight back on the next cycle and a
 * decommissioned machine's spend would sit in the fleet total forever. The
 * tombstone rides the same snapshot and propagates the removal instead. A digest
 * captured AFTER the tombstone still wins, so re-adding the machine later works.
 */
export async function forgetInstanceUsage(instanceId) {
  if (!isNonEmptyStr(instanceId)) return { removed: false };
  return withLock(async () => {
    const store = await readStore();
    store.tombstones = recordTombstone(store.tombstones, instanceId, { keyField: 'instanceId' });
    const removed = Object.hasOwn(store.instances, instanceId);
    delete store.instances[instanceId];
    await atomicWrite(PEER_USAGE_FILE, store);
    console.log(`🔄 Usage sync: retired digest for instance ${instanceId}`);
    return { removed };
  });
}

// Files whose fingerprint invalidates the category's checksum cache. The
// instances file is in the set because the snapshot embeds this instance's NAME
// — without it a rename never reaches peers and their fleet table keeps showing
// the old one until an AI run happens to move usage.json.
export const USAGE_CHECKSUM_PATHS = [USAGE_FILE, PEER_USAGE_FILE, dataPath('instances.json')];

export { PEER_USAGE_FILE };

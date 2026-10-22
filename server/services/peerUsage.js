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
import { isPlainObject, POLLUTING_KEYS } from '../lib/objects.js';
import { createMutex } from '../lib/asyncMutex.js';
import { compareNewerWins, parseTsMs } from '../lib/lwwTimestamp.js';
import { mergeTombstones, normalizeTombstones, recordTombstone, isTombstoned } from '../lib/tombstones.js';
import { canonicalSnapshotChecksum } from '../lib/snapshotChecksum.js';
import { roundCents } from '../lib/subscriptionSavings.js';
import { isFreeProvider } from '../lib/modelPricing.js';
import { familyForProviderId, familyLabel } from '../lib/providerFamilies.js';
import { sanitizeQuotaCards } from '../lib/fleetQuotas.js';
import { buildUsageDigest, buildUsageReport, getUsage, USAGE_FILE } from './usage.js';
import { readLocalQuotaCards, PROVIDER_QUOTAS_FILE } from './providerQuotaShare.js';
import { isNonBlankStr } from '../lib/textUtils.js';
import { readLocalTranscriptUsage, sanitizeTranscriptDays, TRANSCRIPT_USAGE_FILE } from './claudeCodeTranscriptUsage.js';
import { summarizeTranscriptDays, mergeModelRows } from './claudeCodeModelReport.js';

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

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v, max) => (isNonBlankStr(v) ? v.slice(0, max) : null);

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
      if (!isNonBlankStr(model)) continue;
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
      if (!isNonBlankStr(pid)) continue;
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
 * This machine's federation identity, read from the identity leaf
 * (services/instanceIdentity.js, #6836) rather than services/instances.js —
 * that module still drags the peer socket relay / federated-media consumer /
 * tailscale into dataSync's module-load path, the same reason dataSync defers
 * `sharing/peerSync.js`. Kept as a dynamic import to match that call shape,
 * though the leaf itself would no longer need the deferral.
 */
async function readSelfIdentity() {
  const { getSelf, UNKNOWN_INSTANCE_ID } = await import('./instanceIdentity.js');
  const self = await getSelf().catch(() => null);
  const instanceId = isNonBlankStr(self?.instanceId) && self.instanceId !== UNKNOWN_INSTANCE_ID
    ? self.instanceId
    : null;
  return { instanceId, name: isNonBlankStr(self?.name) ? self.name : null };
}

async function readStore() {
  // Retirements are durable tombstones: peers cannot rebuild a deletion that
  // has not propagated yet. Never replace an unreadable store with a new digest.
  const raw = await readJSONFile(PEER_USAGE_FILE, null, { strict: true });
  return {
    instances: isPlainObject(raw?.instances) ? raw.instances : {},
    tombstones: normalizeTombstones(raw?.tombstones, 'instanceId'),
  };
}

/**
 * A peer's Claude Code per-day, per-model token history, or null when it sent
 * none (or an unorderable one). Rebuilt to the fixed day → model → counts shape.
 */
function sanitizeClaudeCode(raw) {
  if (!isPlainObject(raw) || parseTsMs(raw.updatedAt) === null) return null;
  const days = sanitizeTranscriptDays(raw.days);
  return Object.keys(days).length > 0 ? { updatedAt: raw.updatedAt, days } : null;
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
  if (isNonBlankStr(entry.instanceId) && entry.instanceId !== expectedId) return null;
  if (parseTsMs(entry.capturedAt) === null) return null;
  return {
    instanceId: expectedId,
    name: isNonBlankStr(entry.name) ? entry.name.slice(0, 120) : expectedId,
    capturedAt: entry.capturedAt,
    usage: sanitizeDigest(entry.usage),
    // Optional: a peer running an older build publishes no quota readings, and
    // the fleet quota view simply has one fewer contributor.
    quotas: sanitizeQuotaCards(entry.quotas),
    // Optional and additive, like `quotas`: a peer on an older build publishes
    // no Claude Code token history and simply contributes nothing to that report.
    claudeCode: sanitizeClaudeCode(entry.claudeCode),
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

/**
 * This instance's own live entry, rebuilt from `usage.json` (and the last quota
 * readings) on every read.
 *
 * `capturedAt` is the LWW stamp AND the manifest fingerprint, so it has to move
 * whenever anything in the entry does — a quota refresh that left it pinned to
 * `usage.lastUpdated` would never be pulled by a peer.
 */
async function buildSelfEntry() {
  const { instanceId, name } = await readSelfIdentity();
  if (!instanceId) return null;
  const usage = selfDigest(getUsage());
  const { quotas, capturedAt: quotasAt } = await readLocalQuotaCards();
  // An unreadable store publishes no history rather than failing every sync read.
  const local = await readLocalTranscriptUsage().catch(() => null);
  const claudeCode = local?.updatedAt && Object.keys(local.days).length > 0 ? local : null;
  // capturedAt is the LWW stamp AND manifest fingerprint: the newest of every
  // component, so a transcript-store refresh alone still gets pulled by peers.
  const capturedAt = [usage.lastUpdated, quotasAt, claudeCode?.updatedAt].reduce(
    (newest, ts) => (compareNewerWins(ts, newest) ? ts : newest));
  return { instanceId, name: name || instanceId, capturedAt, usage, quotas, ...(claudeCode && { claudeCode }) };
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
  const publishable = self && isNonBlankStr(self.capturedAt) ? self : null;
  return {
    self: publishable,
    peers: peers.filter((e) => e.instanceId !== self?.instanceId),
    tombstones: store.tombstones,
  };
}

/**
 * The category's version map: `{ <instanceId>: capturedAt }` plus the tombstone
 * list. A few hundred bytes, and the ONLY thing this category's checksum is
 * computed over (see `usageChecksum`).
 */
function manifestOf(self, peers, tombstones) {
  const instances = Object.fromEntries(peers.map((e) => [e.instanceId, e.capturedAt]));
  if (self) instances[self.instanceId] = self.capturedAt;
  return { instances, tombstones };
}

/**
 * CANONICAL: the payload is a map keyed by instance ids arriving over the wire,
 * so two converged peers would otherwise hash differently purely from the order
 * they happened to learn each other — which the sync UI reads as "behind"
 * forever.
 *
 * Hashed over the MANIFEST rather than the digests themselves. The digests are
 * a pure function of the (instanceId, capturedAt) pairs — a slot is replaced
 * whole under that stamp and never edited in place — so the manifest is a
 * faithful fingerprint of the payload, and it is what `getUsageSnapshot`
 * reports too. A peer that only knows `/checksum` + `/snapshot` therefore still
 * sees the checksum change exactly when a slot advances.
 */
const usageChecksum = (manifest) => canonicalSnapshotChecksum(manifest);

/**
 * dataSync `getManifest` for the `usage` category. Served at
 * `/api/sync/usage/manifest` so a puller can fetch only the slots that moved,
 * and read locally (same function, no arguments) as "what do we already hold?"
 * for that diff.
 */
export async function getUsageManifest() {
  const { self, peers, tombstones } = await entriesWithSelf();
  const data = manifestOf(self, peers, tombstones);
  return { data, checksum: usageChecksum(data) };
}

/**
 * dataSync `getSnapshot` for the `usage` category: our own live digest plus
 * every peer digest we hold, so a third instance reachable only through us
 * still propagates.
 *
 * `slots` (a `Set`/array of instance ids, from `?slots=` on the wire) narrows
 * the payload to the digests a manifest-aware puller actually needs. Absent —
 * an older peer, or any caller that skipped the manifest — serves everything,
 * which the receiver merges idempotently. The checksum is the FULL manifest's
 * either way: it describes the category's state, not the slice we happened to
 * serve, so the two endpoints can never disagree.
 */
export async function getUsageSnapshot({ slots = null } = {}) {
  const { self, peers, tombstones } = await entriesWithSelf();
  const wanted = slots instanceof Set ? slots : (Array.isArray(slots) && slots.length > 0 ? new Set(slots) : null);
  const keep = (id) => !wanted || wanted.has(id);
  const instances = Object.fromEntries(peers.filter((e) => keep(e.instanceId)).map((e) => [e.instanceId, e]));
  if (self && keep(self.instanceId)) instances[self.instanceId] = self;
  // Tombstones ride EVERY response (slot-scoped included) so a retirement
  // propagates: an add-only merge alone would let any peer that still holds the
  // digest hand it straight back, and a retirement moves no slot's capturedAt.
  return { data: { instances, tombstones }, checksum: usageChecksum(manifestOf(self, peers, tombstones)) };
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
      // A peer-chosen key of `__proto__` would replace this map's prototype on assignment.
      if (!isNonBlankStr(key) || key === selfId || POLLUTING_KEYS.has(key)) continue;
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

export const ROLLING_COST_WINDOW_DAYS = 30;
// Points shown per range. `all` starts at the earliest day any instance has.
export const ROLLING_COST_RANGES = { '1m': 30, '3m': 90, '6m': 182, '1y': 365, all: null };

const DAY_MS = 86_400_000;
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (day) => Date.parse(`${day}T00:00:00Z`);

// Stacked groups beyond this many fold into "Other" so the legend stays short.
const MAX_COST_GROUPS = 5;
const OTHER_GROUP = 'other';

/**
 * A report's cost split by plan: a provider row belongs to its subscription
 * family when it has one (a peer's provider may not be configured here, so the
 * id is tried too), else it stands alone under its own name.
 */
function costByGroup(report, labels) {
  const out = {};
  for (const row of report.providers) {
    if (!(row.estimatedCost > 0)) continue;
    const family = row.family || familyForProviderId(row.id);
    const key = family || `provider:${row.id}`;
    if (!labels.has(key)) labels.set(key, family ? familyLabel(family) : row.name || row.id);
    out[key] = (out[key] || 0) + row.estimatedCost;
  }
  return out;
}

const addInto = (target, source, scale = 1) => {
  for (const [key, cost] of Object.entries(source)) target[key] = (target[key] || 0) + cost * scale;
};

/**
 * Estimated API cost per day for one instance over `span`, split by plan, each
 * day priced on its own through the same `buildUsageReport` as the cost report
 * so the series and the headline agree.
 *
 * Old days survive only as month buckets (a peer's digest rolls up after 120
 * days, this machine's history after 400), so a month bucket's cost is spread
 * evenly over that month's days that no longer have a day bucket. The month's
 * total is exact; its shape within the month is not.
 */
function instanceDailyCosts({ daily = {}, monthly = {} }, span, providers, labels) {
  const missingDays = new Map();
  for (const day of span) {
    const month = day.slice(0, 7);
    if (!daily[day] && monthly[month]) missingDays.set(month, (missingDays.get(month) || 0) + 1);
  }
  const monthShare = new Map();
  for (const [month, count] of missingDays) {
    const report = buildUsageReport({}, { monthlyActivity: { [month]: monthly[month] }, providers });
    // Days of the month outside the span still carry their share, so divide by
    // every rolled-up day of the month, not only the `count` in view.
    const [y, m] = month.split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const rolledDays = daysInMonth - Object.keys(daily).filter((d) => d.startsWith(`${month}-`)).length;
    const share = {};
    addInto(share, costByGroup(report, labels), 1 / Math.max(rolledDays, count));
    monthShare.set(month, share);
  }
  return span.map((day) => {
    if (daily[day]) return costByGroup(buildUsageReport({ [day]: daily[day] }, { from: day, to: day, providers }), labels);
    return monthShare.get(day.slice(0, 7)) || {};
  });
}

function earliestDay(sources) {
  let earliest = null;
  for (const { daily, monthly } of sources) {
    for (const day of Object.keys(daily || {})) if (!earliest || day < earliest) earliest = day;
    for (const month of Object.keys(monthly || {})) if (!earliest || `${month}-01` < earliest) earliest = `${month}-01`;
  }
  return earliest;
}

let rollingMemo = null;

/**
 * Rolling 30-day estimated API cost summed across EVERY known instance, one
 * point per UTC day over `range` (see ROLLING_COST_RANGES). API-billed
 * instances count here: this is total spend at API rates, not the
 * subscription-covered subset the Across Instances total reports. Peers are as
 * fresh as their last sync.
 */
export async function getFleetRollingCost({ providers = [], range = '3m', now = new Date() } = {}) {
  const { self, peers } = await entriesWithSelf();
  const local = getUsage();
  // This machine always reads its live maps; with no minted identity yet it
  // still has its own history to chart.
  const sources = [
    { id: self?.instanceId ?? 'local', stamp: local?.lastUpdated, daily: local?.dailyActivity, monthly: local?.monthlyActivity },
    ...peers.map((e) => ({ id: e.instanceId, stamp: e.capturedAt, daily: e.usage.dailyActivity, monthly: e.usage.monthlyActivity })),
  ];

  const todayMs = dayMs(utcDay(now.getTime()));
  const rangeId = Object.hasOwn(ROLLING_COST_RANGES, range) ? range : '3m';
  const fixed = ROLLING_COST_RANGES[rangeId];
  const first = earliestDay(sources);
  const allPoints = first ? Math.floor((todayMs - dayMs(first)) / DAY_MS) + 1 : 2;
  const pointCount = Math.max(2, fixed ?? allPoints);
  const spanLength = pointCount + ROLLING_COST_WINDOW_DAYS - 1;
  const span = Array.from({ length: spanLength }, (_, i) => utcDay(todayMs - (spanLength - 1 - i) * DAY_MS));

  const key = JSON.stringify([rangeId, span[0], span.at(-1), sources.map((s) => [s.id, s.stamp]), providers.map((p) => [p.id, isFreeProvider(p)])]);
  if (rollingMemo?.key === key) return rollingMemo.value;

  const labels = new Map();
  const perDay = span.map(() => ({}));
  for (const source of sources) {
    instanceDailyCosts(source, span, providers, labels).forEach((costs, i) => addInto(perDay[i], costs));
  }

  const totals = {};
  for (const costs of perDay) addInto(totals, costs);
  const ranked = Object.keys(totals).sort((x, y) => totals[y] - totals[x]);
  const kept = ranked.length > MAX_COST_GROUPS ? ranked.slice(0, MAX_COST_GROUPS - 1) : ranked;
  const groupOf = new Map(ranked.map((key) => [key, kept.includes(key) ? key : OTHER_GROUP]));
  const series = kept.map((key) => ({ key, label: labels.get(key) }));
  if (kept.length < ranked.length) series.push({ key: OTHER_GROUP, label: 'Other' });
  const slot = new Map(series.map((g, i) => [g.key, i]));

  // Per-day cost in series order, then a trailing-window sum per slot.
  const daily = perDay.map((costs) => {
    const row = new Array(series.length).fill(0);
    for (const [key, cost] of Object.entries(costs)) row[slot.get(groupOf.get(key))] += cost;
    return row;
  });
  const running = new Array(series.length).fill(0);
  const points = [];
  for (let i = 0; i < span.length; i++) {
    daily[i].forEach((cost, j) => { running[j] += cost; });
    if (i >= ROLLING_COST_WINDOW_DAYS) daily[i - ROLLING_COST_WINDOW_DAYS].forEach((cost, j) => { running[j] -= cost; });
    if (i < ROLLING_COST_WINDOW_DAYS - 1) continue;
    // Clamp: the add/subtract walk can leave float dust just below zero.
    const values = running.map((v) => Math.max(0, roundCents(v)));
    points.push({ date: span[i], cost: roundCents(values.reduce((sum, v) => sum + v, 0)), values });
  }
  const value = { range: rangeId, windowDays: ROLLING_COST_WINDOW_DAYS, instanceCount: sources.length, series, points };
  rollingMemo = { key, value };
  return value;
}

/**
 * Fleet-wide Claude Code tokens per model, priced at API rates, for a window.
 * One row per instance that has published transcript history (this machine
 * reads its live store), plus a combined per-model list. As with `getFleetUsage`,
 * an instance the viewer marked as API-billed stays listed but does not feed the
 * combined figures. Peer rows are as fresh as the last sync (`capturedAt`).
 */
export async function getFleetClaudeCodeModels({ from = null, to = null, apiBilledInstanceIds = [] } = {}) {
  const { self, peers } = await entriesWithSelf();
  const apiBilled = new Set(Array.isArray(apiBilledInstanceIds) ? apiBilledInstanceIds : []);
  const row = (e, isSelf) => {
    const { models, totals } = summarizeTranscriptDays(e.claudeCode.days, { from, to });
    return { instanceId: e.instanceId, name: e.name || e.instanceId, self: isSelf, capturedAt: e.claudeCode.updatedAt, models, totals, usesSubscriptions: !apiBilled.has(e.instanceId) };
  };
  const instances = [
    ...(self?.claudeCode ? [row(self, true)] : []),
    ...peers.filter((e) => e.claudeCode).map((e) => row(e, false)),
  ];
  const combined = mergeModelRows(instances.filter((i) => i.usesSubscriptions).map((i) => i.models));
  // Peers we know of that published no history (older build, or not scanned yet)
  // — named so the UI can say why they are missing rather than dropping them.
  const pending = peers.filter((e) => !e.claudeCode).map((e) => e.name || e.instanceId);
  return { instances, pendingInstances: pending, ...combined };
}

/**
 * Every OTHER instance's last-known subscription-quota readings, for unifying
 * them with this machine's cards (`lib/fleetQuotas.js`).
 *
 * `excludeInstanceIds` drops instances the viewer marked as paying API rates
 * rather than riding their subscriptions — the same toggle the Across
 * Instances card uses. Those machines meter a different account, so folding
 * their readings into these meters would be a wrong number, not a fuller one.
 */
export async function getFleetQuotaEntries({ excludeInstanceIds = [] } = {}) {
  const { peers } = await entriesWithSelf();
  const excluded = new Set(Array.isArray(excludeInstanceIds) ? excludeInstanceIds : []);
  return peers
    .filter((e) => !excluded.has(e.instanceId) && e.quotas?.length)
    .map(({ instanceId, name, capturedAt, quotas }) => ({ instanceId, name, capturedAt, quotas }));
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
  if (!isNonBlankStr(instanceId)) return { removed: false };
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
// instances file is in the set because the manifest is keyed by this instance's
// ID — a re-identified machine must re-checksum even when no counter moved.
export const USAGE_CHECKSUM_PATHS = [USAGE_FILE, PEER_USAGE_FILE, PROVIDER_QUOTAS_FILE, TRANSCRIPT_USAGE_FILE, dataPath('instances.json')];

export { PEER_USAGE_FILE };

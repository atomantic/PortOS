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
import { stat } from 'fs/promises';
import { atomicWrite, readJSONFile, dataPath, PATHS } from '../lib/fileUtils.js';
import { isPlainObject, POLLUTING_KEYS } from '../lib/objects.js';
import { createMutex } from '../lib/asyncMutex.js';
import { compareNewerWins, parseTsMs } from '../lib/lwwTimestamp.js';
import { mergeTombstones, normalizeTombstones, recordTombstone, isTombstoned } from '../lib/tombstones.js';
import { canonicalSnapshotChecksum } from '../lib/snapshotChecksum.js';
import { roundCents } from '../lib/subscriptionSavings.js';
import { isFreeProvider } from '../lib/modelPricing.js';
import { familyForProvider, familyLabel, PROVIDER_FAMILY_IDS } from '../lib/providerFamilies.js';
import { sanitizeQuotaCards } from '../lib/fleetQuotas.js';
import { resolveEffectiveCategories } from '../lib/instanceSyncCategories.js';
import { buildUsageDigest, buildUsageReport, getUsage, providerVolumeSinceBlock, USAGE_FILE } from './usage.js';
import { readLocalQuotaCards, PROVIDER_QUOTAS_FILE } from './providerQuotaShare.js';
import { isNonBlankStr } from '../lib/textUtils.js';
import { readLocalTranscriptUsage, sanitizeTranscriptDays, TRANSCRIPT_USAGE_FILE } from './claudeCodeTranscriptUsage.js';
import { summarizeTranscriptDays, mergeModelRows } from './claudeCodeModelReport.js';
import { getAllProviders } from './providers.js';
import { nativeUsageSignature, withNativeUsage } from './nativeUsageHistory.js';
import { readRenderReceipts, summarizeRenderReceipts } from './imageRenderUsage.js';

const PEER_USAGE_FILE = join(PATHS.data, 'peer-usage.json');
const PROVIDERS_FILE = join(PATHS.data, 'providers.json');
const IMAGE_RECEIPTS_DIR = join(PATHS.data, 'image-render-usage');
const MAX_IMAGE_RECEIPTS = 10000;

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

// The media units and long-context subsets are priced at read time (usage.js
// countFields), so a peer's digest has to carry them or its Grok/Antigravity
// images, video seconds and 200k-context premium vanish from the fleet report.
const COUNT_FIELDS = [
  'sessions', 'messages', 'tokens', 'tokensIn', 'tokensOut', 'cacheReadTokens', 'cacheWriteTokens',
  'longTokensIn', 'longTokensOut', 'longCacheReadTokens', 'longCacheWriteTokens',
  'images', 'videoSeconds', 'inputImages'
];

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
      if (!isNonBlankStr(model) || POLLUTING_KEYS.has(model)) continue;
      const trimmedModel = model.slice(0, 200);
      if (POLLUTING_KEYS.has(trimmedModel)) continue;
      out.byModel[trimmedModel] = sanitizeModelBucket(mRaw);
    }
  }
  return out;
}

function sanitizeActivityBucket(raw) {
  const out = takeCounts(raw, {});
  if (Array.isArray(raw?.hourlyActivity) && raw.hourlyActivity.length === 24) {
    out.hourlyActivity = raw.hourlyActivity.map((value) => Number.isSafeInteger(value) && value >= 0 ? value : 0);
  }
  if (isPlainObject(raw?.byProvider)) {
    out.byProvider = {};
    for (const [pid, pRaw] of Object.entries(raw.byProvider).slice(0, MAX_PROVIDERS_PER_BUCKET)) {
      if (!isNonBlankStr(pid) || POLLUTING_KEYS.has(pid)) continue;
      const trimmedPid = pid.slice(0, 200);
      if (POLLUTING_KEYS.has(trimmedPid)) continue;
      out.byProvider[trimmedPid] = sanitizeProviderBucket(pRaw);
    }
  }
  return out;
}

function sanitizeActivityMap(raw, keyRe, limit) {
  const out = {};
  if (!isPlainObject(raw)) return out;
  for (const [key, bucket] of Object.entries(raw).slice(0, limit)) {
    if (!keyRe.test(key) || POLLUTING_KEYS.has(key)) continue;
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
    selfVersion: isPlainObject(raw?.selfVersion) ? raw.selfVersion : null,
  };
}

/**
 * A peer's Claude Code per-day, per-model token history, or null when it sent
 * none (or an unorderable one). Rebuilt to the fixed day → model → counts shape.
 */
function sanitizeClaudeCode(raw) {
  if (!isPlainObject(raw) || !isPlainObject(raw.days) || parseTsMs(raw.updatedAt) === null) return null;
  const days = sanitizeTranscriptDays(raw.days);
  return { updatedAt: raw.updatedAt, days };
}

// Only a provider's accounting classification crosses the wire. Commands,
// endpoints, environment variables and credentials never leave this instance.
function sanitizeProviderClasses(raw) {
  if (!isPlainObject(raw)) return null;
  const out = {};
  for (const [id, value] of Object.entries(raw).slice(0, MAX_PROVIDERS_PER_BUCKET)) {
    if (!isNonBlankStr(id) || POLLUTING_KEYS.has(id) || !isPlainObject(value) || typeof value.free !== 'boolean') continue;
    if (value.family !== null && !PROVIDER_FAMILY_IDS.includes(value.family)) continue;
    out[id.slice(0, 200)] = { free: value.free, family: value.family };
  }
  return out;
}

// Only stable hashed identities and accounting evidence cross the wire. A
// capped or malformed projection is explicitly partial, never an empty set.
function sanitizeImageReceipts(raw) {
  if (!isPlainObject(raw) || !Array.isArray(raw.receipts)) return null;
  const receipts = [];
  let complete = raw.complete === true && raw.receipts.length <= MAX_IMAGE_RECEIPTS;
  for (const item of raw.receipts.slice(0, MAX_IMAGE_RECEIPTS)) {
    if (!/^[a-f0-9]{64}$/.test(item?.id || '') || !/^[a-f0-9]{64}$/.test(item?.renderKey || '')
      || typeof item.occurredAt !== 'string' || parseTsMs(item.occurredAt) === null
      || new Date(item.occurredAt).toISOString() !== item.occurredAt
      || !['codex-session', 'portos-job'].includes(item.identitySource)
      || (item.driverTotal !== null && (!Number.isSafeInteger(item.driverTotal) || item.driverTotal < 0))) {
      complete = false;
      continue;
    }
    receipts.push({ id: item.id, renderKey: item.renderKey, occurredAt: item.occurredAt, identitySource: item.identitySource, driverTotal: item.driverTotal });
  }
  return { complete, receipts };
}

function sanitizeBlocks(raw) {
  if (!Array.isArray(raw)) return null;
  const selected = raw.slice(-200);
  const events = selected.flatMap((block) => {
    const providerId = str(block?.providerId, 200);
    if (!providerId || !Number.isSafeInteger(block?.at) || block.at < 0 || block.at > 8640000000000000) return [];
    return [{ providerId, model: str(block.model, 200), at: block.at }];
  });
  return events.length === selected.length ? events : null;
}

let imageProjectionMemo = null;
async function readImageProjection(directoryStat) {
  const stamp = directoryStat ? `${directoryStat.ino}:${directoryStat.mtimeMs}:${directoryStat.size}` : 'missing';
  if (imageProjectionMemo?.stamp === stamp) return imageProjectionMemo.projection;
  const receipts = await readRenderReceipts({ directory: IMAGE_RECEIPTS_DIR });
  receipts.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id));
  const projection = { complete: receipts.length <= MAX_IMAGE_RECEIPTS, receipts: receipts.slice(0, MAX_IMAGE_RECEIPTS).map((receipt) => ({
    id: receipt.id, renderKey: receipt.renderKey, occurredAt: receipt.occurredAt, identitySource: receipt.identitySource,
    driverTotal: receipt.driverTokens?.reportedTotal ?? null,
  })) };
  imageProjectionMemo = { stamp, projection };
  return projection;
}

async function listProviderConfigs() {
  const data = await getAllProviders().catch(() => null);
  const providers = Array.isArray(data) ? data : data?.providers;
  return Array.isArray(providers) ? providers : [];
}

async function readProviderClasses() {
  const data = await getAllProviders().catch(() => null);
  const providers = Array.isArray(data) ? data : data?.providers;
  if (!Array.isArray(providers)) return null;
  return sanitizeProviderClasses(Object.fromEntries(providers.filter((provider) => isNonBlankStr(provider.id))
    .map((provider) => [provider.id, { free: isFreeProvider(provider), family: familyForProvider(provider) }])));
}

// Pair a projection with a stable file generation; a concurrent save must not
// publish old contents under the new generation and then remain stuck there.
const fileStamp = (info) => info ? `${info.ino}:${info.mtimeMs}:${info.size}` : 'missing';
async function optionalStat(path) {
  return stat(path).catch((err) => { if (err.code === 'ENOENT') return null; throw err; });
}
async function stableProjection(path, read) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await optionalStat(path);
    const value = await read(before);
    const after = await optionalStat(path);
    if (fileStamp(before) === fileStamp(after)) return { value, info: after };
  }
  throw new Error('Usage projection changed while reading');
}

// The manifest protocol and older peers compare millisecond timestamps only.
// Persist just the self projection's version in the existing peer store so a
// projection-only update advances the slot even after an upgrade or restart.
async function versionSelfProjection(projection, componentTimes) {
  const fingerprint = canonicalSnapshotChecksum(projection);
  return withLock(async () => {
    const store = await readStore();
    const previous = store.selfVersion;
    if (previous?.instanceId === projection.instanceId && previous.fingerprint === fingerprint && parseTsMs(previous.capturedAt) !== null) return previous.capturedAt;
    const latest = Math.max(Date.now(), parseTsMs(previous?.capturedAt) ?? 0, ...componentTimes.map((time) => parseTsMs(time) ?? 0));
    const capturedAt = new Date(latest + 1).toISOString();
    store.selfVersion = { instanceId: projection.instanceId, fingerprint, capturedAt };
    await atomicWrite(PEER_USAGE_FILE, store);
    return capturedAt;
  });
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
    quotaReported: entry.quotaReported === true,
    // Optional and additive, like `quotas`: a peer on an older build publishes
    // no Claude Code token history and simply contributes nothing to that report.
    claudeCode: sanitizeClaudeCode(entry.claudeCode),
    providerClasses: sanitizeProviderClasses(entry.providerClasses),
    imageReceipts: sanitizeImageReceipts(entry.imageReceipts),
    blockEvents: sanitizeBlocks(entry.blockEvents),
  };
}

// The self digest is a pure function of (usage counters, today's date) — the
// date because the wire rollup's cutoff moves at midnight. `saveUsage` stamps
// `lastUpdated` on every write, so it doubles as the cache key. Without this
// memo the deep clone + rollup re-ran on every checksum-cache miss AND once per
// probing peer, all producing the identical byte-for-byte digest.
let digestMemo = null;
function selfDigest(usageData) {
  const key = `${usageData?.lastUpdated ?? ''}|${nativeUsageSignature()}|${new Date().toISOString().slice(0, 10)}`;
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
const withSelfCapture = createMutex();
async function buildSelfEntry() {
  return withSelfCapture(async () => {
    const { instanceId, name } = await readSelfIdentity();
    if (!instanceId) return null;
    // Peers receive this machine's report as its own Usage page reads it: the
    // provider apps' history in place of the ledger's counts for them.
    const usage = selfDigest(withNativeUsage(getUsage(), await listProviderConfigs()));
    const [{ quotas, capturedAt: quotasAt, reported: quotaReported }, providerResult, imageResult] = await Promise.all([
      readLocalQuotaCards(),
      stableProjection(PROVIDERS_FILE, readProviderClasses).catch(() => ({ value: null, info: null })),
      stableProjection(IMAGE_RECEIPTS_DIR, readImageProjection).catch(() => ({ value: null, info: null })),
    ]);
    const { value: providerClasses, info: providerStat } = providerResult;
    const { value: imageReceipts, info: imageStat } = imageResult;
    // An unreadable store publishes no history rather than failing every sync read.
    const local = await readLocalTranscriptUsage().catch(() => null);
    const claudeCode = local?.updatedAt ? local : null;
    // capturedAt is the LWW stamp AND manifest fingerprint: the newest of every
    // component, so a transcript-store refresh alone still gets pulled by peers.
    const blockEvents = sanitizeBlocks(getUsage()?.blockEvents);
    const projection = { instanceId, name: name || instanceId, usage, quotas, quotaReported, ...(claudeCode && { claudeCode }), ...(providerClasses && { providerClasses }), ...(imageReceipts && { imageReceipts }), ...(blockEvents && { blockEvents }) };
    const capturedAt = await versionSelfProjection(projection, [usage.lastUpdated, quotasAt, claudeCode?.updatedAt, providerStat?.mtime?.toISOString(), imageStat?.mtime?.toISOString()]);
    return { ...projection, capturedAt };
  });
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
  // A peer still running the retired cutover barrier (#15098) stamps `cutover` on
  // a payload only while it holds a fence or an epoch. Its digests then belong to
  // a cutover this version never joins, so the whole payload is skipped.
  if (isPlainObject(remoteData?.cutover)) return { applied: false, count: 0 };
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
  totals.estimatedCost = roundCents(totals.rawEstimatedCost ?? totals.estimatedCost ?? 0);
  totals.costIncomplete = rows.some((row) => row.totals?.costIncomplete);
  return totals;
}

// Daily histograms were added after the original lifetime-only counter. Keep
// the available observations and explicitly flag days that predate them.
function fleetHourlyActivity(sources, { from, to }) {
  const hourly = Array(24).fill(0);
  let incomplete = false;
  const representedSessions = (bucket) => Math.max(bucket.sessions || 0, Object.values(bucket.byProvider || {}).reduce((sum, provider) => sum + (provider.sessions || 0), 0));
  for (const { activity } of sources) {
    if (!from && !to) {
      const values = Array.isArray(activity.hourlyActivity) ? activity.hourlyActivity : [];
      for (let hour = 0; hour < 24; hour++) hourly[hour] += values[hour] || 0;
      const bucketSessions = [...Object.values(activity.dailyActivity || {}), ...Object.values(activity.monthlyActivity || {})]
        .reduce((sum, bucket) => sum + representedSessions(bucket), 0);
      if (values.reduce((sum, n) => sum + (n || 0), 0) < Math.max(activity.totalSessions || 0, bucketSessions)) incomplete = true;
      continue;
    }
    for (const [day, bucket] of Object.entries(activity.dailyActivity || {})) {
      if ((from && day < from) || (to && day > to)) continue;
      const values = Array.isArray(bucket.hourlyActivity) ? bucket.hourlyActivity : [];
      for (let hour = 0; hour < 24; hour++) hourly[hour] += values[hour] || 0;
      if (values.reduce((sum, n) => sum + (n || 0), 0) < representedSessions(bucket)) incomplete = true;
    }
    for (const [month, bucket] of Object.entries(activity.monthlyActivity || {})) {
      if ((!from || month >= from.slice(0, 7)) && (!to || month <= to.slice(0, 7)) && representedSessions(bucket) > 0) incomplete = true;
    }
  }
  return { hourly, incomplete };
}

// The billing toggle answers a different question: API-billed peers can still
// participate in usage sync. Only an explicitly disabled peer or its effective
// usage category removes the expectation of a fresh report. A forwarded digest
// with no local peer configuration remains an expected source.
async function usageParticipation() {
  const { loadData } = await import('./instanceIdentity.js');
  const configured = (await loadData()).peers || [];
  const participating = configured.filter((peer) => peer.enabled !== false && resolveEffectiveCategories(peer).usage);
  const notParticipating = configured.filter((peer) => peer.enabled === false || !resolveEffectiveCategories(peer).usage);
  // A newly added peer can have no ID until its first probe. Never let one
  // such opt-out suppress a different unprobed peer or a forwarded snapshot.
  // Several configured routes can also name one instance: any active route
  // means that instance is expected to report.
  const activeIds = new Set(participating.map((peer) => peer.instanceId).filter(isNonBlankStr));
  const optedOut = new Set(notParticipating.map((peer) => peer.instanceId).filter((id) => isNonBlankStr(id) && !activeIds.has(id)));
  return { participating, notParticipating, optedOut };
}

const peerLabel = (peer) => peer.name || peer.host || peer.instanceId || 'Unnamed instance';

function distinctPeerInstances(peers) {
  const seen = new Set();
  return peers.filter((peer) => {
    if (!isNonBlankStr(peer.instanceId)) return true;
    if (seen.has(peer.instanceId)) return false;
    seen.add(peer.instanceId);
    return true;
  });
}

// Diagnostics use the exact per-origin report rows, never another machine's config.
function classificationGapsFor(source, report) {
  return report.providers.filter((row) => row.classificationKnown === false
    && (row.observations?.from || row.observations?.hasUndatedUsage)).map((row) => ({
    instanceId: source.instanceId, instanceName: source.name || source.instanceId,
    self: source.isSelf, capturedAt: source.capturedAt || null,
    providerId: row.id, providerName: row.name,
    models: row.models.map((model) => model.model).sort(),
    tokens: reportTokens(row), sessions: row.sessions,
    ...row.observations,
    reason: row.id === 'legacy' ? 'legacy-unattributed'
      : source.providerClasses == null ? 'classification-not-reported' : 'provider-not-configured',
  }));
}

export async function getFleetUsage({ from = null, to = null, providers = [], apiBilledInstanceIds = [] } = {}) {
  const { self, peers } = await entriesWithSelf();
  const localIdentity = self || await readSelfIdentity();

  // Instances the viewer marked as paying API rates (not subscriptions). They
  // stay in `instances` so the spend is still visible, but they do not feed
  // the combined total. Default ON (not in the set) — a missing id counts.
  const apiBilled = new Set(Array.isArray(apiBilledInstanceIds) ? apiBilledInstanceIds : []);
  const localTranscript = self ? self.claudeCode : await readLocalTranscriptUsage().catch(() => null);

  const localClasses = Object.fromEntries(providers.map((provider) => [provider.id, { free: isFreeProvider(provider), family: familyForProvider(provider) }]));
  const sources = [
    { instanceId: localIdentity?.instanceId || 'local', name: localIdentity?.name || 'This machine', capturedAt: self?.capturedAt, activity: withNativeUsage(getUsage(), providers) || {}, transcript: localTranscript?.days, providerClasses: localClasses, isSelf: true },
    ...peers.map((entry) => ({ ...entry, activity: entry.usage, transcript: entry.claudeCode?.days, providerClasses: entry.providerClasses, isSelf: false })),
  ];
  const reportSource = ({ activity, providerClasses }) => ({
    dailyActivity: activity.dailyActivity || {},
    monthlyActivity: dropPartiallyCoveredMonths(activity.monthlyActivity, from, to),
    totalTokens: from || to ? null : activity.totalTokens,
    totalSessions: from || to ? null : activity.totalSessions,
    totalMessages: from || to ? null : activity.totalMessages,
    providerClasses,
  });
  const reportFor = (entries, includeObservations = false) => {
    const [first = {}, ...additionalSources] = entries.map(reportSource);
    return buildUsageReport(first.dailyActivity || {}, {
      from,
      to,
      providers,
      monthlyActivity: first.monthlyActivity,
      totalTokens: first.totalTokens,
      totalSessions: first.totalSessions,
      totalMessages: first.totalMessages,
      providerClasses: first.providerClasses,
      additionalSources,
      includeObservations,
    });
  };
  const sourceReports = new Map(sources.map((source) => [source.instanceId, reportFor([source], true)]));
  const row = ({ instanceId, name, capturedAt, activity, isSelf }) => {
    const report = sourceReports.get(instanceId);
    return {
      instanceId,
      name: name || instanceId,
      self: isSelf,
      // The digest's stamp, not the ledger's lastUpdated: since the native
      // history became the source of truth for coding-app tokens, a peer can
      // ship fresh counts hours after its last ledger write.
      capturedAt: capturedAt || activity.lastUpdated,
      totals: report.totals,
      usesSubscriptions: !apiBilled.has(instanceId),
    };
  };

  const rows = sources.map(row);

  rows.sort((a, b) => (b.self ? 1 : 0) - (a.self ? 1 : 0) || b.totals.estimatedCost - a.totals.estimatedCost);

  const included = rows.filter((r) => r.usesSubscriptions);
  const { participating, notParticipating, optedOut } = await usageParticipation();
  const known = new Set(sources.map((source) => source.instanceId));
  const missingPeers = distinctPeerInstances(participating.filter((peer) => !known.has(peer.instanceId)));
  const missingInstances = missingPeers.map(peerLabel);
  const notSyncingInstances = distinctPeerInstances(notParticipating.filter((peer) => optedOut.has(peer.instanceId) && known.has(peer.instanceId))).map(peerLabel);
  const expectedPeers = peers.filter((peer) => !optedOut.has(peer.instanceId));
  const incompleteMonthsFor = (entries) => [...new Set(entries.flatMap(({ activity }) => {
    const months = activity.monthlyActivity || {};
    const covered = dropPartiallyCoveredMonths(months, from, to);
    return Object.keys(months).filter((month) => !covered[month]
      && (!from || month >= from.slice(0, 7)) && (!to || month <= to.slice(0, 7)));
  }))].sort();
  const incompleteMonths = incompleteMonthsFor(sources);
  const subscriptionSources = sources.filter((source) => !apiBilled.has(source.instanceId));
  const subscriptionIncomplete = missingPeers.some((peer) => !apiBilled.has(peer.instanceId))
    || incompleteMonthsFor(subscriptionSources).length > 0;
  const report = reportFor(sources);
  const hourly = fleetHourlyActivity(sources, { from, to });
  const localImage = self ? sanitizeImageReceipts(self.imageReceipts) : await stat(IMAGE_RECEIPTS_DIR).catch(() => null)
    .then(readImageProjection).then(sanitizeImageReceipts).catch(() => null);
  const imageSources = [localImage, ...peers.map((peer) => peer.imageReceipts)];
  const imageRenders = summarizeRenderReceipts(imageSources.flatMap((source) => (source?.receipts || []).map((receipt) => ({
    ...receipt, driverTokens: receipt.driverTotal === null ? null : { reportedTotal: receipt.driverTotal, source: 'codex-cli-footer' },
  }))), { from, to });
  imageRenders.scope = 'federated-codex-saved-renders';
  // A missing projection from an opted-out peer is not an expected report.
  // A projection explicitly marked partial, or a conflict in retained data,
  // still describes a real gap in the historical observations we include.
  imageRenders.incomplete = !localImage?.complete
    || expectedPeers.some((peer) => !peer.imageReceipts?.complete)
    || peers.some((peer) => optedOut.has(peer.instanceId) && peer.imageReceipts && !peer.imageReceipts.complete)
    || missingInstances.length > 0 || imageRenders.conflicts;
  const localBlockProjection = sanitizeBlocks(getUsage()?.blockEvents);
  const localBlocks = localBlockProjection?.map((event, index) => ({
    ...event, resetHint: str(getUsage().blockEvents.slice(-200)[index]?.resetHint, 120),
  }));
  const blockSources = [{ name: localIdentity?.name || 'This instance', activity: getUsage(), events: localBlocks },
    ...peers.map((peer) => ({ name: peer.name || peer.instanceId, activity: peer.usage, events: peer.blockEvents }))];
  const blocks = blockSources.flatMap(({ name, activity, events }) => (events || []).flatMap((event) => {
    const day = new Date(event.at).toISOString().slice(0, 10);
    if ((from && day < from) || (to && day > to)) return [];
    const daily = Object.fromEntries(Object.entries(activity.dailyActivity || {}).filter(([key]) => !to || key <= to));
    const monthly = dropPartiallyCoveredMonths(activity.monthlyActivity, null, to);
    return [{ ...event, originName: name, volumeSince: providerVolumeSinceBlock(daily, monthly, event.providerId, day) }];
  })).sort((a, b) => b.at - a.at).slice(0, 20);
  const subscriptionReport = reportFor(subscriptionSources);
  const activity = fleetPeriodActivity(sources, { from, to });
  if (!from && !to) {
    const undated = report.totals.sessions - activity.reduce((sum, item) => sum + item.sessions, 0);
    if (undated > 0) activity.push({ date: 'undated', label: 'Undated', sessions: undated });
  }
  return {
    instances: peers.length ? rows : [],
    totals: peers.length ? sumFleetTotals(included) : null,
    report,
    subscriptionReport,
    imageRenders,
    blocks,
    firstActivityDay: earliestDay(sources.map(({ activity }) => ({ daily: activity.dailyActivity, monthly: activity.monthlyActivity }))),
    subscriptionFirstActivityDay: earliestDay(subscriptionSources
      .map(({ activity }) => ({ daily: activity.dailyActivity, monthly: activity.monthlyActivity }))),
    activity,
    last7Days: fleetPeriodActivity(sources, { from: utcDay(Date.now() - 6 * DAY_MS), to: utcDay(Date.now()) })
      .map((day) => ({ ...day, label: new Date(`${day.date}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }) })),
    totalToolCalls: from || to ? null : sources.reduce((sum, source) => sum + (source.activity.totalToolCalls || 0), 0),
    monthly: fleetPeriodMonthly(sources, { from, to }, providers),
    transcriptUpdatedAt: localTranscript?.updatedAt || null,
    hourlyActivity: hourly.hourly,
    coverage: {
      range: { from, to },
      classificationGaps: sources.flatMap((source) => classificationGapsFor(source, sourceReports.get(source.instanceId))),
      instanceCount: sources.length, missingInstances, notSyncingInstances, incompleteMonths, subscriptionIncomplete,
      pricingIncomplete: Boolean(report.totals.costIncomplete),
      hourlyIncomplete: hourly.incomplete || missingInstances.length > 0,
      classificationUnreported: peers.filter((entry) => !entry.providerClasses
        && (!optedOut.has(entry.instanceId) || sourceReports.get(entry.instanceId).totals.costIncomplete))
        .map((entry) => entry.name || entry.instanceId),
      blockEventsUnreported: [...(!localBlockProjection ? [localIdentity?.name || 'This instance'] : []),
        ...expectedPeers.filter((entry) => !entry.blockEvents).map((entry) => entry.name || entry.instanceId)],
      transcriptUnreported: expectedPeers.filter((entry) => !entry.claudeCode).map((entry) => entry.name || entry.instanceId),
    },
  };
}

function fleetPeriodMonthly(sources, { from, to }, providers) {
  const histories = sources.map(({ activity, transcript, providerClasses }) => ({
    daily: activity.dailyActivity || {}, monthly: dropPartiallyCoveredMonths(activity.monthlyActivity, from, to), transcript: transcript || {}, providerClasses,
  }));
  const first = earliestDay(histories);
  if (!first) return { instanceCount: sources.length, series: [], history: [] };
  const start = from || first;
  const end = to || utcDay(Date.now());
  if (start > end) return { instanceCount: sources.length, series: [], history: [] };
  const monthNumber = (day) => Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1;
  const firstMonth = monthNumber(start);
  const lastMonth = monthNumber(end);
  // A corrupt or extreme date range must not allocate an unbounded chart.
  if (lastMonth - firstMonth > 1200) return { instanceCount: sources.length, series: [], history: [], rangeTooWide: true };
  const labels = new Map();
  const rows = [];
  for (let value = firstMonth; value <= lastMonth; value++) {
    const year = Math.floor(value / 12);
    const number = (value % 12) + 1;
    const month = `${String(year).padStart(4, '0')}-${String(number).padStart(2, '0')}`;
    const last = new Date(dayMs(`${month}-01`) + 31 * DAY_MS);
    last.setUTCDate(0);
    const monthEnd = last.toISOString().slice(0, 10);
    const beginDay = start > `${month}-01` ? start : `${month}-01`;
    const endDay = end < monthEnd ? end : monthEnd;
    const span = Array.from({ length: Math.floor((dayMs(endDay) - dayMs(beginDay)) / DAY_MS) + 1 }, (_, i) => utcDay(dayMs(beginDay) + i * DAY_MS));
    const costs = {};
    let tokens = 0;
    for (const history of histories) {
      for (const usage of instanceDailyUsage(history, span, providers, labels)) {
        addInto(costs, usage.costs);
        tokens += usage.tokens;
      }
    }
    rows.push({ month, costs, tokens, partial: beginDay !== `${month}-01` || endDay !== monthEnd });
  }
  const { series, values } = stackCosts(rows.map((row) => row.costs), labels);
  return {
    instanceCount: sources.length,
    series,
    history: rows.map((row, index) => ({
      month: row.month,
      estimatedCost: roundCents(values[index].reduce((sum, value) => sum + value, 0)),
      values: values[index].map(roundCents),
      tokens: Math.round(row.tokens),
      partial: row.partial,
    })),
  };
}

// Short windows show days, long windows show months. Rolled-up months clipped
// by the selected range are omitted and separately reported as incomplete.
function fleetPeriodActivity(sources, { from, to }) {
  const end = to || new Date().toISOString().slice(0, 10);
  const hasMonthlyBuckets = sources.some(({ activity }) => Object.keys(dropPartiallyCoveredMonths(activity.monthlyActivity, from, to))
    .some((month) => (!from || month >= from.slice(0, 7)) && (!to || month <= to.slice(0, 7))));
  const daily = from && dayMs(end) >= dayMs(from) && dayMs(end) - dayMs(from) <= 31 * DAY_MS && !hasMonthlyBuckets;
  const sessionsIn = (bucket) => Math.max(bucket.sessions || 0,
    Object.values(bucket.byProvider || {}).reduce((sum, provider) => sum + (provider.sessions || 0), 0));
  const counts = new Map();
  const add = (key, bucket) => {
    const current = counts.get(key) || { sessions: 0, messages: 0, tokens: 0 };
    current.sessions += sessionsIn(bucket);
    current.messages += bucket.messages || 0;
    current.tokens += bucket.tokens || 0;
    counts.set(key, current);
  };
  if (daily) {
    for (let ms = dayMs(from); ms <= dayMs(end); ms += DAY_MS) counts.set(utcDay(ms), { sessions: 0, messages: 0, tokens: 0 });
  }
  for (const { activity } of sources) {
    for (const [day, bucket] of Object.entries(activity.dailyActivity || {})) {
      if ((from && day < from) || (to && day > to) || (daily && day > end)) continue;
      const key = daily ? day : day.slice(0, 7);
      add(key, bucket);
    }
    if (!daily) {
      for (const [month, bucket] of Object.entries(dropPartiallyCoveredMonths(activity.monthlyActivity, from, to))) {
        if ((from && month < from.slice(0, 7)) || (to && month > to.slice(0, 7))) continue;
        add(month, bucket);
      }
    }
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, label: daily ? date.slice(5) : date, ...count }));
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
function reportFamily(row) {
  return row.classificationKnown === false ? null : row.family;
}

function costByGroup(report, labels, providers) {
  const out = {};
  for (const row of report.providers) {
    const cost = row.rawEstimatedCost ?? row.estimatedCost;
    if (!(cost > 0)) continue;
    const family = reportFamily(row, providers);
    const key = family || `provider:${row.id}`;
    if (!labels.has(key)) labels.set(key, family ? familyLabel(family) : row.name || row.id);
    out[key] = (out[key] || 0) + cost;
  }
  return out;
}

const addInto = (target, source, scale = 1) => {
  if (!isPlainObject(source)) return;
  for (const [key, cost] of Object.entries(source)) {
    if (POLLUTING_KEYS.has(key)) continue;
    target[key] = (Object.hasOwn(target, key) && typeof target[key] === 'number' ? target[key] : 0) + cost * scale;
  }
};

const reportTokens = (row) => row.tokensIn + row.tokensOut + row.cacheReadTokens + row.cacheWriteTokens;

function dailyUsage(report, labels, providers) {
  return {
    costs: costByGroup(report, labels, providers),
    tokens: reportTokens(report.totals),
    claudeTokens: report.providers.reduce((sum, row) => sum + (reportFamily(row, providers) === 'claude' ? reportTokens(row) : 0), 0),
  };
}

/**
 * Estimated API cost per day for one instance over `span`, split by plan, each
 * day priced on its own through the same `buildUsageReport` as the cost report
 * so the series and the headline agree.
 *
 * Old days survive only as month buckets (a peer's digest rolls up after 120
 * days, this machine's history after 400), so a month bucket's cost is spread
 * evenly over that month's days that no longer have a day bucket. The month's
 * total is exact; its shape within the month is not.
 *
 * Claude Code use outside PortOS also comes from the instance's transcript
 * history (see `withTranscriptClaude`).
 */
function instanceDailyUsage({ daily = {}, monthly = {}, transcript = {}, providerClasses = undefined }, span, providers, labels) {
  const missingDays = new Map();
  for (const day of span) {
    const month = day.slice(0, 7);
    if (!daily[day] && monthly[month]) missingDays.set(month, (missingDays.get(month) || 0) + 1);
  }
  const monthShare = new Map();
  const monthSupplement = new Map();
  for (const [month, count] of missingDays) {
    const report = buildUsageReport({}, { monthlyActivity: { [month]: monthly[month] }, providers, providerClasses });
    // Days of the month outside the span still carry their share, so divide by
    // every rolled-up day of the month, not only the `count` in view.
    const [y, m] = month.split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const rolledDays = daysInMonth - Object.keys(daily).filter((d) => d.startsWith(`${month}-`)).length;
    const divisor = Math.max(rolledDays, count);
    const usage = dailyUsage(report, labels, providers);
    const costs = {};
    addInto(costs, usage.costs, 1 / divisor);
    monthShare.set(month, { costs, tokens: usage.tokens / divisor, claudeTokens: usage.claudeTokens / divisor });
    // A rollup containing only other providers cannot overlap Claude
    // transcripts; preserve their exact day instead of spreading them.
    if (!(usage.claudeTokens > 0) && !(usage.costs.claude > 0)) continue;
    // The rollup no longer says which day contained a run. Compare its full
    // month with transcripts before spreading any excess, or a transcript on
    // one day would be added to the same rollup spread over the other days.
    const first = `${month}-01`;
    const last = utcDay(dayMs(first) + (daysInMonth - 1) * DAY_MS);
    const ledger = dailyUsage(buildUsageReport(daily, { from: first, to: last, monthlyActivity: { [month]: monthly[month] }, providers, providerClasses }), labels, providers);
    const observed = summarizeTranscriptDays(transcript, { from: first, to: last }).totals;
    const extraCost = Math.max(0, (observed.rawEstimatedCost ?? observed.estimatedCost ?? 0) - (ledger.costs.claude || 0));
    const extraTokens = Math.max(0, (observed.total || 0) - ledger.claudeTokens);
    if (extraCost && !labels.has('claude')) labels.set('claude', familyLabel('claude'));
    monthSupplement.set(month, { cost: extraCost / daysInMonth, tokens: extraTokens / daysInMonth });
  }
  return span.map((day) => {
    const usage = daily[day]
      ? dailyUsage(buildUsageReport({ [day]: daily[day] }, { from: day, to: day, providers, providerClasses }), labels, providers)
      : monthShare.get(day.slice(0, 7)) || { costs: {}, tokens: 0, claudeTokens: 0 };
    const supplement = monthSupplement.get(day.slice(0, 7));
    if (supplement) {
      const costs = { ...usage.costs };
      if (supplement.cost) costs.claude = (costs.claude || 0) + supplement.cost;
      return { costs, tokens: usage.tokens + supplement.tokens };
    }
    const transcriptTotals = transcript[day] && summarizeTranscriptDays({ [day]: transcript[day] }).totals;
    return {
      costs: withTranscriptClaude({ ...usage.costs }, transcriptTotals?.rawEstimatedCost ?? transcriptTotals?.estimatedCost, labels),
      // Transcript sessions overlap the Claude ledger; reconcile tokens by the
      // same per-day maximum as cost, retaining every other provider's tokens.
      tokens: usage.tokens + Math.max(0, (transcriptTotals?.total || 0) - usage.claudeTokens),
    };
  });
}

/**
 * The Claude Code CLI's own transcripts count every session on the machine —
 * the terminal, the desktop app's Code tab, AND the runs PortOS spawned. The
 * ledger holds PortOS runs (with native history overlaid where the store
 * covers it, see nativeUsageOverlay.js), so each can be a partial view of the
 * same spend. Day-level history uses the larger value; a rolled-up month is
 * reconciled over that whole month.
 */
function withTranscriptClaude(costs, transcriptCost, labels) {
  if ((transcriptCost || 0) > (costs.claude || 0)) {
    if (!labels.has('claude')) labels.set('claude', familyLabel('claude'));
    costs.claude = transcriptCost;
  }
  return costs;
}

function earliestDay(sources) {
  let earliest = null;
  for (const { daily, monthly, transcript } of sources) {
    for (const day of [...Object.keys(daily || {}), ...Object.keys(transcript || {})]) if (!earliest || day < earliest) earliest = day;
    for (const month of Object.keys(monthly || {})) if (!earliest || `${month}-01` < earliest) earliest = `${month}-01`;
  }
  return earliest;
}

async function usageHistorySources(providers = []) {
  const { self, peers } = await entriesWithSelf();
  const local = withNativeUsage(getUsage(), providers);
  // An unreadable transcript store charts PortOS runs only rather than failing.
  const localTranscript = await readLocalTranscriptUsage().catch(() => null);
  // This machine always reads its live maps; with no minted identity yet it
  // still has its own history to chart.
  return [
    {
      id: self?.instanceId ?? 'local',
      instanceId: self?.instanceId ?? 'local', name: self?.name || 'This machine', isSelf: true,
      capturedAt: local?.lastUpdated || self?.capturedAt || null,
      stamp: [local?.lastUpdated, localTranscript?.updatedAt, nativeUsageSignature()],
      daily: local?.dailyActivity,
      monthly: local?.monthlyActivity,
      transcript: localTranscript?.days,
      providerClasses: Object.fromEntries(providers.map((provider) => [provider.id, { free: isFreeProvider(provider), family: familyForProvider(provider) }])),
    },
    ...peers.map((e) => ({
      id: e.instanceId,
      instanceId: e.instanceId, name: e.name || e.instanceId, isSelf: false, capturedAt: e.capturedAt,
      stamp: e.capturedAt,
      daily: e.usage.dailyActivity,
      monthly: e.usage.monthlyActivity,
      transcript: e.claudeCode?.days,
      providerClasses: e.providerClasses,
    })),
  ];
}

function stackCosts(rows, labels) {
  const totals = {};
  for (const costs of rows) addInto(totals, costs);
  const ranked = Object.keys(totals).sort((x, y) => totals[y] - totals[x]);
  const kept = ranked.length > MAX_COST_GROUPS ? ranked.slice(0, MAX_COST_GROUPS - 1) : ranked;
  const groupOf = new Map(ranked.map((key) => [key, kept.includes(key) ? key : OTHER_GROUP]));
  const series = kept.map((key) => ({ key, label: labels.get(key) }));
  if (kept.length < ranked.length) series.push({ key: OTHER_GROUP, label: 'Other' });
  const slot = new Map(series.map((g, i) => [g.key, i]));
  const values = rows.map((costs) => {
    const row = new Array(series.length).fill(0);
    for (const [key, cost] of Object.entries(costs)) row[slot.get(groupOf.get(key))] += cost;
    return row;
  });
  return { series, values };
}

/** Calendar months over the same fleet, ledger and transcript sources as rolling cost. */
export async function getFleetMonthlyUsage({ providers = [], now = new Date() } = {}) {
  const sources = await usageHistorySources(providers);
  const first = earliestDay(sources);
  if (!first) return { instanceCount: sources.length, series: [], history: [] };
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1)).getTime();
  const today = utcDay(now.getTime());
  const span = Array.from({ length: Math.floor((dayMs(today) - start) / DAY_MS) + 1 }, (_, i) => utcDay(start + i * DAY_MS));
  const months = new Map();
  for (const day of span) {
    if (day < first) continue;
    const month = day.slice(0, 7);
    if (!months.has(month)) months.set(month, { month, costs: {}, tokens: 0 });
  }
  const labels = new Map();
  for (const source of sources) {
    instanceDailyUsage(source, span, providers, labels).forEach((usage, i) => {
      const month = months.get(span[i].slice(0, 7));
      if (!month) return;
      addInto(month.costs, usage.costs);
      month.tokens += usage.tokens;
    });
  }
  const rows = [...months.values()];
  const { series, values } = stackCosts(rows.map((row) => row.costs), labels);
  const history = rows.map((row, i) => {
    const costs = values[i].map(roundCents);
    return {
      month: row.month,
      estimatedCost: roundCents(costs.reduce((sum, cost) => sum + cost, 0)),
      values: costs,
      tokens: Math.round(row.tokens),
      partial: row.month === today.slice(0, 7) || first > `${row.month}-01`,
    };
  });
  return { instanceCount: sources.length, series, history };
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
  const sources = await usageHistorySources(providers);

  const todayMs = dayMs(utcDay(now.getTime()));
  const rangeId = Object.hasOwn(ROLLING_COST_RANGES, range) ? range : '3m';
  const fixed = ROLLING_COST_RANGES[rangeId];
  const first = earliestDay(sources);
  const allPoints = first ? Math.floor((todayMs - dayMs(first)) / DAY_MS) + 1 : 2;
  const pointCount = Math.max(2, fixed ?? allPoints);
  const spanLength = pointCount + ROLLING_COST_WINDOW_DAYS - 1;
  const span = Array.from({ length: spanLength }, (_, i) => utcDay(todayMs - (spanLength - 1 - i) * DAY_MS));

  const participation = await usageParticipation();
  const key = JSON.stringify([participation.participating, [...participation.optedOut], rangeId, span[0], span.at(-1), sources.map((s) => [s.id, s.stamp]), providers.map((p) => [p.id, isFreeProvider(p), familyForProvider(p)])]);
  if (rollingMemo?.key === key) return rollingMemo.value;

  const labels = new Map();
  const perDay = span.map(() => ({}));
  for (const source of sources) {
    instanceDailyUsage(source, span, providers, labels).forEach(({ costs }, i) => addInto(perDay[i], costs));
  }

  // Per-day cost in series order, then a trailing-window sum per slot.
  const { series, values: daily } = stackCosts(perDay, labels);
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
  const diagnosticRange = { from: span[0], to: span.at(-1) };
  const reports = sources.map((source) => {
    // Rolling charts use a month bucket only on days without a daily bucket.
    // Report the observed bucket in full, rather than inventing exact run dates.
    const contributingMonths = new Set(span.filter((day) => !source.daily?.[day]).map((day) => day.slice(0, 7)));
    const monthlyActivity = Object.fromEntries(Object.entries(source.monthly || {}).filter(([month]) => contributingMonths.has(month)));
    return buildUsageReport(source.daily || {}, {
      ...diagnosticRange, providers, monthlyActivity, providerClasses: source.providerClasses,
      includeObservations: true,
    });
  });
  const pricingIncomplete = reports.some((report) => report.totals.costIncomplete);
  const { participating, optedOut } = participation;
  const known = new Set(sources.map((source) => source.instanceId));
  const expected = sources.filter((source) => !source.isSelf && !optedOut.has(source.instanceId));
  const coverage = {
    range: diagnosticRange, pricingIncomplete,
    classificationGaps: sources.flatMap((source, index) => classificationGapsFor(source, reports[index])),
    missingInstances: distinctPeerInstances(participating.filter((peer) => !known.has(peer.instanceId))).map(peerLabel),
    transcriptUnreported: expected.filter((source) => !source.transcript).map((source) => source.name),
    classificationUnreported: expected.filter((source) => !source.providerClasses).map((source) => source.name),
  };
  const value = { range: rangeId, windowDays: ROLLING_COST_WINDOW_DAYS, instanceCount: sources.length, series, points, pricingIncomplete, coverage };
  rollingMemo = { key, value };
  return value;
}

/**
 * Fleet-wide Claude Code tokens per model, priced at API rates, for a window.
 * One row per instance that has published transcript history (this machine
 * reads its live store), plus a combined per-model list. API-billed instances
 * still contribute to fleet-wide token totals. Peer rows are as fresh as their
 * last snapshot (`capturedAt`).
 */
export async function getFleetClaudeCodeModels({ from = null, to = null, apiBilledInstanceIds = [] } = {}) {
  const { self, peers } = await entriesWithSelf();
  const { optedOut } = await usageParticipation();
  const apiBilled = new Set(Array.isArray(apiBilledInstanceIds) ? apiBilledInstanceIds : []);
  const row = (e, isSelf) => {
    const { models, totals } = summarizeTranscriptDays(e.claudeCode.days, { from, to });
    return { instanceId: e.instanceId, name: e.name || e.instanceId, self: isSelf, capturedAt: e.claudeCode.updatedAt, models, totals, usesSubscriptions: !apiBilled.has(e.instanceId) };
  };
  const instances = [
    ...(self?.claudeCode ? [row(self, true)] : []),
    ...peers.filter((e) => e.claudeCode).map((e) => row(e, false)),
  ];
  const combined = mergeModelRows(instances.map((i) => i.models));
  // Peers we know of that published no history (older build, or not scanned yet)
  // — named so the UI can say why they are missing rather than dropping them.
  const pending = peers.filter((e) => !optedOut.has(e.instanceId) && !e.claudeCode).map((e) => e.name || e.instanceId);
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
export async function getFleetQuotaEntries({ excludeInstanceIds = [], includeEmpty = false } = {}) {
  const { peers } = await entriesWithSelf();
  const excluded = new Set(Array.isArray(excludeInstanceIds) ? excludeInstanceIds : []);
  const { participating, optedOut } = includeEmpty ? await usageParticipation() : { participating: [], optedOut: new Set() };
  const entries = peers
    .filter((e) => !excluded.has(e.instanceId) && (includeEmpty || e.quotas?.length))
    .map(({ instanceId, name, capturedAt, quotas, quotaReported }) => ({ instanceId, name, capturedAt, quotas,
      ...(includeEmpty ? { quotaReported, usageExpected: !optedOut.has(instanceId) } : {}) }));
  if (includeEmpty) {
    const known = new Set(entries.map((entry) => entry.instanceId));
    for (const peer of distinctPeerInstances(participating)) {
      if (known.has(peer.instanceId) || excluded.has(peer.instanceId)) continue;
      entries.push({ instanceId: peer.instanceId, name: peerLabel(peer), quotas: [], quotaReported: false, usageExpected: true });
    }
  }
  return entries;
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
export const USAGE_CHECKSUM_PATHS = [USAGE_FILE, PEER_USAGE_FILE, PROVIDER_QUOTAS_FILE, TRANSCRIPT_USAGE_FILE, PROVIDERS_FILE, IMAGE_RECEIPTS_DIR, dataPath('instances.json')];

export { PEER_USAGE_FILE };

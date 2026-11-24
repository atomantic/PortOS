/** Read-through federation of numeric app audit evidence; never exports prose or relays peers. */
import { PATHS } from '../lib/paths.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { query } from '../lib/db.js';
import { PORTOS_APP_ID } from '../lib/appIdentity.js';
import { AUDIT_EXECUTION_TASK_TYPES, LEGACY_AUDIT_TASK_TYPE_ALIASES, normalizeAuditTaskType } from '../lib/auditCatalog.js';
import { auditQualityReportSchema, historicalQualityReportSchema, AUDIT_FRESHNESS_MS, numericQualityReport, QUALITY_FEDERATION_MAX_REPOSITORIES } from '../lib/auditQuality.js';
import { PLATFORM_SCHEMA_VERSIONS } from '../lib/schemaVersions/platform.js';
import { getOriginInfo } from '../lib/gitRemote.js';
import { peerBaseUrl } from '../lib/peerUrl.js';
import { readBodyCapped } from '../lib/safeUrlFetch.js';
import { peerFetch } from '../lib/peerHttpClient.js';
import { releaseTieId } from './appQualitySnapshotFormat.js';

const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const sharedSummary = 'Numeric assessment shared by a federated instance; evidence remains on the source machine.';
const hash = value => createHash('sha256').update(value).digest('hex');
// A stored v2 (slice-scored) report travels as the v1 numeric shape: the wire
// contract is unchanged, so a peer that predates v2 reads the run score it
// already expects, and the slice text never leaves this machine (#12076).
const numericSchema = schema => z.preprocess(value => value && typeof value === 'object'
  ? { ...numericQualityReport(value), summary: sharedSummary } : value, schema)
  .transform(({ summary: _summary, ...report }) => report);
const numericReportSchema = numericSchema(auditQualityReportSchema);
const measurementSchema = z.object({
  measurementId: z.string().regex(/^[a-f0-9]{64}$/),
  assessedAt: z.string().datetime(),
  report: numericReportSchema,
}).strict();
const historicalMeasurementSchema = measurementSchema.extend({ report: numericSchema(historicalQualityReportSchema) });
// Rows are validated one by one (below), so a peer on a newer catalog that
// sends a category this install does not know costs that row, not the peer.
// Everything this install can parse, sent with each request so a peer on a
// newer catalog withholds categories this one would reject.
const READABLE_CATEGORY_PARAM = encodeURIComponent([
  ...AUDIT_EXECUTION_TASK_TYPES, ...Object.keys(LEGACY_AUDIT_TASK_TYPE_ALIASES),
].join(','));

const payloadSchema = z.object({
  schemaVersion: z.literal(PLATFORM_SCHEMA_VERSIONS.appQuality),
  repository: z.string().regex(/^[a-f0-9]{64}$/),
  measurements: z.array(z.unknown()).max(10000),
}).strict();

/**
 * The categories every install parsed before the catalog added the service and
 * data-platform lenses. An install that predates the `categories` request
 * parameter validates the whole payload strictly, so one row in a category it
 * does not know would make it drop EVERY measurement from this install. Such a
 * requester is sent only these. Frozen: a later catalog addition is announced by
 * the requester's own `categories` list, never by editing this one.
 */
export const FEDERATION_LEGACY_CATEGORIES = Object.freeze([
  'security', 'code-quality', 'test-coverage', 'performance', 'accessibility', 'documentation',
  'ui-bugs', 'mobile-responsive', 'error-handling', 'typing', 'console-errors', 'ux', 'data-safety',
  'simplify', 'module-hygiene', 'api-contract', 'ui-lifecycle', 'observability', 'copy',
  'better-complexity', 'better-cognitive-load', 'better-structural-drift', 'better-runtime-safety',
  'better-dependency-freedom', 'better-test-quality',
]);

// PortOS's own app record always carries a repoPath; the bare `{ id: PORTOS_APP_ID }`
// form used for self-directed calls resolves to this install's checkout.
const appRepoPath = app => app.repoPath || (app.id === PORTOS_APP_ID ? PATHS.root : null);

// One `git remote get-url` per checkout per window: the Apps page and every peer
// ask for the same repoPaths repeatedly. The expiry is absolute (set at lookup
// time, never refreshed on read) so a changed origin is picked up within the
// window. The in-flight promise is cached so concurrent callers share one spawn;
// a rejected lookup is dropped so the next caller retries.
const REPOSITORY_KEY_TTL_MS = 60_000;
const originLookups = new Map();

// Sweeping on each miss keeps the map to lookups from the last window; without it,
// a checkout path that is never requested again would stay for the process lifetime.
export function originLookupCacheSize() {
  return originLookups.size;
}

function cachedOriginInfo(repoPath) {
  const now = Date.now();
  const cached = originLookups.get(repoPath);
  if (cached && cached.expiresAt > now) return cached.promise;
  for (const [key, entry] of originLookups) {
    if (entry.expiresAt <= now) originLookups.delete(key);
  }
  const promise = getOriginInfo(repoPath);
  const entry = { promise, expiresAt: now + REPOSITORY_KEY_TTL_MS };
  originLookups.set(repoPath, entry);
  promise.catch(() => {
    if (originLookups.get(repoPath) === entry) originLookups.delete(repoPath);
  });
  return promise;
}

// Match repositories without sharing remote URLs, names, credentials or local paths.
// Independent versions of the same repository intentionally contribute to one score.
async function repositoryKey(deps, app = { id: PORTOS_APP_ID }) {
  const repoPath = appRepoPath(app);
  if (!repoPath) return null;
  // An injected lookup is a test seam; it bypasses the process-wide cache.
  const origin = await (deps.getOriginInfo ? deps.getOriginInfo(repoPath) : cachedOriginInfo(repoPath));
  return origin.host && origin.fullName ? hash(`${origin.host}/${origin.fullName}`.toLowerCase()) : null;
}

async function eligiblePeers(deps) {
  const { getPeers } = deps.getPeers ? deps : await import('./instances.js');
  const { peerAllowsOutbound } = await import('./sharing/peerSyncShared.js');
  return (await getPeers()).filter(peer => peerAllowsOutbound(peer));
}

export function qualityRecord(row) {
  return { category: normalizeAuditTaskType(row.category), agentId: row.agent_id,
    measurementId: hash(row.agent_id), assessedAt: new Date(row.assessed_at).toISOString(),
    report: row.report, slice: row.slice ?? null };
}

/** Daily category winners; null days reads all local history for publication. */
export async function readQualityRecords(appId, days, now, deps = {}) {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  if (days !== null) start.setUTCDate(start.getUTCDate() - days + 1);
  const result = await (deps.query || query)(
    `SELECT category, agent_id, assessed_at, report, slice FROM (
       SELECT category, agent_id, assessed_at, report, slice,
         rank() OVER (PARTITION BY category, (assessed_at AT TIME ZONE 'UTC')::date ORDER BY assessed_at DESC) AS run_rank
       FROM app_quality_measurements
       WHERE app_id = $1 AND ($2::timestamptz IS NULL OR assessed_at >= $2) AND assessed_at <= $3
     ) runs WHERE run_rank = 1 ORDER BY category, assessed_at DESC, agent_id DESC`,
    [appId, days === null ? null : new Date(start.getTime() - AUDIT_FRESHNESS_MS), new Date(now)]
  );
  return result.rows.map(qualityRecord);
}

async function appsByRepository(deps) {
  const { getAllApps } = deps.getAllApps ? deps : await import('./apps.js');
  const entries = await Promise.all((await getAllApps()).map(async app => [await repositoryKey(deps, app), app]));
  const byHash = new Map();
  for (const [repository, app] of entries) {
    if (repository && !byHash.has(repository)) byHash.set(repository, app);
  }
  return byHash;
}

function visibleMeasurements(snapshot, parseable) {
  return snapshot.measurements.filter(row => parseable.has(row.report.category));
}

/** New endpoint always enforces peer sharing consent, even without instance-password auth. */
export async function exportPortosQuality(callerId, days, deps = {}, requestedRepository, requesterCategories = FEDERATION_LEGACY_CATEGORIES, requestedRepositories) {
  const peers = await eligiblePeers(deps);
  if (!callerId || !peers.some(peer => peer.instanceId === callerId)) return null;
  const parseable = new Set(requesterCategories);
  // One lookup serves every requested app. A missing hash is null so the caller
  // can tell "this peer does not track that repo" from an empty measurement list.
  if (requestedRepositories?.length) {
    const wanted = [...new Set(requestedRepositories)].slice(0, QUALITY_FEDERATION_MAX_REPOSITORIES);
    const byHash = await appsByRepository(deps);
    const repositories = {};
    for (const hash of wanted) {
      const app = byHash.get(hash);
      const snapshot = app ? await buildQualitySnapshot(app, days, deps) : null;
      repositories[hash] = snapshot ? visibleMeasurements(snapshot, parseable) : null;
    }
    return { schemaVersion: PLATFORM_SCHEMA_VERSIONS.appQuality, repositories };
  }
  let app = { id: PORTOS_APP_ID };
  if (requestedRepository) {
    app = (await appsByRepository(deps)).get(requestedRepository);
    if (!app) return null;
  }
  const snapshot = await buildQualitySnapshot(app, days, deps);
  if (!snapshot) return snapshot;
  return { ...snapshot, measurements: visibleMeasurements(snapshot, parseable) };
}

/** Sanitized local evidence, also used by the explicit release snapshot command. */
export async function buildQualitySnapshot(app = { id: PORTOS_APP_ID }, days = 30, deps = {}) {
  const repository = await repositoryKey(deps, app);
  if (!repository) return null;
  const records = await readQualityRecords(app.id, days, deps.now ?? Date.now(), deps);
  const measurements = records.flatMap(record => {
    const schema = days === null ? historicalMeasurementSchema : measurementSchema;
    const parsed = schema.safeParse({ measurementId: record.measurementId,
      assessedAt: record.assessedAt, report: record.report });
    return parsed.success && parsed.data.report.category === record.category ? [parsed.data] : [];
  });
  return { schemaVersion: PLATFORM_SCHEMA_VERSIONS.appQuality, repository, measurements };
}

/** No persistence or forwarding: disabled/offline peers cannot leave a hidden stale contribution. */
export async function collectPortosQuality(days, deps = {}) {
  return collectAppQuality({ id: PORTOS_APP_ID }, days, deps);
}

// Why a peer contributed nothing, so the UI can name it and say what to fix.
// Reasons are a fixed vocabulary: peer error text never reaches the client.
const peerFailure = (reason, extra) => Object.assign(new Error(reason), { peerFailureReason: reason, ...extra });
function unavailableReason(err) {
  if (err?.peerFailureReason) return err.peerFailureReason;
  // Wire-schema or JSON mismatch: the peer runs a PortOS version this one cannot read.
  if (err instanceof z.ZodError || err instanceof SyntaxError) return 'incompatible';
  return 'unreachable';
}
const HTTP_FAILURE_REASONS = { 400: 'incompatible', 403: 'refused', 404: 'incompatible' };
const emptyFederation = () => ({ peers: 0, available: 0, unavailable: 0, unavailablePeers: [] });
const failedFederation = () => ({ records: [], federation: { failed: true } });

// A sleeping peer used to hold every app's request for the full 3s timeout.
// Remember that miss briefly, and share a pull that is already on the wire.
// Not a durable copy of peer evidence: the next dashboard load after the TTL,
// a peer coming back, or a single-app detail read fetches again.
const PEER_FAILURE_TTL_MS = 30_000;
const peerBackoff = new Map();
const legacyPeers = new Map();
const inFlight = new Map();
let recoveryReady = null;

function pullClock(deps) {
  return deps.now ?? Date.now();
}

// Expired skips stay until the next list read. The map is peer ids only, and a
// peer that is never asked again would otherwise sit there for the process lifetime.
function dropExpiredPeerPullState(now) {
  for (const [id, entry] of peerBackoff) if (entry.until <= now) peerBackoff.delete(id);
  for (const [id, until] of legacyPeers) if (until <= now) legacyPeers.delete(id);
}

function rememberBackoff(peer, reason, deps) {
  peerBackoff.set(peer.id, { until: pullClock(deps) + PEER_FAILURE_TTL_MS, reason });
  console.log(`⏳ Quality federation peer ${peer.id} unreachable; skipping pulls for ${PEER_FAILURE_TTL_MS / 1000}s`);
}

function backoffReason(peer, deps) {
  const entry = peerBackoff.get(peer.id);
  if (!entry) return null;
  if (entry.until <= pullClock(deps)) {
    peerBackoff.delete(peer.id);
    return null;
  }
  return entry.reason;
}

/** Drops the sleeping-peer skip for one peer. Detail reads and peer recovery call this. */
export function clearQualityPeerBackoff(peerId) {
  if (peerId) peerBackoff.delete(peerId);
}

/** Test seam. Production recovery goes through the peer-online and sync events. */
export function resetQualityPeerPullState() {
  peerBackoff.clear();
  legacyPeers.clear();
  inFlight.clear();
}

function notePeerReachable(peerId, { legacy = false } = {}) {
  if (!peerId) return;
  peerBackoff.delete(peerId);
  if (legacy) legacyPeers.delete(peerId);
}

// Attached on first use so a suite that mocks the event bus without `.on` still loads.
function ensureRecoveryListener() {
  if (!recoveryReady) {
    recoveryReady = import('./instanceEvents.js').then(({ instanceEvents }) => {
      if (typeof instanceEvents?.on !== 'function') return;
      instanceEvents.on('peer:online', peer => notePeerReachable(peer?.id, { legacy: true }));
      instanceEvents.on('sync:progress', payload => {
        if (payload?.phase === 'complete') notePeerReachable(payload.peerId);
      });
    }).catch(err => {
      recoveryReady = null;
      console.error(`❌ Quality peer recovery listener failed: ${err.message}`);
    });
  }
  return recoveryReady;
}

const batchPayloadSchema = z.object({
  schemaVersion: z.literal(PLATFORM_SCHEMA_VERSIONS.appQuality),
  repositories: z.record(z.string().regex(/^[a-f0-9]{64}$/), z.array(z.unknown()).max(10000).nullable()),
}).strict();

function federationUrl(peer, days, { repository, repositories } = {}) {
  const repo = repositories?.length
    ? `&repositories=${repositories.join(',')}`
    : (repository ? `&repository=${repository}` : '');
  return `${peerBaseUrl(peer)}/api/apps/quality-federation?days=${days}${repo}&categories=${READABLE_CATEGORY_PARAM}`;
}

// PortOS itself omits `repository` so an older peer still serves its own checkout;
// the caller compares the returned hash and rejects a different origin.
function singleUrl(peer, days, app, repository) {
  return federationUrl(peer, days, { repository: app.id === PORTOS_APP_ID ? undefined : repository });
}

function acceptedMeasurements(rows, now, peer) {
  return rows.flatMap(row => {
    const parsed = measurementSchema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  }).filter(row => Date.parse(row.assessedAt) <= now).map(row => ({
    ...row, category: row.report.category, sourcePeerId: peer.id, sourcePeerName: peer.name || peer.id,
    report: { ...row.report, summary: sharedSummary },
  }));
}

async function readPeerJson(peer, url, deps) {
  const response = await (deps.peerFetch || peerFetch)(
    url, { signal: AbortSignal.timeout(3000), redirect: 'error', maxBytes: MAX_PAYLOAD_BYTES }, peer);
  if (!response.ok) {
    await response.body?.cancel?.();
    throw peerFailure(HTTP_FAILURE_REASONS[response.status] || 'error', { httpStatus: response.status });
  }
  const body = await readBodyCapped(response, MAX_PAYLOAD_BYTES);
  if (!body) {
    await response.body?.cancel?.();
    throw peerFailure('too-large');
  }
  return JSON.parse(body.toString('utf8'));
}

async function fetchSingleRepository(peer, days, app, repository, now, deps) {
  const payload = payloadSchema.parse(await readPeerJson(peer, singleUrl(peer, days, app, repository), deps));
  if (payload.repository !== repository) throw peerFailure('different-repository');
  return acceptedMeasurements(payload.measurements, now, peer);
}

function rememberLegacy(peer, deps) {
  legacyPeers.set(peer.id, pullClock(deps) + PEER_FAILURE_TTL_MS);
}

function legacyActive(peer, deps) {
  const until = legacyPeers.get(peer.id);
  if (until == null) return false;
  if (until <= pullClock(deps)) {
    legacyPeers.delete(peer.id);
    return false;
  }
  return true;
}

async function pullSingles(peer, days, targets, now, deps) {
  // The peer already answered, so these are ordinary reads again. One timeout
  // still fails the whole pull: a peer that dies mid-fallback must not look
  // half-successful.
  const settled = await Promise.all(targets.map(async target => {
    try {
      return [target.repository, { records: await fetchSingleRepository(peer, days, target.app, target.repository, now, deps) }];
    } catch (err) {
      if (unavailableReason(err) === 'unreachable') throw err;
      return [target.repository, { reason: unavailableReason(err) }];
    }
  }));
  return new Map(settled);
}

async function pullBatch(peer, days, targets, now, deps) {
  const byHash = new Map();
  for (let offset = 0; offset < targets.length; offset += QUALITY_FEDERATION_MAX_REPOSITORIES) {
    const chunk = targets.slice(offset, offset + QUALITY_FEDERATION_MAX_REPOSITORIES);
    const hashes = chunk.map(target => target.repository);
    let json;
    try {
      json = await readPeerJson(peer, federationUrl(peer, days, { repositories: hashes }), deps);
    } catch (err) {
      // An older peer does not know `repositories` and rejects the query.
      if (err.httpStatus === 400 || err.httpStatus === 404) {
        rememberLegacy(peer, deps);
        const singles = await pullSingles(peer, days, targets, now, deps);
        for (const [hash, entry] of singles) byHash.set(hash, entry);
        return byHash;
      }
      throw err;
    }
    const batch = batchPayloadSchema.safeParse(json);
    if (batch.success) {
      for (const hash of hashes) {
        const rows = batch.data.repositories[hash];
        byHash.set(hash, rows == null ? { missing: true } : { records: acceptedMeasurements(rows, now, peer) });
      }
      continue;
    }
    // A peer that strips unknown query keys answers 200 with the v1 body.
    const single = payloadSchema.safeParse(json);
    if (single.success && hashes.length === 1 && single.data.repository === hashes[0]) {
      rememberLegacy(peer, deps);
      byHash.set(hashes[0], { records: acceptedMeasurements(single.data.measurements, now, peer) });
      continue;
    }
    if (single.success) {
      rememberLegacy(peer, deps);
      const singles = await pullSingles(peer, days, targets, now, deps);
      for (const [hash, entry] of singles) byHash.set(hash, entry);
      return byHash;
    }
    throw peerFailure('incompatible');
  }
  return byHash;
}

async function pullPeer(peer, days, targets, deps) {
  if (deps.freshPeerPull) clearQualityPeerBackoff(peer.id);
  const skipped = backoffReason(peer, deps);
  if (skipped) return { peer, ok: false, reason: skipped };
  const now = pullClock(deps);
  const hashes = targets.map(target => target.repository).join(',');
  const key = `${peer.id}|${days}|${hashes}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const promise = (async () => {
    try {
      const byHash = legacyActive(peer, deps)
        ? await pullSingles(peer, days, targets, now, deps)
        : await pullBatch(peer, days, targets, now, deps);
      return { peer, ok: true, byHash };
    } catch (err) {
      const reason = unavailableReason(err);
      if (reason === 'unreachable') rememberBackoff(peer, reason, deps);
      return { peer, ok: false, reason };
    }
  })().finally(() => {
    if (inFlight.get(key) === promise) inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

function peerName(peer) {
  return peer.name || peer.id;
}

function qualityFromPeerResults(repository, peerResults) {
  if (!repository) return { records: [], federation: emptyFederation() };
  const unavailablePeers = [];
  const records = [];
  for (const result of peerResults) {
    if (!result.ok) {
      unavailablePeers.push({ id: result.peer.id, name: peerName(result.peer), reason: result.reason });
      continue;
    }
    const entry = result.byHash.get(repository);
    if (!entry || entry.missing) {
      unavailablePeers.push({ id: result.peer.id, name: peerName(result.peer), reason: 'refused' });
      continue;
    }
    if (entry.reason) {
      unavailablePeers.push({ id: result.peer.id, name: peerName(result.peer), reason: entry.reason });
      continue;
    }
    records.push(...entry.records);
  }
  return {
    records,
    federation: {
      peers: peerResults.length,
      available: peerResults.length - unavailablePeers.length,
      unavailable: unavailablePeers.length,
      unavailablePeers,
    },
  };
}

/**
 * One pull per eligible peer for a list of apps. Peers that accept `repositories`
 * get a single request; a peer that rejects it is remembered and read one
 * repository at a time until the short TTL. A peer that just timed out is
 * reported unavailable immediately instead of opening another 3s wait.
 * `deps.freshPeerPull` drops that skip (the app detail read).
 */
export async function collectAppsQualityBatch(apps, days, deps = {}) {
  await ensureRecoveryListener();
  dropExpiredPeerPullState(pullClock(deps));
  const peers = await eligiblePeers(deps);
  // No peers means no origin lookups: a broken checkout must not look like a failed pull.
  if (!peers.length) return apps.map(() => ({ records: [], federation: emptyFederation() }));
  const keyed = await Promise.all(apps.map(async app => {
    try {
      return { app, repository: await repositoryKey(deps, app) };
    } catch {
      return { app, failed: true };
    }
  }));
  const targets = [];
  const seen = new Set();
  for (const entry of keyed) {
    if (!entry.repository || seen.has(entry.repository)) continue;
    seen.add(entry.repository);
    const app = entry.app;
    targets.push({ app, repository: entry.repository });
  }
  const peerResults = peers.length && targets.length
    ? await Promise.all(peers.map(peer => pullPeer(peer, days, targets, deps)))
    : [];
  return keyed.map(entry => (entry.failed ? failedFederation() : qualityFromPeerResults(entry.repository, peerResults)));
}

export async function collectAppQuality(app, days, deps = {}) {
  const [quality] = await collectAppsQualityBatch([app], days, { ...deps, freshPeerPull: true });
  return quality || failedFederation();
}

/**
 * Every app — PortOS's own checkout included — reads `.quality.json` (or the
 * historical `quality-snapshot.json` when the canonical file is absent). v1 and
 * v2 both normalize. The read never writes. Repository match, future dates, and
 * the 4 MiB cap still apply. The peer wire schema is not used here.
 */
async function releasePayload(deps, app) {
  const repoPath = appRepoPath(app);
  if (!repoPath) return null;
  const { readStoredQualitySnapshot } = await import('./appQualitySnapshotFile.js');
  const stored = await readStoredQualitySnapshot(repoPath, deps);
  // 'future-categories': a newer install's snapshot — its known rows still count.
  return ['v1', 'v2', 'v3', 'future-categories'].includes(stored.status) ? stored : null;
}

/** Shipped evidence is read-only and never re-exported as a local audit. */
export async function readReleaseQuality(deps = {}, app = { id: PORTOS_APP_ID }) {
  const payload = await releasePayload(deps, app);
  if (!payload || payload.repository !== await repositoryKey(deps, app)) return [];
  const now = deps.now ?? Date.now();
  return payload.records.filter(row => Date.parse(row.assessedAt) <= now).map(row => ({
    measurementId: releaseTieId(row),
    assessedAt: row.assessedAt,
    category: row.category,
    sourcePeerName: 'Release snapshot',
    report: {
      version: 1,
      category: row.category,
      score: row.score,
      worstSeverity: row.worstSeverity,
      coverage: row.coverage,
      confidence: row.confidence,
      summary: 'Published release assessment; original assessment date and freshness rules apply.',
      scannedFiles: row.scannedFiles,
      totalFiles: row.totalFiles,
    },
  }));
}

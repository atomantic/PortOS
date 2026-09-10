/** Read-through federation of numeric PortOS audit evidence; never exports prose or relays peers. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { query } from '../lib/db.js';
import { PORTOS_APP_ID } from '../lib/appIdentity.js';
import { auditQualityReportSchema, AUDIT_FRESHNESS_MS } from '../lib/auditQuality.js';
import { PORTOS_SCHEMA_VERSIONS } from '../lib/schemaVersions.js';
import { getOriginInfo } from '../lib/gitRemote.js';
import { peerBaseUrl } from '../lib/peerUrl.js';
import { readBodyCapped } from '../lib/safeUrlFetch.js';
import { peerFetch } from '../lib/peerHttpClient.js';

const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const sharedSummary = 'Numeric assessment shared by a federated instance; evidence remains on the source machine.';
const hash = value => createHash('sha256').update(value).digest('hex');
const numericReportSchema = z.preprocess(value => value && typeof value === 'object'
  ? { ...value, summary: sharedSummary } : value, auditQualityReportSchema)
  .transform(({ summary: _summary, ...report }) => report);
const measurementSchema = z.object({
  measurementId: z.string().regex(/^[a-f0-9]{64}$/),
  assessedAt: z.string().datetime(),
  report: numericReportSchema,
}).strict();
const payloadSchema = z.object({
  schemaVersion: z.literal(PORTOS_SCHEMA_VERSIONS.appQuality),
  repository: z.string().regex(/^[a-f0-9]{64}$/),
  measurements: z.array(measurementSchema).max(10000),
}).strict();

// Match repositories without sharing remote URLs, names, credentials or local paths.
// Independent versions of the same repository intentionally contribute to one score.
async function repositoryKey(deps) {
  const origin = await (deps.getOriginInfo || getOriginInfo)();
  return origin.host && origin.fullName ? hash(`${origin.host}/${origin.fullName}`.toLowerCase()) : null;
}

async function eligiblePeers(deps) {
  const { getPeers } = deps.getPeers ? deps : await import('./instances.js');
  const { peerAllowsOutbound } = await import('./sharing/peerSyncShared.js');
  return (await getPeers()).filter(peer => peer.fullSync === true && peerAllowsOutbound(peer));
}

export function qualityRecord(row) {
  return { category: row.category, agentId: row.agent_id,
    measurementId: hash(row.agent_id), assessedAt: new Date(row.assessed_at).toISOString(), report: row.report };
}

/** Daily category winners include the freshness lookback required for historical snapshots. */
export async function readQualityRecords(appId, days, now, deps = {}) {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - days + 1);
  const result = await (deps.query || query)(
    `SELECT DISTINCT ON (category, (assessed_at AT TIME ZONE 'UTC')::date)
       category, agent_id, assessed_at, report FROM app_quality_measurements
     WHERE app_id = $1 AND assessed_at >= $2 AND assessed_at <= $3
     ORDER BY category, (assessed_at AT TIME ZONE 'UTC')::date, assessed_at DESC, agent_id DESC`,
    [appId, new Date(start.getTime() - AUDIT_FRESHNESS_MS), new Date(now)]
  );
  return result.rows.map(qualityRecord);
}

/** New endpoint always enforces peer sharing consent, even without instance-password auth. */
export async function exportPortosQuality(callerId, days, deps = {}) {
  const peers = await eligiblePeers(deps);
  if (!callerId || !peers.some(peer => peer.instanceId === callerId)) return null;
  const repository = await repositoryKey(deps);
  if (!repository) return null;
  const records = await readQualityRecords(PORTOS_APP_ID, days, deps.now ?? Date.now(), deps);
  const measurements = records.flatMap(record => {
    const parsed = measurementSchema.safeParse({ measurementId: record.measurementId,
      assessedAt: record.assessedAt, report: record.report });
    return parsed.success && parsed.data.report.category === record.category ? [parsed.data] : [];
  });
  return { schemaVersion: PORTOS_SCHEMA_VERSIONS.appQuality, repository, measurements };
}

/** No persistence or forwarding: disabled/offline peers cannot leave a hidden stale contribution. */
export async function collectPortosQuality(days, deps = {}) {
  const peers = await eligiblePeers(deps);
  if (!peers.length) return { records: [], federation: { peers: 0, available: 0, unavailable: 0 } };
  const repository = await repositoryKey(deps);
  const now = deps.now ?? Date.now();
  const results = await Promise.allSettled(peers.map(async peer => {
    if (!repository) throw new Error('Repository identity unavailable');
    const response = await (deps.peerFetch || peerFetch)(
      `${peerBaseUrl(peer)}/api/apps/quality-federation?days=${days}`,
      { signal: AbortSignal.timeout(3000), redirect: 'error', maxBytes: MAX_PAYLOAD_BYTES }, peer);
    if (!response.ok) {
      await response.body?.cancel?.();
      throw new Error('Peer quality unavailable');
    }
    const body = await readBodyCapped(response, MAX_PAYLOAD_BYTES);
    if (!body) {
      await response.body?.cancel?.();
      throw new Error('Peer quality payload too large');
    }
    const payload = payloadSchema.parse(JSON.parse(body.toString('utf8')));
    if (payload.repository !== repository) throw new Error('Different repository');
    return payload.measurements.filter(row => Date.parse(row.assessedAt) <= now).map(row => ({
      ...row, category: row.report.category, sourcePeerId: peer.id, sourcePeerName: peer.name || peer.id,
      report: { ...row.report, summary: sharedSummary },
    }));
  }));
  return { records: results.flatMap(result => result.status === 'fulfilled' ? result.value : []),
    federation: { peers: peers.length, available: results.filter(r => r.status === 'fulfilled').length,
      unavailable: results.filter(r => r.status === 'rejected').length } };
}

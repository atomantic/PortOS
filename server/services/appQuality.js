import { isLegacyDeepAudit } from '../lib/auditWorkflow.js';
/**
 * DB-primary audit measurements with read-through app federation. Reads never dispatch AI work.
 *
 * Storage: `db-primary` (`app_quality_measurements`) — machine-local rows and
 * prose; only a numeric projection is offered to identified, sync-enabled peers
 * with outbound sharing (`appQualityFederation.js`). Immutable assessments queried
 * latest-per-category, so Postgres. App ids are opaque keys into the file-backed
 * registry (reads keep only registered apps). Additive boot DDL; no seed or
 * backfill fabricates scores. The Postgres backup covers it.
 */
import { ensureSchema, query } from '../lib/db.js';
import { doneSentinelPath, parseSentinelPayload } from '../lib/agent/agentSentinel.js';
import { tryReadFile } from '../lib/jsonIo.js';
import { CONSOLIDATED_AUDIT_DOMAINS } from '../lib/auditDomains.js';
import { normalizeAuditTaskType } from '../lib/auditCatalog.js';
import { AUDIT_FRESHNESS_MS, parseAuditQualityReport, parseAuditSlice, summarizeAppQuality, buildAppQualityHistory, dailyQualityRecords } from '../lib/auditQuality.js';
import { collectAppQuality, collectAppsQualityBatch, qualityRecord, readQualityRecords, readReleaseQuality } from './appQualityFederation.js';
import { toPgJson } from '../lib/pgJson.js';

export async function recordAuditQuality({ task, taskType, agentId, workspacePath, success, assessedAt, deepDiscoveryComplete = false }, deps = {}) {
  if (!success || !workspacePath || !task?.metadata?.app || !agentId) return false;
  const contents = await (deps.readFile || tryReadFile)(doneSentinelPath(workspacePath, agentId));
  const { summary } = parseSentinelPayload(contents);
  const category = normalizeAuditTaskType(taskType);
  const report = parseAuditQualityReport(summary, category);
  if (!report) {
    console.warn(`⚠️ Audit quality report missing or invalid for ${agentId} (${taskType})`);
    return false;
  }
  if (isLegacyDeepAudit(task.metadata) && !deepDiscoveryComplete && report.coverage === 'broad') report.coverage = 'partial';
  // Immutable run measurements make completion replay idempotent.
  if (!Number.isFinite(Date.parse(assessedAt))) {
    console.warn(`⚠️ Audit quality skipped for ${agentId}: no valid run start time`);
    return false;
  }
  // The AUDIT_SLICE line is the rotation record (#12090); a v2 report names the
  // same slice, so a summary that dropped the line still records one.
  const slice = parseAuditSlice(summary) ?? (report.version === 2 ? report.slice : null);
  await (deps.ensureSchema || ensureSchema)();
  await (deps.query || query)(
    `INSERT INTO app_quality_measurements (app_id, category, agent_id, assessed_at, report, slice)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     ON CONFLICT (app_id, category, agent_id) DO NOTHING`,
    [task.metadata.app, category, agentId, assessedAt, toPgJson(report), slice]
  );
  return true;
}

export const AUDIT_SLICE_HISTORY_RUNS = 8;

/**
 * The slices this lane recorded for an app in its most recent runs, newest
 * first, for the `audit-slice-history` task data input (#12090). Runs that
 * recorded no slice (older prompts, summaries without the line) are skipped.
 */
export async function readRecentAuditSlices(appId, taskType, deps = {}) {
  const id = normalizeAuditTaskType(taskType);
  const categories = [id, ...(CONSOLIDATED_AUDIT_DOMAINS[id]?.members || [])];
  if (categories.includes('ui-lifecycle')) categories.push('react-lifecycle');
  const result = await (deps.query || query)(
    `SELECT assessed_at, slice, report FROM app_quality_measurements
     WHERE app_id = $1 AND category = ANY($2::text[]) AND slice IS NOT NULL
     ORDER BY assessed_at DESC, agent_id DESC LIMIT $3`,
    [appId, categories, AUDIT_SLICE_HISTORY_RUNS]
  );
  return result.rows.map(row => {
    const report = row.report; // jsonb column, already parsed by pg
    const score = report && typeof report === 'object' ? (report.version === 2 ? report.sliceScore : report.score) : null;
    return { assessedAt: new Date(row.assessed_at).toISOString(), slice: row.slice, sliceScore: Number.isFinite(score) ? score : null };
  });
}

/**
 * @param {object[]} apps - Managed app records
 * @param {object} [deps] - Injectable seams. `resolveApplicability(app)` →
 *   `{ [category]: reason }` adds repository-scan applicability; only the
 *   single-app detail read passes it, so a list read never walks N checkouts.
 */
export async function enrichAppsWithQuality(apps, deps = {}) {
  if (!apps.length) return apps;
  // One app-scoped query per list, not one per tile or transcript scan. Every
  // run inside the freshness window feeds a category's rolling figure; the
  // newest run per category is kept past it as the row's evidence (#12076).
  const now = deps.now ?? Date.now();
  const result = await (deps.query || query)(
    `SELECT app_id, category, agent_id, assessed_at, report FROM (
       SELECT app_id, category, agent_id, assessed_at, report,
         row_number() OVER (PARTITION BY app_id, category ORDER BY assessed_at DESC, agent_id DESC) AS run_rank
       FROM app_quality_measurements WHERE app_id = ANY($1::text[])) runs
     WHERE run_rank = 1 OR assessed_at >= $2`,
    [apps.map(app => app.id), new Date(now - AUDIT_FRESHNESS_MS)]
  ).catch(err => {
    console.error(`❌ App quality unavailable: ${err.message}`);
    return null;
  });
  // Shipped evidence: `.quality.json`, or a historical `quality-snapshot.json`
  // when the canonical file is absent.
  // One unreadable checkout (git spawn failure, timeout) must cost that app its release
  // records, never the whole list — same posture as the peer collect below.
  const releases = await Promise.all(apps.map(app => readReleaseQuality(deps, app).catch(() => [])));
  // One peer round-trip for the list. A per-app collect made every dashboard
  // load wait out a sleeping peer once per app.
  const [shared, applicability] = await Promise.all([
    collectAppsQualityBatch(apps, 30, deps).catch(() => null),
    Promise.all(apps.map(app => (deps.resolveApplicability ? deps.resolveApplicability(app).catch(() => ({})) : {}))),
  ]);
  const failedPeerPull = { records: [], federation: { failed: true } };
  return apps.map((app, index) => {
    const peerQuality = shared?.[index] || failedPeerPull;
    const inapplicable = applicability[index];
    return { ...app,
      quality: result ? { ...summarizeAppQuality(dailyQualityRecords([
        ...result.rows.filter(row => row.app_id === app.id).map(qualityRecord),
        ...peerQuality.records, ...releases[index],
      ]), now, { inapplicable }), federation: peerQuality.federation }
        : { ...summarizeAppQuality(), unavailable: true },
    };
  });
}

/** Takes the full app record: the repo path is what locates a managed app's `.quality.json`. */
export async function getAppQualityHistory(app, days, deps = {}) {
  const now = deps.now ?? Date.now();
  const records = await readQualityRecords(app.id, days, now, deps);
  const shared = await collectAppQuality(app, days, deps)
    .catch(() => ({ records: [], federation: { failed: true } }));
  const release = await readReleaseQuality(deps, app).catch(() => []);
  return { ...buildAppQualityHistory([...records, ...shared.records, ...release], days, now),
    federation: shared.federation };
}

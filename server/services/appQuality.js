import { isLegacyDeepAudit } from '../lib/auditWorkflow.js';
/** DB-primary audit measurements with read-through app federation. Reads never dispatch AI work. */
import { ensureSchema, query } from '../lib/db.js';
import { doneSentinelPath, parseSentinelPayload } from '../lib/agentSentinel.js';
import { tryReadFile } from '../lib/jsonIo.js';
import { normalizeAuditTaskType } from '../lib/auditCatalog.js';
import { AUDIT_FRESHNESS_MS, parseAuditQualityReport, summarizeAppQuality, buildAppQualityHistory, dailyQualityRecords } from '../lib/auditQuality.js';
import { collectAppQuality, qualityRecord, readQualityRecords, readReleaseQuality } from './appQualityFederation.js';

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
  await (deps.ensureSchema || ensureSchema)();
  await (deps.query || query)(
    `INSERT INTO app_quality_measurements (app_id, category, agent_id, assessed_at, report)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (app_id, category, agent_id) DO NOTHING`,
    [task.metadata.app, category, agentId, assessedAt, JSON.stringify(report)]
  );
  return true;
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
  return Promise.all(apps.map(async (app, index) => {
    const [shared, inapplicable] = await Promise.all([
      collectAppQuality(app, 30, deps).catch(() => ({ records: [], federation: { failed: true } })),
      deps.resolveApplicability ? deps.resolveApplicability(app).catch(() => ({})) : {},
    ]);
    return { ...app,
      quality: result ? { ...summarizeAppQuality(dailyQualityRecords([
        ...result.rows.filter(row => row.app_id === app.id).map(qualityRecord),
        ...shared.records, ...releases[index],
      ]), now, { inapplicable }), federation: shared.federation }
        : { ...summarizeAppQuality(), unavailable: true },
    };
  }));
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

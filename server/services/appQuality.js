/** Machine-local, DB-primary audit measurements. Reads never dispatch AI work. */
import { ensureSchema, query } from '../lib/db.js';
import { doneSentinelPath, parseSentinelPayload } from '../lib/agentSentinel.js';
import { tryReadFile } from '../lib/fileCore.js';
import { parseAuditQualityReport, summarizeAppQuality, buildAppQualityHistory, AUDIT_FRESHNESS_MS } from '../lib/auditQuality.js';

export async function recordAuditQuality({ task, taskType, agentId, workspacePath, success, assessedAt }, deps = {}) {
  if (!success || !workspacePath || !task?.metadata?.app || !agentId) return false;
  const contents = await (deps.readFile || tryReadFile)(doneSentinelPath(workspacePath, agentId));
  const { summary } = parseSentinelPayload(contents);
  const report = parseAuditQualityReport(summary, taskType);
  if (!report) return false;
  // Immutable run measurements make completion replay idempotent.
  if (!Number.isFinite(Date.parse(assessedAt))) return false;
  await (deps.ensureSchema || ensureSchema)();
  await (deps.query || query)(
    `INSERT INTO app_quality_measurements (app_id, category, agent_id, assessed_at, report)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (app_id, category, agent_id) DO NOTHING`,
    [task.metadata.app, taskType, agentId, assessedAt, JSON.stringify(report)]
  );
  return true;
}

export async function enrichAppsWithQuality(apps, deps = {}) {
  if (!apps.length) return apps;
  // One app-scoped query per list, not one per tile or transcript scan.
  const result = await (deps.query || query)(
    `SELECT DISTINCT ON (app_id, category) app_id, category, agent_id, assessed_at, report FROM app_quality_measurements WHERE app_id = ANY($1::text[]) ORDER BY app_id, category, assessed_at DESC, agent_id DESC`,
    [apps.map(app => app.id)]
  ).catch(err => {
    console.error(`❌ App quality unavailable: ${err.message}`);
    return null;
  });
  return apps.map(app => ({
    ...app,
    quality: result ? summarizeAppQuality(result.rows.filter(row => row.app_id === app.id).map(row => ({
      category: row.category, agentId: row.agent_id,
      assessedAt: new Date(row.assessed_at).toISOString(), report: row.report,
    }))) : { ...summarizeAppQuality(), unavailable: true },
  }));
}

export async function getAppQualityHistory(appId, days, deps = {}) {
  const now = deps.now ?? Date.now();
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - days + 1);
  // Last measurement per UTC day/category bounds the payload regardless of run frequency.
  const result = await (deps.query || query)(
    `SELECT DISTINCT ON (category, (assessed_at AT TIME ZONE 'UTC')::date)
       category, agent_id, assessed_at, report FROM app_quality_measurements
     WHERE app_id = $1 AND assessed_at >= $2 AND assessed_at <= $3
     ORDER BY category, (assessed_at AT TIME ZONE 'UTC')::date, assessed_at DESC, agent_id DESC`,
    [appId, new Date(start.getTime() - AUDIT_FRESHNESS_MS), new Date(now)]
  );
  return buildAppQualityHistory(result.rows.map(row => ({ category: row.category,
    agentId: row.agent_id, assessedAt: new Date(row.assessed_at).toISOString(), report: row.report,
  })), days, now);
}

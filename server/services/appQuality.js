/** Machine-local, DB-primary audit measurements. Reads never dispatch AI work. */
import { ensureSchema, query } from '../lib/db.js';
import { doneSentinelPath, parseSentinelPayload } from '../lib/agentSentinel.js';
import { tryReadFile } from '../lib/fileCore.js';
import { parseAuditQualityReport, summarizeAppQuality } from '../lib/auditQuality.js';

export async function recordAuditQuality({ task, taskType, agentId, workspacePath, success, assessedAt }, deps = {}) {
  if (!success || !workspacePath || !task?.metadata?.app || !agentId) return false;
  const contents = await (deps.readFile || tryReadFile)(doneSentinelPath(workspacePath, agentId));
  const { summary } = parseSentinelPayload(contents);
  const report = parseAuditQualityReport(summary, taskType);
  if (!report) return false;
  // Latest measurement per category, idempotent for repeated completion. A
  // delayed recovery of an older task must not replace a newer assessment.
  if (!Number.isFinite(Date.parse(assessedAt))) return false;
  await (deps.ensureSchema || ensureSchema)();
  await (deps.query || query)(
    `INSERT INTO app_quality_assessments (app_id, category, agent_id, assessed_at, report)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (app_id, category) DO UPDATE SET
       agent_id = EXCLUDED.agent_id, assessed_at = EXCLUDED.assessed_at, report = EXCLUDED.report
     WHERE app_quality_assessments.assessed_at < EXCLUDED.assessed_at`,
    [task.metadata.app, taskType, agentId, assessedAt, JSON.stringify(report)]
  );
  return true;
}

export async function enrichAppsWithQuality(apps, deps = {}) {
  if (!apps.length) return apps;
  // One indexed query per list, not one per tile, and no history/log scans.
  const result = await (deps.query || query)(
    `SELECT app_id, category, agent_id, assessed_at, report FROM app_quality_assessments WHERE app_id = ANY($1::text[])`,
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

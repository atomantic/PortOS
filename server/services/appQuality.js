/** DB-primary audit measurements with read-through app federation. Reads never dispatch AI work. */
import { ensureSchema, query } from '../lib/db.js';
import { doneSentinelPath, parseSentinelPayload } from '../lib/agentSentinel.js';
import { tryReadFile } from '../lib/jsonIo.js';
import { parseAuditQualityReport, summarizeAppQuality, buildAppQualityHistory, latestQualityRecords } from '../lib/auditQuality.js';
import { collectAppQuality, qualityRecord, readQualityRecords, readReleaseQuality } from './appQualityFederation.js';

export async function recordAuditQuality({ task, taskType, agentId, workspacePath, success, assessedAt }, deps = {}) {
  if (!success || !workspacePath || !task?.metadata?.app || !agentId) return false;
  const contents = await (deps.readFile || tryReadFile)(doneSentinelPath(workspacePath, agentId));
  const { summary } = parseSentinelPayload(contents);
  const report = parseAuditQualityReport(summary, taskType);
  if (!report) {
    console.warn(`⚠️ Audit quality report missing or invalid for ${agentId} (${taskType})`);
    return false;
  }
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
  // Shipped evidence: any app's committed `.quality.json`.
  // One unreadable checkout (git spawn failure, timeout) must cost that app its release
  // records, never the whole list — same posture as the peer collect below.
  const releases = await Promise.all(apps.map(app => readReleaseQuality(deps, app).catch(() => [])));
  return Promise.all(apps.map(async (app, index) => {
    const shared = await collectAppQuality(app, 30, deps)
      .catch(() => ({ records: [], federation: { failed: true } }));
    return { ...app,
      quality: result ? { ...summarizeAppQuality(latestQualityRecords([
        ...result.rows.filter(row => row.app_id === app.id).map(qualityRecord),
        ...shared.records, ...releases[index],
      ]), deps.now ?? Date.now()), federation: shared.federation }
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

// Only npm run test:db (portos_test); each run owns its scoped rows.
import { afterAll, describe, expect, it } from 'vitest';
import { checkHealth, ensureSchema, query, close } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import { AUDIT_FRESHNESS_MS } from '../lib/auditQuality.js';
import { recordAuditQuality, enrichAppsWithQuality, getAppQualityHistory } from './appQuality.js';
import { buildQualitySnapshot, exportPortosQuality, readDailyQualityRecords, readQualityRecords } from './appQualityFederation.js';
import { serializeQualitySnapshot } from './appQualitySnapshotFormat.js';

const health = await checkHealth().catch(error => ({ connected: false, error: error.message }));
const runDb = requireDbOrSkip('appQuality', health.connected, health.error);
const appId = `test-quality-${process.pid}-${Date.now()}`;

afterAll(async () => {
  if (runDb) await query('DELETE FROM app_quality_measurements WHERE app_id = ANY($1::text[])', [[appId, `${appId}-history`, `${appId}-same-day`]]);
  await close();
});

describe.skipIf(!runDb)('app quality persistence', () => {
  it('keeps the newest assessment across duplicate completion and delayed recovery, isolated by app', async () => {
    await ensureSchema();
    const now = Date.parse('2026-09-10T12:00:00Z');
    const write = (offset, score, success = true) => recordAuditQuality({
      task: { metadata: { app: appId } }, taskType: 'better-complexity',
      agentId: `agent-${offset}`, workspacePath: '/test-repo', success,
      assessedAt: new Date(now + offset).toISOString(),
    }, { readFile: async () => `QUALITY_AUDIT_JSON: ${JSON.stringify({
      version: 1, category: 'better-complexity', score, worstSeverity: 7,
      coverage: 'broad', confidence: 'high', summary: 'Measured dispatcher branching.', scannedFiles: 50, totalFiles: 50,
    })}` });
    await write(-2000, 30);
    await write(-1000, 65);
    await write(-1000, 10); // repeated completion cannot rewrite its assessment
    await write(-2000, 5); // recovery of an older run cannot supersede it
    await write(0, 99, false); // failed run cannot overwrite measured evidence
    // This persistence fixture has no managed checkout or federation peers.
    const deps = { now, getPeers: async () => [], getAppById: async id => ({ id }) };
    const [app, other] = await enrichAppsWithQuality([{ id: appId }, { id: `${appId}-other` }], deps);
    expect(app.quality).toMatchObject({ score: 65, ratedCategories: 1 });
    const history = await getAppQualityHistory({ id: appId }, 30, deps);
    expect(history.additionalCategories.map(category => category.id)).toContain('better-complexity');
    expect(history.points.at(-1)).toMatchObject({ score: 65, ratedCategories: 1, categories: {
      'better-complexity': { score: 65 },
      'code-simplification': { score: 65 },
    } });
    const retained = await query('SELECT category, report FROM app_quality_measurements WHERE app_id = $1 ORDER BY assessed_at', [appId]);
    expect(retained.rows.map(row => [row.category, row.report.score])).toEqual([
      ['better-complexity', 30], ['better-complexity', 65],
    ]);
    expect(other.quality.score).toBeNull();
    expect(app.quality.categories.find(category => category.id === 'code-simplification')).toMatchObject({ agentId: 'agent--1000', score: 65 });
  });

  it('reads all local history in range while daily snapshot queries retain conflicting runs tied at the latest timestamp', async () => {
    await ensureSchema();
    const now = Date.parse('2026-09-10T12:00:00Z');
    const write = (agentId, assessedAt, score) => recordAuditQuality({
      task: { metadata: { app: `${appId}-history` } }, taskType: 'privacy', agentId,
      workspacePath: '/test-repo', success: true, assessedAt,
    }, { readFile: async () => `QUALITY_AUDIT_JSON: ${JSON.stringify({
      version: 1, category: 'privacy', score, worstSeverity: 4,
      coverage: 'broad', confidence: 'high', summary: 'Assessment.', scannedFiles: 10, totalFiles: 10,
    })}` });
    await write('old', '2026-01-01T10:00:00Z', 50);
    await write('earlier', '2026-09-10T09:00:00Z', 60);
    await write('tie-a', '2026-09-10T10:00:00Z', 70);
    await write('tie-b', '2026-09-10T10:00:00Z', 80);
    const all = await readQualityRecords(`${appId}-history`, null, now);
    expect(all.map(row => row.report.score).sort()).toEqual([50, 60, 70, 80]);
    const recent = await readQualityRecords(`${appId}-history`, 30, now);
    expect(recent.map(row => row.report.score).sort()).toEqual([60, 70, 80]);
    const dailyAll = await readDailyQualityRecords(`${appId}-history`, null, now);
    expect(dailyAll.map(row => row.report.score).sort()).toEqual([50, 70, 80]);
    const dailyRecent = await readDailyQualityRecords(`${appId}-history`, 30, now);
    expect(dailyRecent.map(row => row.report.score).sort()).toEqual([70, 80]);
    const [enriched] = await enrichAppsWithQuality([{ id: `${appId}-history` }], {
      now: now + AUDIT_FRESHNESS_MS,
      getPeers: async () => [],
    });
    expect(enriched.quality.categories.find(category => category.id === 'privacy')).toMatchObject({
      agentId: 'tie-b', score: 80, stale: true,
    });
  });

  it('keeps same-day slice re-verifications and qualifying broad runs consistent across live summary, history, and snapshot exports', async () => {
    await ensureSchema();
    const sameDayAppId = `${appId}-same-day`;
    const now = Date.parse('2026-09-10T16:00:00Z');
    const write = (taskType, agentId, assessedAt, reportBody) => recordAuditQuality({
      task: { metadata: { app: sameDayAppId } }, taskType, agentId,
      workspacePath: '/test-repo', success: true, assessedAt,
    }, { readFile: async () => `QUALITY_AUDIT_JSON: ${JSON.stringify(reportBody)}` });

    await write('security', 'sec-day1-a', '2026-09-09T10:00:00Z', {
      version: 2, category: 'security', slice: 'server/services', sliceScore: 55, worstSeverity: 8,
      coverage: 'broad', confidence: 'high', summary: 'Pre-fix slice A.', scannedFiles: 50, totalFiles: 50,
    });
    await write('security', 'sec-day2-a', '2026-09-10T09:00:00Z', {
      version: 2, category: 'security', slice: 'server/services', sliceScore: 95, worstSeverity: 1,
      coverage: 'broad', confidence: 'high', summary: 'Re-verified slice A.', scannedFiles: 50, totalFiles: 50,
    });
    await write('security', 'sec-day2-b', '2026-09-10T15:00:00Z', {
      version: 2, category: 'security', slice: 'server/lib', sliceScore: 88, worstSeverity: 1,
      coverage: 'broad', confidence: 'high', summary: 'Audited slice B.', scannedFiles: 50, totalFiles: 50,
    });
    await write('privacy', 'priv-day2-broad', '2026-09-10T09:00:00Z', {
      version: 2, category: 'privacy', slice: 'server/routes', sliceScore: 90, worstSeverity: 1,
      coverage: 'broad', confidence: 'high', summary: 'Broad privacy check.', scannedFiles: 50, totalFiles: 50,
    });
    await write('privacy', 'priv-day2-partial', '2026-09-10T15:00:00Z', {
      version: 2, category: 'privacy', slice: 'server/routes', sliceScore: 40, worstSeverity: 7,
      coverage: 'partial', confidence: 'high', summary: 'Partial follow-up.', scannedFiles: 10, totalFiles: 50,
    });

    const getOriginInfo = async () => ({ host: 'github.com', fullName: 'owner/app' });
    const app = { id: sameDayAppId, repoPath: '/test-repo' };
    const snapshot = await buildQualitySnapshot(app, null, { now, getOriginInfo });
    expect(snapshot.measurements.filter(m => m.report.category === 'security').map(m => m.report.score)).toEqual([88, 55]);
    expect(snapshot.measurements.filter(m => m.report.category === 'privacy').map(m => m.report.score)).toEqual([40]);
    expect(JSON.stringify(snapshot)).not.toMatch(/slice|server\/services|server\/lib|server\/routes/i);

    const peer = { id: 'peer-a', instanceId: 'instance-a', enabled: true, address: '192.0.2.1', port: 5555 };
    const exported = await exportPortosQuality(peer.instanceId, 30, {
      now, getOriginInfo, getPeers: async () => [peer], getAllApps: async () => [app],
    }, snapshot.repository, ['security', 'privacy']);
    expect(exported.measurements.filter(m => m.report.category === 'security').map(m => m.report.score)).toEqual([88, 55]);
    expect(exported.measurements.filter(m => m.report.category === 'privacy').map(m => m.report.score)).toEqual([40]);
    expect(JSON.stringify(exported)).not.toMatch(/slice|server\/services|server\/lib|server\/routes/i);

    const snapshotBody = serializeQualitySnapshot(snapshot.repository,
      snapshot.measurements.map(m => ({ ...m.report, assessedAt: m.assessedAt, measurementId: m.measurementId })));
    const deps = { now, getOriginInfo, getPeers: async () => [], readFile: async () => snapshotBody };

    const [enriched] = await enrichAppsWithQuality([app], deps);
    expect(enriched.quality).toMatchObject({ score: 91, ratedCategories: 2 });
    expect(enriched.quality.categories.find(c => c.id === 'security')).toMatchObject({
      score: 91, runScore: 88, window: { runs: 2, worstSeverity: 1 },
    });
    expect(enriched.quality.categories.find(c => c.id === 'privacy')).toMatchObject({
      score: 90, runScore: 40, coverage: 'partial', worstSeverity: 7, window: { runs: 1, worstSeverity: 1 },
    });

    const history = await getAppQualityHistory(app, 30, deps);
    expect(history.points.at(-1)).toMatchObject({
      score: 91, ratedCategories: 2,
      categories: {
        security: { score: 91, coverage: 'broad' },
        privacy: { score: 90, coverage: 'partial' },
      },
    });
  });
});

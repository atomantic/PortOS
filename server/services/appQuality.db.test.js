// Only npm run test:db (portos_test); each run owns its scoped rows.
import { afterAll, describe, expect, it } from 'vitest';
import { checkHealth, ensureSchema, query, close } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import { recordAuditQuality, enrichAppsWithQuality, getAppQualityHistory } from './appQuality.js';
import { readQualityRecords } from './appQualityFederation.js';

const health = await checkHealth().catch(error => ({ connected: false, error: error.message }));
const runDb = requireDbOrSkip('appQuality', health.connected, health.error);
const appId = `test-quality-${process.pid}-${Date.now()}`;

afterAll(async () => {
  if (runDb) await query('DELETE FROM app_quality_measurements WHERE app_id = ANY($1::text[])', [[appId, `${appId}-history`]]);
  await close();
});

describe.skipIf(!runDb)('app quality persistence', () => {
  it('keeps the newest assessment across duplicate completion and delayed recovery, isolated by app', async () => {
    await ensureSchema();
    const now = Date.now();
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
    const deps = { getPeers: async () => [], getAppById: async id => ({ id }) };
    const [app, other] = await enrichAppsWithQuality([{ id: appId }, { id: `${appId}-other` }], deps);
    expect(app.quality).toMatchObject({ score: 65, ratedCategories: 1 });
    const history = await getAppQualityHistory({ id: appId }, 30, deps);
    expect(history.points.at(-1)).toMatchObject({ score: 65, ratedCategories: 1 });
    const retained = await query('SELECT report FROM app_quality_measurements WHERE app_id = $1 ORDER BY assessed_at', [appId]);
    expect(retained.rows.map(row => row.report.score)).toEqual([30, 65]);
    expect(other.quality.score).toBeNull();
    expect(app.quality.categories.find(category => category.id === 'better-complexity')).toMatchObject({ agentId: 'agent--1000', score: 65 });
  });

  it('reads old local history and retains conflicting runs tied at the latest timestamp', async () => {
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
    expect(all.map(row => row.report.score).sort()).toEqual([50, 70, 80]);
    const recent = await readQualityRecords(`${appId}-history`, 30, now);
    expect(recent.map(row => row.report.score).sort()).toEqual([70, 80]);
  });
});

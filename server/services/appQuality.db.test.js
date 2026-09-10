// Only npm run test:db (portos_test); each run owns its scoped rows.
import { afterAll, describe, expect, it } from 'vitest';
import { checkHealth, ensureSchema, query, close } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import { recordAuditQuality, enrichAppsWithQuality, getAppQualityHistory } from './appQuality.js';

const health = await checkHealth().catch(error => ({ connected: false, error: error.message }));
const runDb = requireDbOrSkip('appQuality', health.connected, health.error);
const appId = `test-quality-${process.pid}-${Date.now()}`;

afterAll(async () => {
  if (runDb) await query('DELETE FROM app_quality_measurements WHERE app_id = $1', [appId]);
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
    const [app, other] = await enrichAppsWithQuality([{ id: appId }, { id: `${appId}-other` }]);
    expect(app.quality).toMatchObject({ score: 65, ratedCategories: 1 });
    const history = await getAppQualityHistory(appId, 30);
    expect(history.points.at(-1)).toMatchObject({ score: 65, ratedCategories: 1 });
    const retained = await query('SELECT report FROM app_quality_measurements WHERE app_id = $1 ORDER BY assessed_at', [appId]);
    expect(retained.rows.map(row => row.report.score)).toEqual([30, 65]);
    expect(other.quality.score).toBeNull();
    expect(app.quality.categories.find(category => category.id === 'better-complexity')).toMatchObject({ agentId: 'agent--1000', score: 65 });
  });
});

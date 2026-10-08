// The DB runner forces portos_test; never run this against the live database.
import { afterAll, describe, expect, it } from 'vitest';
import { checkHealth, query, close } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import { assignDeepAuditAttempt, createDeepAuditLedger } from '../lib/deepAudit.js';
import { checkpointDeepAudit, getDeepAuditLedger } from './deepAudit.js';

const health = await checkHealth().catch(error => ({ connected: false, error: error.message }));
const runDb = requireDbOrSkip('deepAudit', health.connected, health.error);
const id = `test-deep-${process.pid}-${Date.now()}`;
const blob = 'a'.repeat(40);
const task = { id, description: 'Example audit', metadata: { app: id, deepAuditId: id, auditDepth: 'deep', fileIssues: true } };
const scope = { revision: 'b'.repeat(40), files: [{ path: 'source.js', blob }], capabilities: {}, exclusions: [], promptHash: 'example', promptVersions: { contract: 1 } };
const deps = { inventory: async () => scope };

afterAll(async () => {
  if (runDb) await query('DELETE FROM deep_audit_ledgers WHERE id=$1', [id]);
  await close();
});

describe.skipIf(!runDb)('Deep audit PostgreSQL persistence', () => {
  it('serializes overlapping checkpoint merges without losing evidence and replays after output loss', async () => {
    // Deep launches no longer create ledgers; persist one as a retained legacy ledger would be.
    const seeded = createDeepAuditLedger({ id, appId: id, category: 'code-quality', scope, delivery: 'file-issues' });
    for (const agentId of ['first', 'second']) assignDeepAuditAttempt(seeded, agentId);
    await query('INSERT INTO deep_audit_ledgers (id, app_id, category, ledger) VALUES ($1,$2,$3,$4::jsonb)', [id, id, seeded.category, JSON.stringify(seeded)]);
    const initial = await getDeepAuditLedger(id);
    const checkpoint = async (agentId, index) => {
      const attempt = initial.attempts[agentId];
      const unit = initial.units[index];
      const report = { version: 1, scopeHash: initial.scopeHash, attemptId: agentId, prerequisiteHash: attempt.prerequisiteHash,
        pass: 'static', units: [{ id: unit.id, status: 'evidenced', reason: 'Full static inspection of this scenario', sources: [{ path: 'source.js', blob }],
          evidence: { method: 'Read source and callers', observations: 'No findings in this scenario' } }], candidates: [], stopReason: 'Interrupted' };
      return checkpointDeepAudit({ task, agentId, workspacePath: '/example', success: false }, { ...deps, read: async () => JSON.stringify(report) });
    };
    await Promise.all([checkpoint('first', 0), checkpoint('second', 1)]);
    const persisted = await getDeepAuditLedger(id);
    expect(persisted.units.filter(unit => unit.evidence.static)).toHaveLength(2);
    expect(persisted.attempts.first.reportHash).toBeTruthy();
    expect(persisted.attempts.second.reportHash).toBeTruthy();
    const replay = await checkpointDeepAudit({ task, agentId: 'first', workspacePath: null, success: false }, { read: async () => { throw new Error('Output no longer exists'); } });
    expect(replay).toMatchObject({ satisfiedPasses: 2, discoveryComplete: false });
    expect((await query('SELECT id FROM deep_audit_ledgers WHERE id=$1', [id])).rows).toHaveLength(1);
  });
});

// The DB runner forces portos_test; never run this against the live database.
import { afterAll, describe, expect, it } from 'vitest';
import { checkHealth, query, close } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import { getDeepAuditLedger } from './deepAudit.js';

const health = await checkHealth().catch(error => ({ connected: false, error: error.message }));
const runDb = requireDbOrSkip('deepAudit', health.connected, health.error);
const id = `test-deep-${process.pid}-${Date.now()}`;

afterAll(async () => {
  if (runDb) await query('DELETE FROM deep_audit_ledgers WHERE id=$1', [id]);
  await close();
});

describe.skipIf(!runDb)('Deep audit PostgreSQL persistence', () => {
  it('reads back a retained historical ledger by id and returns null once absent', async () => {
    const stored = { id, appId: id, category: 'code-quality', units: [], candidates: {}, scope: { files: [] } };
    await query('INSERT INTO deep_audit_ledgers (id, app_id, category, ledger) VALUES ($1,$2,$3,$4::jsonb)', [id, id, stored.category, JSON.stringify(stored)]);
    expect(await getDeepAuditLedger(id)).toEqual(stored);
    await query('DELETE FROM deep_audit_ledgers WHERE id=$1', [id]);
    expect(await getDeepAuditLedger(id)).toBeNull();
  });
});

/**
 * Postgres-backed round-trip for the Trusted Organizations registry
 * (issue #2141). Like privacyVault.db.test.js, this needs a live PostgreSQL
 * with the schema applied. If no DB is reachable (CI, fresh checkout) it
 * SKIPS cleanly rather than failing red. Exercises org CRUD, cascade deletes
 * (org delete and vault-record delete both clean up holdings), the
 * getOrgsHoldingRecord join, and the batch status flip. Runs via
 * `npm run test:db` (→ portos_test) ONLY; the db.js guards refuse writes to
 * a non-test DB.
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { checkHealth, ensureSchema, query, close } from '../lib/db.js';

const HEX_KEY = 'd'.repeat(64);
const originalKey = process.env.PRIVACY_VAULT_KEY;
process.env.PRIVACY_VAULT_KEY = HEX_KEY;

let dbReady = false;
let skipReason = '';
{
  const health = await checkHealth().catch((e) => ({ connected: false, error: e?.message }));
  if (!health.connected) {
    skipReason = `Postgres not reachable (${health.error || 'no connection'})`;
  } else {
    await ensureSchema().catch(() => {});
    const probe = await query(
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'privacy_orgs') AS ok`,
    ).catch(() => ({ rows: [{ ok: false }] }));
    if (probe.rows?.[0]?.ok) dbReady = true;
    else skipReason = 'privacy_orgs table not present';
  }
}

if (!dbReady) console.log(`⏭️  privacyOrgs.db.test.js skipped: ${skipReason}`);

describe.skipIf(!dbReady)('privacy orgs DB round-trip', () => {
  let orgs;
  let vault;
  const createdOrgs = [];
  const createdVaultRecords = [];

  beforeAll(async () => {
    orgs = await import('./privacyOrgs.js');
    vault = await import('./privacyVault.js');
  });

  afterAll(async () => {
    for (const id of createdOrgs) {
      await query(`DELETE FROM privacy_orgs WHERE id = $1`, [id]).catch(() => {});
    }
    for (const id of createdVaultRecords) {
      await query(`DELETE FROM privacy_vault_records WHERE id = $1`, [id]).catch(() => {});
    }
    await close();
    if (originalKey === undefined) delete process.env.PRIVACY_VAULT_KEY;
    else process.env.PRIVACY_VAULT_KEY = originalKey;
  });

  it('creates an org, attaches vault holdings, and queries both directions', async () => {
    const record = await vault.createVaultRecord({ type: 'email', label: 'Work email', value: 'me@work.example' });
    createdVaultRecords.push(record.id);

    const org = await orgs.createOrg({ name: 'Acme Bank', category: 'bank', trust: 'trusted' });
    createdOrgs.push(org.id);
    expect(org.category).toBe('bank');

    const holdings = await orgs.setOrgHoldings(org.id, [{ vaultRecordId: record.id, status: 'current' }]);
    expect(holdings).toHaveLength(1);
    expect(holdings[0]).toMatchObject({ vaultRecordId: record.id, vaultType: 'email', vaultMaskedValue: 'm•••@work.example' });
    expect(JSON.stringify(holdings)).not.toContain('me@work.example');

    const forOrg = await orgs.getHoldingsForOrg(org.id);
    expect(forOrg).toHaveLength(1);

    const holdingOrgs = await orgs.getOrgsHoldingRecord(record.id);
    expect(holdingOrgs).toHaveLength(1);
    expect(holdingOrgs[0]).toMatchObject({ orgId: org.id, orgName: 'Acme Bank' });
  });

  it('replace-set semantics: re-calling setOrgHoldings drops anything not listed', async () => {
    const r1 = await vault.createVaultRecord({ type: 'phone', label: 'Cell', value: '+1 503 555 0100' });
    const r2 = await vault.createVaultRecord({ type: 'address', label: 'Home', value: '1 Main St' });
    createdVaultRecords.push(r1.id, r2.id);

    const org = await orgs.createOrg({ name: 'Utility Co' });
    createdOrgs.push(org.id);

    await orgs.setOrgHoldings(org.id, [
      { vaultRecordId: r1.id }, { vaultRecordId: r2.id },
    ]);
    expect(await orgs.getHoldingsForOrg(org.id)).toHaveLength(2);

    await orgs.setOrgHoldings(org.id, [{ vaultRecordId: r1.id, status: 'update_pending' }]);
    const after = await orgs.getHoldingsForOrg(org.id);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ vaultRecordId: r1.id, status: 'update_pending' });
  });

  it('cascades: deleting the org drops its holdings', async () => {
    const record = await vault.createVaultRecord({ type: 'custom', label: 'Misc', value: 'x' });
    createdVaultRecords.push(record.id);
    const org = await orgs.createOrg({ name: 'Temp Org' });
    await orgs.setOrgHoldings(org.id, [{ vaultRecordId: record.id }]);

    await orgs.deleteOrg(org.id);
    const { rows } = await query(`SELECT * FROM privacy_org_holdings WHERE org_id = $1`, [org.id]);
    expect(rows).toHaveLength(0);
    expect(await orgs.getOrg(org.id)).toBe(null);
  });

  it('rejects a nonexistent vaultRecordId as a 400 and rolls back the whole call (transactional)', async () => {
    const record = await vault.createVaultRecord({ type: 'custom', label: 'Real one', value: 'z' });
    createdVaultRecords.push(record.id);
    const org = await orgs.createOrg({ name: 'Rollback Org' });
    createdOrgs.push(org.id);
    // Seed one real holding so we can confirm it survives the failed call untouched.
    await orgs.setOrgHoldings(org.id, [{ vaultRecordId: record.id }]);

    await expect(orgs.setOrgHoldings(org.id, [
      { vaultRecordId: record.id }, { vaultRecordId: '00000000-0000-4000-8000-000000000000' },
    ])).rejects.toMatchObject({ status: 400, code: 'VAULT_RECORD_NOT_FOUND' });

    // The transaction must have rolled back the DELETE-complement too — the
    // pre-existing holding for `record.id` is still there, unchanged.
    const holdings = await orgs.getHoldingsForOrg(org.id);
    expect(holdings).toHaveLength(1);
    expect(holdings[0].vaultRecordId).toBe(record.id);
  });

  it('cascades: deleting the vault record drops its holdings', async () => {
    const record = await vault.createVaultRecord({ type: 'custom', label: 'Misc2', value: 'y' });
    const org = await orgs.createOrg({ name: 'Another Org' });
    createdOrgs.push(org.id);
    await orgs.setOrgHoldings(org.id, [{ vaultRecordId: record.id }]);

    await vault.deleteVaultRecord(record.id);
    const { rows } = await query(`SELECT * FROM privacy_org_holdings WHERE vault_record_id = $1`, [record.id]);
    expect(rows).toHaveLength(0);
  });

  it('batch-flips holdings status across all orgs holding a record', async () => {
    const record = await vault.createVaultRecord({ type: 'address', label: 'Old address', value: '9 Old Rd' });
    createdVaultRecords.push(record.id);
    const orgA = await orgs.createOrg({ name: 'Bank A' });
    const orgB = await orgs.createOrg({ name: 'Bank B' });
    createdOrgs.push(orgA.id, orgB.id);
    await orgs.setOrgHoldings(orgA.id, [{ vaultRecordId: record.id, status: 'current' }]);
    await orgs.setOrgHoldings(orgB.id, [{ vaultRecordId: record.id, status: 'current' }]);

    const result = await orgs.setHoldingsStatus(record.id, 'current', 'update_pending');
    expect(result.updated).toBe(2);
    const holdingOrgs = await orgs.getOrgsHoldingRecord(record.id);
    expect(holdingOrgs.every((h) => h.status === 'update_pending')).toBe(true);
  });

  it('validation rejects unknown enum values at the service boundary via the schema layer', async () => {
    const { privacyOrgCreateSchema } = await import('../lib/privacyValidation.js');
    expect(() => privacyOrgCreateSchema.parse({ name: 'X', trust: 'bogus' })).toThrow();
    expect(() => privacyOrgCreateSchema.parse({ name: 'X', category: 'bogus' })).toThrow();
    expect(() => privacyOrgCreateSchema.parse({ name: 'X', status: 'bogus' })).toThrow();
  });

  it('reports a holdings summary across orgs and vault records', async () => {
    const summary = await orgs.getHoldingsSummary();
    expect(Array.isArray(summary.byOrg)).toBe(true);
    expect(Array.isArray(summary.byVaultRecord)).toBe(true);
  });
});

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

import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { checkHealth, ensureSchema, query, close } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';

// DB tests exercise real row transactions; artifact fixtures live in privacyPromptScrub.test.js.
vi.mock('./privacyPromptScrub.js', () => ({ scrubRevokedPrivacyFacts: vi.fn() }));

const HEX_KEY = 'd'.repeat(64);
const originalKey = process.env.PRIVACY_VAULT_KEY;

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

const runDb = requireDbOrSkip('services/privacyOrgs.db.test', dbReady, skipReason);

describe.skipIf(!runDb)('privacy orgs DB round-trip', () => {
  let orgs;
  let vault;
  const createdOrgs = [];
  const createdVaultRecords = [];

  beforeAll(async () => {
    // Set only while the suite runs, before any service import, so a skipped suite never leaks it.
    process.env.PRIVACY_VAULT_KEY = HEX_KEY;
    orgs = await import('./privacyOrgs.js');
    vault = await import('./privacyVault.js');
  });

  afterAll(async () => {
    try {
      for (const id of createdOrgs) {
        await query(`DELETE FROM privacy_orgs WHERE id = $1`, [id]).catch(() => {});
      }
      for (const id of createdVaultRecords) {
        await query(`DELETE FROM privacy_vault_records WHERE id = $1`, [id]).catch(() => {});
      }
      await close();
    } finally {
      if (originalKey === undefined) delete process.env.PRIVACY_VAULT_KEY;
      else process.env.PRIVACY_VAULT_KEY = originalKey;
    }
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

  it('keeps a held record\'s stored status when the replace-set omits it', async () => {
    const held = await vault.createVaultRecord({ type: 'address', label: 'Old home', value: '2 Example Rd' });
    const added = await vault.createVaultRecord({ type: 'email', label: 'Alt', value: 'alt@example.com' });
    createdVaultRecords.push(held.id, added.id);
    const org = await orgs.createOrg({ name: 'Example Insurer' });
    createdOrgs.push(org.id);

    await orgs.setOrgHoldings(org.id, [{ vaultRecordId: held.id, status: 'update_pending' }]);
    // The org editor sends ids only — an unrelated edit must not reset the mark.
    await orgs.setOrgHoldings(org.id, [{ vaultRecordId: held.id }, { vaultRecordId: added.id }]);
    const byRecord = Object.fromEntries((await orgs.getHoldingsForOrg(org.id)).map((h) => [h.vaultRecordId, h.status]));
    expect(byRecord).toEqual({ [held.id]: 'update_pending', [added.id]: 'current' });
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

  it('validation rejects unknown enum values at the service boundary via the schema layer', async () => {
    const { privacyOrgCreateSchema } = await import('../lib/privacyValidation.js');
    expect(() => privacyOrgCreateSchema.parse({ name: 'X', trust: 'bogus' })).toThrow();
    expect(() => privacyOrgCreateSchema.parse({ name: 'X', category: 'bogus' })).toThrow();
    expect(() => privacyOrgCreateSchema.parse({ name: 'X', status: 'bogus' })).toThrow();
  });

});

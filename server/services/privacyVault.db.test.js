/**
 * Postgres-backed round-trip for the privacy vault (issue #2140).
 *
 * Like moodBoard/db.test.js, this needs a live PostgreSQL with the schema
 * applied. If no DB is reachable (CI, fresh checkout) it SKIPS cleanly rather
 * than failing red. When a DB IS reachable it exercises the full CRUD +
 * reveal + status surface and asserts the encryption-at-rest acceptance
 * criterion: a raw dump of the created rows contains no plaintext. Cleans up
 * only rows it created — no global table mutation. Runs via `npm run test:db`
 * (→ portos_test) ONLY; the db.js guards refuse writes to a non-test DB.
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { checkHealth, ensureSchema, query, close } from '../lib/db.js';

// A valid key BEFORE the service is imported/called so ensureVaultKey never
// touches the repo's real .env during the run.
const HEX_KEY = 'c'.repeat(64);
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
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'privacy_vault_records') AS ok`,
    ).catch(() => ({ rows: [{ ok: false }] }));
    if (probe.rows?.[0]?.ok) dbReady = true;
    else skipReason = 'privacy_vault_records table not present';
  }
}

if (!dbReady) console.log(`⏭️  privacyVault.db.test.js skipped: ${skipReason}`);

describe.skipIf(!dbReady)('privacy vault DB round-trip', () => {
  let vault;
  const created = [];
  let tableWasEmpty = false;
  const testStart = new Date().toISOString();

  beforeAll(async () => {
    vault = await import('./privacyVault.js');
    const { rows } = await query(`SELECT COUNT(*)::int AS n FROM privacy_vault_records`);
    tableWasEmpty = rows[0].n === 0;
  });

  afterAll(async () => {
    for (const id of created) {
      await query(`DELETE FROM privacy_vault_records WHERE id = $1`, [id]).catch(() => {});
    }
    // Only consent rows this run could have created (first-record consent).
    if (tableWasEmpty) {
      await query(
        `DELETE FROM privacy_consents WHERE scope = 'pii_vault' AND granted_at >= $1`,
        [testStart],
      ).catch(() => {});
    }
    await close();
    if (originalKey === undefined) delete process.env.PRIVACY_VAULT_KEY;
    else process.env.PRIVACY_VAULT_KEY = originalKey;
  });

  it('creates a record with ciphertext + mask — raw row has NO plaintext', async () => {
    const record = await vault.createVaultRecord({
      type: 'ssn', label: 'My SSN', value: '123-45-6789',
    });
    created.push(record.id);
    expect(record.maskedValue).toBe('••••6789');
    expect(record.useForScans).toBe(false); // sensitive hard-false
    expect(record).not.toHaveProperty('value_enc');

    // Acceptance criterion: raw table dump carries no plaintext PII.
    const { rows } = await query(`SELECT * FROM privacy_vault_records WHERE id = $1`, [record.id]);
    const rawDump = JSON.stringify(rows[0]);
    expect(rawDump).not.toContain('123-45-6789');
    expect(rows[0].value_enc).toMatch(/^v1:/);
  });

  it('writes the first-record consent row', async () => {
    // createVaultRecord above ran with the pre-test emptiness we captured.
    const { rows } = await query(
      `SELECT scope, method, subject FROM privacy_consents WHERE scope = 'pii_vault' AND granted_at >= $1`,
      [testStart],
    );
    if (tableWasEmpty) {
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]).toMatchObject({ scope: 'pii_vault', method: 'vault-record-create', subject: 'self' });
    } else {
      expect(rows.length).toBe(0); // not the first record → no new consent
    }
  });

  it('lists masked records and filters by type', async () => {
    const record = await vault.createVaultRecord({
      type: 'email', label: 'Main email', value: 'vault-test@example.com',
    });
    created.push(record.id);
    expect(record.useForScans).toBe(true); // scan-default type

    const all = await vault.listVaultRecords();
    const mine = all.find((r) => r.id === record.id);
    expect(mine.maskedValue).toBe('v•••@example.com');
    expect(JSON.stringify(all)).not.toContain('vault-test@example.com');

    const emails = await vault.listVaultRecords({ type: 'email' });
    expect(emails.every((r) => r.type === 'email')).toBe(true);
    expect(emails.some((r) => r.id === record.id)).toBe(true);
  });

  it('reveals the decrypted plaintext through the ONE reveal path', async () => {
    const record = await vault.createVaultRecord({
      type: 'phone', label: 'Cell', value: '+1 503 555 0142',
    });
    created.push(record.id);
    const revealed = await vault.revealValue(record.id);
    expect(revealed).toEqual({ id: record.id, type: 'phone', value: '+1 503 555 0142' });
  });

  it('round-trips valid_from/valid_to as plain YYYY-MM-DD strings (no TZ shift)', async () => {
    const record = await vault.createVaultRecord({
      type: 'address', label: 'Old place', value: '1 Old Rd, Portland, OR', status: 'previous',
      validFrom: '2019-02-01', validTo: '2026-07-04',
    });
    created.push(record.id);
    expect(record.validFrom).toBe('2019-02-01');
    expect(record.validTo).toBe('2026-07-04');
    const fetched = await vault.getVaultRecord(record.id);
    expect(fetched.validFrom).toBe('2019-02-01');
    expect(fetched.validTo).toBe('2026-07-04');
    const cleared = await vault.updateVaultRecord(record.id, { validTo: null });
    expect(cleared.validTo).toBe(null);
  });

  it('updates value (re-encrypt + re-mask) and metadata', async () => {
    const record = await vault.createVaultRecord({
      type: 'address', label: 'Home', value: '123 Main St, Portland, OR 97201',
    });
    created.push(record.id);
    const updated = await vault.updateVaultRecord(record.id, {
      value: '9 Oak Ave, Salem, OR 97301', label: 'New home', status: 'current',
    });
    expect(updated.label).toBe('New home');
    expect(updated.maskedValue).toBe('•••, Salem, OR 97301');
    expect((await vault.revealValue(record.id)).value).toBe('9 Oak Ave, Salem, OR 97301');
  });

  it('hard-rejects useForScans=true on a stored sensitive type', async () => {
    const record = await vault.createVaultRecord({
      type: 'passport', label: 'Passport', value: 'P123456789',
    });
    created.push(record.id);
    expect(record.useForScans).toBe(false);
    await expect(vault.updateVaultRecord(record.id, { useForScans: true }))
      .rejects.toMatchObject({ status: 400, code: 'SENSITIVE_TYPE_SCAN_FORBIDDEN' });
  });

  it('deletes a record and 404s subsequent access', async () => {
    const record = await vault.createVaultRecord({
      type: 'custom', label: 'Temp', value: 'to-delete',
    });
    expect(await vault.deleteVaultRecord(record.id)).toEqual({ ok: true });
    expect(await vault.getVaultRecord(record.id)).toBe(null);
    await expect(vault.revealValue(record.id)).rejects.toMatchObject({ status: 404 });
    await expect(vault.deleteVaultRecord(record.id)).rejects.toMatchObject({ status: 404 });
  });

  it('reports vault status with per-type counts', async () => {
    const status = await vault.getVaultStatus();
    expect(status.keyConfigured).toBe(true);
    expect(typeof status.recordCounts).toBe('object');
  });
});

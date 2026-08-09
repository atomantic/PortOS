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
  let subjects;
  const created = [];
  const createdSubjects = [];
  let selfSubjectId = '';

  beforeAll(async () => {
    vault = await import('./privacyVault.js');
    subjects = await import('./privacySubjects.js');
    selfSubjectId = (await import('../lib/privacyValidation.js')).PRIVACY_SELF_SUBJECT_ID;
  });

  afterAll(async () => {
    for (const id of created) {
      await query(`DELETE FROM privacy_vault_records WHERE id = $1`, [id]).catch(() => {});
    }
    // Household subjects created here cascade their own records + consent rows.
    for (const id of createdSubjects) {
      await query(`DELETE FROM privacy_subjects WHERE id = $1`, [id]).catch(() => {});
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

  it('the seeded self subject always has consent, so a record adds no duplicate (#3658)', async () => {
    // The boot DDL seeds a consent row for `self`, so the install owner is never
    // refused by the engine guard and an ordinary create appends nothing.
    expect(await subjects.hasActiveConsent(selfSubjectId)).toBe(true);
    const before = await query(
      `SELECT COUNT(*)::int AS n FROM privacy_consents WHERE subject_id = $1`, [selfSubjectId],
    );
    const record = await vault.createVaultRecord({
      type: 'email', label: 'Consent probe', value: 'consent-probe@example.com',
    });
    created.push(record.id);
    const after = await query(
      `SELECT COUNT(*)::int AS n FROM privacy_consents WHERE subject_id = $1`, [selfSubjectId],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('writes a household member first-record consent and scopes their records away from self (#3658)', async () => {
    const subject = await subjects.createSubject({
      displayName: 'Example Household Member', relationship: 'partner', consentMethod: 'signed_form',
    });
    createdSubjects.push(subject.id);

    const consents = await subjects.listSubjectConsents(subject.id);
    expect(consents).toHaveLength(1);
    expect(consents[0]).toMatchObject({ scope: 'pii_vault', method: 'signed_form' });

    const record = await vault.createVaultRecord({
      type: 'email', label: 'Member email', value: 'member@example.com', subjectId: subject.id,
    });
    expect(record.subjectId).toBe(subject.id);

    // Their record is invisible to a `self`-scoped list, and vice versa.
    const theirs = await vault.listVaultRecords({ subjectId: subject.id });
    expect(theirs.map((r) => r.id)).toContain(record.id);
    const mine = await vault.listVaultRecords();
    expect(mine.map((r) => r.id)).not.toContain(record.id);

    // Deleting the subject hard-deletes their records by CASCADE (no tombstone).
    await subjects.deleteSubject(subject.id);
    createdSubjects.pop();
    const { rows } = await query(`SELECT id FROM privacy_vault_records WHERE id = $1`, [record.id]);
    expect(rows).toHaveLength(0);
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

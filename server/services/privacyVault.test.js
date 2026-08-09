/**
 * Privacy vault service unit tests (issue #2140) — DB mocked; the live-DB
 * round trip lives in privacyVault.db.test.js (test:db → portos_test only).
 * Pins the encryption-at-write contract (params carry ciphertext + mask,
 * never plaintext), the first-record consent write, and the sensitive-type
 * use_for_scans hard-false rules.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

const { queryMock, withTransactionMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  withTransactionMock: vi.fn(),
}));

vi.mock('../lib/db.js', () => ({
  query: queryMock,
  withTransaction: withTransactionMock,
}));

// #3658: the subject scope + consent trail live in privacySubjects; stubbed so
// these DB-mocked tests keep asserting on the privacy_vault_records SQL.
const SELF = '00000000-0000-4000-8000-000000000001';
const { recordConsentMock } = vi.hoisted(() => ({ recordConsentMock: vi.fn(async () => ({ id: 'consent-1' })) }));
vi.mock('./privacySubjects.js', () => ({
  resolveSubjectId: (id) => id || SELF,
  assertSubject: vi.fn(async (id) => ({ id: id || SELF })),
  recordConsent: recordConsentMock,
}));

const {
  createVaultRecord, listVaultRecords, updateVaultRecord, revealValue, getVaultStatus, resolveUseForScans,
} = await import('./privacyVault.js');
const { encryptValue } = await import('../lib/vaultCrypto.js');

const HEX_KEY = 'b'.repeat(64);
const originalKey = process.env.PRIVACY_VAULT_KEY;

beforeAll(() => { process.env.PRIVACY_VAULT_KEY = HEX_KEY; });
afterAll(() => {
  if (originalKey === undefined) delete process.env.PRIVACY_VAULT_KEY;
  else process.env.PRIVACY_VAULT_KEY = originalKey;
});

beforeEach(() => {
  queryMock.mockReset();
  withTransactionMock.mockReset();
});

const insertedRow = (params) => ({
  id: params[0], subject_id: params[1], type: params[2], label: params[3], masked_value: params[5],
  status: params[6], valid_from: params[7], valid_to: params[8],
  share_with_twin: params[9], use_for_scans: params[10], notes: params[11],
  created_at: 'now', updated_at: 'now',
});

// queryMock playbook for createVaultRecord: consent COUNT probe → INSERT.
// `existingCount` is the subject's EXISTING CONSENT-row count (#3658): 0 means
// this create also writes the subject's first consent row.
function mockCreateFlow({ existingCount = 1 } = {}) {
  queryMock.mockImplementation(async (sql, params) => {
    if (/COUNT\(\*\)/.test(sql)) return { rows: [{ n: existingCount }] };
    if (/INSERT INTO privacy_vault_records/.test(sql)) return { rows: [insertedRow(params)] };
    if (/INSERT INTO privacy_consents/.test(sql)) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  });
}

describe('resolveUseForScans', () => {
  it('hard-forces false for sensitive types even when requested true', () => {
    for (const type of ['ssn', 'passport', 'drivers_license', 'financial_account']) {
      expect(resolveUseForScans(type, true)).toBe(false);
      expect(resolveUseForScans(type, undefined)).toBe(false);
    }
  });

  it('defaults true for scan-default types and false otherwise', () => {
    for (const type of ['legal_name', 'email', 'phone', 'address']) {
      expect(resolveUseForScans(type, undefined)).toBe(true);
    }
    expect(resolveUseForScans('dob', undefined)).toBe(false);
    expect(resolveUseForScans('custom', undefined)).toBe(false);
  });

  it('lets an explicit choice win for non-sensitive types', () => {
    expect(resolveUseForScans('email', false)).toBe(false);
    expect(resolveUseForScans('dob', true)).toBe(true);
  });
});

describe('createVaultRecord', () => {
  it('stores ciphertext + mask — never the plaintext', async () => {
    mockCreateFlow();
    const record = await createVaultRecord({ type: 'ssn', label: 'My SSN', value: '123-45-6789' });
    const insert = queryMock.mock.calls.find(([sql]) => /INSERT INTO privacy_vault_records/.test(sql));
    const params = insert[1];
    expect(params[1]).toBe(SELF); // subject scope defaults to `self` (#3658)
    expect(params[4]).toMatch(/^v1:/); // value_enc
    expect(params[5]).toBe('••••6789'); // masked_value
    expect(params).not.toContain('123-45-6789');
    expect(record.maskedValue).toBe('••••6789');
    expect(record.useForScans).toBe(false); // ssn is hard-false
    expect(record).not.toHaveProperty('valueEnc');
    expect(record).not.toHaveProperty('value_enc');
  });

  it('applies the per-type use_for_scans default', async () => {
    mockCreateFlow();
    const record = await createVaultRecord({ type: 'email', label: 'Main', value: 'a@b.com' });
    expect(record.useForScans).toBe(true);
  });

  it("writes a consent row on the subject's FIRST record only", async () => {
    recordConsentMock.mockClear();
    mockCreateFlow({ existingCount: 0 });
    await createVaultRecord({ type: 'email', label: 'Main', value: 'a@b.com' });
    expect(recordConsentMock).toHaveBeenCalledWith({ subjectId: SELF, scope: 'pii_vault', method: 'vault-record-create' });

    recordConsentMock.mockClear();
    mockCreateFlow({ existingCount: 3 });
    await createVaultRecord({ type: 'email', label: 'Alt', value: 'c@d.com' });
    expect(recordConsentMock).not.toHaveBeenCalled();
  });

  it('scopes the record to an explicit household subject when one is given (#3658)', async () => {
    mockCreateFlow();
    const record = await createVaultRecord({ type: 'email', label: 'Main', value: 'a@b.com', subjectId: 'subject-2' });
    const insert = queryMock.mock.calls.find(([sql]) => /INSERT INTO privacy_vault_records/.test(sql));
    expect(insert[1][1]).toBe('subject-2');
    expect(record.subjectId).toBe('subject-2');
  });
});

describe('listVaultRecords', () => {
  it('scopes to the subject and binds the type filter as $2 (not a literal)', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await listVaultRecords({ type: 'email' });
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/WHERE subject_id = \$1 AND type = \$2/);
    expect(params).toEqual([SELF, 'email']);
  });

  it('omits the type clause when no type is given', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await listVaultRecords({ subjectId: 'subject-2' });
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/WHERE subject_id = \$1 ORDER BY/);
    expect(params).toEqual(['subject-2']);
  });
});

describe('updateVaultRecord', () => {
  function mockLockedRow(row) {
    const client = {
      query: vi.fn(async (sql, params) => {
        if (/FOR UPDATE/.test(sql)) return { rows: row ? [row] : [] };
        if (/UPDATE privacy_vault_records/.test(sql)) {
          return { rows: [{ ...insertedRow(['id', row.type, '', 'enc', 'mask', 'current', null, null, false, false, '']), id: row.id }] };
        }
        throw new Error(`unexpected client query: ${sql}`);
      }),
    };
    withTransactionMock.mockImplementation(async (fn) => fn(client));
    return client;
  }

  it('rejects useForScans=true against a stored sensitive type', async () => {
    mockLockedRow({ id: 'r1', type: 'passport' });
    await expect(updateVaultRecord('r1', { useForScans: true }))
      .rejects.toMatchObject({ status: 400, code: 'SENSITIVE_TYPE_SCAN_FORBIDDEN' });
  });

  it('404s an unknown record', async () => {
    mockLockedRow(null);
    await expect(updateVaultRecord('missing', { label: 'x' }))
      .rejects.toMatchObject({ status: 404 });
  });

  it('re-encrypts and re-masks when value changes', async () => {
    const client = mockLockedRow({ id: 'r1', type: 'phone' });
    await updateVaultRecord('r1', { value: '503-555-0142' });
    const update = client.query.mock.calls.find(([sql]) => /UPDATE privacy_vault_records/.test(sql));
    expect(update[1][0]).toMatch(/^v1:/);
    expect(update[1][1]).toBe('••••0142');
    expect(update[1]).not.toContain('503-555-0142');
  });
});

describe('revealValue', () => {
  it('decrypts the stored ciphertext', async () => {
    const enc = encryptValue('my secret value');
    queryMock.mockResolvedValue({ rows: [{ id: 'r1', type: 'custom', value_enc: enc }] });
    expect(await revealValue('r1')).toEqual({ id: 'r1', type: 'custom', value: 'my secret value' });
  });

  it('404s an unknown record', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await expect(revealValue('missing')).rejects.toMatchObject({ status: 404 });
  });
});

describe('getVaultStatus', () => {
  it('reports key state and per-type counts', async () => {
    queryMock.mockResolvedValue({ rows: [{ type: 'email', n: 2 }, { type: 'ssn', n: 1 }] });
    expect(await getVaultStatus()).toEqual({
      keyConfigured: true,
      subjectId: SELF,
      recordCounts: { email: 2, ssn: 1 },
    });
  });
});

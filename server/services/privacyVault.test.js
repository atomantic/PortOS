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

const {
  createVaultRecord, updateVaultRecord, revealValue, getVaultStatus, resolveUseForScans,
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
  id: params[0], type: params[1], label: params[2], masked_value: params[4],
  status: params[5], valid_from: params[6], valid_to: params[7],
  share_with_twin: params[8], use_for_scans: params[9], notes: params[10],
  created_at: 'now', updated_at: 'now',
});

// queryMock playbook for createVaultRecord: COUNT probe → INSERT → (consent INSERT).
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
    expect(params[3]).toMatch(/^v1:/); // value_enc
    expect(params[4]).toBe('••••6789'); // masked_value
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

  it('writes a consent row on the FIRST record only', async () => {
    mockCreateFlow({ existingCount: 0 });
    await createVaultRecord({ type: 'email', label: 'Main', value: 'a@b.com' });
    expect(queryMock.mock.calls.some(([sql]) => /INSERT INTO privacy_consents/.test(sql))).toBe(true);

    queryMock.mockClear();
    mockCreateFlow({ existingCount: 3 });
    await createVaultRecord({ type: 'email', label: 'Alt', value: 'c@d.com' });
    expect(queryMock.mock.calls.some(([sql]) => /INSERT INTO privacy_consents/.test(sql))).toBe(false);
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
      recordCounts: { email: 2, ssn: 1 },
    });
  });
});

/**
 * Trusted Organizations registry service unit tests (issue #2141) — DB
 * mocked; the live-DB round trip lives in privacyOrgs.db.test.js (test:db →
 * portos_test only). Pins CRUD param shapes, the replace-set holdings
 * semantics, the batch status-flip query, and the 404 paths.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock, withTransactionMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  withTransactionMock: vi.fn(),
}));

vi.mock('../lib/db.js', () => ({ query: queryMock, withTransaction: withTransactionMock }));

const {
  createOrg, listOrgs, getOrg, updateOrg, deleteOrg,
  getHoldingsForOrg, getOrgsHoldingRecord, setOrgHoldings, setHoldingsStatus, getHoldingsSummary,
} = await import('./privacyOrgs.js');

beforeEach(() => {
  queryMock.mockReset();
  withTransactionMock.mockReset();
});

/** Fakes a transactional client whose `.query` is driven by the given handler. */
function mockTransaction(handler) {
  const client = { query: vi.fn(handler) };
  withTransactionMock.mockImplementation(async (fn) => fn(client));
  return client;
}

const orgRow = (overrides = {}) => ({
  id: 'o1', name: 'Acme Bank', category: 'bank', website: 'https://acme.example',
  trust: 'trusted', status: 'active', contact: {}, social_account_id: null,
  notes: '', created_at: 'now', updated_at: 'now', ...overrides,
});

describe('createOrg', () => {
  it('inserts with defaults for optional fields', async () => {
    queryMock.mockResolvedValue({ rows: [orgRow()] });
    const org = await createOrg({ name: 'Acme Bank' });
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO privacy_orgs/);
    expect(params[1]).toBe('Acme Bank');
    expect(params[2]).toBe('other'); // category default
    expect(params[4]).toBe('trusted'); // trust default
    expect(params[5]).toBe('active'); // status default
    expect(org.name).toBe('Acme Bank');
  });

  it('serializes contact as JSON', async () => {
    queryMock.mockResolvedValue({ rows: [orgRow()] });
    await createOrg({ name: 'Acme', contact: { email: 'a@b.com' } });
    const [, params] = queryMock.mock.calls[0];
    expect(params[6]).toBe(JSON.stringify({ email: 'a@b.com' }));
  });
});

describe('listOrgs', () => {
  it('lists with no filters', async () => {
    queryMock.mockResolvedValue({ rows: [orgRow()] });
    const orgs = await listOrgs();
    expect(orgs).toHaveLength(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).not.toMatch(/WHERE/);
    expect(params).toEqual([]);
  });

  it('applies trust/status/category filters', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await listOrgs({ trust: 'unwanted', status: 'active', category: 'broker' });
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/trust = \$1/);
    expect(sql).toMatch(/status = \$2/);
    expect(sql).toMatch(/category = \$3/);
    expect(params).toEqual(['unwanted', 'active', 'broker']);
  });
});

describe('getOrg', () => {
  it('returns null for a missing org', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    expect(await getOrg('missing')).toBe(null);
  });
});

describe('updateOrg', () => {
  it('builds a partial SET clause for only the provided fields', async () => {
    queryMock.mockResolvedValue({ rows: [orgRow({ name: 'Renamed' })] });
    const updated = await updateOrg('o1', { name: 'Renamed' });
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/SET name = \$1, updated_at = NOW\(\)/);
    expect(params).toEqual(['Renamed', 'o1']);
    expect(updated.name).toBe('Renamed');
  });

  it('404s an unknown org', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await expect(updateOrg('missing', { name: 'x' })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});

describe('deleteOrg', () => {
  it('404s an unknown org', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await expect(deleteOrg('missing')).rejects.toMatchObject({ status: 404 });
  });

  it('deletes and returns ok', async () => {
    queryMock.mockResolvedValue({ rows: [{ id: 'o1' }] });
    expect(await deleteOrg('o1')).toEqual({ ok: true });
  });
});

describe('getHoldingsForOrg / getOrgsHoldingRecord', () => {
  it('joins masked vault fields only — never value_enc', async () => {
    queryMock.mockResolvedValue({
      rows: [{
        org_id: 'o1', vault_record_id: 'v1', status: 'current', noted_at: 'now', updated_at: 'now',
        type: 'email', label: 'Main', masked_value: 'a•••@b.com',
      }],
    });
    const holdings = await getHoldingsForOrg('o1');
    expect(holdings[0]).toEqual({
      orgId: 'o1', vaultRecordId: 'v1', status: 'current', notedAt: 'now', updatedAt: 'now',
      vaultType: 'email', vaultLabel: 'Main', vaultMaskedValue: 'a•••@b.com',
    });
    expect(JSON.stringify(holdings)).not.toMatch(/value_enc/);
  });

  it('getOrgsHoldingRecord joins org name', async () => {
    queryMock.mockResolvedValue({
      rows: [{ org_id: 'o1', vault_record_id: 'v1', status: 'current', noted_at: 'now', updated_at: 'now', org_name: 'Acme Bank' }],
    });
    const orgs = await getOrgsHoldingRecord('v1');
    expect(orgs[0]).toMatchObject({ orgId: 'o1', orgName: 'Acme Bank' });
  });
});

describe('setOrgHoldings', () => {
  it('404s an unknown org before writing anything, inside the transaction', async () => {
    const client = mockTransaction(async (sql) => {
      if (/FROM privacy_orgs WHERE id/.test(sql)) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });
    await expect(setOrgHoldings('missing', [{ vaultRecordId: 'v1' }]))
      .rejects.toMatchObject({ status: 404 });
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(queryMock).not.toHaveBeenCalled(); // getHoldingsForOrg never reached
  });

  it('deletes the complement and upserts the given set, all inside one transaction', async () => {
    const client = mockTransaction(async (sql) => {
      if (/FROM privacy_orgs WHERE id/.test(sql)) return { rows: [orgRow()] };
      if (/DELETE FROM privacy_org_holdings/.test(sql)) return { rows: [] };
      if (/INSERT INTO privacy_org_holdings/.test(sql)) return { rows: [] };
      throw new Error(`unexpected client query: ${sql}`);
    });
    queryMock.mockResolvedValue({ rows: [] }); // getHoldingsForOrg after commit
    await setOrgHoldings('o1', [{ vaultRecordId: 'v1', status: 'current' }, { vaultRecordId: 'v2' }]);
    const deleteCall = client.query.mock.calls.find(([sql]) => /DELETE FROM privacy_org_holdings/.test(sql));
    expect(deleteCall[1]).toEqual(['o1', ['v1', 'v2']]);
    const insertCalls = client.query.mock.calls.filter(([sql]) => /INSERT INTO privacy_org_holdings/.test(sql));
    expect(insertCalls).toHaveLength(2);
    expect(insertCalls[1][1]).toEqual(['o1', 'v2', 'current']); // default status applied
    expect(withTransactionMock).toHaveBeenCalledTimes(1);
  });

  it('clears all holdings when given an empty list', async () => {
    const client = mockTransaction(async (sql) => {
      if (/FROM privacy_orgs WHERE id/.test(sql)) return { rows: [orgRow()] };
      if (/DELETE FROM privacy_org_holdings WHERE org_id = \$1$/.test(sql)) return { rows: [] };
      throw new Error(`unexpected client query: ${sql}`);
    });
    queryMock.mockResolvedValue({ rows: [] });
    await setOrgHoldings('o1', []);
    const deleteCall = client.query.mock.calls.find(([sql]) => /DELETE FROM privacy_org_holdings/.test(sql));
    expect(deleteCall[1]).toEqual(['o1']);
  });

  it('surfaces a stale/unknown vaultRecordId as a 400, not a raw FK-violation 500', async () => {
    const fkError = Object.assign(new Error('insert or update on table violates foreign key constraint'), { code: '23503' });
    mockTransaction(async (sql) => {
      if (/FROM privacy_orgs WHERE id/.test(sql)) return { rows: [orgRow()] };
      if (/DELETE FROM privacy_org_holdings/.test(sql)) return { rows: [] };
      if (/INSERT INTO privacy_org_holdings/.test(sql)) throw fkError;
      throw new Error(`unexpected client query: ${sql}`);
    });
    await expect(setOrgHoldings('o1', [{ vaultRecordId: 'missing-vault-id' }]))
      .rejects.toMatchObject({ status: 400, code: 'VAULT_RECORD_NOT_FOUND' });
  });
});

describe('setHoldingsStatus', () => {
  it('flips only rows matching fromStatus and reports the count', async () => {
    queryMock.mockResolvedValue({ rows: [{ org_id: 'o1', vault_record_id: 'v1' }, { org_id: 'o2', vault_record_id: 'v1' }] });
    const result = await setHoldingsStatus('v1', 'current', 'update_pending');
    expect(result).toEqual({ updated: 2 });
    const [, params] = queryMock.mock.calls[0];
    expect(params).toEqual(['update_pending', 'v1', 'current']);
  });
});

describe('getHoldingsSummary', () => {
  it('returns per-org and per-vault-record counts', async () => {
    queryMock.mockImplementation(async (sql) => {
      if (/FROM privacy_orgs o/.test(sql)) return { rows: [{ org_id: 'o1', org_name: 'Acme', holding_count: 2 }] };
      if (/FROM privacy_vault_records v/.test(sql)) return { rows: [{ vault_record_id: 'v1', type: 'email', label: 'Main', org_count: 1 }] };
      throw new Error(`unexpected query: ${sql}`);
    });
    const summary = await getHoldingsSummary();
    expect(summary.byOrg).toEqual([{ orgId: 'o1', orgName: 'Acme', holdingCount: 2 }]);
    expect(summary.byVaultRecord).toEqual([{ vaultRecordId: 'v1', type: 'email', label: 'Main', orgCount: 1 }]);
  });
});

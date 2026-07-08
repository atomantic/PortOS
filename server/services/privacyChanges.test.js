/**
 * Change-of-address inventory service unit tests (issue #2143) — DB + sibling
 * services mocked; the live-DB round trip lives in privacyChanges.db.test.js
 * (test:db → portos_test only). Pins the declare transaction sequence (old
 * record retired, holdings flipped, forward-holding mirrored, event written),
 * the idempotent per-org marks, the removal-drops-replacement-holding rule,
 * the draft-email unapproved-draft contract, and the pure helpers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock, withTransactionMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  withTransactionMock: vi.fn(),
}));

vi.mock('../lib/db.js', () => ({ query: queryMock, withTransaction: withTransactionMock }));
vi.mock('../lib/vaultCrypto.js', () => ({
  encryptValue: (v) => `enc(${v})`,
  maskValue: (t, v) => `mask(${t}:${v})`,
  ensureVaultKey: vi.fn(async () => {}),
}));
vi.mock('./privacyVault.js', () => ({
  resolveUseForScans: (_t, req) => req ?? true,
  getVaultRecord: vi.fn(async (id) => ({ id, type: 'address', label: 'Old', maskedValue: 'mask-old' })),
  revealValue: vi.fn(async (id) => ({ id, type: 'address', value: '742 New Ave' })),
}));
vi.mock('./privacyOrgs.js', () => ({
  getOrg: vi.fn(async (id) => ({ id, name: 'Acme Bank', contact: { email: 'ops@acme.example' } })),
}));
vi.mock('./messageAccounts.js', () => ({
  listAccounts: vi.fn(async () => [{ id: 'acct-1', type: 'gmail', name: 'Primary' }]),
}));
vi.mock('./messageDrafts.js', () => ({
  createDraft: vi.fn(async (data) => ({ id: 'draft-1', status: 'draft', ...data })),
}));

const {
  declareChange, listChangeEvents, getChangeProgress, markOrgUpdated, markOrgRemoved,
  draftUpdateEmail, renderUpdateEmailBody, kindForType,
} = await import('./privacyChanges.js');

const privacyVault = await import('./privacyVault.js');
const privacyOrgs = await import('./privacyOrgs.js');
const messageAccounts = await import('./messageAccounts.js');

beforeEach(() => {
  queryMock.mockReset();
  withTransactionMock.mockReset();
  privacyVault.getVaultRecord.mockClear();
  privacyVault.revealValue.mockClear();
  privacyOrgs.getOrg.mockClear();
  messageAccounts.listAccounts.mockClear();
});

function mockTransaction(handler) {
  const client = { query: vi.fn(handler) };
  withTransactionMock.mockImplementation(async (fn) => fn(client));
  return client;
}

const eventRow = (overrides = {}) => ({
  id: 'ev1', vault_record_id: 'old1', replacement_record_id: 'new1',
  kind: 'address_change', declared_at: 'now', note: '', ...overrides,
});

describe('kindForType', () => {
  it('maps vault types to change kinds and defaults to other', () => {
    expect(kindForType('address')).toBe('address_change');
    expect(kindForType('phone')).toBe('phone_change');
    expect(kindForType('email')).toBe('email_change');
    expect(kindForType('legal_name')).toBe('name_change');
    expect(kindForType('passport')).toBe('other');
  });
});

describe('renderUpdateEmailBody', () => {
  it('includes the new value and masked old value', () => {
    const body = renderUpdateEmailBody({
      orgName: 'Acme', fieldLabel: 'mailing address', oldMasked: '••• Old St', newValue: '742 New Ave',
    });
    expect(body).toContain('Acme');
    expect(body).toContain('New mailing address: 742 New Ave');
    expect(body).toContain('Previous mailing address on record: ••• Old St');
  });

  it('omits the previous line when no masked old value is supplied', () => {
    const body = renderUpdateEmailBody({ fieldLabel: 'phone number', newValue: '555-0100' });
    expect(body).toContain('New phone number: 555-0100');
    expect(body).not.toContain('Previous');
  });
});

describe('declareChange', () => {
  it('retires the old record, creates the inline replacement, flips holdings, mirrors forward holdings, and writes the event', async () => {
    const client = mockTransaction(async (sql) => {
      if (/FROM privacy_vault_records WHERE id = \$1 FOR UPDATE/.test(sql)) return { rows: [{ id: 'old1', type: 'address' }] };
      if (/INSERT INTO privacy_vault_records/.test(sql)) return { rows: [] };
      if (/UPDATE privacy_vault_records\s+SET status = 'previous'/.test(sql)) return { rows: [] };
      if (/UPDATE privacy_org_holdings SET status = 'update_pending'/.test(sql)) return { rows: [{ org_id: 'o1' }, { org_id: 'o2' }] };
      if (/INSERT INTO privacy_org_holdings/.test(sql)) return { rows: [] };
      if (/INSERT INTO privacy_change_events/.test(sql)) return { rows: [eventRow()] };
      throw new Error(`unexpected query: ${sql}`);
    });

    const event = await declareChange({
      vaultRecordId: 'old1',
      replacement: { label: 'New home', value: '742 New Ave' },
      note: 'moved',
    });

    expect(event).toMatchObject({ id: 'ev1', vaultRecordId: 'old1', replacementRecordId: 'new1', kind: 'address_change' });
    // Old record retired.
    const retire = client.query.mock.calls.find(([s]) => /SET status = 'previous'/.test(s));
    expect(retire[0]).toMatch(/valid_to = COALESCE\(valid_to, CURRENT_DATE\)/);
    // Replacement created with inherited type + encrypted value.
    const insertRec = client.query.mock.calls.find(([s]) => /INSERT INTO privacy_vault_records/.test(s));
    expect(insertRec[1]).toContain('enc(742 New Ave)');
    // Both flipped orgs got a forward-looking current holding on the new record.
    const forwardInserts = client.query.mock.calls.filter(([s]) => /INSERT INTO privacy_org_holdings/.test(s));
    expect(forwardInserts).toHaveLength(2);
    // Event kind derived from the old record type when none supplied.
    const insertEvent = client.query.mock.calls.find(([s]) => /INSERT INTO privacy_change_events/.test(s));
    expect(insertEvent[1]).toContain('address_change');
  });

  it('404s when the old record does not exist', async () => {
    mockTransaction(async (sql) => {
      if (/FOR UPDATE/.test(sql)) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });
    await expect(declareChange({ vaultRecordId: 'missing', replacement: { label: 'x', value: 'y' } }))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('400s when linking a replacementRecordId that does not exist', async () => {
    mockTransaction(async (sql) => {
      if (/FOR UPDATE/.test(sql)) return { rows: [{ id: 'old1', type: 'email' }] };
      if (/FROM privacy_vault_records WHERE id = \$1$/.test(sql)) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });
    await expect(declareChange({ vaultRecordId: 'old1', replacementRecordId: 'bad', kind: 'email_change' }))
      .rejects.toMatchObject({ status: 400, code: 'REPLACEMENT_NOT_FOUND' });
  });

  it('skips forward holdings for a removal-only change (no replacement)', async () => {
    const client = mockTransaction(async (sql) => {
      if (/FOR UPDATE/.test(sql)) return { rows: [{ id: 'old1', type: 'address' }] };
      if (/SET status = 'previous'/.test(sql)) return { rows: [] };
      if (/UPDATE privacy_org_holdings SET status = 'update_pending'/.test(sql)) return { rows: [{ org_id: 'o1' }] };
      if (/INSERT INTO privacy_change_events/.test(sql)) return { rows: [eventRow({ replacement_record_id: null })] };
      throw new Error(`unexpected query: ${sql}`);
    });
    const event = await declareChange({ vaultRecordId: 'old1', kind: 'other' });
    expect(event.replacementRecordId).toBe(null);
    expect(client.query.mock.calls.filter(([s]) => /INSERT INTO privacy_org_holdings/.test(s))).toHaveLength(0);
  });
});

describe('getChangeProgress', () => {
  it('groups the old record holdings by inventory status', async () => {
    queryMock.mockImplementation(async (sql) => {
      if (/FROM privacy_change_events WHERE id/.test(sql)) return { rows: [eventRow()] };
      if (/FROM privacy_org_holdings h/.test(sql)) {
        return { rows: [
          { org_id: 'o1', status: 'update_pending', org_name: 'Bank A', website: 'https://a', contact: { email: 'a@a' } },
          { org_id: 'o2', status: 'updated', org_name: 'Bank B', website: null, contact: {} },
          { org_id: 'o3', status: 'removed', org_name: 'Bank C', website: null, contact: null },
        ] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const groups = await getChangeProgress('ev1');
    expect(groups.pending).toEqual([{ orgId: 'o1', orgName: 'Bank A', website: 'https://a', contactEmail: 'a@a' }]);
    expect(groups.updated[0]).toMatchObject({ orgId: 'o2', contactEmail: null });
    expect(groups.removed[0]).toMatchObject({ orgId: 'o3', website: null, contactEmail: null });
  });

  it('404s an unknown event', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await expect(getChangeProgress('missing')).rejects.toMatchObject({ status: 404 });
  });
});

describe('markOrgUpdated', () => {
  it('flips the org holding to updated and returns fresh progress', async () => {
    queryMock.mockImplementation(async (sql) => {
      if (/FROM privacy_change_events WHERE id/.test(sql)) return { rows: [eventRow()] };
      if (/UPDATE privacy_org_holdings SET status = \$1/.test(sql)) return { rows: [{ org_id: 'o1' }] };
      if (/FROM privacy_org_holdings h/.test(sql)) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });
    const groups = await markOrgUpdated('ev1', 'o1');
    const updateCall = queryMock.mock.calls.find(([s]) => /SET status = \$1/.test(s));
    expect(updateCall[1][0]).toBe('updated');
    expect(groups).toEqual({ pending: [], updated: [], removed: [] });
  });

  it('404s when the org is not part of this change (idempotent guard also covers already-terminal)', async () => {
    queryMock.mockImplementation(async (sql) => {
      if (/FROM privacy_change_events WHERE id/.test(sql)) return { rows: [eventRow()] };
      if (/UPDATE privacy_org_holdings SET status = \$1/.test(sql)) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });
    await expect(markOrgUpdated('ev1', 'nope')).rejects.toMatchObject({ status: 404, code: 'HOLDING_NOT_FOUND' });
  });
});

describe('markOrgRemoved', () => {
  it('flips to removed and drops the forward holding on the replacement record', async () => {
    // getChangeEvent (pool query) then a transaction.
    queryMock.mockImplementation(async (sql) => {
      if (/FROM privacy_change_events WHERE id/.test(sql)) return { rows: [eventRow()] };
      if (/FROM privacy_org_holdings h/.test(sql)) return { rows: [] };
      throw new Error(`unexpected pool query: ${sql}`);
    });
    const client = mockTransaction(async (sql) => {
      if (/UPDATE privacy_org_holdings SET status = 'removed'/.test(sql)) return { rows: [{ org_id: 'o1' }] };
      if (/DELETE FROM privacy_org_holdings/.test(sql)) return { rows: [] };
      throw new Error(`unexpected client query: ${sql}`);
    });
    await markOrgRemoved('ev1', 'o1');
    const del = client.query.mock.calls.find(([s]) => /DELETE FROM privacy_org_holdings/.test(s));
    expect(del[1]).toEqual(['new1', 'o1']); // replacement record + org
  });
});

describe('listChangeEvents', () => {
  it('maps rows with progress counts + masked old/new values', async () => {
    queryMock.mockResolvedValue({ rows: [{
      ...eventRow(),
      old_type: 'address', old_label: 'Old', old_masked: 'mask-old',
      new_type: 'address', new_label: 'New', new_masked: 'mask-new',
      pending_count: 2, updated_count: 1, removed_count: 0,
    }] });
    const list = await listChangeEvents();
    expect(list[0]).toMatchObject({
      id: 'ev1',
      oldRecord: { type: 'address', maskedValue: 'mask-old' },
      replacementRecord: { maskedValue: 'mask-new' },
      progress: { pending: 2, updated: 1, removed: 0, total: 3 },
    });
    expect(JSON.stringify(list)).not.toContain('value_enc');
  });
});

describe('draftUpdateEmail', () => {
  it('creates an UNAPPROVED draft (status draft) to the org contact email', async () => {
    queryMock.mockImplementation(async (sql) => {
      if (/FROM privacy_change_events WHERE id/.test(sql)) return { rows: [eventRow()] };
      throw new Error(`unexpected query: ${sql}`);
    });
    const result = await draftUpdateEmail('ev1', 'o1');
    expect(result).toEqual({ draftId: 'draft-1', status: 'draft' });
    expect(privacyVault.revealValue).toHaveBeenCalledWith('new1');
  });

  it('400s a removal-only change with no replacement to update to', async () => {
    queryMock.mockResolvedValue({ rows: [eventRow({ replacement_record_id: null })] });
    await expect(draftUpdateEmail('ev1', 'o1')).rejects.toMatchObject({ status: 400, code: 'REPLACEMENT_REQUIRED' });
  });

  it('400s when the org has no contact email', async () => {
    queryMock.mockImplementation(async (sql) => {
      if (/FROM privacy_change_events WHERE id/.test(sql)) return { rows: [eventRow()] };
      throw new Error(`unexpected query: ${sql}`);
    });
    privacyOrgs.getOrg.mockResolvedValueOnce({ id: 'o1', name: 'NoEmail', contact: {} });
    await expect(draftUpdateEmail('ev1', 'o1')).rejects.toMatchObject({ status: 400, code: 'ORG_EMAIL_MISSING' });
  });
});

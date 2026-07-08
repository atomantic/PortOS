/**
 * Unit test for the Digital Twin ↔ org social-account cross-link reverse index
 * (issue #2147). DB mocked — never touches real Postgres, not a *.db.test.js.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));

const { query } = await import('../lib/db.js');
const { getOrgsBySocialAccounts } = await import('./privacyOrgs.js');

// Route by SQL: the existence gate runs first, then the select.
function routeQueries({ orgsTable = 'privacy_orgs', rows = [] } = {}) {
  query.mockImplementation((sql) => {
    if (sql?.includes('to_regclass')) return Promise.resolve({ rows: [{ orgs: orgsTable }] });
    return Promise.resolve({ rows });
  });
}

beforeEach(() => query.mockReset());

describe('getOrgsBySocialAccounts', () => {
  it('maps only orgs that reference a social account, keyed for the twin', async () => {
    routeQueries({ rows: [
      { id: 'org-1', name: 'GitHub', social_account_id: 'acct-1' },
      { id: 'org-2', name: 'Acme', social_account_id: 'acct-2' },
    ] });
    const result = await getOrgsBySocialAccounts();
    // Filters to non-null social_account_id in SQL.
    const selectCall = query.mock.calls.find(([sql]) => sql?.includes('WHERE social_account_id IS NOT NULL'));
    expect(selectCall).toBeDefined();
    expect(result).toEqual([
      { socialAccountId: 'acct-1', orgId: 'org-1', orgName: 'GitHub' },
      { socialAccountId: 'acct-2', orgId: 'org-2', orgName: 'Acme' },
    ]);
  });

  it('returns an empty array when no orgs are linked', async () => {
    routeQueries({ rows: [] });
    expect(await getOrgsBySocialAccounts()).toEqual([]);
  });

  it('degrades to an empty array when the privacy_orgs table is absent', async () => {
    routeQueries({ orgsTable: null });
    expect(await getOrgsBySocialAccounts()).toEqual([]);
    // Never runs the select when the table doesn't exist.
    expect(query.mock.calls.some(([sql]) => sql?.includes('WHERE social_account_id IS NOT NULL'))).toBe(false);
  });
});

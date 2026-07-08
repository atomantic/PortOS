/**
 * Unit test for the Digital Twin ↔ org social-account cross-link reverse index
 * (issue #2147). DB mocked — never touches real Postgres, not a *.db.test.js.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
vi.mock('../lib/db.js', () => ({
  query: (...args) => query(...args),
  withTransaction: vi.fn(),
}));

const { getOrgsBySocialAccounts } = await import('./privacyOrgs.js');

beforeEach(() => query.mockReset());

describe('getOrgsBySocialAccounts', () => {
  it('maps only orgs that reference a social account, keyed for the twin', async () => {
    query.mockResolvedValue({
      rows: [
        { id: 'org-1', name: 'GitHub', social_account_id: 'acct-1' },
        { id: 'org-2', name: 'Acme', social_account_id: 'acct-2' },
      ],
    });
    const result = await getOrgsBySocialAccounts();
    // Filters to non-null social_account_id in SQL.
    expect(query.mock.calls[0][0]).toContain('social_account_id IS NOT NULL');
    expect(result).toEqual([
      { socialAccountId: 'acct-1', orgId: 'org-1', orgName: 'GitHub' },
      { socialAccountId: 'acct-2', orgId: 'org-2', orgName: 'Acme' },
    ]);
  });

  it('returns an empty array when no orgs are linked', async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await getOrgsBySocialAccounts()).toEqual([]);
  });
});

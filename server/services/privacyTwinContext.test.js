/**
 * Unit tests for getPrivacyTwinContext (issue #2147). DB + crypto are mocked —
 * this is a pure logic test, never touches a real Postgres (see CLAUDE.md
 * DB-test safety) and never runs as a *.db.test.js.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
vi.mock('../lib/db.js', () => ({ query: (...args) => query(...args) }));
// decrypt is deterministic in the mock: ciphertext "enc:<v>" → "<v>".
vi.mock('../lib/vaultCrypto.js', () => ({
  decryptValue: vi.fn((ct) => ct.replace(/^enc:/, '')),
}));

const { getPrivacyTwinContext } = await import('./privacyTwinContext.js');
const { decryptValue } = await import('../lib/vaultCrypto.js');

// Route a query to a canned result by matching a substring of the SQL.
function routeQueries(map) {
  query.mockImplementation((sql) => {
    for (const [needle, rows] of map) {
      if (sql.includes(needle)) return Promise.resolve({ rows });
    }
    return Promise.resolve({ rows: [] });
  });
}

const ALL_TABLES = [{ vault: 'privacy_vault_records', orgs: 'privacy_orgs', broker: 'privacy_broker_cases' }];

beforeEach(() => {
  query.mockReset();
  decryptValue.mockClear();
});

describe('getPrivacyTwinContext', () => {
  it('returns empty string when the vault table does not exist (graceful degrade)', async () => {
    routeQueries([['to_regclass', [{ vault: null, orgs: null, broker: null }]]]);
    expect(await getPrivacyTwinContext()).toBe('');
    // Never queries records when the vault table is absent.
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('injects only share_with_twin records, decrypted at injection time', async () => {
    routeQueries([
      ['to_regclass', [{ vault: 'privacy_vault_records', orgs: null, broker: null }]],
      ['FROM privacy_vault_records', [
        { type: 'legal_name', label: 'Legal name', status: 'current', value_enc: 'enc:Ada Lovelace' },
        { type: 'address', label: 'Home', status: 'previous', value_enc: 'enc:1 Old St' },
      ]],
    ]);
    const out = await getPrivacyTwinContext();
    // Per-field gate is enforced in SQL.
    const recordCall = query.mock.calls.find(([sql]) => sql.includes('FROM privacy_vault_records'));
    expect(recordCall[0]).toContain('share_with_twin = true');
    // Decrypted values present; masked/ciphertext never leaks.
    expect(out).toContain('Ada Lovelace');
    expect(out).toContain('address (previous): 1 Old St');
    expect(out).not.toContain('enc:');
    expect(decryptValue).toHaveBeenCalledTimes(2);
  });

  it('returns empty string when nothing is flagged and no orgs exist', async () => {
    routeQueries([
      ['to_regclass', [{ vault: 'privacy_vault_records', orgs: 'privacy_orgs', broker: null }]],
      ['FROM privacy_vault_records', []],
      ['FROM privacy_orgs', []],
    ]);
    expect(await getPrivacyTwinContext()).toBe('');
  });

  it('adds a one-line org summary grouped by trust + category span', async () => {
    routeQueries([
      ['to_regclass', [{ vault: 'privacy_vault_records', orgs: 'privacy_orgs', broker: null }]],
      ['FROM privacy_vault_records', [
        { type: 'email', label: 'Main', status: 'current', value_enc: 'enc:a@b.com' },
      ]],
      ['FROM privacy_orgs', [
        { trust: 'trusted', category: 'bank' },
        { trust: 'trusted', category: 'employer' },
        { trust: 'unwanted', category: 'broker' },
      ]],
    ]);
    const out = await getPrivacyTwinContext();
    expect(out).toContain('Organizations on file: 3 (2 trusted, 1 unwanted) across 3 categories.');
  });

  it('omits the broker posture line when the broker table is absent', async () => {
    routeQueries([
      ['to_regclass', [{ vault: 'privacy_vault_records', orgs: 'privacy_orgs', broker: null }]],
      ['FROM privacy_vault_records', [
        { type: 'email', label: 'Main', status: 'current', value_enc: 'enc:a@b.com' },
      ]],
      ['FROM privacy_orgs', []],
    ]);
    const out = await getPrivacyTwinContext();
    expect(out).not.toContain('Data-broker posture');
    // Never queries privacy_broker_cases when the table doesn't exist.
    expect(query.mock.calls.some(([sql]) => sql.includes('FROM privacy_broker_cases'))).toBe(false);
  });

  it('adds a broker posture line (removed vs pending) when the table exists', async () => {
    routeQueries([
      ['to_regclass', ALL_TABLES],
      ['FROM privacy_vault_records', [
        { type: 'email', label: 'Main', status: 'current', value_enc: 'enc:a@b.com' },
      ]],
      ['FROM privacy_orgs', []],
      ['FROM privacy_broker_cases', [
        { state: 'removed' }, { state: 'confirmed_removed' }, { state: 'found' }, { state: 'pending' },
      ]],
    ]);
    const out = await getPrivacyTwinContext();
    expect(out).toContain('Data-broker posture: 2 confirmed removed, 2 pending.');
  });
});

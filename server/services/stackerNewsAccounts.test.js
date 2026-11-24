import { describe, expect, it, vi } from 'vitest';

const transactionQuery = vi.fn(async () => ({ rows: [], rowCount: 1 }));
const query = vi.fn(async (sql) => {
  if (sql.startsWith('SELECT a.*')) return { rows: [{
    id: '00000000-0000-4000-8000-000000000001',
    label: 'Example',
    username: 'mixed_case',
    enabled: true,
    monitoring_enabled: false,
    monitoring_interval_minutes: 30,
    analysis_enabled: false,
    text_model: '',
    vision_model: '',
    rules: {},
    policy_version: 'v1',
  }] };
  return { rows: [], rowCount: 1 };
});
vi.mock('../lib/db.js', () => ({
  query,
  withTransaction: vi.fn(async (callback) => callback({ query: transactionQuery })),
}));
vi.mock('../lib/vaultCrypto.js', () => ({ decryptValue: vi.fn(), encryptValue: vi.fn(), ensureVaultKey: vi.fn() }));
vi.mock('../integrations/stackerNews/index.js', () => ({ executeStackerNewsOperation: vi.fn(), stackerNewsCapabilities: {} }));

const { createAccount } = await import('./stackerNews.js');

describe('Stacker News account identity', () => {
  it('normalizes usernames before inserting them', async () => {
    await createAccount({ label: 'Example', username: 'Mixed_Case' });
    const insert = transactionQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO stacker_news_accounts'));
    expect(insert[1][2]).toBe('mixed_case');
  });

  it('maps a duplicate username to a safe 409 without the raw constraint name', async () => {
    transactionQuery.mockRejectedValueOnce(Object.assign(new Error('duplicate key value violates unique constraint "stacker_news_accounts_username_key"'), { code: '23505' }));
    await expect(createAccount({ label: 'Example', username: 'dupe' })).rejects.toMatchObject({
      status: 409,
      code: 'CONFLICT',
      message: 'A Stacker News account with that username already exists',
    });
  });
});

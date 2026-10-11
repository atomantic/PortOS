import { describe, expect, it, vi } from 'vitest';

const account = { id: 'account', username: 'example_user', enabled: true, rules: {}, policy_version: 'v1' };
const territory = { id: 'territory', account_id: 'account', slug: 'art', rules: {}, inherit_account_rules: true, is_owned: false, remote_settings: {} };
const item = { id: 'item', account_id: 'account', territory_id: 'territory', remote_id: '42', content_hash: 'content-hash' };
let actionForExecution = null;

const query = vi.fn(async (sql) => {
  if (sql === 'SELECT * FROM stacker_news_actions WHERE id=$1') return { rows: actionForExecution ? [actionForExecution] : [] };
  if (sql.startsWith('SELECT * FROM stacker_news_accounts')) return { rows: [account] };
  if (sql.startsWith('SELECT * FROM stacker_news_items')) return { rows: [item] };
  if (sql.startsWith('SELECT * FROM stacker_news_territories')) return { rows: [territory] };
  return { rows: [] };
});

const transactionQuery = vi.fn(async (sql, params) => {
  if (sql.includes('WHERE idempotency_key=$1')) return { rows: [] };
  if (sql.includes('INSERT INTO stacker_news_actions')) {
    return {
      rows: [{
        id: params[0], account_id: params[1], item_id: params[2], territory_id: params[3], kind: params[4],
        state: 'pending_review', destination: params[5], payload: params[6], source_content_hash: params[7],
        rules_hash: params[8], policy_version: params[9], idempotency_key: params[10], reviewed_target: params[11],
      }],
    };
  }
  return { rows: [], rowCount: 1 };
});
const withTransaction = vi.fn(async (callback) => callback({ query: transactionQuery }));

vi.mock('../lib/db.js', () => ({ query, withTransaction }));
vi.mock('../lib/vaultCrypto.js', () => ({ decryptValue: vi.fn(), encryptValue: vi.fn(), ensureVaultKey: vi.fn() }));
vi.mock('../integrations/stackerNews/index.js', () => ({ executeStackerNewsOperation: vi.fn(), stackerNewsCapabilities: {} }));

const { createAction, executeApprovedAction } = await import('./stackerNews.js');

describe('Stacker News reviewed actions', () => {
  it('persists the reviewed external account and destination', async () => {
    const action = await createAction({
      accountId: account.id,
      itemId: item.id,
      territoryId: territory.id,
      kind: 'publish_comment',
      payload: { body: 'Thanks for sharing.' },
    });
    expect(action.reviewedTarget).toEqual({ username: 'example_user', territorySlug: 'art', remoteItemId: '42' });
    expect(transactionQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO stacker_news_actions'))[0]).toContain('reviewed_target');
  });

  it('derives an item action territory and rejects an explicit mismatch', async () => {
    const action = await createAction({
      accountId: account.id,
      itemId: item.id,
      kind: 'publish_comment',
      payload: { body: 'Thanks for sharing.' },
    });
    expect(action.territoryId).toBe(territory.id);
    expect(action.reviewedTarget.territorySlug).toBe('art');
    await expect(createAction({
      accountId: account.id,
      itemId: item.id,
      territoryId: 'different-territory',
      kind: 'publish_comment',
      payload: { body: 'Thanks for sharing.' },
    })).rejects.toThrow('territory does not match');
  });

  it('refuses execution when the reviewed identity no longer matches', async () => {
    actionForExecution = {
      id: 'action', account_id: account.id, item_id: item.id, territory_id: territory.id,
      kind: 'publish_comment', state: 'approved', approved_at: new Date(), payload: { body: 'Hello' },
      reviewed_target: { username: 'previous_user', territorySlug: 'art', remoteItemId: '42' },
      source_content_hash: item.content_hash, rules_hash: '', policy_version: 'v1',
    };
    await expect(executeApprovedAction('action')).rejects.toThrow('External account or destination changed after review');
  });

  it('fails a stale executing action so it cannot wedge the idempotency key', async () => {
    const stale = { id: 'zombie', state: 'executing', updated_at: new Date(Date.now() - 2 * 60 * 60 * 1000) };
    transactionQuery.mockImplementationOnce(async () => ({ rows: [stale] }));
    const action = await createAction({
      accountId: account.id, itemId: item.id, kind: 'publish_comment', payload: { body: 'Retry after crash.' },
    });
    expect(action.state).toBe('pending_review');
    expect(action.id).not.toBe('zombie');
    const calls = transactionQuery.mock.calls.map(([sql, params]) => ({ sql, params }));
    const fail = calls.find(({ sql }) => sql.includes("state='failed'"));
    expect(fail.params).toEqual(['zombie']);
    const event = calls.find(({ sql, params }) => sql.includes('stacker_news_action_events') && params?.includes('failed'));
    expect(event.params).toContain('zombie');
  });

  it('keeps returning a recently started executing action', async () => {
    const fresh = { id: 'running', account_id: account.id, state: 'executing', updated_at: new Date() };
    transactionQuery.mockImplementationOnce(async () => ({ rows: [fresh] }));
    const action = await createAction({
      accountId: account.id, itemId: item.id, kind: 'publish_comment', payload: { body: 'In flight.' },
    });
    expect(action.id).toBe('running');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const accountId = '00000000-0000-4000-8000-000000000001';
const territoryId = '00000000-0000-4000-8000-000000000002';
let accountRow = {};
let credentialRows = [];
const query = vi.fn(async (sql) => {
  if (sql.startsWith('SELECT * FROM stacker_news_accounts')) return { rows: [accountRow] };
  if (sql.startsWith('SELECT api_key_enc')) return { rows: credentialRows };
  if (sql.startsWith('SELECT * FROM stacker_news_territories')) return { rows: [{ id: territoryId, account_id: accountId, slug: 'art', label: 'Art', is_owned: true, monitoring_enabled: true, inherit_account_rules: true, rules: {}, remote_settings: {} }] };
  if (sql.startsWith('SELECT content_hash')) return { rows: [] };
  if (sql.includes('INSERT INTO stacker_news_items')) return { rows: [{ id: '00000000-0000-4000-8000-000000000003', account_id: accountId, territory_id: territoryId, remote_id: '42', kind: 'post', author_name: 'artist', title: 'Example work', body: 'A post', source_url: 'https://stacker.news/items/42', image_urls: [], content_hash: 'hash', received_at: new Date() }] };
  return { rows: [], rowCount: 1 };
});
const itemsPage = (cursor) => cursor
  ? { items: { cursor: null, items: [] } }
  : { items: { cursor: 'page-2', items: [{ id: '42', title: 'Example work', text: 'A post', user: { name: 'artist' } }] } };
const executeStackerNewsOperation = vi.fn(async (name, input) => {
  if (name === 'me') return { me: { id: 'owner-1', name: 'example_user' } };
  if (name === 'sub') return { sub: { name: 'art', userId: 'owner-1' } };
  return itemsPage(input.cursor);
});
const browserRead = async (name, input = {}) => {
  if (name === 'me') return { me: { id: 'owner-1', name: 'example_user' } };
  if (name === 'sub') return { sub: { name: 'art', userId: 'owner-1' } };
  return itemsPage(input.cursor);
};
const executeStackerNewsBrowserRead = vi.fn(browserRead);
vi.mock('../lib/db.js', () => ({ query, withTransaction: vi.fn() }));
vi.mock('../lib/vaultCrypto.js', () => ({ decryptValue: () => 'api-key', encryptValue: vi.fn(), ensureVaultKey: vi.fn() }));
vi.mock('../integrations/stackerNews/index.js', () => ({ executeStackerNewsOperation, executeStackerNewsBrowserRead, stackerNewsCapabilities: {} }));
const { listItems, syncAccount, verifyConnection } = await import('./stackerNews.js');

const baseAccount = { id: accountId, label: 'Example', username: 'example_user', enabled: true, monitoring_enabled: false, monitoring_interval_minutes: 30, analysis_enabled: false, text_model: '', vision_model: '', rules: {}, policy_version: 'v1' };

describe('Stacker News sync', () => {
  beforeEach(() => {
    query.mockClear();
    executeStackerNewsOperation.mockClear();
    executeStackerNewsBrowserRead.mockReset().mockImplementation(browserRead);
    accountRow = { ...baseAccount, read_transport: 'api' };
    credentialRows = [{ api_key_enc: 'ciphertext' }];
  });

  it('paginates named reads, verifies ownership, and ingests without analyzing when analysis is off', async () => {
    await expect(syncAccount(accountId, { force: true })).resolves.toMatchObject({ ingested: 1, analyzed: 0, transport: 'api' });
    const itemCalls = executeStackerNewsOperation.mock.calls.filter(([name]) => name === 'items');
    expect(itemCalls).toHaveLength(2);
    expect(itemCalls[0][1]).toMatchObject({ sub: 'art', cursor: null });
    expect(itemCalls[1][1]).toMatchObject({ sub: 'art', cursor: 'page-2' });
    expect(query.mock.calls.some(([sql, params]) => sql.startsWith('UPDATE stacker_news_territories') && params[1].ownershipVerified === true)).toBe(true);
  });

  it('honors a territory monitoring opt-in when account monitoring is off', async () => {
    await expect(syncAccount(accountId)).resolves.toMatchObject({ skipped: false, ingested: 1 });
    expect(executeStackerNewsOperation).toHaveBeenCalledWith('sub', expect.objectContaining({ name: 'art' }), 'api-key');
  });

  // Stacker News grants API keys on request only, so the default install has no
  // key at all — reads must still work through the signed-in pinned browser.
  it('syncs with no API key stored by reading through the pinned browser', async () => {
    accountRow = { ...baseAccount };
    credentialRows = [];
    await expect(syncAccount(accountId, { force: true })).resolves.toMatchObject({ ingested: 1, transport: 'browser' });
    expect(executeStackerNewsOperation).not.toHaveBeenCalled();
    const itemCalls = executeStackerNewsBrowserRead.mock.calls.filter(([name]) => name === 'items');
    expect(itemCalls.map(([, input]) => input.cursor)).toEqual([null, 'page-2']);
  });

  // The browser identity extractor's profile-link fallback has no user ID, and a
  // territory page can omit one too — two absences must not certify ownership.
  it('refuses to verify ownership when either side has no user ID', async () => {
    accountRow = { ...baseAccount };
    credentialRows = [];
    executeStackerNewsBrowserRead.mockImplementation(async (name, input = {}) => {
      if (name === 'me') return { me: { id: null, name: 'example_user' } };
      if (name === 'sub') return { sub: { name: 'art', userId: null } };
      return itemsPage(input.cursor);
    });
    await syncAccount(accountId, { force: true });
    expect(query.mock.calls.some(([sql, params]) => sql.startsWith('UPDATE stacker_news_territories') && params[1].ownershipVerified === false)).toBe(true);
  });

  it('still refuses an API-transport account with no key', async () => {
    credentialRows = [];
    await expect(syncAccount(accountId, { force: true })).rejects.toThrow('Stacker News API key is not configured');
  });

  it('resolves the signed-in username with no key, and can be forced onto the API', async () => {
    accountRow = { ...baseAccount };
    credentialRows = [];
    await expect(verifyConnection(accountId)).resolves.toMatchObject({ configured: true, connected: true, transport: 'browser', username: 'example_user', matchesConfigured: true });
    await expect(verifyConnection(accountId, { transport: 'api' })).resolves.toMatchObject({ configured: false, connected: false, transport: 'api' });
    credentialRows = [{ api_key_enc: 'ciphertext' }];
    await expect(verifyConnection(accountId, { transport: 'api' })).resolves.toMatchObject({ configured: true, transport: 'api', username: 'example_user' });
  });

  it('limits each territory sync to the configured newest-item cap and reports it', async () => {
    accountRow = { ...baseAccount, read_transport: 'api', sync_item_limit: 1 };
    await expect(syncAccount(accountId, { force: true })).resolves.toMatchObject({ ingested: 1, newestItemLimit: 1 });
    const itemCalls = executeStackerNewsOperation.mock.calls.filter(([name]) => name === 'items');
    expect(itemCalls).toHaveLength(1);
    expect(itemCalls[0][1]).toMatchObject({ limit: 1 });
  });

  it('captures a direct image URL from an image-first item for the vision stage', async () => {
    executeStackerNewsOperation.mockImplementation(async (name, input) => {
      if (name === 'me') return { me: { id: 'owner-1', name: 'example_user' } };
      if (name === 'sub') return { sub: { name: 'art', userId: 'owner-1' } };
      if (input.cursor) return { items: { cursor: null, items: [] } };
      return { items: { cursor: null, items: [{ id: '42', createdAt: '2026-08-06T10:00:00.000Z', title: 'Fresh artwork', text: '', url: 'https://cdn.example.com/artwork.png', user: { name: 'artist' } }] } };
    });
    await syncAccount(accountId, { force: true });
    const insert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO stacker_news_items'));
    expect(insert[1][9]).toEqual(['https://cdn.example.com/artwork.png']);
  });

  it('requests newest source items first and exposes the latest persisted analysis', async () => {
    const latestAnalysis = {
      id: '00000000-0000-4000-8000-000000000004',
      stage: 'policy',
      provider: 'deterministic',
      model: '',
      status: 'completed',
      source_content_hash: 'hash',
      rules_hash: 'rules-hash',
      policy_version: 'v1',
      result: { classification: 'review' },
      created_at: new Date('2026-08-06T10:01:00.000Z'),
    };
    query.mockImplementationOnce(async (sql, params) => {
      expect(sql).toContain('ORDER BY i.remote_created_at DESC NULLS LAST');
      expect(sql).toContain('PARTITION BY territory_id');
      expect(sql).toContain('queue_rank <= COALESCE');
      expect(params).toEqual([accountId, 30]);
      return {
        rows: [{
          id: '00000000-0000-4000-8000-000000000003',
          account_id: accountId,
          territory_id: territoryId,
          remote_id: '42',
          kind: 'post',
          author_name: 'artist',
          title: 'Fresh artwork',
          body: '',
          source_url: 'https://stacker.news/items/42',
          image_urls: ['https://cdn.example.com/artwork.png'],
          content_hash: 'hash',
          remote_created_at: new Date('2026-08-06T10:00:00.000Z'),
          remote_updated_at: null,
          received_at: new Date('2026-08-06T10:00:01.000Z'),
          created_at: new Date('2026-08-06T10:00:01.000Z'),
          latest_analysis_id: latestAnalysis.id,
          latest_analysis_stage: latestAnalysis.stage,
          latest_analysis_provider: latestAnalysis.provider,
          latest_analysis_model: latestAnalysis.model,
          latest_analysis_status: latestAnalysis.status,
          latest_analysis_source_content_hash: latestAnalysis.source_content_hash,
          latest_analysis_rules_hash: latestAnalysis.rules_hash,
          latest_analysis_policy_version: latestAnalysis.policy_version,
          latest_analysis_result: latestAnalysis.result,
          latest_analysis_created_at: latestAnalysis.created_at,
        }],
      };
    });

    await expect(listItems(accountId)).resolves.toMatchObject([{
      remoteId: '42',
      latestAnalysis: {
        stage: 'policy',
        result: { classification: 'review' },
      },
    }]);
  });
});

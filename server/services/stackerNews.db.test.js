import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { checkHealth, close, ensureSchema, query } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import { executeStackerNewsBrowserRead } from '../integrations/stackerNews/index.js';

// Stop both UPDATEs just before PostgreSQL executes them. On the old path this
// guarantees both callers already read the same stale configuration snapshot.
// The actual SQL, row locks, constraints and transactions remain real.
const gate = vi.hoisted(() => ({ table: null, waiting: [], release: null }));
vi.mock('../lib/db.js', async (importOriginal) => {
  const actual = await importOriginal();
  const execute = async (run, sql, params) => {
    if (gate.table && sql.startsWith(`UPDATE ${gate.table} SET`)) {
      await new Promise((resolve) => {
        gate.waiting.push(resolve);
        if (gate.waiting.length === 2) gate.release();
      });
    }
    return run(sql, params);
  };
  return {
    ...actual,
    query: (sql, params) => execute(actual.query, sql, params),
    withTransaction: (work) => actual.withTransaction((client) => work({
      query: (sql, params) => execute(client.query.bind(client), sql, params),
    })),
  };
});
vi.mock('../integrations/stackerNews/index.js', () => ({
  executeStackerNewsOperation: vi.fn(), executeStackerNewsBrowserRead: vi.fn(), stackerNewsCapabilities: {},
}));

const { createAccount, createTerritory, getAccount, listTerritories, syncAccount, updateAccount, updateTerritory } = await import('./stackerNews.js');
const health = await checkHealth().catch(() => ({ connected: false }));
const ready = requireDbOrSkip('stackerNews.db.test', health.connected, 'test database unavailable');
let accountId;
let territoryId;

async function overlap(table, work) {
  gate.table = table;
  gate.waiting = [];
  gate.release = () => {
    gate.table = null;
    gate.waiting.forEach((resolve) => resolve());
  };
  try {
    await work();
  } finally {
    gate.release();
  }
}

describe.skipIf(!ready)('Stacker News configuration integrity', () => {
  beforeAll(async () => {
    await ensureSchema();
    const account = await createAccount({ label: 'Example account', username: `example_${randomUUID()}` });
    accountId = account.id;
    territoryId = (await createTerritory({ accountId, slug: 'example-art' })).id;
  });

  afterAll(async () => {
    if (accountId) await query('DELETE FROM stacker_news_accounts WHERE id=$1', [accountId]);
  });

  it('preserves disjoint concurrent account PATCHes, including false and empty values', async () => {
    await updateAccount(accountId, { enabled: true, textModel: 'example-model' });
    await overlap('stacker_news_accounts', () => Promise.all([
      updateAccount(accountId, { label: 'Updated account', textModel: '' }),
      updateAccount(accountId, { enabled: false, syncItemLimit: 17 }),
    ]));
    expect(await getAccount(accountId)).toMatchObject({
      label: 'Updated account', textModel: '', enabled: false, syncItemLimit: 17,
    });
  });

  it('preserves concurrent territory edits and distinguishes omitted monitoring from null', async () => {
    await updateTerritory(territoryId, { monitoringEnabled: true, isOwned: true });
    await overlap('stacker_news_territories', () => Promise.all([
      updateTerritory(territoryId, { label: 'Updated territory', isOwned: false }),
      updateTerritory(territoryId, { monitoringEnabled: null, inheritAccountRules: false }),
    ]));
    await updateTerritory(territoryId, { rules: {} });
    expect((await listTerritories(accountId))[0]).toMatchObject({
      label: 'Updated territory', isOwned: false, monitoringEnabled: null, inheritAccountRules: false,
    });
  });

  it('preserves refreshed remote evidence on edits and clears it only on an actual rename', async () => {
    const evidence = { ownershipVerified: true, name: 'example-art' };
    await query('UPDATE stacker_news_territories SET remote_settings=$2,remote_refreshed_at=NOW() WHERE id=$1', [territoryId, evidence]);
    const sameSlug = await updateTerritory(territoryId, { slug: 'example-art', label: '' });
    expect(sameSlug.remoteSettings).toEqual(evidence);
    expect(sameSlug.remoteRefreshedAt).not.toBeNull();
    const renamed = await updateTerritory(territoryId, { slug: 'example-new-art' });
    expect(renamed.remoteSettings).toEqual({});
    expect(renamed.remoteRefreshedAt).toBeNull();
  });

  it('returns null for deleted targets without attempting a credential write', async () => {
    const missingId = randomUUID();
    expect(await updateAccount(missingId, { apiKey: 'example-key' })).toBeNull();
    expect(await updateTerritory(missingId, { slug: 'example-missing' })).toBeNull();
  });

  it('discards provider data fetched for a territory renamed during sync', async () => {
    const account = await getAccount(accountId);
    const previous = (await listTerritories(accountId))[0];
    executeStackerNewsBrowserRead.mockImplementation(async (name) => {
      if (name === 'me') return { me: { id: 'example-owner', name: account.username } };
      if (name === 'sub') {
        await updateTerritory(territoryId, { slug: 'example-renamed-during-sync' });
        return { sub: { name: previous.slug, userId: 'example-owner' } };
      }
      throw new Error('Old-slug items must not be read after a rename');
    });
    expect(await syncAccount(accountId, { force: true })).toMatchObject({ ingested: 0 });
    expect((await listTerritories(accountId))[0]).toMatchObject({
      slug: 'example-renamed-during-sync', remoteSettings: {}, remoteRefreshedAt: null,
    });
  });
});

afterAll(async () => { await close(); });

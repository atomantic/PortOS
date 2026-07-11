import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/contactsSync.js', () => ({
  checkSetup: vi.fn(async () => ({ ok: true, sourceCount: 2, rawContactRows: 100 })),
  getStatus: vi.fn(async () => ({ cache: { contactCount: 50, syncedAt: null }, state: {}, setup: { ok: true } })),
  runSync: vi.fn(async () => ({ ok: true, contactCount: 50, sourceCount: 2 })),
  searchContacts: vi.fn(async () => [{ id: 'c1', displayName: 'Jane' }]),
}));

vi.mock('../services/identityResolve.js', () => ({
  loadResolverContext: vi.fn(async () => ({})),
  resolveHandle: vi.fn(() => ({ displayName: 'Jane', source: 'contacts', handle: '+1555' })),
}));

vi.mock('../services/tribeContacts.js', () => ({
  enrichTribeFromContacts: vi.fn(async ({ dryRun }) => ({ dryRun, matched: 3, updated: dryRun ? 0 : 3, changes: [] })),
  suggestTribeImports: vi.fn(async () => ({ suggestions: [{ displayName: 'Sam', eventCount: 5 }], contactsCached: 10, tribeCount: 2 })),
  importContactToTribe: vi.fn(async () => ({ person: { id: 'p1', name: 'Sam' }, created: true })),
}));

const { default: router } = await import('./contacts.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/contacts', router);
  app.use(errorMiddleware);
  return app;
}

describe('contacts routes (#2415)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET /setup-check', async () => {
    const res = await request(makeApp()).get('/api/contacts/setup-check');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('POST /sync', async () => {
    const res = await request(makeApp()).post('/api/contacts/sync');
    expect(res.status).toBe(200);
    expect(res.body.contactCount).toBe(50);
  });

  it('GET /resolve', async () => {
    const res = await request(makeApp()).get('/api/contacts/resolve?handle=%2B15551234567');
    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe('Jane');
  });

  it('POST /enrich-tribe dry run', async () => {
    const res = await request(makeApp()).post('/api/contacts/enrich-tribe').send({ dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.matched).toBe(3);
  });

  it('GET /suggest-tribe', async () => {
    const res = await request(makeApp()).get('/api/contacts/suggest-tribe');
    expect(res.status).toBe(200);
    expect(res.body.suggestions).toHaveLength(1);
  });

  it('POST /import-to-tribe', async () => {
    const res = await request(makeApp()).post('/api/contacts/import-to-tribe').send({ contactId: 'c1', name: 'Sam' });
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
  });
});

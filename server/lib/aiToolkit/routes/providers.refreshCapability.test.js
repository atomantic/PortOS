import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from '../../testHelper.js';
import { asyncHandler, errorMiddleware, ServerError } from '../../errorHandler.js';
import { createProviderService } from '../providers.js';
import { createProvidersRoutes } from './providers.js';

// #3620 — `canRefreshModels` is DERIVED ON READ from the per-vendor fetcher
// table and decorated at the ROUTE. If it were computed in `getAllProviders()`
// instead it would ride the object `saveProviders` writes back and land in
// providers.json, where it would go stale against the table the first time a
// user repointed a provider's command — reintroducing exactly the drift the
// field exists to remove. These tests pin both halves: the payload has it, the
// file never does.

describe('#3620: providers route decorates canRefreshModels without persisting it', () => {
  let dataDir;
  let app;

  const providersFile = () => join(dataDir, 'providers.json');
  const readStored = async () => JSON.parse(await readFile(providersFile(), 'utf8'));

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'portos-providers-'));
    const service = createProviderService({ dataDir });
    app = express();
    app.use(express.json());
    app.use('/api/providers', createProvidersRoutes(service, { asyncHandler, ServerError }));
    app.use(errorMiddleware);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  const createProvider = (body) => request(app).post('/api/providers').send(body);

  it('GET / carries the flag per provider — true for a refreshable CLI, false otherwise', async () => {
    await createProvider({ id: 'claude-code', name: 'Claude Code CLI', type: 'cli', command: 'claude' });
    await createProvider({ id: 'codex', name: 'Codex CLI', type: 'cli', command: 'codex' });

    const res = await request(app).get('/api/providers');
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.providers.map((p) => [p.id, p]));
    expect(byId['claude-code'].canRefreshModels).toBe(true);
    expect(byId.codex.canRefreshModels).toBe(false);
  });

  it('never writes the field to providers.json — not on create, not on update', async () => {
    await createProvider({ id: 'claude-code', name: 'Claude Code CLI', type: 'cli', command: 'claude' });
    await request(app).get('/api/providers');

    const afterCreate = await readStored();
    expect(afterCreate.providers['claude-code']).not.toHaveProperty('canRefreshModels');

    // The round-trip hazard: a client that echoes the decorated payload back.
    // `providerSchema.partial()` strips unknown keys, so it cannot be stored.
    const put = await request(app)
      .put('/api/providers/claude-code')
      .send({ name: 'Claude Code CLI', enabled: false, canRefreshModels: true });
    expect(put.status).toBe(200);

    const afterUpdate = await readStored();
    expect(afterUpdate.providers['claude-code']).not.toHaveProperty('canRefreshModels');
    expect(afterUpdate.providers['claude-code'].enabled).toBe(false);
    // …and the response still reports the DERIVED value, not the echoed one.
    expect(put.body.canRefreshModels).toBe(true);
  });

  it('a POSTed canRefreshModels is not stored either, and does not fake the answer', async () => {
    const res = await createProvider({
      id: 'codex', name: 'Codex CLI', type: 'cli', command: 'codex', canRefreshModels: true,
    });
    expect(res.status).toBe(201);
    // Derived from the table, which has no codex row — the client's button
    // must stay hidden regardless of what the payload claimed.
    expect(res.body.canRefreshModels).toBe(false);

    const stored = await readStored();
    expect(stored.providers.codex).not.toHaveProperty('canRefreshModels');
  });

  it('decorates GET /:id and GET /active too, so every read agrees', async () => {
    await createProvider({ id: 'claude-code', name: 'Claude Code CLI', type: 'cli', command: 'claude' });
    await request(app).put('/api/providers/active').send({ id: 'claude-code' });

    const byId = await request(app).get('/api/providers/claude-code');
    expect(byId.body.canRefreshModels).toBe(true);

    const active = await request(app).get('/api/providers/active');
    expect(active.body.canRefreshModels).toBe(true);
  });
});

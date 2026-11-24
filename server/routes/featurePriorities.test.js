/**
 * Feature priority API: the focused-visit beacon, pins and the resolved tiers.
 *
 * Runs the real service on its file backend (PATHS.data re-rooted at a temp dir) so the visit rows, the pin write and the tier precedence are proven end to end. The Postgres SQL is covered by
 * `featureUsageDb.db.test.js` (`npm run test:db`). Instance-feature detectors are stubbed to "no answer" so the suite never probes the host.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import express from 'express';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';
import { bindSettingsFile } from '../lib/settingsTestUtil.js';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-feature-priorities-' });
vi.mock('../lib/fileUtils.js', async () => makeProxy(await vi.importActual('../lib/fileUtils.js')));
vi.mock('../services/instanceFeatures.js', async () => ({
  ...(await vi.importActual('../services/instanceFeatures.js')),
  detectFeatureConfiguration: async () => ({}),
}));
const identity = vi.hoisted(() => ({ session: null }));
vi.mock('../services/auth.js', () => ({ verifyRequestSessionIdentity: async () => identity.session }));

const { default: featurePriorityRoutes } = await import('./featurePriorities.js');
const { recordVisit } = await import('../services/featurePriorities.js');
const { writeSettingsFile } = bindSettingsFile(tempRoot);

const USAGE_FILE = join(tempRoot, 'feature-usage-days.json');
const DAY_MS = 24 * 60 * 60 * 1000;
const io = { emit: vi.fn() };

const buildApp = ({ withIo = false } = {}) => {
  const app = express();
  app.use(express.json());
  if (withIo) app.set('io', io);
  app.use((req, _res, next) => {
    const method = req.headers['x-test-auth-method'];
    if (method) req.portosAuthContext = { enabled: true, authenticated: true, method };
    next();
  });
  app.use('/api/feature-priorities', featurePriorityRoutes);
  app.use(errorMiddleware);
  return app;
};

const readRows = () => (existsSync(USAGE_FILE) ? JSON.parse(readFileSync(USAGE_FILE, 'utf8')).rows : []);
const visit = (path, headers = {}) => {
  let builder = request(buildApp()).post('/api/feature-priorities/visit').send({ path });
  for (const [name, value] of Object.entries(headers)) builder = builder.set(name, value);
  return builder;
};
const area = (body, areaId) => body.areas.find((entry) => entry.areaId === areaId);

// Seed `count` consecutive days of Brain visits ending today (a margin over 14 absorbs a DST day boundary).
const seedBrainDays = async (count) => {
  for (let ago = count - 1; ago >= 0; ago -= 1) await recordVisit('/brain/inbox', { now: Date.now() - ago * DAY_MS });
};

beforeEach(async () => {
  rmSync(USAGE_FILE, { force: true });
  await writeSettingsFile({});
  identity.session = null;
  io.emit.mockClear();
});

afterAll(cleanup);

describe('POST /api/feature-priorities/visit', () => {
  it('creates one row for a known path and increments it on a repeat visit', async () => {
    expect((await visit('/brain/inbox')).body).toEqual({ recorded: true });
    expect(readRows()).toHaveLength(1);
    expect(readRows()[0]).toMatchObject({ areaId: 'brain', visits: 1 });

    await visit('/brain/inbox?tab=1');
    expect(readRows()).toHaveLength(1);
    expect(readRows()[0].visits).toBe(2);
  });

  it('writes nothing for the dashboard or a path no area owns', async () => {
    for (const path of ['/', '/not-a-real-page']) {
      expect((await visit(path)).body).toEqual({ recorded: false });
    }
    expect(readRows()).toEqual([]);
  });

  it('refuses a peer or basic-auth caller and records nothing', async () => {
    for (const method of ['peer', 'basic']) {
      const res = await visit('/brain/inbox', { 'x-test-auth-method': method });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OPERATOR_REQUIRED');
    }
    expect(readRows()).toEqual([]);
  });

  it('accepts a signed-in operator session', async () => {
    identity.session = { kind: 'session', sessionId: 's1', label: null };
    expect((await visit('/brain/inbox', { 'x-test-auth-method': 'session' })).body).toEqual({ recorded: true });
    expect(readRows()).toHaveLength(1);
  });

  it('skips a session minted for an agent', async () => {
    identity.session = { kind: 'session', sessionId: 's2', label: 'agent' };
    expect((await visit('/brain/inbox', { 'x-test-auth-method': 'session' })).body).toEqual({ recorded: false });
    expect(readRows()).toEqual([]);
  });

  it('rejects a body without a path', async () => {
    const res = await request(buildApp()).post('/api/feature-priorities/visit').send({});
    expect(res.status).toBe(400);
  });

  it('prunes rows older than 90 days when a visit lands', async () => {
    await recordVisit('/brain/inbox', { now: Date.now() - 100 * DAY_MS });
    await recordVisit('/brain/inbox', { now: Date.now() - 20 * DAY_MS });
    expect(readRows()).toHaveLength(2);

    await visit('/brain/inbox');
    const rows = readRows();
    expect(rows).toHaveLength(2);
    const oldest = rows.map((row) => row.day).sort()[0];
    expect(Date.now() - Date.parse(`${oldest}T00:00:00Z`)).toBeLessThan(25 * DAY_MS);
  });
});

describe('PUT /api/feature-priorities/:areaId', () => {
  it('sets a pin, reports it from GET and emits the update event', async () => {
    const res = await request(buildApp({ withIo: true })).put('/api/feature-priorities/brain').send({ tier: 'P0' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ areaId: 'brain', tier: 'P0' });
    expect(io.emit).toHaveBeenCalledWith('feature-priorities:updated', { areaId: 'brain', tier: 'P0' });
    expect(JSON.parse(readFileSync(join(tempRoot, 'settings.json'), 'utf8')).featurePriorities)
      .toEqual({ overrides: { brain: 'P0' } });

    const listed = (await request(buildApp()).get('/api/feature-priorities')).body;
    expect(area(listed, 'brain')).toMatchObject({ tier: 'P0', source: 'pinned' });
  });

  it('clears a pin with null and drops the stored key', async () => {
    await request(buildApp()).put('/api/feature-priorities/brain').send({ tier: 'P3' });
    await request(buildApp()).put('/api/feature-priorities/jira').send({ tier: 'P2' });
    const res = await request(buildApp()).put('/api/feature-priorities/brain').send({ tier: null });
    expect(res.body).toEqual({ areaId: 'brain', tier: null });
    expect(JSON.parse(readFileSync(join(tempRoot, 'settings.json'), 'utf8')).featurePriorities.overrides)
      .toEqual({ jira: 'P2' });
    expect(area((await request(buildApp()).get('/api/feature-priorities')).body, 'brain'))
      .toMatchObject({ tier: 'P1', source: 'default' });
  });

  it('rejects an unknown area, an unknown tier and a missing tier', async () => {
    const app = buildApp();
    expect((await request(app).put('/api/feature-priorities/not-an-area').send({ tier: 'P1' })).status).toBe(400);
    expect((await request(app).put('/api/feature-priorities/brain').send({ tier: 'P4' })).status).toBe(400);
    expect((await request(app).put('/api/feature-priorities/brain').send({})).status).toBe(400);
  });
});

describe('GET /api/feature-priorities', () => {
  it('answers P1 by default and P3 for a switched-off optional feature, before any evidence exists', async () => {
    const body = (await request(buildApp()).get('/api/feature-priorities')).body;
    expect(body.minEvidenceDays).toBe(14);
    expect(body.evidenceDays).toBe(0);
    expect(area(body, 'brain')).toMatchObject({ tier: 'P1', source: 'default', activeDays30: 0, lastActiveDay: null, instanceFeatureId: null });
    // Beeper ships disabled, so with no visit in 30 days it is dormant.
    expect(area(body, 'beeper')).toMatchObject({ tier: 'P3', source: 'feature-off', instanceFeatureId: 'beeper' });
    expect(Object.keys(area(body, 'brain')).sort())
      .toEqual(['activeDays30', 'areaId', 'instanceFeatureId', 'label', 'lastActiveDay', 'source', 'tier']);
  });

  it('holds every area at the default until 14 distinct days of evidence exist', async () => {
    await seedBrainDays(10);
    const body = (await request(buildApp()).get('/api/feature-priorities')).body;
    expect(body.evidenceDays).toBe(10);
    expect(area(body, 'brain')).toMatchObject({ tier: 'P1', source: 'default', activeDays30: 10 });
    expect(area(body, 'jira')).toMatchObject({ tier: 'P1', source: 'default' });
  });

  it('learns tiers once the evidence gate is met and a pin wins over the learned tier', async () => {
    await seedBrainDays(16);
    const learned = (await request(buildApp()).get('/api/feature-priorities')).body;
    expect(area(learned, 'brain')).toMatchObject({ tier: 'P0', source: 'learned' });
    expect(area(learned, 'brain').lastActiveDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // An enabled optional area nobody opened is dormant once the install has enough evidence.
    expect(area(learned, 'jira')).toMatchObject({ tier: 'P3', source: 'learned' });
    // A core area never learns below P2.
    expect(area(learned, 'tribe').tier).toBe('P2');

    await request(buildApp()).put('/api/feature-priorities/brain').send({ tier: 'P2' });
    const pinned = (await request(buildApp()).get('/api/feature-priorities')).body;
    expect(area(pinned, 'brain')).toMatchObject({ tier: 'P2', source: 'pinned' });
  });

  it('applies the feature-off rule ahead of the learned tier for an explicitly disabled feature', async () => {
    await seedBrainDays(16);
    await writeSettingsFile({ instanceFeatures: { jira: { enabled: false } } });
    expect(area((await request(buildApp()).get('/api/feature-priorities')).body, 'jira'))
      .toMatchObject({ tier: 'P3', source: 'feature-off' });
  });

  it('ignores a malformed pin in a hand-edited settings file', async () => {
    writeFileSync(join(tempRoot, 'settings.json'), JSON.stringify({ featurePriorities: { overrides: { brain: 'P9', ghost: 'P0' } } }));
    const { __resetSettingsCache } = await import('../services/settings.js');
    __resetSettingsCache();
    expect(area((await request(buildApp()).get('/api/feature-priorities')).body, 'brain'))
      .toMatchObject({ tier: 'P1', source: 'default' });
  });
});

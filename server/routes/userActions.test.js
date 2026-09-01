/**
 * GET /api/user-actions — the read API over the operator-action ledger (#5594).
 *
 * Runs against the real service on its file backend (PATHS.data re-rooted at a
 * temp dir) so the filters are proven end to end rather than against a stub. The
 * writes come from `recordUserAction` because the ledger has no write endpoint —
 * an operator log a client can POST into is not evidence of anything.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import express from 'express';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const tempRoot = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  return mkdtempSync(joinPath(tmpdir(), 'portos-user-actions-routes-'));
});
vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  const { makePathsProxy } = await import('../lib/mockPathsDataRoot.js');
  return makePathsProxy(actual, { dataRoot: tempRoot });
});

import userActionRoutes from './userActions.js';
import { USER_ACTION_TYPES } from '../lib/userActionTypes.js';
import { MAX_LIST_LIMIT, recordUserAction } from '../services/userActions.js';
import { apiAccessForPath } from '../lib/apiCatalog.js';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/user-actions', userActionRoutes);
  app.use(errorMiddleware);
  return app;
};

const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

beforeEach(async () => {
  rmSync(join(tempRoot, 'user-action-events.json'), { force: true });
  await recordUserAction({
    type: 'cos.task.create', actor: 'user', target: 'task-1',
    summary: 'Queued CoS task: example', dedupeKey: 'e1', happenedAt: daysAgo(9),
  });
  await recordUserAction({
    type: 'cos.schedule.trigger', actor: 'user', target: 'branch-reconcile',
    summary: 'Ran branch-reconcile', dedupeKey: 'e2', happenedAt: daysAgo(5),
  });
  await recordUserAction({
    type: 'settings.update', actor: 'system',
    summary: 'Updated settings: theme', dedupeKey: 'e3', happenedAt: daysAgo(1),
  });
});

afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

describe('GET /api/user-actions', () => {
  it('returns the ledger newest-first', async () => {
    const res = await request(buildApp()).get('/api/user-actions');
    expect(res.status).toBe(200);
    expect(res.body.events.map((e) => e.dedupeKey)).toEqual(['e3', 'e2', 'e1']);
  });

  it('filters by type, actor, and time window', async () => {
    const byType = await request(buildApp()).get('/api/user-actions?type=settings.update');
    expect(byType.body.events.map((e) => e.dedupeKey)).toEqual(['e3']);

    const byActor = await request(buildApp()).get('/api/user-actions?actor=system');
    expect(byActor.body.events.map((e) => e.dedupeKey)).toEqual(['e3']);

    const window = await request(buildApp())
      .get(`/api/user-actions?from=${encodeURIComponent(daysAgo(7))}&to=${encodeURIComponent(daysAgo(3))}`);
    expect(window.body.events.map((e) => e.dedupeKey)).toEqual(['e2']);
  });

  it('accepts a repeated types parameter', async () => {
    const res = await request(buildApp())
      .get('/api/user-actions?types=cos.task.create&types=settings.update');
    expect(res.body.events.map((e) => e.dedupeKey)).toEqual(['e3', 'e1']);
  });

  it('accepts a single types parameter as one filter value', async () => {
    const res = await request(buildApp()).get('/api/user-actions?types=cos.task.create');
    expect(res.body.events.map((e) => e.dedupeKey)).toEqual(['e1']);
  });

  it('clamps an oversized limit instead of rejecting it', async () => {
    const res = await request(buildApp()).get(`/api/user-actions?limit=${MAX_LIST_LIMIT * 10}`);
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(3);
  });

  it('pages with limit + offset', async () => {
    const res = await request(buildApp()).get('/api/user-actions?limit=1&offset=1');
    expect(res.body.events.map((e) => e.dedupeKey)).toEqual(['e2']);
  });

  it('rejects a type outside the closed vocabulary and an unparseable date', async () => {
    expect((await request(buildApp()).get('/api/user-actions?type=cos.task.explode')).status).toBe(400);
    expect((await request(buildApp()).get('/api/user-actions?from=not-a-date')).status).toBe(400);
    // Bypass probe: the same shape with valid values is accepted, so the two
    // refusals above are about the values and not about the route being broken.
    expect((await request(buildApp()).get(`/api/user-actions?type=cos.task.create&from=${encodeURIComponent(daysAgo(30))}`)).status).toBe(200);
  });
});

describe('GET /api/user-actions/types', () => {
  it('serves the closed vocabulary so a filter UI need not mirror it', async () => {
    const res = await request(buildApp()).get('/api/user-actions/types');
    expect(res.status).toBe(200);
    expect(res.body.types).toEqual([...USER_ACTION_TYPES]);
    expect(res.body.actors).toEqual(['user', 'mind', 'schedule', 'system']);
    expect(res.body.maxLimit).toBe(MAX_LIST_LIMIT);
  });
});

describe('auth posture', () => {
  it('sits behind the normal /api/* gate', () => {
    // The ledger names what one operator did on one machine. It must never be
    // reachable without a session when the instance password is on, so it may
    // not appear in ALWAYS_PUBLIC_API_PATHS or an API_REGISTRY public prefix.
    expect(apiAccessForPath('/api/user-actions')).toBe('authenticated-ui');
    expect(apiAccessForPath('/api/user-actions/types')).toBe('authenticated-ui');
    // Bypass probe: the classifier does return something else for a genuinely
    // public path, so the two assertions above are not vacuously true.
    expect(apiAccessForPath('/api/system/health')).toBe('always-public');
  });
});

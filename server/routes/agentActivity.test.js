import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const mocks = vi.hoisted(() => ({
  readRunEvents: vi.fn(),
  getRunProjections: vi.fn(),
  getRunDiagnostic: vi.fn(),
  getRunEventLedgerStats: vi.fn(),
  getRunReconciliation: vi.fn(),
  repairRunRecords: vi.fn(),
}));

vi.mock('../services/agentRunEventLog.js', () => mocks);
vi.mock('../services/agentRunReconciler.js', () => mocks);
vi.mock('../services/agentActivity.js', () => ({
  getRecentActivities: vi.fn(async () => []),
  getActivityTimeline: vi.fn(async () => []),
  getActivities: vi.fn(async () => []),
  getAgentStats: vi.fn(async () => ({})),
  cleanupOldActivity: vi.fn(async () => 0),
}));

import agentActivityRoutes from './agentActivity.js';

const app = () => {
  const a = express();
  a.use(express.json());
  a.use('/api/agents/activity', agentActivityRoutes);
  a.use(errorMiddleware);
  return a;
};

const get = (path) => request(app()).get(`/api/agents/activity${path}`);
const post = (path, body) => request(app()).post(`/api/agents/activity${path}`).send(body);

describe('GET /run-events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readRunEvents.mockResolvedValue([]);
    mocks.getRunProjections.mockResolvedValue([]);
    mocks.getRunDiagnostic.mockResolvedValue({ projection: null, events: [] });
    mocks.getRunEventLedgerStats.mockResolvedValue({ activeEvents: 0, archivedEvents: 0 });
  });

  it('passes validated, coerced filters through to the ledger', async () => {
    const res = await get('/run-events?runId=r1&kind=run.finalized&limit=25&since=2026-08-18T10:00:00.000Z');
    expect(res.status).toBe(200);
    // `limit` must arrive as a NUMBER — the service compares it numerically, so a
    // raw query string would silently disable the cap.
    expect(mocks.readRunEvents).toHaveBeenCalledWith({
      runId: 'r1',
      kind: 'run.finalized',
      limit: 25,
      since: '2026-08-18T10:00:00.000Z',
    });
  });

  it('rejects a kind outside the closed event vocabulary', async () => {
    const res = await get('/run-events?kind=run.invented');
    expect(res.status).toBe(400);
    expect(mocks.readRunEvents).not.toHaveBeenCalled();
  });

  it('rejects a limit above the ledger read ceiling', async () => {
    expect((await get('/run-events?limit=100000')).status).toBe(400);
    expect((await get('/run-events?limit=0')).status).toBe(400);
    expect(mocks.readRunEvents).not.toHaveBeenCalled();
  });

  it('rejects an unknown query key rather than ignoring it', async () => {
    expect((await get('/run-events?nope=1')).status).toBe(400);
  });

  it('returns the ledger rows verbatim — redaction already happened on append', async () => {
    const event = { eventId: 'e1', kind: 'run.spawned', runId: 'r1', at: '2026-08-18T10:00:00.000Z', data: {} };
    mocks.readRunEvents.mockResolvedValue([event]);
    const res = await get('/run-events');
    expect(res.body).toEqual([event]);
  });
});

describe('GET /run-events/projections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRunProjections.mockResolvedValue([{ id: 'r1', status: 'completed' }]);
  });

  it('serves the replayed projections', async () => {
    const res = await get('/run-events/projections?runId=r1&limit=5');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'r1', status: 'completed' }]);
    expect(mocks.getRunProjections).toHaveBeenCalledWith({ runId: 'r1', limit: 5 });
  });

  it('rejects an unknown filter', async () => {
    expect((await get('/run-events/projections?kind=run.spawned')).status).toBe(400);
  });
});

describe('GET /run-events/run/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRunDiagnostic.mockResolvedValue({ projection: { id: 'r1' }, events: [] });
  });

  it('serves one run diagnostic', async () => {
    const res = await get('/run-events/run/r1');
    expect(res.status).toBe(200);
    expect(res.body.projection).toEqual({ id: 'r1' });
    expect(mocks.getRunDiagnostic).toHaveBeenCalledWith('r1');
  });

  it('resolves the `agent:<id>` fallback key for a run that never got an id', async () => {
    await get(`/run-events/run/${encodeURIComponent('agent:a9')}`);
    expect(mocks.getRunDiagnostic).toHaveBeenCalledWith('agent:a9');
  });

  it('does not shadow the sibling /run-events routes', async () => {
    await get('/run-events/stats');
    expect(mocks.getRunEventLedgerStats).toHaveBeenCalled();
    expect(mocks.getRunDiagnostic).not.toHaveBeenCalled();
  });
});

describe('/run-events/reconcile', () => {
  const emptyReport = { checkedAt: '2026-08-18T13:00:00.000Z', findings: [], summary: { checked: 0 } };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRunReconciliation.mockResolvedValue(emptyReport);
    mocks.repairRunRecords.mockResolvedValue({ ...emptyReport, repaired: [], skipped: 0 });
  });

  it('serves the drift report and forwards the parsed filters', async () => {
    const res = await get('/run-events/reconcile?runId=r1&limit=25');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(emptyReport);
    expect(mocks.getRunReconciliation).toHaveBeenCalledWith({ runId: 'r1', limit: 25 });
  });

  it('rejects an unknown filter rather than silently ignoring it', async () => {
    expect((await get('/run-events/reconcile?nope=1')).status).toBe(400);
  });

  it('holds the report to the ledger read ceiling', async () => {
    expect((await get('/run-events/reconcile?limit=100000')).status).toBe(400);
    expect((await get('/run-events/reconcile?limit=0')).status).toBe(400);
  });

  it('never repairs from the GET', async () => {
    await get('/run-events/reconcile');
    expect(mocks.repairRunRecords).not.toHaveBeenCalled();
  });

  it('repairs only from the POST, and validates the body', async () => {
    const res = await post('/run-events/reconcile', { runId: 'r1', limit: 10 });
    expect(res.status).toBe(200);
    expect(res.body.repaired).toEqual([]);
    expect(mocks.repairRunRecords).toHaveBeenCalledWith({ runId: 'r1', limit: 10 });
  });

  it('accepts an empty POST body', async () => {
    const res = await post('/run-events/reconcile');
    expect(res.status).toBe(200);
    expect(mocks.repairRunRecords).toHaveBeenCalledWith({});
  });

  it('rejects an unknown field in the POST body', async () => {
    expect((await post('/run-events/reconcile', { force: true })).status).toBe(400);
  });
});

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
const activityMocks = vi.hoisted(() => ({
  getRecentActivities: vi.fn(async () => []),
  getActivityTimeline: vi.fn(async () => []),
  getActivities: vi.fn(async () => []),
  getAgentStats: vi.fn(async () => ({})),
  cleanupOldActivity: vi.fn(async () => 0),
}));

vi.mock('../services/agentActivity.js', () => activityMocks);

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

// ---------------------------------------------------------------------------
// Activity-log input validation (#5714). Before this, `limit` was a bare
// parseInt, `agentIds` an uncapped split(','), `date` went straight to
// `new Date()`, and `daysToKeep` reached a function that unlinks files.
// ---------------------------------------------------------------------------

describe('activity route validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /cleanup', () => {
    it('refuses a zero-day window instead of wiping the archive', async () => {
      const res = await post('/cleanup', { daysToKeep: 0 });
      expect(res.status).toBe(400);
      expect(activityMocks.cleanupOldActivity).not.toHaveBeenCalled();
    });

    it('refuses a negative window, which would reach future-dated files', async () => {
      expect((await post('/cleanup', { daysToKeep: -5 })).status).toBe(400);
      expect(activityMocks.cleanupOldActivity).not.toHaveBeenCalled();
    });

    it('refuses a non-numeric window', async () => {
      expect((await post('/cleanup', { daysToKeep: 'abc' })).status).toBe(400);
      expect(activityMocks.cleanupOldActivity).not.toHaveBeenCalled();
    });

    it('defaults an empty body to the 30-day window', async () => {
      const res = await post('/cleanup', {});
      expect(res.status).toBe(200);
      expect(activityMocks.cleanupOldActivity).toHaveBeenCalledWith(30);
    });

    it('passes a valid window through as a number', async () => {
      await post('/cleanup', { daysToKeep: '7' });
      expect(activityMocks.cleanupOldActivity).toHaveBeenCalledWith(7);
    });

    it('rejects an unknown body field rather than ignoring it', async () => {
      expect((await post('/cleanup', { daysToKeep: 30, force: true })).status).toBe(400);
    });
  });

  describe('GET /', () => {
    it('clamps the list limit server-side', async () => {
      expect((await get('/?limit=999999')).status).toBe(400);
      expect((await get('/?limit=0')).status).toBe(400);
      expect(activityMocks.getRecentActivities).not.toHaveBeenCalled();
    });

    it('parses agentIds into a capped array, not a raw split', async () => {
      const res = await get('/?limit=10&agentIds=a-1,%20a-2%20');
      expect(res.status).toBe(200);
      expect(activityMocks.getRecentActivities).toHaveBeenCalledWith({
        limit: 10,
        agentIds: ['a-1', 'a-2'],
        action: null,
      });
    });

    it('treats a blank filter value as absent, not as a 400', async () => {
      const res = await get('/?action=&agentIds=');
      expect(res.status).toBe(200);
      expect(activityMocks.getRecentActivities).toHaveBeenCalledWith({
        limit: 50,
        agentIds: null,
        action: null,
      });
    });

    it('rejects an agentIds batch past the cap', async () => {
      const tooMany = Array.from({ length: 51 }, (_, i) => `a${i}`).join(',');
      expect((await get(`/?agentIds=${tooMany}`)).status).toBe(400);
    });

    it('defaults limit and passes absent filters as null', async () => {
      await get('/');
      expect(activityMocks.getRecentActivities).toHaveBeenCalledWith({
        limit: 50,
        agentIds: null,
        action: null,
      });
    });
  });

  describe('GET /timeline', () => {
    it('requires a full ISO instant for the scroll cursor', async () => {
      expect((await get('/timeline?before=not-a-date')).status).toBe(400);
      expect(activityMocks.getActivityTimeline).not.toHaveBeenCalled();
    });

    it('forwards a valid cursor and coerced limit', async () => {
      const res = await get('/timeline?limit=25&before=2026-08-23T00:00:05.000Z');
      expect(res.status).toBe(200);
      expect(activityMocks.getActivityTimeline).toHaveBeenCalledWith({
        limit: 25,
        agentIds: null,
        beforeTimestamp: '2026-08-23T00:00:05.000Z',
      });
    });
  });

  describe('GET /agent/:agentId', () => {
    it('rejects a traversal segment in the agent id', async () => {
      // The separator is percent-encoded so the path survives URL normalization
      // and arrives as one decoded param — `agentId` is interpolated straight
      // into `data/agents/activity/<agentId>/<date>.json`.
      expect((await get('/agent/..%2fetc')).status).toBe(400);
      expect((await get('/agent/%2e%2e%2fetc')).status).toBe(400);
      expect((await get('/agent/a b')).status).toBe(400);
      expect(activityMocks.getActivities).not.toHaveBeenCalled();
    });

    it('hands the date through as a YYYY-MM-DD string, never a Date', async () => {
      const res = await get('/agent/agent-a?date=2026-08-22&limit=10&offset=5');
      expect(res.status).toBe(200);
      expect(activityMocks.getActivities).toHaveBeenCalledWith('agent-a', {
        date: '2026-08-22',
        limit: 10,
        offset: 5,
        action: null,
      });
    });

    it('rejects a free-form date string', async () => {
      expect((await get('/agent/agent-a?date=yesterday')).status).toBe(400);
      expect(activityMocks.getActivities).not.toHaveBeenCalled();
    });

    it('clamps the limit and refuses a negative offset', async () => {
      expect((await get('/agent/agent-a?limit=999999')).status).toBe(400);
      expect((await get('/agent/agent-a?offset=-1')).status).toBe(400);
    });
  });

  describe('GET /agent/:agentId/stats', () => {
    it('bounds the stats window, which is one file read per day', async () => {
      expect((await get('/agent/agent-a/stats?days=100000')).status).toBe(400);
      expect((await get('/agent/agent-a/stats?days=0')).status).toBe(400);
      expect(activityMocks.getAgentStats).not.toHaveBeenCalled();
    });

    it('defaults to a 7-day window as a number', async () => {
      await get('/agent/agent-a/stats');
      expect(activityMocks.getAgentStats).toHaveBeenCalledWith('agent-a', 7);
    });
  });
});

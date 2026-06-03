import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock every producer service the aggregator pulls from, so the test exercises
// only the normalization / sort / cap / degrade-on-failure logic.
const brain = { getInboxLog: vi.fn() };
const askConversations = { listConversations: vi.fn() };
const cosTaskStore = { getCosTasks: vi.fn() };
const messageDrafts = { listDrafts: vi.fn() };
const proactiveAlerts = { generateAlerts: vi.fn() };
const backup = { getState: vi.fn() };

vi.mock('./brain.js', () => brain);
vi.mock('./askConversations.js', () => askConversations);
vi.mock('./cosTaskStore.js', () => cosTaskStore);
vi.mock('./messageDrafts.js', () => messageDrafts);
vi.mock('./proactiveAlerts.js', () => proactiveAlerts);
vi.mock('./backup.js', () => backup);

const { buildQueue, __resetAlertsCache } = await import('./reviewQueue.js');

// Default: every producer returns "nothing needs attention".
function resetEmpty() {
  brain.getInboxLog.mockResolvedValue([]);
  askConversations.listConversations.mockResolvedValue([]);
  cosTaskStore.getCosTasks.mockResolvedValue({ awaitingApproval: [] });
  messageDrafts.listDrafts.mockResolvedValue([]);
  proactiveAlerts.generateAlerts.mockResolvedValue({ alerts: [] });
  backup.getState.mockResolvedValue({ status: 'ok', error: null });
}

describe('reviewQueue.buildQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetEmpty();
    // The alerts sweep is cached with a TTL; clear it so each case sees its
    // own generateAlerts mock rather than a prior case's cached result.
    __resetAlertsCache();
  });

  it('returns an empty queue when nothing needs attention', async () => {
    const queue = await buildQueue();
    expect(queue.items).toEqual([]);
    expect(queue.counts.total).toBe(0);
    expect(queue.sources.brain.total).toBe(0);
  });

  it('normalizes each producer into the common row shape', async () => {
    brain.getInboxLog.mockResolvedValue([{ id: 'b1', capturedText: 'classify me', capturedAt: '2026-06-03T10:00:00.000Z' }]);
    const queue = await buildQueue();
    const row = queue.items.find(i => i.source === 'brain');
    expect(row).toMatchObject({
      id: 'brain:b1',
      source: 'brain',
      sourceLabel: 'Brain inbox',
      title: 'Inbox item needs classification',
      summary: 'classify me',
      drillTo: '/brain/inbox'
    });
  });

  it('only surfaces unpromoted ask conversations with content', async () => {
    askConversations.listConversations.mockResolvedValue([
      { id: 'a1', title: 'has content', promoted: false, turnCount: 2, updatedAt: '2026-06-03T10:00:00.000Z' },
      { id: 'a2', title: 'already promoted', promoted: true, turnCount: 3 },
      { id: 'a3', title: 'no turns', promoted: false, turnCount: 0 }
    ]);
    const queue = await buildQueue();
    const askRows = queue.items.filter(i => i.source === 'ask');
    expect(askRows).toHaveLength(1);
    expect(askRows[0].id).toBe('ask:a1');
    expect(askRows[0].drillTo).toBe('/ask/a1');
  });

  it('surfaces drafts and CoS approvals from their producers', async () => {
    cosTaskStore.getCosTasks.mockResolvedValue({ awaitingApproval: [{ id: 'sys-1', description: 'approve me', priority: 'HIGH', createdAt: '2026-06-03T09:00:00.000Z' }] });
    messageDrafts.listDrafts.mockResolvedValue([
      { id: 'd1', status: 'draft', subject: 'unsent', updatedAt: '2026-06-03T08:00:00.000Z' },
      { id: 'd2', status: 'sent', subject: 'gone' }
    ]);
    const queue = await buildQueue();
    expect(queue.items.find(i => i.id === 'cos:sys-1')).toMatchObject({ severity: 'high', drillTo: '/cos/tasks' });
    const draftRows = queue.items.filter(i => i.source === 'drafts');
    expect(draftRows).toHaveLength(1);
    expect(draftRows[0].id).toBe('draft:d1');
  });

  it('only surfaces critical/high health alerts and a failed backup', async () => {
    // Real proactiveAlerts shape: { type, severity, title, detail, link }.
    proactiveAlerts.generateAlerts.mockResolvedValue({ alerts: [
      { type: 'system_resource', severity: 'critical', title: 'High memory usage', detail: '95% used', link: '/apps' },
      { type: 'goal_stall', severity: 'medium', title: 'meh', detail: 'low' }
    ] });
    // Real backup failure shape: status 'error' with an `error` field.
    backup.getState.mockResolvedValue({ status: 'error', error: 'disk full', lastRun: '2026-06-03T07:00:00.000Z' });
    const queue = await buildQueue();
    const healthRows = queue.items.filter(i => i.source === 'health');
    expect(healthRows).toHaveLength(1);
    expect(healthRows[0]).toMatchObject({ severity: 'critical', summary: '95% used', drillTo: '/apps' });
    expect(queue.items.find(i => i.source === 'backup')).toMatchObject({ title: 'Backup failed', summary: 'disk full' });
  });

  it('gives same-type health alerts unique ids', async () => {
    proactiveAlerts.generateAlerts.mockResolvedValue({ alerts: [
      { type: 'system_resource', severity: 'high', title: 'High memory', detail: 'mem', link: '/apps' },
      { type: 'system_resource', severity: 'high', title: 'High CPU', detail: 'cpu', link: '/apps' }
    ] });
    const queue = await buildQueue();
    const ids = queue.items.filter(i => i.source === 'health').map(i => i.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('sorts by severity then recency', async () => {
    brain.getInboxLog.mockResolvedValue([{ id: 'b1', capturedText: 'normal', capturedAt: '2026-06-03T12:00:00.000Z' }]);
    proactiveAlerts.generateAlerts.mockResolvedValue({ alerts: [{ type: 'disk', severity: 'critical', title: 'crit', detail: 'full', link: '/apps', timestamp: '2026-06-03T01:00:00.000Z' }] });
    const queue = await buildQueue();
    // critical alert sorts ahead of the (newer) normal brain item
    expect(queue.items[0].severity).toBe('critical');
    expect(queue.counts.critical).toBe(1);
  });

  it('treats a producer returning null/non-array as empty', async () => {
    brain.getInboxLog.mockResolvedValue(null);
    askConversations.listConversations.mockResolvedValue(undefined);
    const queue = await buildQueue();
    expect(queue.items).toEqual([]);
    expect(queue.sources.brain.total).toBe(0);
    expect(queue.sources.brain.error).toBeNull();
  });

  it('degrades a failing producer to empty without sinking the queue', async () => {
    brain.getInboxLog.mockRejectedValue(new Error('inbox boom'));
    messageDrafts.listDrafts.mockResolvedValue([{ id: 'd1', status: 'draft', subject: 'still here' }]);
    const queue = await buildQueue();
    expect(queue.sources.brain.error).toBe('inbox boom');
    expect(queue.items.find(i => i.source === 'drafts')).toBeTruthy();
  });

  it('caps each source and reports the pre-cap total', async () => {
    brain.getInboxLog.mockResolvedValue(
      Array.from({ length: 40 }, (_, i) => ({ id: `b${i}`, capturedText: `t${i}`, capturedAt: '2026-06-03T10:00:00.000Z' }))
    );
    const queue = await buildQueue();
    const brainRows = queue.items.filter(i => i.source === 'brain');
    expect(brainRows).toHaveLength(25);
    expect(queue.sources.brain.total).toBe(40);
    expect(queue.sources.brain.shown).toBe(25);
  });
});

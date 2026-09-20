import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock every producer service the aggregator pulls from, so the test exercises
// only the normalization / sort / bounded-read / snapshot / degrade-on-failure logic.
const brain = { getInboxLog: vi.fn(), markInboxDone: vi.fn() };
const askConversations = { listConversations: vi.fn() };
const cosTaskStore = { getCosTasks: vi.fn(), approveTask: vi.fn() };
const messageDrafts = { listDrafts: vi.fn(), approveDraft: vi.fn() };
const proactiveAlerts = { generateAlerts: vi.fn() };
const backup = { getState: vi.fn() };
const reviewService = { getItems: vi.fn(), dismissByReferenceId: vi.fn() };
const notifications = { getNotifications: vi.fn() };
// Mocked so the meta-field / buildQueue cases don't pull the brain/cos/identity
// stack in transitively (askPromote imports all three). The promoteAskQueueItem
// suite drives this mock directly.
const askPromote = { promoteLatestAssistantTurn: vi.fn() };
// getGoals feeds the Ask row's inline goal picker (goalOptions); default to no
// active goals so existing cases see the brain/task-only target list.
const identity = { getGoals: vi.fn() };
const stackerNews = { listPendingReviewActions: vi.fn() };
const x = { listPendingReviewActions: vi.fn() };

vi.mock('./brain.js', () => brain);
vi.mock('./askConversations.js', () => askConversations);
vi.mock('./cosTaskStore.js', () => cosTaskStore);
vi.mock('./messageDrafts.js', () => messageDrafts);
vi.mock('./proactiveAlerts.js', () => proactiveAlerts);
vi.mock('./backup.js', () => backup);
vi.mock('./review.js', () => reviewService);
vi.mock('./notifications.js', () => notifications);
vi.mock('./identity.js', () => identity);
vi.mock('./askPromote.js', () => askPromote);
vi.mock('./stackerNews.js', () => stackerNews);
vi.mock('./x.js', () => x);

const {
  buildQueue,
  resolveQueueItem,
  promoteAskQueueItem,
  __resetAlertsCache,
  __resetQueueSnapshots,
  REVIEW_QUEUE_SOURCE_READ_LIMIT,
} = await import('./reviewQueue.js');

// Default: every producer returns "nothing needs attention".
function resetEmpty() {
  brain.getInboxLog.mockResolvedValue([]);
  askConversations.listConversations.mockResolvedValue([]);
  cosTaskStore.getCosTasks.mockResolvedValue({ awaitingApproval: [] });
  messageDrafts.listDrafts.mockResolvedValue([]);
  proactiveAlerts.generateAlerts.mockResolvedValue({ alerts: [] });
  backup.getState.mockResolvedValue({ status: 'ok', error: null });
  reviewService.getItems.mockResolvedValue([]);
  notifications.getNotifications.mockResolvedValue([]);
  identity.getGoals.mockResolvedValue({ goals: [] });
  stackerNews.listPendingReviewActions.mockResolvedValue([]);
  x.listPendingReviewActions.mockResolvedValue([]);
}

describe('reviewQueue.buildQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetEmpty();
    // The alerts sweep is cached with a TTL; clear it so each case sees its
    // own generateAlerts mock rather than a prior case's cached result.
    __resetAlertsCache();
    __resetQueueSnapshots();
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetQueueSnapshots();
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
      drillTo: '/brain/inbox',
      sourceRef: 'b1',
      actionKind: 'brain.classify',
      reason: 'classify me',
      nextAction: 'Done',
      priority: null,
      dueAt: null,
      revision: '2026-06-03T10:00:00.000Z',
      occurrence: null,
      required: true,
      isRecommendation: false,
      operations: [{ id: 'resolve', label: 'Done', available: true }],
      availability: 'available',
      available: true,
    });
  });

  it('surfaces pending Stacker News approvals with an account-specific drill-down', async () => {
    stackerNews.listPendingReviewActions.mockResolvedValue([{ id: 's1', accountId: 'a1', accountLabel: 'Example account', kind: 'publish_comment', payload: { body: 'Thoughtful reply' }, createdAt: '2026-06-03T10:00:00.000Z' }]);
    const queue = await buildQueue();
    expect(queue.items.find((item) => item.source === 'stacker')).toMatchObject({
      id: 'stacker:s1',
      drillTo: '/stacker-news/a1/review',
      sourceLabel: 'Stacker News approvals',
    });
  });

  it('surfaces X drafts with an account-specific drill-down', async () => {
    x.listPendingReviewActions.mockResolvedValue([{ id: 'x1', accountId: 'a1', accountLabel: 'Example X account', username: 'example_user', payload: { body: 'A thoughtful draft' }, createdAt: '2026-06-03T11:00:00.000Z' }]);
    const queue = await buildQueue();
    expect(queue.items.find((item) => item.source === 'x')).toMatchObject({
      id: 'x:x1',
      drillTo: '/x/a1/drafts',
      sourceLabel: 'X drafts',
    });
  });

  it('only surfaces unpromoted ask conversations that have an assistant answer', async () => {
    askConversations.listConversations.mockResolvedValue([
      { id: 'a1', title: 'has content', promoted: false, turnCount: 2, assistantTurnCount: 1, updatedAt: '2026-06-03T10:00:00.000Z' },
      { id: 'a2', title: 'already promoted', promoted: true, turnCount: 3, assistantTurnCount: 2 },
      { id: 'a3', title: 'no turns', promoted: false, turnCount: 0, assistantTurnCount: 0 },
      // turnCount > 0 but NO assistant turn (stream errored / client disconnected
      // before the answer persisted). Promoting it would fail NO_ASSISTANT_TURN,
      // so it must NOT be surfaced as a promotable row.
      { id: 'a4', title: 'user turn only', promoted: false, turnCount: 1, assistantTurnCount: 0 }
    ]);
    const queue = await buildQueue();
    const askRows = queue.items.filter(i => i.source === 'ask');
    expect(askRows).toHaveLength(1);
    expect(askRows[0].id).toBe('ask:a1');
    expect(askRows[0].drillTo).toBe('/ask/a1');
    expect(askRows[0]).toMatchObject({ required: false, isRecommendation: true });
  });

  it('surfaces drafts and CoS approvals from their producers', async () => {
    cosTaskStore.getCosTasks.mockResolvedValue({ awaitingApproval: [{ id: 'sys-1', description: 'approve me', priority: 'HIGH', createdAt: '2026-06-03T09:00:00.000Z' }] });
    // The producer pushes a multi-status filter down to listDrafts, so the mock
    // honors it the way the real implementation does (drops the 'sent' draft).
    const allDrafts = [
      { id: 'd1', status: 'draft', subject: 'unsent', updatedAt: '2026-06-03T08:00:00.000Z' },
      { id: 'd2', status: 'sent', subject: 'gone' }
    ];
    messageDrafts.listDrafts.mockImplementation(({ status } = {}) => {
      const wanted = Array.isArray(status) ? status : status ? [status] : null;
      return Promise.resolve(wanted ? allDrafts.filter(d => wanted.includes(d.status)) : allDrafts);
    });
    const queue = await buildQueue();
    expect(messageDrafts.listDrafts).toHaveBeenCalledWith({ status: ['draft', 'pending_review'] });
    expect(queue.items.find(i => i.id === 'cos:sys-1')).toMatchObject({ severity: 'high', drillTo: '/cos/tasks' });
    const draftRows = queue.items.filter(i => i.source === 'drafts');
    expect(draftRows).toHaveLength(1);
    expect(draftRows[0].id).toBe('drafts:d1');
    expect(draftRows[0]).toMatchObject({ required: false, isRecommendation: true, nextAction: 'Open draft' });
  });

  it('adapts stored obligations and notifications, deduplicating only proven references', async () => {
    reviewService.getItems.mockResolvedValue([
      {
        id: 'review-memory',
        type: 'alert',
        title: 'Memory approval',
        description: 'Approve a memory',
        status: 'pending',
        createdAt: '2026-09-20T00:00:00.000Z',
        metadata: { referenceId: 'memory-1', category: 'memory-approval' },
      },
      {
        id: 'legacy-alert',
        type: 'alert',
        title: 'Legacy review alert',
        description: 'Needs triage',
        status: 'pending',
        createdAt: '2026-09-20T00:00:00.000Z',
        metadata: {},
      },
    ]);
    notifications.getNotifications.mockResolvedValue([
      {
        id: 'memory-notification',
        type: 'memory_approval',
        title: 'Memory approval',
        description: 'Same obligation',
        timestamp: '2026-09-20T00:00:00.000Z',
        link: '/cos/memory',
        metadata: { memoryId: 'memory-1' },
      },
      {
        id: 'plan-notification',
        type: 'plan_question',
        title: 'Plan question',
        message: 'Choose a direction',
        timestamp: '2026-09-20T00:00:00.000Z',
        link: '/apps/example/documents',
        metadata: { agentId: 'agent-1' },
      },
      {
        id: 'briefing-notification',
        type: 'briefing_ready',
        title: 'Briefing',
        timestamp: '2026-09-20T00:00:00.000Z',
        metadata: {},
      },
    ]);

    const queue = await buildQueue();

    expect(queue.items.filter(item => item.id === 'memory:memory-1')).toHaveLength(1);
    expect(queue.items.find(item => item.id === 'review:legacy-alert')).toMatchObject({
      actionKind: 'review.triage',
      triageOnly: true,
    });
    expect(queue.items.find(item => item.id === 'plan:agent-1')).toMatchObject({
      source: 'notifications',
      actionKind: 'plan.question',
      summary: 'Choose a direction',
      operations: [{ id: 'review', available: false }],
    });
    expect(queue.items.find(item => item.id === 'briefing:briefing-notification')).toBeUndefined();
  });

  it('only surfaces critical/high health alerts and a failed backup', async () => {
    // Real proactiveAlerts shape: { id, type, severity, title, detail, link }.
    proactiveAlerts.generateAlerts.mockResolvedValue({ alerts: [
      { id: 'system_resource:memory', type: 'system_resource', severity: 'critical', title: 'High memory usage', detail: '95% used', link: '/apps' },
      { id: 'goal_stall:example-goal', type: 'goal_stall', severity: 'medium', title: 'meh', detail: 'low' }
    ] });
    // Real backup failure shape: status 'error' with an `error` field.
    backup.getState.mockResolvedValue({ status: 'error', error: 'disk full', lastRun: '2026-06-03T07:00:00.000Z' });
    const queue = await buildQueue();
    const healthRows = queue.items.filter(i => i.source === 'health');
    expect(healthRows).toHaveLength(1);
    expect(healthRows[0]).toMatchObject({ severity: 'critical', summary: '95% used', drillTo: '/system-resources/overview' });
    expect(queue.items.find(i => i.source === 'backup')).toMatchObject({ title: 'Backup failed', summary: 'disk full' });
  });

  it('surfaces a degraded backup as a normal-severity warning, not a high-severity failure', async () => {
    proactiveAlerts.generateAlerts.mockResolvedValue({ alerts: [] });
    // Degraded shape: files saved (status 'degraded') but the DB dump failed,
    // so an `error` string is also present. Must NOT read as a full failure.
    backup.getState.mockResolvedValue({ status: 'degraded', error: 'DB dump dump_error', lastRun: '2026-06-03T07:00:00.000Z' });
    const queue = await buildQueue();
    const row = queue.items.find(i => i.source === 'backup');
    expect(row).toMatchObject({ title: 'Backup degraded (DB dump failed)', severity: 'normal' });
  });

  it('preserves condition identity through reorder, wording changes and severity escalation', async () => {
    const memory = { id: 'system_resource:memory', type: 'system_resource', severity: 'high', title: 'High memory', detail: 'mem', link: '/apps' };
    const cpu = { id: 'system_resource:cpu', type: 'system_resource', severity: 'high', title: 'High CPU', detail: 'cpu', link: '/apps' };
    proactiveAlerts.generateAlerts.mockResolvedValue({ alerts: [memory, cpu] });
    const first = await buildQueue();
    expect(first.items.map(i => i.id).sort()).toEqual(['health:system_resource:cpu', 'health:system_resource:memory']);

    __resetAlertsCache();
    proactiveAlerts.generateAlerts.mockResolvedValue({ alerts: [
      cpu, { ...memory, title: 'Memory pressure', severity: 'critical' },
      { id: 'goal_stall:example', type: 'goal_stall', severity: 'high', title: 'Check goal' }
    ] });
    const next = await buildQueue();
    expect(next.items.find(i => i.title === 'Memory pressure')).toMatchObject({
      id: 'health:system_resource:memory', severity: 'critical'
    });
    expect(next.items.find(i => i.title === 'High CPU').id).toBe('health:system_resource:cpu');

    __resetAlertsCache();
    proactiveAlerts.generateAlerts.mockResolvedValue({ alerts: [cpu] });
    expect((await buildQueue()).items.map(i => i.id)).toEqual(['health:system_resource:cpu']);
  });

  it('deduplicates before caps and counts while retaining severity escalation', async () => {
    const memory = { id: 'system_resource:memory', type: 'system_resource', severity: 'high' };
    proactiveAlerts.generateAlerts.mockResolvedValue({ alerts: [
      ...Array.from({ length: 30 }, () => memory),
      { ...memory, severity: 'critical' },
      { id: 'system_resource:cpu', type: 'system_resource', severity: 'high' }
    ] });
    const queue = await buildQueue();
    expect(queue.items.map(i => i.id)).toEqual(['health:system_resource:memory', 'health:system_resource:cpu']);
    expect(queue.sources.health).toMatchObject({ total: 2, shown: 2, error: null });
    expect(queue.counts).toEqual({ total: 2, critical: 1, high: 1 });
  });

  it('reports missing health identity without hiding healthy sources', async () => {
    proactiveAlerts.generateAlerts.mockResolvedValue({ alerts: [{ type: 'system_resource', severity: 'critical' }] });
    brain.getInboxLog.mockResolvedValue([{ id: 'b1', capturedText: 'classify' }]);
    const queue = await buildQueue();
    expect(queue.sources.health.error).toBe('Health alert identity is unavailable');
    expect(queue.items.map(i => i.id)).toEqual(['brain:b1']);
  });

  it('sorts required work by severity, then due time, priority, and stable ID', async () => {
    brain.getInboxLog.mockResolvedValue([{ id: 'b1', capturedText: 'normal', capturedAt: '2026-06-03T12:00:00.000Z' }]);
    proactiveAlerts.generateAlerts.mockResolvedValue({ alerts: [{ id: 'disk:primary', type: 'disk', severity: 'critical', title: 'crit', detail: 'full', link: '/apps', timestamp: '2026-06-03T01:00:00.000Z' }] });
    const queue = await buildQueue();
    // critical alert sorts ahead of the normal brain item.
    expect(queue.items[0].severity).toBe('critical');
    expect(queue.counts.critical).toBe(1);

    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    proactiveAlerts.generateAlerts.mockResolvedValue({ alerts: [] });
    brain.getInboxLog.mockResolvedValue([
      { id: 'optional', capturedText: 'optional', required: false, dueAt: past },
      { id: 'required-low', capturedText: 'low', required: true, dueAt: future, priority: 'LOW' },
      { id: 'required-high-b', capturedText: 'high b', required: true, dueAt: future, priority: 'HIGH' },
      { id: 'required-overdue', capturedText: 'overdue', required: true, dueAt: past, priority: 'LOW' },
      { id: 'required-high-a', capturedText: 'high a', required: true, dueAt: future, priority: 'HIGH' },
    ]);
    __resetAlertsCache();
    const ordered = await buildQueue();
    expect(ordered.items.map((item) => item.id)).toEqual([
      'brain:required-overdue',
      'brain:required-high-a',
      'brain:required-high-b',
      'brain:required-low',
      'brain:optional',
    ]);
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
    expect(queue.sources.brain.availability).toBe('unavailable');
    expect(queue.sources.brain.total).toBeNull();
    expect(queue.totalsBySource.brain).toBeNull();
    expect(queue.total).toBeNull();
    expect(queue.partial).toBe(true);
    expect(queue.items.find(i => i.source === 'drafts')).toBeTruthy();
  });

  it('returns every row within the bounded source read and reports its total', async () => {
    brain.getInboxLog.mockResolvedValue(
      Array.from({ length: 40 }, (_, i) => ({ id: `b${i}`, capturedText: `t${i}`, capturedAt: '2026-06-03T10:00:00.000Z' }))
    );
    const queue = await buildQueue();
    const brainRows = queue.items.filter(i => i.source === 'brain');
    expect(brainRows).toHaveLength(40);
    expect(queue.sources.brain.total).toBe(40);
    expect(queue.sources.brain.shown).toBe(40);
    expect(queue.sources.brain.truncation).toBe(false);
  });

  it('keeps page order stable when a source changes between cursor requests', async () => {
    const firstRows = Array.from({ length: 5 }, (_, i) => ({
      id: `b${i}`,
      capturedText: `row ${i}`,
      capturedAt: '2026-06-03T10:00:00.000Z',
    }));
    brain.getInboxLog.mockResolvedValue(firstRows);
    const first = await buildQueue({ limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual(['brain:b0', 'brain:b1']);
    expect(first.total).toBe(5);
    expect(first.counts.total).toBe(5);
    expect(first.nextCursor).toBeTruthy();

    brain.getInboxLog.mockResolvedValue([{ id: 'new', capturedText: 'changed source' }]);
    const second = await buildQueue({ limit: 2, cursor: first.nextCursor });
    expect(second.items.map((item) => item.id)).toEqual(['brain:b2', 'brain:b3']);
    expect(second.counts.total).toBe(5);
    expect(brain.getInboxLog).toHaveBeenCalledTimes(1);

    const third = await buildQueue({ cursor: second.nextCursor });
    expect(third.items.map((item) => item.id)).toEqual(['brain:b4']);
    expect(third.nextCursor).toBeNull();
  });

  it('rejects malformed, changed, and expired cursors explicitly', async () => {
    await expect(buildQueue({ cursor: 'not-a-cursor' })).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_CURSOR',
    });

    brain.getInboxLog.mockResolvedValue([
      { id: 'b1', capturedText: 'one' },
      { id: 'b2', capturedText: 'two' },
    ]);
    const first = await buildQueue({ limit: 1, query: { source: 'brain' } });
    await expect(buildQueue({ cursor: first.nextCursor, query: { source: 'ask' } })).rejects.toMatchObject({
      status: 400,
      code: 'CURSOR_QUERY_MISMATCH',
    });

    vi.useFakeTimers({ now: Date.now() });
    const expiring = await buildQueue({ limit: 1 });
    vi.advanceTimersByTime(30_001);
    await expect(buildQueue({ cursor: expiring.nextCursor })).rejects.toMatchObject({
      status: 409,
      code: 'CURSOR_EXPIRED',
    });
  });

  it('marks a bounded source as partial instead of claiming inbox zero', async () => {
    brain.getInboxLog.mockResolvedValue(
      Array.from({ length: REVIEW_QUEUE_SOURCE_READ_LIMIT + 1 }, (_, i) => ({ id: `b${i}`, capturedText: `t${i}` }))
    );
    const queue = await buildQueue({ limit: 10 });
    expect(brain.getInboxLog).toHaveBeenCalledWith({ status: 'needs_review', limit: REVIEW_QUEUE_SOURCE_READ_LIMIT + 1 });
    expect(queue.partial).toBe(true);
    expect(queue.total).toBeNull();
    expect(queue.totalsBySource.brain).toBeNull();
    expect(queue.sources.brain).toMatchObject({
      total: null,
      lowerBound: 100,
      truncation: true,
      availability: 'available',
      error: null,
    });
  });

  it('tags resolvable rows with an inline action verb, leaves no-clean-resolve sources without one', async () => {
    brain.getInboxLog.mockResolvedValue([{ id: 'b1', capturedText: 'classify', capturedAt: '2026-06-03T10:00:00.000Z' }]);
    cosTaskStore.getCosTasks.mockResolvedValue({ awaitingApproval: [{ id: 'sys-1', description: 'approve me', priority: 'HIGH', createdAt: '2026-06-03T09:00:00.000Z' }] });
    askConversations.listConversations.mockResolvedValue([{ id: 'a1', title: 'promote me', promoted: false, turnCount: 1, assistantTurnCount: 1 }]);
    proactiveAlerts.generateAlerts.mockResolvedValue({ alerts: [{ id: 'disk:primary', type: 'disk', severity: 'critical', title: 'crit', detail: 'full', link: '/apps' }] });
    backup.getState.mockResolvedValue({ status: 'error', error: 'disk full' });
    const queue = await buildQueue();
    expect(queue.items.find(i => i.source === 'brain').action).toBe('Done');
    expect(queue.items.find(i => i.source === 'cos').action).toBe('Approve');
    // Ask "promote" needs a per-turn target choice (drill-down), and health
    // (live-computed) / backup (settings-driven retry) have no clean local
    // resolve — none of them carry an inline action.
    expect(queue.items.find(i => i.source === 'ask').action).toBeUndefined();
    expect(queue.items.find(i => i.source === 'health').action).toBeUndefined();
    expect(queue.items.find(i => i.source === 'backup').action).toBeUndefined();
  });

  it('attaches source-appropriate meta chips when the raw field is present', async () => {
    brain.getInboxLog.mockResolvedValue([{ id: 'b1', capturedText: 'classify', source: 'voice', capturedAt: '2026-06-03T10:00:00.000Z' }]);
    askConversations.listConversations.mockResolvedValue([{ id: 'a1', title: 'promote me', promoted: false, turnCount: 4, assistantTurnCount: 2 }]);
    cosTaskStore.getCosTasks.mockResolvedValue({ awaitingApproval: [{ id: 'sys-1', description: 'approve me', priority: 'MEDIUM', createdAt: '2026-06-03T09:00:00.000Z' }] });
    messageDrafts.listDrafts.mockResolvedValue([{ id: 'd1', status: 'draft', subject: 's', to: ['boss@example.com'], sendVia: 'gmail', updatedAt: '2026-06-03T08:00:00.000Z' }]);
    proactiveAlerts.generateAlerts.mockResolvedValue({ alerts: [{ id: 'system_resource:memory', type: 'system_resource', severity: 'critical', title: 'mem', detail: 'high', link: '/apps' }] });
    const queue = await buildQueue();
    expect(queue.items.find(i => i.source === 'brain').meta).toEqual({ captureSource: 'voice' });
    expect(queue.items.find(i => i.source === 'ask').meta).toEqual({ turnCount: 4 });
    expect(queue.items.find(i => i.source === 'cos').meta).toEqual({ priority: 'MEDIUM' });
    expect(queue.items.find(i => i.source === 'drafts').meta).toEqual({ recipient: 'boss@example.com', channel: 'gmail' });
    expect(queue.items.find(i => i.source === 'health').meta).toEqual({ alertType: 'system_resource' });
  });

  it('omits meta entirely when the raw fields are missing (no fabricated values)', async () => {
    // Brain entry with no `source`, draft with no recipient/channel — meta should
    // be absent, not an empty object.
    brain.getInboxLog.mockResolvedValue([{ id: 'b1', capturedText: 'classify', capturedAt: '2026-06-03T10:00:00.000Z' }]);
    messageDrafts.listDrafts.mockResolvedValue([{ id: 'd1', status: 'draft', subject: 's', to: [], updatedAt: '2026-06-03T08:00:00.000Z' }]);
    const queue = await buildQueue();
    expect(queue.items.find(i => i.source === 'brain').meta).toBeUndefined();
    expect(queue.items.find(i => i.source === 'drafts').meta).toBeUndefined();
  });

  it('drops an out-of-range cos priority rather than badge-ing it', async () => {
    cosTaskStore.getCosTasks.mockResolvedValue({ awaitingApproval: [{ id: 'sys-1', description: 'x', priority: 'URGENT', createdAt: '2026-06-03T09:00:00.000Z' }] });
    const queue = await buildQueue();
    expect(queue.items.find(i => i.source === 'cos').meta).toBeUndefined();
  });

  it('advertises Ask promote targets (brain/task) and no other source carries them', async () => {
    askConversations.listConversations.mockResolvedValue([{ id: 'a1', title: 'promote me', promoted: false, turnCount: 1, assistantTurnCount: 1 }]);
    brain.getInboxLog.mockResolvedValue([{ id: 'b1', capturedText: 'classify', capturedAt: '2026-06-03T10:00:00.000Z' }]);
    const queue = await buildQueue();
    const ask = queue.items.find(i => i.source === 'ask');
    // No active goals → goal target is not offered and no picker options ride along.
    expect(ask.promoteTargets).toEqual(['brain', 'task']);
    expect(ask.goalOptions).toBeUndefined();
    expect(queue.items.find(i => i.source === 'brain').promoteTargets).toBeUndefined();
  });

  it('adds the goal target + active-goal options to Ask rows when goals exist', async () => {
    askConversations.listConversations.mockResolvedValue([{ id: 'a1', title: 'promote me', promoted: false, turnCount: 1, assistantTurnCount: 1 }]);
    identity.getGoals.mockResolvedValue({
      goals: [
        { id: 'g1', title: 'Ship inbox zero', status: 'active' },
        { id: 'g2', title: 'Archived idea', status: 'archived' }, // filtered out (not active)
        { title: 'No id', status: 'active' }                       // filtered out (no id)
      ]
    });
    const queue = await buildQueue();
    const ask = queue.items.find(i => i.source === 'ask');
    expect(ask.promoteTargets).toEqual(['brain', 'task', 'goal']);
    expect(ask.goalOptions).toEqual([{ id: 'g1', title: 'Ship inbox zero' }]);
  });

  it('degrades to no goal target when the goal store fails', async () => {
    askConversations.listConversations.mockResolvedValue([{ id: 'a1', title: 'promote me', promoted: false, turnCount: 1, assistantTurnCount: 1 }]);
    identity.getGoals.mockRejectedValue(new Error('goals unreadable'));
    const queue = await buildQueue();
    const ask = queue.items.find(i => i.source === 'ask');
    // Ask still surfaces; just without the goal option.
    expect(ask.promoteTargets).toEqual(['brain', 'task']);
    expect(ask.goalOptions).toBeUndefined();
  });

  it('skips malformed goal entries without sinking the whole queue', async () => {
    askConversations.listConversations.mockResolvedValue([{ id: 'a1', title: 'promote me', promoted: false, turnCount: 1, assistantTurnCount: 1 }]);
    // A null / non-object entry must not throw synchronously in the filter —
    // that would run before the per-producer catch and sink every source.
    identity.getGoals.mockResolvedValue({ goals: [null, 'bogus', { id: 'g1', title: 'Real goal', status: 'active' }] });
    const queue = await buildQueue();
    const ask = queue.items.find(i => i.source === 'ask');
    expect(ask).toBeTruthy();
    expect(ask.promoteTargets).toEqual(['brain', 'task', 'goal']);
    expect(ask.goalOptions).toEqual([{ id: 'g1', title: 'Real goal' }]);
  });
});

describe('reviewQueue.promoteAskQueueItem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('promotes the latest assistant turn to brain via the shared promote helper', async () => {
    askPromote.promoteLatestAssistantTurn.mockResolvedValue({ target: 'brain', ref: { type: 'brain', id: 'note-1' } });
    const result = await promoteAskQueueItem('ask:conv-1', 'brain');
    expect(askPromote.promoteLatestAssistantTurn).toHaveBeenCalledWith({ conversationId: 'conv-1', target: 'brain', goalId: undefined });
    expect(result).toMatchObject({ source: 'ask', id: 'ask:conv-1', promoted: true, target: 'brain', ref: { type: 'brain', id: 'note-1' } });
  });

  it('promotes to task target', async () => {
    askPromote.promoteLatestAssistantTurn.mockResolvedValue({ target: 'task', ref: { type: 'task', id: 't-1' } });
    await promoteAskQueueItem('ask:conv-2', 'task');
    expect(askPromote.promoteLatestAssistantTurn).toHaveBeenCalledWith({ conversationId: 'conv-2', target: 'task', goalId: undefined });
  });

  it('promotes to a goal target with the supplied goalId', async () => {
    askPromote.promoteLatestAssistantTurn.mockResolvedValue({ target: 'goal', ref: { type: 'goal', id: 'g1', entryId: 'e1' } });
    const result = await promoteAskQueueItem('ask:conv-9', 'goal', 'g1');
    expect(askPromote.promoteLatestAssistantTurn).toHaveBeenCalledWith({ conversationId: 'conv-9', target: 'goal', goalId: 'g1' });
    expect(result).toMatchObject({ source: 'ask', id: 'ask:conv-9', promoted: true, target: 'goal' });
  });

  it('rejects a goal target with no goalId (400) before touching the helper', async () => {
    await expect(promoteAskQueueItem('ask:conv-1', 'goal')).rejects.toMatchObject({ status: 400 });
    expect(askPromote.promoteLatestAssistantTurn).not.toHaveBeenCalled();
  });

  it('rejects a non-ask row with a 400', async () => {
    await expect(promoteAskQueueItem('brain:b1', 'brain')).rejects.toMatchObject({ status: 400 });
    expect(askPromote.promoteLatestAssistantTurn).not.toHaveBeenCalled();
  });

  it('rejects a genuinely unsupported target with a 400', async () => {
    await expect(promoteAskQueueItem('ask:conv-1', 'calendar')).rejects.toMatchObject({ status: 400 });
    expect(askPromote.promoteLatestAssistantTurn).not.toHaveBeenCalled();
  });

  it('propagates the 404 when no assistant turn exists', async () => {
    const err = new Error('Conversation has no assistant answer to promote');
    err.status = 404;
    askPromote.promoteLatestAssistantTurn.mockRejectedValue(err);
    await expect(promoteAskQueueItem('ask:conv-3', 'brain')).rejects.toMatchObject({ status: 404 });
  });
});

describe('reviewQueue.resolveQueueItem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dispatches brain rows to markInboxDone', async () => {
    brain.markInboxDone.mockResolvedValue({ id: 'b1', status: 'done' });
    const result = await resolveQueueItem('brain:b1');
    expect(brain.markInboxDone).toHaveBeenCalledWith('b1');
    expect(result).toMatchObject({ source: 'brain', id: 'brain:b1', resolved: true });
  });

  it('dispatches draft rows to approveDraft', async () => {
    messageDrafts.approveDraft.mockResolvedValue({ id: 'd1', status: 'approved' });
    await resolveQueueItem('drafts:d1');
    expect(messageDrafts.approveDraft).toHaveBeenCalledWith('d1');
  });

  it('dispatches explicit source operations through the owning service', async () => {
    cosTaskStore.approveTask.mockResolvedValue({ id: 'sys-1', approvalRequired: false });
    const result = await resolveQueueItem('cos:sys-1', 'approve');
    expect(cosTaskStore.approveTask).toHaveBeenCalledWith('sys-1');
    expect(reviewService.dismissByReferenceId).toHaveBeenCalledWith('sys-1');
    expect(result).toMatchObject({ source: 'cos', id: 'cos:sys-1', operation: 'approve', resolved: true });
  });

  it('preserves colons in the raw id (splits on the first only)', async () => {
    brain.markInboxDone.mockResolvedValue({ id: 'b:1:2', status: 'done' });
    await resolveQueueItem('brain:b:1:2');
    expect(brain.markInboxDone).toHaveBeenCalledWith('b:1:2');
  });

  it('rejects sources without an inline resolve (ask/health/backup) and unknown sources with a 400', async () => {
    await expect(resolveQueueItem('ask:a1')).rejects.toMatchObject({ status: 400 });
    await expect(resolveQueueItem('health:x')).rejects.toMatchObject({ status: 400 });
    await expect(resolveQueueItem('backup:last-run')).rejects.toMatchObject({ status: 400 });
    await expect(resolveQueueItem('nope:x')).rejects.toMatchObject({ status: 400 });
  });

  it('surfaces a 404 when the primitive returns null (record gone)', async () => {
    brain.markInboxDone.mockResolvedValue(null);
    await expect(resolveQueueItem('brain:missing')).rejects.toMatchObject({ status: 404 });
  });

  it('maps a CoS approve {error} result to a 409', async () => {
    cosTaskStore.approveTask.mockResolvedValue({ error: 'Task does not require approval' });
    await expect(resolveQueueItem('cos:sys-1')).rejects.toMatchObject({ status: 409 });
  });
});

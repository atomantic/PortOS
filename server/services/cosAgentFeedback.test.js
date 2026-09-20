import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';


const mockCosState = vi.hoisted(() => ({
  // Use $TMPDIR (falls back to /tmp) rather than a hardcoded /private/tmp — the
  // latter exists on macOS (where /tmp symlinks to it) but not on Linux CI.
  agentsDir: `${process.env.TMPDIR || process.env.TEMP || process.env.TMP || '/tmp'}/portos-cos-feedback-test-${process.pid}`,
  state: null
}));

const mockAgentIndex = vi.hoisted(() => ({ entries: new Map() }));

vi.mock('./cosState.js', () => ({
  AGENTS_DIR: mockCosState.agentsDir,
  loadState: vi.fn(async () => mockCosState.state),
  saveState: vi.fn(),
  withStateLock: async (fn) => fn()
}));

vi.mock('./cosAgentIndex.js', () => ({
  loadAgentIndex: vi.fn(async () => mockAgentIndex.entries),
  getAgentDir: (agentId, dateBucket) => join(mockCosState.agentsDir, dateBucket || '', agentId)
}));

// The operator-action ledger's file backend writes under PATHS.data — re-root it
// at a temp dir so this suite never touches the developer's live `data/` tree
// (#3683/#3687). Everything else in fileUtils stays real (agent metadata I/O).
const ledgerRoot = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  return mkdtempSync(joinPath(tmpdir(), 'portos-agent-feedback-ledger-'));
});
vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  const { makePathsProxy } = await import('../lib/mockPathsDataRoot.js');
  return makePathsProxy(actual, { dataRoot: ledgerRoot });
});

import {
  getFeedbackStats,
  getPendingAgentFeedback,
  getPendingAgentFeedbackCount,
  initializeAgentFeedback,
  submitAgentFeedback,
} from './cosAgentFeedback.js';
import { cosEvents } from './cosEvents.js';
import {
  listPendingAgentFeedbackRefs,
  resetPendingAgentFeedbackStore,
} from './cosAgentFeedbackStore.js';
import { listUserActions } from './userActions.js';

describe('getPendingAgentFeedbackCount', () => {
  beforeEach(async () => {
    mockCosState.state = { agents: {} };
    mockAgentIndex.entries = new Map();
    resetPendingAgentFeedbackStore();
    await rm(join(ledgerRoot, 'cos-pending-agent-feedback.json'), { force: true });
  });

  afterAll(async () => {
    await rm(mockCosState.agentsDir, { recursive: true, force: true });
  });

  it('counts only unrated completed non-system manually-run agents for the feedback insight', async () => {
    mockCosState.state.agents = {
      'agent-unrated': { id: 'agent-unrated', status: 'completed', completedAt: '2026-08-01T10:00:00.000Z', metadata: { taskType: 'user' } },
      'agent-rated': { id: 'agent-rated', status: 'completed', metadata: { taskType: 'user' }, feedback: { rating: 'positive' } },
      'agent-system': { id: 'agent-system', taskId: 'sys-health-check', status: 'completed', metadata: { taskType: 'user' } },
      'agent-running': { id: 'agent-running', status: 'running', metadata: { taskType: 'user' } },
      'agent-scheduled': { id: 'agent-scheduled', status: 'completed', metadata: { taskType: 'internal' } }
    };

    await expect(getPendingAgentFeedbackCount()).resolves.toBe(1);
  });

  it('excludes system agents identified by id as well as taskId', async () => {
    mockCosState.state.agents = {
      'sys-nightly-sweep': { id: 'sys-nightly-sweep', status: 'completed', metadata: { taskType: 'user' } },
      'agent-real': { id: 'agent-real', status: 'completed', metadata: { taskType: 'user' } }
    };

    await expect(getPendingAgentFeedbackCount()).resolves.toBe(1);
  });

  it('excludes scheduled-task and autopilot agents (taskType internal) from the feedback ask', async () => {
    mockCosState.state.agents = {
      'agent-scheduled': { id: 'agent-scheduled', status: 'completed', metadata: { taskType: 'internal' } },
      'agent-manual': { id: 'agent-manual', status: 'completed', metadata: { taskType: 'user' } }
    };

    await expect(getPendingAgentFeedbackCount()).resolves.toBe(1);
  });

  it('excludes a run retired by Relaunch, which has no result to rate', async () => {
    // A permanent banner otherwise: the count included the record Relaunch
    // retires, but AgentCard shows no rating buttons for it, so nothing the user
    // could do would ever clear "1 completed run needs feedback".
    mockCosState.state.agents = {
      'agent-relaunched': {
        id: 'agent-relaunched', status: 'completed', completedAt: '2026-08-01T10:00:00.000Z',
        metadata: { taskType: 'user' },
        result: { success: false, resumed: true, error: 'Relaunched by user on codex' }
      },
      'agent-manual': { id: 'agent-manual', status: 'completed', metadata: { taskType: 'user' }, result: { success: true } }
    };

    await expect(getPendingAgentFeedbackCount()).resolves.toBe(1);
  });

  it('returns 0 when nothing is awaiting a rating', async () => {
    await expect(getPendingAgentFeedbackCount()).resolves.toBe(0);
  });

  it('enrolls a future completion without reading historical archives', async () => {
    initializeAgentFeedback();
    cosEvents.emit('agent:completed', {
      id: 'agent-future',
      status: 'completed',
      completedAt: '2026-08-02T10:00:00.000Z',
      metadata: { taskType: 'user' },
    });

    await expect.poll(() => listPendingAgentFeedbackRefs()).toEqual([
      { agentId: 'agent-future', archiveDate: '2026-08-02' },
    ]);
  });

  it('keeps an eligible run actionable after live state is evicted', async () => {
    const agent = {
      id: 'agent-archived-pending',
      status: 'completed',
      completedAt: '2026-08-03T10:00:00.000Z',
      metadata: { taskType: 'user', taskDescription: 'Review an example change' },
    };
    mockCosState.state.agents = { [agent.id]: agent };
    await expect(getPendingAgentFeedback()).resolves.toMatchObject({ count: 1, agents: [agent] });

    const dir = join(mockCosState.agentsDir, '2026-08-03', agent.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'metadata.json'), JSON.stringify(agent));
    mockCosState.state = { agents: {} };
    mockAgentIndex.entries.set(agent.id, '2026-08-03');

    await expect(getPendingAgentFeedback()).resolves.toMatchObject({ count: 1, agents: [agent] });
  });

  it('retains a deleted reference as unavailable history instead of claiming completion', async () => {
    const agent = {
      id: 'agent-deleted',
      status: 'completed',
      completedAt: '2026-08-04T10:00:00.000Z',
      metadata: { taskType: 'user' },
    };
    mockCosState.state.agents = { [agent.id]: agent };
    await getPendingAgentFeedback();
    mockCosState.state = { agents: {} };

    await expect(getPendingAgentFeedback({ includeUnavailable: true })).resolves.toMatchObject({
      count: 0,
      unavailable: [{ agentId: agent.id, unavailableReason: 'deleted' }],
    });
    await expect(listPendingAgentFeedbackRefs()).resolves.toEqual([
      { agentId: agent.id, archiveDate: '2026-08-04' },
    ]);
  });

  it('retains a reference when the indexed archive cannot be read', async () => {
    const agent = {
      id: 'agent-unreadable',
      status: 'completed',
      completedAt: '2026-08-05T10:00:00.000Z',
      metadata: { taskType: 'user' },
    };
    mockCosState.state.agents = { [agent.id]: agent };
    await getPendingAgentFeedback();
    mockCosState.state = { agents: {} };
    mockAgentIndex.entries.set(agent.id, '2026-08-05');
    await mkdir(join(mockCosState.agentsDir, '2026-08-05', agent.id, 'metadata.json'), { recursive: true });

    await expect(getPendingAgentFeedback({ includeUnavailable: true })).resolves.toMatchObject({
      count: 0,
      unavailable: [{ agentId: agent.id, unavailableReason: 'read-failed' }],
    });
    await expect(listPendingAgentFeedbackRefs()).resolves.toEqual([
      { agentId: agent.id, archiveDate: '2026-08-05' },
    ]);
  });

  it('clears the reference only after rating the source archive', async () => {
    const agent = {
      id: 'agent-source-owned',
      status: 'completed',
      completedAt: '2026-08-06T10:00:00.000Z',
      metadata: { taskType: 'user', taskDescription: 'Fix an example regression' },
    };
    const dir = join(mockCosState.agentsDir, '2026-08-06', agent.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'metadata.json'), JSON.stringify(agent));
    mockCosState.state = { agents: {} };
    mockAgentIndex.entries.set(agent.id, '2026-08-06');
    await getPendingAgentFeedback();

    await submitAgentFeedback(agent.id, { rating: 'positive' });

    await expect(listPendingAgentFeedbackRefs()).resolves.toEqual([]);
    await expect(getPendingAgentFeedbackCount()).resolves.toBe(0);
  });

  it('aggregates archived feedback and de-duplicates a live copy of the same agent', async () => {
    const dateBucket = '2026-08-01';
    const archived = [
      {
        id: 'agent-archived',
        metadata: { taskDescription: 'Fix the example bug' },
        feedback: { rating: 'negative', comment: 'The regression remained.', submittedAt: '2026-08-01T11:00:00.000Z' }
      },
      {
        id: 'agent-duplicate',
        metadata: { taskDescription: 'Write example tests' },
        feedback: { rating: 'positive', submittedAt: '2026-08-01T10:00:00.000Z' }
      }
    ];

    for (const agent of archived) {
      const dir = join(mockCosState.agentsDir, dateBucket, agent.id);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'metadata.json'), JSON.stringify(agent));
      mockAgentIndex.entries.set(agent.id, dateBucket);
    }

    mockCosState.state.agents = {
      'agent-duplicate': {
        ...archived[1],
        feedback: { rating: 'positive', submittedAt: '2026-08-01T12:00:00.000Z' }
      },
      'agent-live': {
        id: 'agent-live',
        metadata: { taskDescription: 'Document the example workflow' },
        feedback: { rating: 'neutral', submittedAt: '2026-08-01T13:00:00.000Z' }
      }
    };

    await expect(getFeedbackStats()).resolves.toEqual({
      total: 3,
      positive: 1,
      negative: 1,
      neutral: 1,
      satisfactionRate: 33,
      byTaskType: {
        'bug-fix': { positive: 0, negative: 1, neutral: 0, total: 1 },
        testing: { positive: 1, negative: 0, neutral: 0, total: 1 },
        documentation: { positive: 0, negative: 0, neutral: 1, total: 1 }
      },
      recentWithComments: [{
        agentId: 'agent-archived',
        taskDescription: 'Fix the example bug',
        rating: 'negative',
        comment: 'The regression remained.',
        submittedAt: '2026-08-01T11:00:00.000Z'
      }]
    });
  });
});

// ── Operator-action ledger (#5594) ──────────────────────────────────────────
//
// The hook lives in `submitAgentFeedback` rather than the HTTP route so every
// caller records the rating, and it runs AFTER the CoS state lock releases so a
// ledger write never holds that lock across I/O.
describe('submitAgentFeedback records the rating (#5594)', () => {
  beforeEach(async () => {
    mockCosState.state = {
      agents: {
        'agent-1': {
          id: 'agent-1',
          taskId: 'task-42',
          status: 'completed',
          completedAt: '2026-08-01T10:00:00.000Z',
          metadata: { taskType: 'user', taskDescription: 'Fix the failing render test' },
        },
      },
    };
    mockAgentIndex.entries = new Map();
    resetPendingAgentFeedbackStore();
    await rm(join(ledgerRoot, 'user-action-events.json'), { force: true });
  });

  afterAll(async () => {
    await rm(ledgerRoot, { recursive: true, force: true });
  });

  it('writes a cos.agent.feedback row with the rating, comment, and derived task type', async () => {
    const result = await submitAgentFeedback('agent-1', { rating: 'negative', comment: 'Missed the root cause' });
    expect(result).toMatchObject({ success: true });
    // The internal feedbackData carrier must not leak into the caller's response.
    expect(result).not.toHaveProperty('feedbackData');

    const [event] = await listUserActions({ type: 'cos.agent.feedback' });
    expect(event).toMatchObject({
      actor: 'user',
      target: 'agent-1',
      targetName: 'Fix the failing render test',
      source: { service: 'cosAgentFeedback', fn: 'submitAgentFeedback' },
    });
    expect(event.payload).toMatchObject({
      agentId: 'agent-1',
      taskId: 'task-42',
      rating: 'negative',
      comment: 'Missed the root cause',
      // extractTaskType maps the description to a bucket the learning view uses.
      taskType: 'bug-fix',
    });
    expect(event.dedupeKey).toBe(`cos.agent.feedback:agent-1:${event.happenedAt}`);
  });

  it('records nothing when the agent is not in a ratable state', async () => {
    mockCosState.state.agents['agent-1'].status = 'running';
    await expect(submitAgentFeedback('agent-1', { rating: 'positive' })).rejects.toThrow(/completed agents/);
    expect(await listUserActions({ type: 'cos.agent.feedback' })).toEqual([]);
  });
});

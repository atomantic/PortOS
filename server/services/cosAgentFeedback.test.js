import { describe, it, expect, beforeEach, vi } from 'vitest';


const mockCosState = vi.hoisted(() => ({
  // Use $TMPDIR (falls back to /tmp) rather than a hardcoded /private/tmp — the
  // latter exists on macOS (where /tmp symlinks to it) but not on Linux CI.
  agentsDir: `${process.env.TMPDIR || process.env.TEMP || process.env.TMP || '/tmp'}/portos-cos-feedback-test-${process.pid}`,
  state: null
}));

vi.mock('./cosState.js', () => ({
  AGENTS_DIR: mockCosState.agentsDir,
  loadState: vi.fn(async () => mockCosState.state),
  saveState: vi.fn(),
  withStateLock: async (fn) => fn()
}));

import { getPendingAgentFeedbackCount } from './cosAgentFeedback.js';

describe('getPendingAgentFeedbackCount', () => {
  beforeEach(() => {
    mockCosState.state = { agents: {} };
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

  it('returns 0 when nothing is awaiting a rating', async () => {
    await expect(getPendingAgentFeedbackCount()).resolves.toBe(0);
  });
});

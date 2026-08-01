import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockCosState = vi.hoisted(() => ({
  // Use $TMPDIR (falls back to /tmp) rather than a hardcoded /private/tmp — the
  // latter exists on macOS (where /tmp symlinks to it) but not on Linux CI.
  agentsDir: `${process.env.TMPDIR || '/tmp'}/portos-cos-feedback-test-${process.pid}`,
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

  it('counts only unrated completed non-system agents for the feedback insight', async () => {
    mockCosState.state.agents = {
      'agent-unrated': { id: 'agent-unrated', status: 'completed', completedAt: '2026-08-01T10:00:00.000Z' },
      'agent-rated': { id: 'agent-rated', status: 'completed', feedback: { rating: 'positive' } },
      'agent-system': { id: 'agent-system', taskId: 'sys-health-check', status: 'completed' },
      'agent-running': { id: 'agent-running', status: 'running' }
    };

    await expect(getPendingAgentFeedbackCount()).resolves.toBe(1);
  });

  it('excludes system agents identified by id as well as taskId', async () => {
    mockCosState.state.agents = {
      'sys-nightly-sweep': { id: 'sys-nightly-sweep', status: 'completed' },
      'agent-real': { id: 'agent-real', status: 'completed' }
    };

    await expect(getPendingAgentFeedbackCount()).resolves.toBe(1);
  });

  it('returns 0 when nothing is awaiting a rating', async () => {
    await expect(getPendingAgentFeedbackCount()).resolves.toBe(0);
  });
});

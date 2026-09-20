import { describe, expect, it, vi } from 'vitest';

const migrationFs = vi.hoisted(() => ({ existsSync: vi.fn() }));
const migrationState = vi.hoisted(() => ({
  STATE_FILE: '/tmp/example-cos-state.json',
  loadState: vi.fn(),
}));

vi.mock('node:fs', async () => ({
  ...(await vi.importActual('node:fs')),
  existsSync: migrationFs.existsSync,
}));

vi.mock('../../services/cosState.js', () => migrationState);

import { derivePendingFeedbackRefs, up } from './008-cos-agent-feedback-refs.js';

const manualAgent = {
  id: 'agent-example',
  status: 'completed',
  completedAt: '2026-08-01T10:00:00.000Z',
  metadata: { taskType: 'user' },
};

describe('db-migration 008 — CoS feedback references', () => {
  it('derives only unrated manual completed runs and no task prose', () => {
    expect(derivePendingFeedbackRefs({
      agents: {
        keep: manualAgent,
        rated: { ...manualAgent, id: 'agent-rated', feedback: { rating: 'positive' } },
        scheduled: { ...manualAgent, id: 'agent-scheduled', metadata: { taskType: 'internal' } },
      },
    })).toEqual([{ agentId: 'agent-example', archiveDate: '2026-08-01' }]);
  });

  it('is input-gated when live state is absent', async () => {
    migrationFs.existsSync.mockReturnValue(false);
    migrationState.loadState.mockClear();
    const query = vi.fn();

    await up({ query });

    expect(migrationState.loadState).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('writes derived references without reading the archive or calling a provider', async () => {
    migrationFs.existsSync.mockReturnValue(true);
    migrationState.loadState.mockResolvedValue({ agents: { [manualAgent.id]: manualAgent } });
    const query = vi.fn(async () => ({ rows: [] }));

    await up({ query });

    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO cos_pending_agent_feedback'), [
      'agent-example',
      '2026-08-01',
    ]);
  });
});

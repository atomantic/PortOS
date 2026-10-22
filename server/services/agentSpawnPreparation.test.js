import { describe, it, expect, vi } from 'vitest';

const loadState = vi.hoisted(() => vi.fn());
const hasActiveTaskOwner = vi.hoisted(() => vi.fn());

vi.mock('./cosEvents.js', () => ({ cosEvents: { emit: vi.fn(), on: vi.fn() }, emitLog: vi.fn() }));
vi.mock('./cosState.js', () => ({ loadState }));
vi.mock('./agentState.js', () => ({ hasActiveTaskOwner }));
vi.mock('./cos.js', () => ({ getTaskById: vi.fn(), updateTask: vi.fn() }));
vi.mock('./toolStateMachine.js', () => ({
  createToolExecution: vi.fn(), startExecution: vi.fn(), completeExecution: vi.fn(), errorExecution: vi.fn(),
}));
vi.mock('./executionLanes.js', () => ({ determineLane: vi.fn(), acquire: vi.fn(), release: vi.fn() }));
vi.mock('./agentPromptBuilder.js', () => ({ getAppWorkspace: vi.fn() }));
vi.mock('./instanceIdentity.js', () => ({ ensureInstanceId: vi.fn() }));
vi.mock('./appActivity.js', () => ({ releaseAppReviewMarker: vi.fn() }));

import { prepareAgentSpawn } from './agentSpawnPreparation.js';

describe('prepareAgentSpawn — duplicate dispatch', () => {
  it('skips a task another run already owns and reports the skip on stdout, not stderr', async () => {
    loadState.mockResolvedValue({ agents: {} });
    hasActiveTaskOwner.mockReturnValue(true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await prepareAgentSpawn({ id: 'task-1', taskType: 'user' })).toBeNull();

    expect(log).toHaveBeenCalledWith(expect.stringContaining('Task task-1 already has an active owner'));
    expect(warn).not.toHaveBeenCalled();
  });
});

import { describe, it, expect } from 'vitest';
import { executionDurationKey as serverExecutionDurationKey } from '../../../server/lib/executionDurationKey.js';
import { executionDurationKey, estimateCosDuration } from './cosDurationEstimate.js';

const taskType = 'self-improve:release-check';
const task = { taskType: 'scheduled', description: '[self-improvement] release-check - verify the release' };

describe('persisted execution-duration key compatibility', () => {
  it.each([
    ['high', 'self-improve:release-check|claude|opus|high'],
    [undefined, 'self-improve:release-check|claude|opus|default']
  ])('reads existing history for effort %s with the unchanged server key', (effort, expectedKey) => {
    const identity = { taskType, providerId: 'claude', model: 'opus', effort };
    expect(serverExecutionDurationKey(identity)).toBe(expectedKey);
    expect(executionDurationKey(identity)).toBe(expectedKey);
    const durations = {
      _byExecution: { [expectedKey]: { avgDurationMs: 60_000, completed: 3 } },
      [taskType]: { avgDurationMs: 300_000, completed: 20 }
    };
    expect(estimateCosDuration({ durations, task, agentMetadata: identity }))
      .toMatchObject({ basis: 'execution', estimatedMs: 60_000, basedOn: 3 });
  });

  it('preserves the published task-type and overall fallback without an execution threshold', () => {
    const durations = {
      _byExecution: { 'self-improve:release-check|claude|opus|high': { avgDurationMs: 60_000, completed: 2 } },
      _byExecutionProviderModel: { 'self-improve:release-check|claude|opus': { avgDurationMs: 90_000, completed: 2 } },
      [taskType]: { avgDurationMs: 300_000, completed: 1 },
      _overall: { avgDurationMs: 400_000, completed: 1 }
    };
    const agentMetadata = { providerId: 'claude', model: 'opus', effort: 'high' };
    expect(estimateCosDuration({ durations, task, agentMetadata }))
      .toMatchObject({ basis: 'task-type', estimatedMs: 300_000, basedOn: 1 });
    delete durations[taskType];
    expect(estimateCosDuration({ durations, task, agentMetadata }))
      .toMatchObject({ basis: 'overall', estimatedMs: 400_000, basedOn: 1 });
  });
});

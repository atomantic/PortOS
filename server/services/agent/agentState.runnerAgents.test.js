/**
 * `runnerAgents` entries may carry the in-flight Ollama hold of a runner-hosted
 * harness (#17342). These pin the two helpers that own the map's mutations; the
 * tree guard that keeps every other module going through them lives in
 * `server/test/guards/modules/runnerAgentsMutationOwner.test.js`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dropRunnerAgent, runnerAgents, trackRunnerAgent } from './agentState.js';

afterEach(() => runnerAgents.clear());

describe('runner-agent tracking helpers', () => {
  it('dropRunnerAgent removes the entry and releases its hold exactly once', () => {
    const releaseOllamaWork = vi.fn();
    trackRunnerAgent('agent-1', { taskId: 'task-1', releaseOllamaWork });
    expect(dropRunnerAgent('agent-1')).toBe(true);
    expect(dropRunnerAgent('agent-1')).toBe(false);
    expect(runnerAgents.has('agent-1')).toBe(false);
    expect(releaseOllamaWork).toHaveBeenCalledTimes(1);
  });

  it('trackRunnerAgent releases the hold of an entry it replaces', () => {
    const first = vi.fn();
    const second = vi.fn();
    trackRunnerAgent('agent-1', { releaseOllamaWork: first });
    trackRunnerAgent('agent-1', { releaseOllamaWork: second });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('a throwing release still drops the entry', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    trackRunnerAgent('agent-1', { releaseOllamaWork: () => { throw new Error('boom'); } });
    expect(() => dropRunnerAgent('agent-1')).not.toThrow();
    expect(runnerAgents.has('agent-1')).toBe(false);
  });
});

import { afterEach, expect, it } from 'vitest';
import { markHostShuttingDown, resetHostShutdownFlagForTests } from '../../lib/hostShutdown.js';
import { finalizeAgentRunCommon } from './agentRunFinalize.js';
import { activeAgents, pausedAgents } from './agentState.js';

const agentId = 'agent-paused';

afterEach(() => {
  activeAgents.delete(agentId);
  pausedAgents.delete(agentId);
  resetHostShutdownFlagForTests();
});

it('settles a paused agent before applying the host-shutdown abandonment rule', () => {
  const active = { startedAt: Date.now() };
  activeAgents.set(agentId, active);
  markHostShuttingDown();

  expect(finalizeAgentRunCommon({ agentId })).toEqual({ outcome: 'abandoned' });
  expect(activeAgents.get(agentId)).toBe(active);

  pausedAgents.set(agentId, true);
  expect(finalizeAgentRunCommon({ agentId, success: true })).toEqual({ outcome: 'paused' });
  expect(pausedAgents.has(agentId)).toBe(false);
  expect(activeAgents.has(agentId)).toBe(false);
});

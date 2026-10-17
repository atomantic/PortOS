import { afterEach, describe, expect, it } from 'vitest';
import { clearAgentDispatching, getActiveAgentIds, markAgentDispatching, protectedAgentIds } from './agentState.js';

describe('agent dispatching ownership', () => {
  afterEach(() => clearAgentDispatching('agent-x'));

  it('reports a mid-dispatch agent as active and protected until it is cleared', () => {
    markAgentDispatching('agent-x');
    expect(getActiveAgentIds()).toContain('agent-x');
    expect(protectedAgentIds([]).has('agent-x')).toBe(true);

    clearAgentDispatching('agent-x');
    expect(getActiveAgentIds()).not.toContain('agent-x');
    expect(protectedAgentIds([]).has('agent-x')).toBe(false);
  });
});

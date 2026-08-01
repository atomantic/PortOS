import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';

const getFeatureAgentOutput = vi.fn();

vi.mock('../../services/api', () => ({
  getFeatureAgentOutput: (...args) => getFeatureAgentOutput(...args),
}));

vi.mock('../../services/socket', () => ({
  default: {
    on: vi.fn(),
    off: vi.fn(),
  },
}));

import OutputTab from './OutputTab.jsx';

beforeEach(() => {
  getFeatureAgentOutput.mockReset();
});

describe('OutputTab staleness', () => {
  it('does not let a slow prior agent response overwrite the newer agent selection', async () => {
    // Agent A's fetch resolves late; agent B's fetch resolves fast.
    let resolveA;
    const aPromise = new Promise((res) => { resolveA = res; });
    getFeatureAgentOutput.mockImplementation((agentId) => {
      if (agentId === 'agent-a') return aPromise;
      if (agentId === 'agent-b') return Promise.resolve({ output: 'B output', agentId: 'run-b' });
      return Promise.resolve(null);
    });

    const { rerender } = render(<OutputTab agent={{ id: 'agent-a', currentAgentId: null }} />);

    // Switch to agent B before A's fetch resolves — B's effect cleanup marks
    // A's in-flight fetch cancelled.
    rerender(<OutputTab agent={{ id: 'agent-b', currentAgentId: null }} />);
    await act(async () => {});

    expect(screen.getByText(/B output/)).toBeInTheDocument();
    expect(screen.getByText(/run-b/)).toBeInTheDocument();

    // Now the stale agent-A response finally arrives — it must be ignored.
    await act(async () => {
      resolveA({ output: 'A output', agentId: 'run-a' });
      await Promise.resolve();
    });

    expect(screen.getByText(/B output/)).toBeInTheDocument();
    expect(screen.getByText(/run-b/)).toBeInTheDocument();
    expect(screen.queryByText(/A output/)).not.toBeInTheDocument();
  });
});

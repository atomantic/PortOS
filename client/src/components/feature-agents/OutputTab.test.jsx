import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

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

  it('drops a refresh-button response that lands after the user switched agents', async () => {
    const aResolvers = [];
    getFeatureAgentOutput.mockImplementation((agentId) => {
      if (agentId === 'agent-a') return new Promise((res) => { aResolvers.push(res); });
      return Promise.resolve({ output: 'B output', agentId: 'run-b' });
    });

    const { rerender } = render(<OutputTab agent={{ id: 'agent-a', currentAgentId: 'run-a' }} />);
    // Refresh fires outside the fetch effect, so it is not covered by the
    // effect cleanup — the guard has to key on the current selection.
    await act(async () => { fireEvent.click(screen.getByLabelText('Refresh output')); });

    rerender(<OutputTab agent={{ id: 'agent-b', currentAgentId: null }} />);
    await act(async () => {});
    expect(screen.getByText(/B output/)).toBeInTheDocument();

    await act(async () => {
      aResolvers.forEach((res) => res({ output: 'A output', agentId: 'run-a' }));
      await Promise.resolve();
    });

    expect(screen.queryByText(/A output/)).not.toBeInTheDocument();
    expect(screen.getByText(/B output/)).toBeInTheDocument();
  });

  it('clears the prior agent output while the new agent fetch is still in flight', async () => {
    let resolveB;
    getFeatureAgentOutput.mockImplementation((agentId) => {
      if (agentId === 'agent-a') return Promise.resolve({ output: 'A output', agentId: 'run-a' });
      return new Promise((res) => { resolveB = res; });
    });

    const { rerender } = render(<OutputTab agent={{ id: 'agent-a', currentAgentId: 'run-a' }} />);
    await act(async () => {});
    expect(screen.getByText(/A output/)).toBeInTheDocument();

    rerender(<OutputTab agent={{ id: 'agent-b', currentAgentId: 'run-b' }} />);
    await act(async () => {});
    expect(screen.queryByText(/A output/)).not.toBeInTheDocument();

    await act(async () => { resolveB({ output: 'B output', agentId: 'run-b' }); });
    expect(screen.getByText(/B output/)).toBeInTheDocument();
  });
});

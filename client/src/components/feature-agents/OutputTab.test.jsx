import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const { getFeatureAgentOutput, mockSocketOn, mockSocketOff } = vi.hoisted(() => {
  return {
    getFeatureAgentOutput: vi.fn(),
    mockSocketOn: vi.fn(),
    mockSocketOff: vi.fn(),
  };
});

vi.mock('../../services/api', () => ({
  getFeatureAgentOutput: (...args) => getFeatureAgentOutput(...args),
}));

vi.mock('../../services/socket', () => ({
  default: {
    on: mockSocketOn,
    off: mockSocketOff,
  },
}));

import OutputTab from './OutputTab.jsx';

beforeEach(() => {
  getFeatureAgentOutput.mockReset();
  mockSocketOn.mockReset();
  mockSocketOff.mockReset();
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

    // Switch to agent B before A's fetch resolves — B's fetch supersedes A's
    // in the request sequence, so A's response is no longer allowed to write.
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

  it('drops an out-of-order response for the same agent when a new run starts', async () => {
    // Same feature agent, two runs — so an agent-id comparison alone would let
    // the slow first response repaint over the newer run's output.
    let resolveFirst;
    const responses = [
      new Promise((res) => { resolveFirst = res; }),
      Promise.resolve({ output: 'run-2 output', agentId: 'run-2' }),
    ];
    getFeatureAgentOutput.mockImplementation(() => responses.shift());

    const { rerender } = render(<OutputTab agent={{ id: 'agent-a', currentAgentId: 'run-1' }} />);
    rerender(<OutputTab agent={{ id: 'agent-a', currentAgentId: 'run-2' }} />);
    await act(async () => {});
    expect(screen.getByText(/run-2 output/)).toBeInTheDocument();

    await act(async () => {
      resolveFirst({ output: 'run-1 output', agentId: 'run-1' });
      await Promise.resolve();
    });

    expect(screen.queryByText(/run-1 output/)).not.toBeInTheDocument();
    expect(screen.getByText(/run-2 output/)).toBeInTheDocument();
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

describe('OutputTab live socket output', () => {
  it('appends cos:agent:output frames with matching agentId', async () => {
    getFeatureAgentOutput.mockResolvedValue({ output: 'initial', agentId: 'run-1' });

    render(<OutputTab agent={{ id: 'agent-a', currentAgentId: 'run-1' }} />);
    await act(async () => {});

    expect(screen.getByText(/initial/)).toBeInTheDocument();

    // Get the socket handler that was registered
    const handler = mockSocketOn.mock.calls.find(call => call[0] === 'cos:agent:output')?.[1];
    expect(handler).toBeDefined();

    // Emit a line from the agent
    await act(async () => {
      handler({ agentId: 'run-1', line: 'line 1' });
    });

    expect(screen.getByText(/line 1/).textContent).toBe('initial\nline 1\n');

    // Emit another line
    await act(async () => {
      handler({ agentId: 'run-1', line: 'line 2' });
    });

    expect(screen.getByText(/line 1/)).toBeInTheDocument();
    expect(screen.getByText(/line 2/)).toBeInTheDocument();
  });

  it('ignores cos:agent:output frames for other agent ids', async () => {
    getFeatureAgentOutput.mockResolvedValue({ output: 'initial', agentId: 'run-1' });

    render(<OutputTab agent={{ id: 'agent-a', currentAgentId: 'run-1' }} />);
    await act(async () => {});

    const handler = mockSocketOn.mock.calls.find(call => call[0] === 'cos:agent:output')?.[1];

    // Emit a line from a different agent
    await act(async () => {
      handler({ agentId: 'run-2', line: 'other agent output' });
    });

    // Should still only show initial output
    expect(screen.getByText(/initial/)).toBeInTheDocument();
    expect(screen.queryByText(/other agent output/)).not.toBeInTheDocument();
  });

  it('caps output to 500 lines to prevent unbounded growth', async () => {
    getFeatureAgentOutput.mockResolvedValue({ output: '', agentId: 'run-1' });

    render(<OutputTab agent={{ id: 'agent-a', currentAgentId: 'run-1' }} />);
    await act(async () => {});

    const handler = mockSocketOn.mock.calls.find(call => call[0] === 'cos:agent:output')?.[1];

    // Emit 510 lines
    await act(async () => {
      for (let i = 0; i < 510; i++) {
        handler({ agentId: 'run-1', line: `line ${i}` });
      }
    });

    const text = screen.getByText(/line 509/).textContent;
    expect(text.split('\n').filter(Boolean)).toHaveLength(500);
    expect(text).not.toMatch(/line 9\n/);
  });

  it('unsubscribes from socket when component unmounts', async () => {
    getFeatureAgentOutput.mockResolvedValue({ output: 'test', agentId: 'run-1' });

    const { unmount } = render(<OutputTab agent={{ id: 'agent-a', currentAgentId: 'run-1' }} />);
    await act(async () => {});

    const registerCall = mockSocketOn.mock.calls.find(call => call[0] === 'cos:agent:output');
    expect(registerCall).toBeDefined();

    unmount();
    await act(async () => {});

    const unregisterCall = mockSocketOff.mock.calls.find(call => call[0] === 'cos:agent:output');
    expect(unregisterCall).toBeDefined();
  });
});

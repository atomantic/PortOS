import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';

// Deferred-promise registry so a test can resolve A's load *after* navigating
// to B, reproducing the stale-result race the guard is meant to defeat.
const deferreds = {};
function makeDeferred(id) {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  deferreds[id] = { promise, resolve };
  return promise;
}

vi.mock('../services/api', () => ({
  getApps: vi.fn().mockResolvedValue([]),
  getFeatureAgent: vi.fn((id) => makeDeferred(id)),
  startFeatureAgent: vi.fn(),
  pauseFeatureAgent: vi.fn(),
  resumeFeatureAgent: vi.fn(),
  stopFeatureAgent: vi.fn(),
  triggerFeatureAgent: vi.fn(),
}));

vi.mock('../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn() },
}));

// Keep the tab children inert — the header (which shows agent.name) is what we
// assert on for "which agent is displayed."
vi.mock('../components/feature-agents/OverviewTab', () => ({ default: () => null }));
vi.mock('../components/feature-agents/ConfigTab', () => ({ default: () => null }));
vi.mock('../components/feature-agents/RunsTab', () => ({ default: () => null }));
vi.mock('../components/feature-agents/OutputTab', () => ({ default: () => null }));
vi.mock('../components/feature-agents/GitTab', () => ({ default: () => null }));

import * as api from '../services/api';
import FeatureAgentDetail from './FeatureAgentDetail';

function Harness() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate('/feature-agents/agent-b/overview')}>go-b</button>
      <Routes>
        <Route path="/feature-agents/:id/:tab" element={<FeatureAgentDetail />} />
      </Routes>
    </>
  );
}

describe('FeatureAgentDetail load race', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of Object.keys(deferreds)) delete deferreds[k];
  });

  it('ignores a stale A response that resolves after navigating A→B', async () => {
    render(
      <MemoryRouter initialEntries={['/feature-agents/agent-a/overview']}>
        <Harness />
      </MemoryRouter>,
    );

    // A's fetch is in flight; spinner shown.
    expect(api.getFeatureAgent).toHaveBeenCalledWith('agent-a');
    expect(screen.getByText(/Loading agent/)).toBeInTheDocument();

    // Navigate A→B before A resolves.
    await act(async () => {
      screen.getByText('go-b').click();
    });
    await waitFor(() => expect(api.getFeatureAgent).toHaveBeenCalledWith('agent-b'));

    // Resolve A LATE — must be ignored (wrong agent must never show).
    await act(async () => {
      deferreds['agent-a'].resolve({ id: 'agent-a', name: 'Agent Alpha', appId: 'app1' });
    });
    expect(screen.queryByText('Agent Alpha')).not.toBeInTheDocument();

    // Resolve B — the current record is what renders.
    await act(async () => {
      deferreds['agent-b'].resolve({ id: 'agent-b', name: 'Agent Beta', appId: 'app2' });
    });
    await waitFor(() => expect(screen.getByText('Agent Beta')).toBeInTheDocument());
    expect(screen.queryByText('Agent Alpha')).not.toBeInTheDocument();
  });

  it('shows the spinner (not the stale agent) immediately on A→B switch', async () => {
    render(
      <MemoryRouter initialEntries={['/feature-agents/agent-a/overview']}>
        <Harness />
      </MemoryRouter>,
    );
    await act(async () => {
      deferreds['agent-a'].resolve({ id: 'agent-a', name: 'Agent Alpha', appId: 'app1' });
    });
    await waitFor(() => expect(screen.getByText('Agent Alpha')).toBeInTheDocument());

    await act(async () => {
      screen.getByText('go-b').click();
    });
    // B is still loading — the old agent name must be gone, spinner up.
    expect(screen.queryByText('Agent Alpha')).not.toBeInTheDocument();
    expect(screen.getByText(/Loading agent/)).toBeInTheDocument();
  });
});

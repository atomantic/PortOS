import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router';

const mockAgentDeferreds = {};
const mockPlatformDeferreds = {};

function makeDeferred(registry, id) {
  let resolve;
  const promise = new Promise(resolution => {
    resolve = resolution;
  });
  registry[id] = { promise, resolve };
  return promise;
}

vi.mock('../../services/api', () => ({
  getAgentPersonality: vi.fn(id => makeDeferred(mockAgentDeferreds, id)),
  getPlatformAccounts: vi.fn(id => makeDeferred(mockPlatformDeferreds, id)),
  toggleAgentPersonality: vi.fn(),
}));

vi.mock('../BrailleSpinner', () => ({
  default: ({ text }) => <div role="status" aria-label={text}>{text}</div>,
}));

vi.mock('./tabs/OverviewTab', () => ({ default: () => null }));
vi.mock('./tabs/ToolsTab', () => ({ default: () => null }));
vi.mock('./tabs/WorldTab', () => ({ default: () => null }));
vi.mock('./tabs/PublishedTab', () => ({ default: () => null }));
vi.mock('./tabs/SchedulesTab', () => ({ default: () => null }));
vi.mock('./tabs/ActivityTab', () => ({ default: () => null }));

import * as api from '../../services/api';
import AgentDetail from './AgentDetail';

function Harness() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate('/agents/agent-b/overview')}>go-b</button>
      <Routes>
        <Route path="/agents/:agentId/:tab" element={<AgentDetail />} />
      </Routes>
    </>
  );
}

function renderAgentDetail() {
  return render(
    <MemoryRouter initialEntries={['/agents/agent-a/overview']}>
      <Harness />
    </MemoryRouter>,
  );
}

describe('AgentDetail route lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockAgentDeferreds).forEach(id => delete mockAgentDeferreds[id]);
    Object.keys(mockPlatformDeferreds).forEach(id => delete mockPlatformDeferreds[id]);
  });

  it('ignores personality and platform responses from a previous agent', async () => {
    renderAgentDetail();

    await act(async () => {
      screen.getByText('go-b').click();
    });
    await waitFor(() => {
      expect(api.getAgentPersonality).toHaveBeenLastCalledWith('agent-b');
      expect(api.getPlatformAccounts).toHaveBeenLastCalledWith('agent-b');
    });

    await act(async () => {
      mockAgentDeferreds['agent-b'].resolve({ id: 'agent-b', name: 'Agent Beta', enabled: true });
      mockPlatformDeferreds['agent-b'].resolve([{ platform: 'moltworld' }]);
    });
    await waitFor(() => expect(screen.getByText('Agent Beta')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /World/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Moltbook/ })).not.toBeInTheDocument();

    await act(async () => {
      mockAgentDeferreds['agent-a'].resolve({ id: 'agent-a', name: 'Agent Alpha', enabled: true });
      mockPlatformDeferreds['agent-a'].resolve([{ platform: 'moltbook' }]);
    });

    expect(screen.getByText('Agent Beta')).toBeInTheDocument();
    expect(screen.queryByText('Agent Alpha')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /World/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Moltbook/ })).not.toBeInTheDocument();
  });

  it('clears the old agent before loading the next route and toggles the active agent', async () => {
    renderAgentDetail();

    await act(async () => {
      mockAgentDeferreds['agent-a'].resolve({ id: 'agent-a', name: 'Agent Alpha', enabled: true });
      mockPlatformDeferreds['agent-a'].resolve([]);
    });
    await waitFor(() => expect(screen.getByText('Agent Alpha')).toBeInTheDocument());

    await act(async () => {
      screen.getByText('go-b').click();
    });
    expect(screen.queryByText('Agent Alpha')).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Loading agent' })).toBeInTheDocument();

    await act(async () => {
      mockAgentDeferreds['agent-b'].resolve({ id: 'agent-b', name: 'Agent Beta', enabled: true });
      mockPlatformDeferreds['agent-b'].resolve([]);
    });
    await waitFor(() => expect(screen.getByText('Agent Beta')).toBeInTheDocument());

    await act(async () => {
      screen.getByRole('button', { name: 'Enabled' }).click();
    });
    expect(api.toggleAgentPersonality).toHaveBeenCalledWith('agent-b', false);
  });
});

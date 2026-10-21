import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({ getMemoryRuns: vi.fn() }));
vi.mock('../../../services/api', () => api);

import MemoryRunsUsedBy from './MemoryRunsUsedBy';

const renderPanel = () => render(<MemoryRouter><MemoryRunsUsedBy memoryId="mem-1" /></MemoryRouter>);

describe('MemoryRunsUsedBy', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders nothing for a memory no run has used', async () => {
    api.getMemoryRuns.mockResolvedValue({ runs: [] });
    const { container } = renderPanel();
    await act(async () => {});
    expect(api.getMemoryRuns).toHaveBeenCalledTimes(1);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a load error with Retry instead of hiding the section, and recovers on retry', async () => {
    api.getMemoryRuns.mockRejectedValueOnce(new Error('runs unavailable'));
    api.getMemoryRuns.mockResolvedValueOnce({ runs: [{ runId: 'run-12345678', agentId: 'agent-abcdef12' }] });
    renderPanel();

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load recent runs.*runs unavailable/i);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Used by recent runs')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'agent-ab' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(api.getMemoryRuns).toHaveBeenCalledTimes(2);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  getRuns: vi.fn(),
  getRunPrompt: vi.fn(),
  getRunOutput: vi.fn(),
  deleteRun: vi.fn(),
  deleteFailedRuns: vi.fn(),
  stopRun: vi.fn(),
  getProcessLogs: vi.fn(),
}));

vi.mock('../../../services/api', () => api);
vi.mock('../../ui/ProcessLogModal', () => ({
  default: () => null,
}));

import RunsTab from './RunsTab';

const RUNS = [
  { id: 'run-a', prompt: 'first prompt', providerName: 'demo', success: true, startTime: '2026-01-01T00:00:00Z' },
  { id: 'run-b', prompt: 'second prompt', providerName: 'demo', success: true, startTime: '2026-01-01T00:01:00Z' },
];

const renderTab = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <RunsTab />
  </MemoryRouter>
);

describe('RunsTab ?run= deep link', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getRuns.mockResolvedValue({ runs: RUNS });
    api.getRunPrompt.mockResolvedValue('full prompt for run-b');
    api.getRunOutput.mockResolvedValue('full output for run-b');
  });

  it('expands the run named by ?run= once the list has loaded', async () => {
    renderTab('/cos/runs?run=run-b');

    expect(await screen.findByText('full output for run-b')).toBeInTheDocument();
    expect(api.getRunPrompt).toHaveBeenCalledWith('run-b');
    expect(api.getRunOutput).toHaveBeenCalledWith('run-b');
  });

  it('expands nothing when no ?run= param is present', async () => {
    renderTab('/cos/runs');

    expect(await screen.findByText('first prompt')).toBeInTheDocument();
    expect(api.getRunPrompt).not.toHaveBeenCalled();
  });

  it('ignores a ?run= id that is not in the loaded list', async () => {
    renderTab('/cos/runs?run=run-missing');

    expect(await screen.findByText('first prompt')).toBeInTheDocument();
    expect(api.getRunPrompt).not.toHaveBeenCalled();
  });

  it('renders a failed runs read as an error row with Retry, not "No AI runs yet"', async () => {
    api.getRuns.mockRejectedValueOnce(new Error('runs 500'));
    renderTab('/cos/runs');

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load runs — runs 500');
    expect(screen.queryByText('No AI runs yet')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('first prompt')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the empty copy for a genuinely empty run history', async () => {
    api.getRuns.mockResolvedValue({ runs: [] });
    renderTab('/cos/runs');

    expect(await screen.findByText('No AI runs yet')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

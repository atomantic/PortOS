import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, NavLink } from 'react-router';

const api = vi.hoisted(() => ({
  getRuns: vi.fn(),
  getRun: vi.fn(),
  getRunPrompt: vi.fn(),
  getRunOutput: vi.fn(),
  deleteRun: vi.fn(),
  deleteFailedRuns: vi.fn(),
  stopRun: vi.fn(),
  getProcessLogs: vi.fn(),
}));

const socket = vi.hoisted(() => {
  const handlers = new Map();
  return {
    on: vi.fn((event, handler) => handlers.set(event, handler)),
    off: vi.fn((event) => handlers.delete(event)),
    fire: (event, payload) => handlers.get(event)?.(payload),
  };
});

vi.mock('../../../services/apiRuns.js', () => ({
  getRuns: api.getRuns,
  getRun: api.getRun,
  getRunPrompt: api.getRunPrompt,
  getRunOutput: api.getRunOutput,
  deleteRun: api.deleteRun,
  deleteFailedRuns: api.deleteFailedRuns,
  stopRun: api.stopRun,
}));
vi.mock('../../../services/apiLogs.js', () => ({ getProcessLogs: api.getProcessLogs }));
vi.mock('../../../services/socket', () => ({ default: socket }));
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

  it('shows Claude sign-in renewal guidance on a successful run without opening its logs', async () => {
    api.getRuns.mockResolvedValue({ runs: [{ ...RUNS[0], providerName: 'Claude Code', claudeSignInExpiring: true }, RUNS[1]] });
    renderTab('/cos/runs');

    expect(await screen.findByText('Claude Code sign-in expires soon')).toBeVisible();
    expect(screen.getByText('claude auth login')).toBeVisible();
    expect(screen.getAllByText('Succeeded')).toHaveLength(2);
    expect(api.getRunOutput).not.toHaveBeenCalled();
  });

  it('moves a Running row to its end state on any activity invalidation (#16557)', async () => {
    api.getRuns.mockResolvedValue({ runs: [{ ...RUNS[0], id: 'recovering', success: null }] });
    renderTab('/cos/runs');
    expect(await within(await screen.findByTestId('run-row-recovering')).findByText('Running')).toBeVisible();

    // A coalesced frame names only the burst's last source, so even a media
    // frame may carry a run transition.
    api.getRuns.mockResolvedValue({ runs: [{ ...RUNS[0], id: 'recovering', success: false, canceled: true }] });
    await act(async () => { socket.fire('system:activity', { seq: 1, source: 'media', phase: 'completion' }); });
    expect(api.getRuns).toHaveBeenCalledTimes(2);
    expect(within(screen.getByTestId('run-row-recovering')).queryByText('Running')).not.toBeInTheDocument();
  });

  it('re-reads once the first load lands when an invalidation arrived during it', async () => {
    let finishLoad;
    api.getRuns.mockReturnValueOnce(new Promise((resolve) => { finishLoad = resolve; }));
    renderTab('/cos/runs');
    await act(async () => { socket.fire('system:activity', { seq: 1, source: 'llm', phase: 'cancellation' }); });
    expect(api.getRuns).toHaveBeenCalledTimes(1);

    api.getRuns.mockResolvedValue({ runs: [{ ...RUNS[0], id: 'recovering', success: false }] });
    await act(async () => { finishLoad({ runs: [{ ...RUNS[0], id: 'recovering', success: null }] }); });
    expect(api.getRuns).toHaveBeenCalledTimes(2);
    expect(within(screen.getByTestId('run-row-recovering')).queryByText('Running')).not.toBeInTheDocument();
  });

  it('does not restore a deleted run from a re-read that started before the delete', async () => {
    renderTab('/cos/runs');
    expect(await screen.findByText('first prompt')).toBeInTheDocument();
    let finishStale;
    api.getRuns.mockReturnValueOnce(new Promise((resolve) => { finishStale = resolve; }));
    await act(async () => { socket.fire('system:activity', { seq: 1, source: 'llm', phase: 'start' }); });
    api.deleteRun.mockResolvedValue({ ok: true });
    api.getRuns.mockResolvedValue({ runs: [RUNS[1]] });
    await act(async () => { fireEvent.click(within(screen.getByTestId('run-row-run-a')).getByRole('button', { name: 'Delete run' })); });
    await act(async () => { finishStale({ runs: RUNS }); });
    expect(screen.queryByText('first prompt')).not.toBeInTheDocument();
    expect(screen.getByText('second prompt')).toBeInTheDocument();
  });

  it('folds a burst of invalidations during a re-read into one follow-up read', async () => {
    renderTab('/cos/runs');
    expect(await screen.findByText('first prompt')).toBeInTheDocument();
    let finishFirst;
    api.getRuns.mockReturnValueOnce(new Promise((resolve) => { finishFirst = resolve; }));
    await act(async () => {
      for (let seq = 1; seq <= 4; seq++) socket.fire('system:activity', { seq, source: 'llm', phase: 'start' });
    });
    expect(api.getRuns).toHaveBeenCalledTimes(2);
    api.getRuns.mockResolvedValue({ runs: [RUNS[1]] });
    await act(async () => { finishFirst({ runs: RUNS }); });
    expect(api.getRuns).toHaveBeenCalledTimes(3);
    expect(screen.queryByText('first prompt')).not.toBeInTheDocument();
  });

  it('keeps the loaded rows when an invalidation re-read fails', async () => {
    renderTab('/cos/runs');
    expect(await screen.findByText('first prompt')).toBeInTheDocument();
    api.getRuns.mockRejectedValue(new Error('offline'));
    await act(async () => { socket.fire('connect'); });
    expect(api.getRuns).toHaveBeenCalledTimes(2);
    expect(screen.getByText('first prompt')).toBeInTheDocument();
  });

  it('expands nothing when no ?run= param is present', async () => {
    renderTab('/cos/runs');

    expect(await screen.findByText('first prompt')).toBeInTheDocument();
    expect(api.getRunPrompt).not.toHaveBeenCalled();
  });

  it('resolves a ?run= id outside the loaded list with one by-id read and pins it expanded', async () => {
    api.getRun.mockResolvedValue({ id: 'run-old', prompt: 'old prompt', providerName: 'demo', success: true, startTime: '2025-01-01T00:00:00Z' });
    renderTab('/cos/runs?run=run-old');

    const pinned = await screen.findByTestId('pinned-run');
    expect(within(pinned).getByText('old prompt')).toBeInTheDocument();
    expect(api.getRun).toHaveBeenCalledTimes(1);
    expect(api.getRun.mock.calls[0][0]).toBe('run-old');
    expect(api.getRunPrompt).toHaveBeenCalledWith('run-old');
  });

  it('keeps a failed by-id read distinct from a missing run and retries it', async () => {
    api.getRun.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }));
    api.getRun.mockResolvedValue({ id: 'run-old', prompt: 'old prompt', providerName: 'demo', success: true, startTime: '2025-01-01T00:00:00Z' });
    renderTab('/cos/runs?run=run-old');

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load run run-old — boom');
    expect(screen.queryByText('Run not found or deleted.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('pinned-run')).toBeInTheDocument();
  });

  it('re-reads the pinned run on a lifecycle invalidation so it does not stay Running', async () => {
    api.getRun.mockResolvedValueOnce({ id: 'run-old', prompt: 'old prompt', providerName: 'demo', success: null, startTime: '2025-01-01T00:00:00Z' });
    api.getRun.mockResolvedValue({ id: 'run-old', prompt: 'old prompt', providerName: 'demo', success: true, startTime: '2025-01-01T00:00:00Z' });
    renderTab('/cos/runs?run=run-old');

    const pinned = await screen.findByTestId('pinned-run');
    expect(within(pinned).getAllByText('Running').length).toBeGreaterThan(0);
    await act(async () => { socket.fire('connect'); });
    expect(within(screen.getByTestId('pinned-run')).getAllByText('Succeeded').length).toBeGreaterThan(0);
  });

  it('coalesces a burst of invalidations into at most two pinned reads and still renders the run', async () => {
    let resolveFirst;
    api.getRun.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));
    api.getRun.mockResolvedValue({ id: 'run-old', prompt: 'old prompt', providerName: 'demo', success: true, startTime: '2025-01-01T00:00:00Z' });
    renderTab('/cos/runs?run=run-old');
    await act(async () => {});
    expect(api.getRun).toHaveBeenCalledTimes(1);

    await act(async () => { for (let i = 0; i < 10; i++) socket.fire('connect'); });
    await act(async () => { resolveFirst({ id: 'run-old', prompt: 'old prompt', providerName: 'demo', success: null, startTime: '2025-01-01T00:00:00Z' }); });

    expect(await screen.findByTestId('pinned-run')).toBeInTheDocument();
    expect(api.getRun.mock.calls.length).toBeLessThanOrEqual(2);
    await act(async () => {});
    expect(within(screen.getByTestId('pinned-run')).getAllByText('Succeeded').length).toBeGreaterThan(0);
  });

  it('ignores totals from a response for a previous source filter', async () => {
    let resolveAll;
    api.getRuns.mockImplementation((_limit, _offset, source) => {
      if (source === 'cos-agent') return Promise.resolve({ runs: [RUNS[0]], total: 5 });
      return Promise.resolve({ runs: RUNS, total: 250 });
    });
    renderTab('/cos/runs');
    expect(await screen.findByText('Showing the newest 2 of 250 runs')).toBeInTheDocument();

    api.getRuns.mockImplementationOnce(() => new Promise((resolve) => { resolveAll = resolve; }));
    await act(async () => { socket.fire('connect'); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'CoS' })); });
    expect(await screen.findByText('Showing the newest 1 of 5 runs')).toBeInTheDocument();

    await act(async () => { resolveAll({ runs: RUNS, total: 999 }); });
    expect(screen.getByText('Showing the newest 1 of 5 runs')).toBeInTheDocument();
  });

  it('does not let a stale All response overwrite the total after All, CoS, All', async () => {
    let resolveStale;
    api.getRuns.mockResolvedValue({ runs: RUNS, total: 251 });
    renderTab('/cos/runs');
    expect(await screen.findByText('Showing the newest 2 of 251 runs')).toBeInTheDocument();

    api.getRuns.mockImplementationOnce(() => new Promise((resolve) => { resolveStale = resolve; }));
    await act(async () => { socket.fire('connect'); });
    api.getRuns.mockResolvedValue({ runs: [RUNS[0]], total: 200 });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'CoS' })); });
    api.getRuns.mockResolvedValue({ runs: RUNS, total: 251 });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'All' })); });
    expect(await screen.findByText('Showing the newest 2 of 251 runs')).toBeInTheDocument();

    await act(async () => { resolveStale({ runs: RUNS, total: 999 }); });
    expect(screen.getByText('Showing the newest 2 of 251 runs')).toBeInTheDocument();
  });

  it('lowers the total after a confirmed delete', async () => {
    api.getRuns.mockResolvedValue({ runs: RUNS, total: 3 });
    api.deleteRun.mockResolvedValue({ success: true });
    renderTab('/cos/runs');
    expect(await screen.findByText('Showing the newest 2 of 3 runs')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByTestId('delete-run-run-a')); });
    expect(screen.getByText('Showing the newest 1 of 2 runs')).toBeInTheDocument();
  });

  it('reopens a listed run after navigating to another selection and back', async () => {
    const view = render(
      <MemoryRouter initialEntries={['/cos/runs?run=run-a']}>
        <RunsTab />
        <NavLink to="/cos/runs?run=run-b">go-b</NavLink>
        <NavLink to="/cos/runs?run=run-a">go-a</NavLink>
      </MemoryRouter>
    );
    await act(async () => {});
    expect(await screen.findByText('full output for run-b')).toBeInTheDocument();
    api.getRunPrompt.mockClear();
    api.getRunOutput.mockClear();
    api.getRunPrompt.mockResolvedValue('prompt b');
    await act(async () => { fireEvent.click(screen.getByText('go-b')); });
    await act(async () => { fireEvent.click(screen.getByText('go-a')); });
    expect(screen.getByRole('button', { name: 'Collapse run details' })).toBeInTheDocument();
    view.unmount();
  });

  it('shows a not-found notice for an unknown ?run= id', async () => {
    api.getRun.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));
    renderTab('/cos/runs?run=run-missing');

    expect(await screen.findByText('Run not found or deleted.')).toBeInTheDocument();
    expect(api.getRunPrompt).not.toHaveBeenCalled();
  });

  it('makes no by-id read when the run is in the loaded list or no ?run= is given', async () => {
    renderTab('/cos/runs?run=run-b');
    await screen.findByText('full output for run-b');
    expect(api.getRun).not.toHaveBeenCalled();
  });

  it('notes the server total when more runs exist than were loaded', async () => {
    api.getRuns.mockResolvedValue({ runs: RUNS, total: 250 });
    renderTab('/cos/runs');
    expect(await screen.findByText('Showing the newest 2 of 250 runs')).toBeInTheDocument();
  });

  it('links a CoS run to its agent and task', async () => {
    api.getRuns.mockResolvedValue({ runs: [
      { ...RUNS[0], id: 'cos-run', source: 'cos-agent', agentId: 'agent-1', taskId: 'sys-task-1', success: false },
    ] });
    renderTab('/cos/runs?run=cos-run');
    expect(await screen.findByRole('link', { name: 'View agent' })).toHaveAttribute('href', '/cos/agents/agent-1');
    expect(screen.getByRole('link', { name: 'View task' })).toHaveAttribute('href', '/cos/tasks?task=sys-task-1&source=internal');
  });

  it('shows each execution state and complete failure guidance before optional diagnostics', async () => {
    const error = 'The provider could not start after checking the configured connection and model.\nChoose an available model for this service.';
    const suggestedFix = 'Open AI Services and reconnect the provider before resuming.';
    api.getRuns.mockResolvedValue({ runs: [
      { ...RUNS[0], id: 'failed', success: false, error, suggestedFix, exitCode: 1 },
      { ...RUNS[0], id: 'running', success: null },
      RUNS[1],
    ] });
    renderTab('/cos/runs');

    expect(await screen.findByText(/Choose an available model for this service/)).toHaveTextContent(error.replace('\n', ' '));
    expect(screen.getByRole('note')).toHaveTextContent(/Open AI Services and reconnect/);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    for (const [id, label] of [['failed', 'Failed'], ['running', 'Running'], ['run-b', 'Succeeded']]) {
      expect(within(screen.getByTestId(`run-row-${id}`)).getByText(label)).toBeVisible();
    }
    expect(api.getRunPrompt).not.toHaveBeenCalled();
    expect(api.getRunOutput).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(within(screen.getByTestId('run-row-failed')).getByRole('button', { name: 'Expand run details' }));
    });
    expect(await screen.findByText('full output for run-b')).toBeVisible();
    expect(screen.getAllByText(/Choose an available model for this service/)).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /View system logs/i })).toHaveLength(1);

    await act(async () => {
      fireEvent.click(within(screen.getByTestId('run-row-run-b')).getByRole('button', { name: 'Expand run details' }));
    });
    expect(screen.getAllByRole('button', { name: 'Resume run' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Continue Conversation' })).not.toBeInTheDocument();
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

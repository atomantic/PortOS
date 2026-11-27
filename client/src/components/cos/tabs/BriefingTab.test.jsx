import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import BriefingTab from './BriefingTab';

const api = vi.hoisted(() => ({
  getCosBriefings: vi.fn(),
  getCosLatestBriefing: vi.fn(),
  getCosBriefing: vi.fn(),
  triggerCosJob: vi.fn(),
}));
const toast = vi.hoisted(() => ({ error: vi.fn() }));

const socket = vi.hoisted(() => {
  const handlers = new Map();
  return {
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(handler);
    },
    off: (event, handler) => handlers.get(event)?.delete(handler),
    emit: vi.fn(),
    receive: (event, payload) => handlers.get(event)?.forEach(handler => handler(payload)),
  };
});
vi.mock('../../../services/socket', () => ({ default: socket }));

vi.mock('../../../services/apiAgents.js', () => ({
  getCosBriefings: api.getCosBriefings,
  getCosLatestBriefing: api.getCosLatestBriefing,
  getCosBriefing: api.getCosBriefing,
  triggerCosJob: api.triggerCosJob,
}));
vi.mock('../../ui/Toast', () => ({ default: toast }));

function CurrentSearch() {
  return <output aria-label="Current query">{useLocation().search}</output>;
}

const renderTab = (entry = '/cos/briefing') => render(
  <MemoryRouter initialEntries={[entry]}>
    <BriefingTab />
    <CurrentSearch />
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  api.getCosBriefings.mockReset().mockResolvedValue({ briefings: [] });
  api.getCosBriefing.mockReset();
  api.getCosLatestBriefing.mockReset().mockResolvedValue(null);
  api.triggerCosJob.mockReset().mockResolvedValue({ started: true });
  toast.error.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

it('announces the briefing heading hierarchy and section disclosure state', async () => {
  const user = userEvent.setup();
  api.getCosLatestBriefing.mockResolvedValue({
    date: '2026-09-11',
    content: '# Today\n## Focus\n### Priority\nAn existing briefing',
  });
  renderTab();

  expect(await screen.findByRole('heading', { name: 'Today', level: 3 })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Daily Briefing', level: 2 })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Priority', level: 4 })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Focus', expanded: true }));
  expect(screen.getByRole('button', { name: 'Focus', expanded: false })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Priority' })).not.toBeInTheDocument();
});

it('keeps the shown briefing and says a refresh failed', async () => {
  const user = userEvent.setup();
  api.getCosLatestBriefing
    .mockResolvedValueOnce({ date: '2026-09-11', content: '# Today\n## Focus\nAn existing briefing' })
    .mockRejectedValueOnce(new Error('Server unavailable'));
  renderTab();
  expect(await screen.findByText('Today')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await screen.findByText(/Could not load the latest briefing — Server unavailable/)).toBeInTheDocument();
  expect(screen.getByText('Today')).toBeInTheDocument();
});

describe('BriefingTab empty state', () => {
  it('shows a retryable error instead of offering generation when the read fails', async () => {
    const user = userEvent.setup();
    api.getCosLatestBriefing
      .mockRejectedValueOnce(new Error('Server unavailable'))
      .mockResolvedValueOnce({ date: '2026-09-11', content: '# Today\n## Focus\nAn existing briefing' });
    renderTab();

    expect(await screen.findByText('Could not load the daily briefing.')).toBeInTheDocument();
    expect(screen.queryByText('No briefing yet')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Generate today’s briefing' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Today')).toBeInTheDocument();
    expect(api.triggerCosJob).not.toHaveBeenCalled();
  });

  it('offers generation and the Daily Briefing job settings link', async () => {
    const user = userEvent.setup();
    renderTab();

    const generate = await screen.findByRole('button', { name: 'Generate today’s briefing' });
    expect(screen.getByText('No briefing yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Daily Briefing job' })).toHaveAttribute('href', '/cos/jobs');

    await user.click(generate);

    await waitFor(() => expect(api.triggerCosJob).toHaveBeenCalledWith(
      'job-daily-briefing',
      { silent: true },
    ));
    await waitFor(() => expect(api.getCosLatestBriefing).toHaveBeenCalledTimes(2));
  });

  it('keeps the action pending until the triggered briefing is persisted', async () => {
    vi.useFakeTimers();
    api.getCosLatestBriefing
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        date: '2026-09-11',
        content: '# Today\n## Focus\nA generated briefing',
      });
    renderTab();

    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Generate today’s briefing' }));
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Generating today’s briefing…' })).toBeDisabled();

    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(api.getCosLatestBriefing).toHaveBeenCalledTimes(2);
    await act(async () => socket.receive('cos:agent:completed', { metadata: { jobId: 'other-job' } }));
    expect(api.getCosLatestBriefing).toHaveBeenCalledTimes(2);
    await act(async () => socket.receive('cos:agent:completed', { metadata: { jobId: 'job-daily-briefing' } }));
    expect(screen.getByText('Today')).toBeInTheDocument();
  });

  it.each([false, true])('offers a new generation attempt after a failed completion (early event: %s)', async early => {
    const user = userEvent.setup();
    let resolveTrigger;
    api.triggerCosJob.mockReturnValueOnce(new Promise(resolve => { resolveTrigger = resolve; }));
    renderTab();

    await user.click(await screen.findByRole('button', { name: 'Generate today’s briefing' }));
    expect(screen.getByRole('button', { name: 'Generating today’s briefing…' })).toBeDisabled();

    const finishTrigger = () => act(async () => resolveTrigger({ started: true }));
    if (!early) await finishTrigger();
    await act(async () => socket.receive('cos:agent:completed', {
      metadata: { jobId: 'job-daily-briefing' },
      result: { success: false },
    }));
    if (early) await finishTrigger();

    expect(screen.getByRole('alert')).toHaveTextContent('The Daily Briefing job ended without producing a briefing.');
    expect(screen.getByRole('link', { name: 'Open Daily Briefing job' })).toHaveAttribute('href', '/cos/jobs');
    const retry = screen.getByRole('button', { name: 'Retry' });
    expect(retry).toBeEnabled();
    await user.click(retry);
    expect(api.triggerCosJob).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not trigger twice while generation is pending', async () => {
    let resolveTrigger;
    api.triggerCosJob.mockReturnValue(new Promise((resolve) => { resolveTrigger = resolve; }));
    renderTab();
    await act(async () => {});
    const generate = await screen.findByRole('button', { name: 'Generate today’s briefing' });

    await act(async () => { fireEvent.click(generate); });
    await act(async () => { fireEvent.click(generate); });

    expect(api.triggerCosJob).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Generating today’s briefing…' })).toBeDisabled();
    resolveTrigger({ started: true });
    await act(async () => {});
  });

  it('shows a rejected trigger reason once', async () => {
    const user = userEvent.setup();
    api.triggerCosJob.mockRejectedValue(new Error('No provider available'));
    renderTab();

    await user.click(await screen.findByRole('button', { name: 'Generate today’s briefing' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('No provider available'));
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});

it('reconciles once on reconnect and tab show, and stops reading after unmount', async () => {
  const view = renderTab();
  await act(async () => {});
  expect(api.getCosLatestBriefing).toHaveBeenCalledTimes(1);
  await act(async () => socket.receive('connect'));
  expect(api.getCosLatestBriefing).toHaveBeenCalledTimes(2);
  await act(async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await act(async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(api.getCosLatestBriefing).toHaveBeenCalledTimes(3);
  view.unmount();
  await act(async () => socket.receive('cos:agent:completed', { metadata: { jobId: 'job-daily-briefing' } }));
  await act(async () => socket.receive('connect'));
  expect(api.getCosLatestBriefing).toHaveBeenCalledTimes(3);
});

it('keeps the selected historical briefing when a daily job completes', async () => {
  api.getCosBriefings.mockResolvedValue({ briefings: [{ date: '2026-09-12' }, { date: '2026-09-11' }] });
  api.getCosLatestBriefing.mockResolvedValue({ date: '2026-09-12', content: '# Latest' });
  renderTab('/cos/briefing?view=compact');
  await act(async () => {});
  let resolveOld;
  api.getCosBriefing.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Date' }), { target: { value: '2026-09-11' } });
  expect(screen.getByLabelText('Current query')).toHaveTextContent('?view=compact&date=2026-09-11');
  await act(async () => {});
  // The route remains mounted while the first historical read is pending.
  api.getCosBriefing.mockResolvedValue({ date: '2026-09-11', content: '# Historical' });
  await act(async () => resolveOld({ date: '2026-09-11', content: '# Historical' }));
  await act(async () => socket.receive('cos:agent:completed', { metadata: { jobId: 'job-daily-briefing' } }));
  expect(screen.getByText('Historical')).toBeInTheDocument();
  expect(api.getCosLatestBriefing).toHaveBeenCalledTimes(1);
  expect(api.getCosBriefing).toHaveBeenLastCalledWith('2026-09-11', { silent: true });
});

it('reconciles completion received while the post-trigger read is still pending', async () => {
  let resolvePending;
  api.getCosLatestBriefing
    .mockResolvedValueOnce(null)
    .mockReturnValueOnce(new Promise(resolve => { resolvePending = resolve; }))
    .mockResolvedValueOnce({ date: '2026-09-12', content: '# Finished during read' });
  renderTab();
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Generate today’s briefing' }));
  await act(async () => {});
  await act(async () => socket.receive('cos:agent:completed', { metadata: { jobId: 'job-daily-briefing' } }));
  await act(async () => resolvePending(null));
  expect(screen.getByText('Finished during read')).toBeInTheDocument();
  expect(api.getCosLatestBriefing).toHaveBeenCalledTimes(3);
});

it('loads a historical briefing directly from the date query parameter', async () => {
  api.getCosBriefing.mockResolvedValue({ date: '2026-09-11', content: '# Historical' });
  renderTab('/cos/briefing?date=2026-09-11');

  expect(await screen.findByText('Historical')).toBeInTheDocument();
  expect(api.getCosBriefing).toHaveBeenCalledWith('2026-09-11', { silent: true });
  expect(api.getCosLatestBriefing).not.toHaveBeenCalled();
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
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

vi.mock('../../../services/api', () => api);
vi.mock('../../ui/Toast', () => ({ default: toast }));

const renderTab = () => render(
  <MemoryRouter>
    <BriefingTab />
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  api.getCosBriefings.mockReset().mockResolvedValue({ briefings: [] });
  api.getCosLatestBriefing.mockReset().mockResolvedValue(null);
  api.triggerCosJob.mockReset().mockResolvedValue({ started: true });
  toast.error.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('BriefingTab empty state', () => {
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
    api.triggerCosJob.mockResolvedValue({ success: false, status: 'skipped', reason: 'No provider available' });
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
  renderTab();
  await act(async () => {});
  let resolveOld;
  api.getCosBriefing.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Date' }), { target: { value: '2026-09-11' } });
  await act(async () => {});
  // The route remains mounted while the first historical read is pending.
  api.getCosBriefing.mockResolvedValue({ date: '2026-09-11', content: '# Historical' });
  await act(async () => resolveOld({ date: '2026-09-11', content: '# Historical' }));
  await act(async () => socket.receive('cos:agent:completed', { metadata: { jobId: 'job-daily-briefing' } }));
  expect(screen.getByText('Historical')).toBeInTheDocument();
  expect(api.getCosLatestBriefing).toHaveBeenCalledTimes(1);
  expect(api.getCosBriefing).toHaveBeenLastCalledWith('2026-09-11');
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

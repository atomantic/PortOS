import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AutoUpdatePanel from './AutoUpdatePanel';

const { mockPatch, mockGetStatus } = vi.hoisted(() => ({ mockPatch: vi.fn(), mockGetStatus: vi.fn() }));
vi.mock('../../../services/api', () => ({ patchSettingsSlice: mockPatch, getAutoUpdateStatus: mockGetStatus }));
vi.mock('../../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
const handlers = new Map();
vi.mock('../../../services/socket', () => ({
  default: {
    on: (event, handler) => handlers.set(event, handler),
    off: (event, handler) => { if (handlers.get(event) === handler) handlers.delete(event); },
  },
}));
afterEach(() => { cleanup(); vi.useRealTimers(); });


const status = (overrides = {}) => ({
  config: { enabled: true, channel: 'release', minIntervalHours: 6, resolveBlockersWithAgent: true },
  runtime: { lastRunAt: null, lastSkip: null },
  repo: { ready: true, branch: 'main', defaultBranch: 'main' },
  activity: { idle: true, blockers: [] },
  ...overrides,
});
const showing = (overrides) => mockGetStatus.mockReturnValue(status(overrides));

beforeEach(() => {
  mockPatch.mockReset();
  mockGetStatus.mockReset();
  mockPatch.mockResolvedValue({});
});

describe('AutoUpdatePanel', () => {
  it('renders nothing until the server has sent an effective config', async () => {
    mockGetStatus.mockReturnValue(undefined);
    const { container } = render(<AutoUpdatePanel />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });

  it('saves a channel change through the settings slice', async () => {
    showing();
    render(<AutoUpdatePanel />);
    await userEvent.click(await screen.findByLabelText(/origin\/main/));
    expect(mockPatch).toHaveBeenCalledWith('autoUpdate', expect.objectContaining({ channel: 'main', enabled: true }), { silent: true });
  });

  // An unattended updater that simply never runs is indistinguishable from a
  // broken one, so whatever gate it is sitting behind has to be on screen.
  it('says what the scheduler is waiting for', async () => {
    showing({
      activity: { idle: false, blockers: [{ kind: 'media-queued:video', label: '2 video renders queued', count: 2 }] },
      runtime: { lastRunAt: null, lastSkip: { reason: 'busy', detail: '2 video renders queued', at: new Date().toISOString() } },
    });
    render(<AutoUpdatePanel />);
    expect(await screen.findByText(/Busy: 2 video renders queued/)).toBeInTheDocument();
    expect(screen.getByText(/Waiting for the system to go idle/)).toBeInTheDocument();
  });

  it('surfaces a checkout that is not ready to update', async () => {
    showing({
      repo: { ready: false, needsAgent: true, branch: 'feature/x', defaultBranch: 'main', summary: 'the working tree has uncommitted changes' },
    });
    render(<AutoUpdatePanel />);
    expect(await screen.findByText(/the working tree has uncommitted changes/)).toBeInTheDocument();
    expect(screen.getByText(/A CoS agent will be queued to resolve it/)).toBeInTheDocument();
  });

  it('hides the configuration while the feature is off', async () => {
    showing({
      config: { enabled: false, channel: 'release', minIntervalHours: 6, resolveBlockersWithAgent: true },
    });
    render(<AutoUpdatePanel />);
    expect(screen.queryByLabelText(/origin\/main/)).not.toBeInTheDocument();
    expect(await screen.findByLabelText(/Off/)).toBeInTheDocument();
  });
});

it('refreshes on events and recovery once, never periodically, and cleans up', async () => {
  vi.useFakeTimers();
  showing();
  const view = render(<AutoUpdatePanel />);
  await act(async () => {});
  expect(mockGetStatus).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(mockGetStatus).toHaveBeenCalledTimes(1);
  showing({ runtime: { lastSkip: { reason: 'cooldown', detail: '60 minutes left' } } });
  await act(async () => {
    handlers.get('portos:auto-update:changed')({});
    handlers.get('system:activity')({});
  });
  expect(mockGetStatus).toHaveBeenCalledTimes(2);
  expect(screen.getByText(/60 minutes left/)).toBeInTheDocument();
  await act(async () => { handlers.get('connect')(); });
  expect(mockGetStatus).toHaveBeenCalledTimes(3);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => { handlers.get('system:activity')({}); });
  expect(mockGetStatus).toHaveBeenCalledTimes(3);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(mockGetStatus).toHaveBeenCalledTimes(4);
  view.unmount();
  expect(handlers.size).toBe(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(mockGetStatus).toHaveBeenCalledTimes(4);
});

it('keeps a successful save ahead of an older pending status response', async () => {
  showing();
  render(<AutoUpdatePanel />);
  await screen.findByLabelText(/origin\/main/);
  let finishOld;
  mockGetStatus.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
  await act(async () => { handlers.get('system:activity')({}); });
  const saved = { ...status().config, channel: 'main' };
  mockPatch.mockResolvedValue({ autoUpdate: saved });
  mockGetStatus.mockReturnValue(status({ config: saved }));
  await userEvent.click(screen.getByLabelText(/origin\/main/));
  expect(screen.getByLabelText(/origin\/main/)).toBeChecked();
  await act(async () => { finishOld(status()); });
  expect(screen.getByLabelText(/origin\/main/)).toBeChecked();
});

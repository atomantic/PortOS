import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AutoUpdatePanel from './AutoUpdatePanel';

const { mockPatch, mockGetStatus } = vi.hoisted(() => ({ mockPatch: vi.fn(), mockGetStatus: vi.fn() }));
vi.mock('../../../services/api', () => ({ patchSettingsSlice: mockPatch, getAutoUpdateStatus: mockGetStatus }));
vi.mock('../../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../hooks/useAutoRefetch', () => ({
  useAutoRefetch: (fetchFn) => {
    fetchFn();
    return { data: mockGetStatus.mock.results.at(-1)?.value, refetch: vi.fn() };
  },
}));

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
  it('renders nothing until the server has sent an effective config', () => {
    mockGetStatus.mockReturnValue(undefined);
    const { container } = render(<AutoUpdatePanel />);
    expect(container).toBeEmptyDOMElement();
  });

  it('saves a channel change through the settings slice', async () => {
    showing();
    render(<AutoUpdatePanel />);
    await userEvent.click(screen.getByLabelText(/origin\/main/));
    expect(mockPatch).toHaveBeenCalledWith('autoUpdate', expect.objectContaining({ channel: 'main', enabled: true }));
  });

  // An unattended updater that simply never runs is indistinguishable from a
  // broken one, so whatever gate it is sitting behind has to be on screen.
  it('says what the scheduler is waiting for', async () => {
    showing({
      activity: { idle: false, blockers: [{ kind: 'media-queued:video', label: '2 video renders queued', count: 2 }] },
      runtime: { lastRunAt: null, lastSkip: { reason: 'busy', detail: '2 video renders queued', at: new Date().toISOString() } },
    });
    render(<AutoUpdatePanel />);
    expect(screen.getByText(/Busy: 2 video renders queued/)).toBeInTheDocument();
    expect(screen.getByText(/Waiting for the system to go idle/)).toBeInTheDocument();
  });

  it('surfaces a checkout that is not ready to update', () => {
    showing({
      repo: { ready: false, needsAgent: true, branch: 'feature/x', defaultBranch: 'main', summary: 'the working tree has uncommitted changes' },
    });
    render(<AutoUpdatePanel />);
    expect(screen.getByText(/the working tree has uncommitted changes/)).toBeInTheDocument();
    expect(screen.getByText(/A CoS agent will be queued to resolve it/)).toBeInTheDocument();
  });

  it('hides the configuration while the feature is off', () => {
    showing({
      config: { enabled: false, channel: 'release', minIntervalHours: 6, resolveBlockersWithAgent: true },
    });
    render(<AutoUpdatePanel />);
    expect(screen.queryByLabelText(/origin\/main/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Off/)).toBeInTheDocument();
  });
});

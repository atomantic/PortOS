import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ActiveProcessingWidget, { sameProcessingSnapshot } from './ActiveProcessingWidget';

const { mockGetActiveProcessing, mockCancelMediaJob } = vi.hoisted(() => ({
  mockGetActiveProcessing: vi.fn(),
  mockCancelMediaJob: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../services/api', () => ({
  getActiveProcessing: mockGetActiveProcessing,
  cancelMediaJob: mockCancelMediaJob,
}));

vi.mock('../../hooks/useAutoRefetch', () => ({
  useAutoRefetch: (fetchFn) => {
    fetchFn();
    return { data: mockGetActiveProcessing.mock.results.at(-1)?.value, loading: false };
  },
}));

const renderWidget = () => render(<MemoryRouter><ActiveProcessingWidget /></MemoryRouter>);

beforeEach(() => vi.clearAllMocks());

describe('ActiveProcessingWidget', () => {
  it('shows an idle GPU link when nothing is active', () => {
    mockGetActiveProcessing.mockReturnValue({ gpu: { status: 'available' }, jobs: [], extras: {}, agents: {} });
    renderWidget();
    expect(screen.getByText('Live activity')).toBeInTheDocument();
    expect(screen.getByText('Nothing is running')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /GPU ready/ })).toHaveAttribute('href', '/system-resources/overview');
  });

  it('summarizes active work and links each lane to its destination', () => {
    mockGetActiveProcessing.mockReturnValue({
      gpu: { status: 'available', laneBusy: true, gpus: [{ utilizationPercent: 42 }] },
      jobs: [
        { id: 'image-1', kind: 'image', status: 'running', progress: 0.5, startedAt: new Date().toISOString(), params: { prompt: 'Example image' } },
        { id: 'audio-1', kind: 'audio', status: 'queued', position: 2, params: { musicStudio: { title: 'Example track' } } },
      ],
      extras: { imageTo3d: [{ id: 'model-1', name: 'Example mesh' }] },
      agents: { active: 2, queued: 1 },
      mind: { trusted: true, thinking: false, queued: 0 },
      // Sent by the server (lib/systemIdle.js) and rendered as-is — the widget
      // deliberately has no second definition of "idle" to fall back on.
      activity: { idle: false, activeCount: 4, queuedCount: 2, blockers: [] },
    });
    renderWidget();
    // Running and queued are counted separately: a queued render is real work
    // waiting on the user, not part of the "active" tally.
    expect(screen.getByText('4 active · 2 queued')).toBeInTheDocument();
    expect(screen.getByText('Example image')).toBeInTheDocument();
    expect(screen.getByText('Example track')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open image activity' })).toHaveAttribute('href', '/media/image');
    expect(screen.getByRole('link', { name: 'Open audio activity' })).toHaveAttribute('href', '/media/history?type=audio');
    expect(screen.getByRole('link', { name: /Chief of Staff agents/ })).toHaveAttribute('href', '/cos/agents');
    expect(screen.getByText('50%')).toBeInTheDocument();
  });

  // Counts and lifecycle only — the widget must never render what the mind is
  // thinking about, and the snapshot never carries it.
  it('surfaces a thinking Persistent Mind as its own lane', () => {
    mockGetActiveProcessing.mockReturnValue({
      gpu: { status: 'available' },
      jobs: [],
      extras: {},
      agents: {},
      mind: { trusted: true, thinking: true, queued: 2, thinkingSince: new Date().toISOString() },
      activity: { idle: false, activeCount: 1, queuedCount: 2, blockers: [{ kind: 'mind-thinking', label: 'Persistent Mind is thinking', count: 1 }] },
    });
    renderWidget();
    expect(screen.getByRole('link', { name: /Persistent Mind is thinking/ })).toHaveAttribute('href', '/cos/mind');
    expect(screen.getByText('1 active · 2 queued')).toBeInTheDocument();
  });

  it('shows a running app operation as activity', () => {
    mockGetActiveProcessing.mockReturnValue({
      gpu: { status: 'available' },
      jobs: [],
      extras: {},
      agents: {},
      appOperations: [{ appId: 'example', appName: 'Example App', type: 'update' }],
      activity: { idle: false, activeCount: 1, queuedCount: 0, blockers: [{ kind: 'app-operations', label: '1 app operation running', count: 1 }] },
    });
    renderWidget();
    expect(screen.getByRole('link', { name: /Example App · update/ })).toHaveAttribute('href', '/apps');
  });

  it('cancels a live job from its row', async () => {
    mockGetActiveProcessing.mockReturnValue({
      gpu: { status: 'available' },
      jobs: [{ id: 'image-1', kind: 'image', status: 'running', progress: 0.5, startedAt: new Date().toISOString(), params: { prompt: 'Example image' } }],
      extras: {},
      agents: {},
    });
    const user = userEvent.setup();
    renderWidget();
    await user.click(screen.getByRole('button', { name: 'Cancel Example image' }));
    expect(mockCancelMediaJob).toHaveBeenCalledWith('image-1', { silent: true });
  });

  it('recognizes queue movement while ignoring server timestamps', () => {
    const base = { updatedAt: '2026-01-01T00:00:00Z', jobs: [{ id: 'job-1', status: 'queued', position: 2 }], agents: {}, gpu: {}, extras: {} };
    expect(sameProcessingSnapshot(base, { ...base, updatedAt: '2026-01-01T00:00:03Z' })).toBe(true);
    expect(sameProcessingSnapshot(base, { ...base, jobs: [{ ...base.jobs[0], position: 1 }] })).toBe(false);
    expect(sameProcessingSnapshot(undefined, base)).toBe(false);
  });
});

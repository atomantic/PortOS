import { render, screen, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ActiveProcessingWidget from './ActiveProcessingWidget';
import { sameProcessingSnapshot, __resetSystemActivityForTests } from '../../hooks/useSystemActivity';

const handlers = new Map();
vi.mock('../../services/socket', () => ({
  default: {
    on: (event, fn) => { handlers.set(event, fn); },
    off: (event, fn) => { if (handlers.get(event) === fn) handlers.delete(event); },
  },
}));

const { mockGetSystemActivity, mockGetGpuTelemetry, mockCancelMediaJob } = vi.hoisted(() => ({
  mockGetSystemActivity: vi.fn(),
  mockGetGpuTelemetry: vi.fn(),
  mockCancelMediaJob: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../services/api', () => ({
  getSystemActivity: (...args) => mockGetSystemActivity(...args),
  getGpuTelemetry: (...args) => mockGetGpuTelemetry(...args),
  cancelMediaJob: (...args) => mockCancelMediaJob(...args),
}));

let intersecting = true;
class FakeObserver {
  constructor(callback) { this.callback = callback; }
  observe() { this.callback([{ isIntersecting: intersecting }]); }
  disconnect() {}
}

const renderWidget = () => render(<MemoryRouter><ActiveProcessingWidget /></MemoryRouter>);
const idle = { activity: { idle: true, activeCount: 0, queuedCount: 0, blockers: [] }, jobs: [], extras: {}, agents: {} };

beforeEach(() => {
  handlers.clear();
  intersecting = true;
  globalThis.IntersectionObserver = FakeObserver;
  mockGetSystemActivity.mockReset();
  mockGetGpuTelemetry.mockReset();
  mockCancelMediaJob.mockClear();
  mockGetSystemActivity.mockResolvedValue(idle);
  mockGetGpuTelemetry.mockResolvedValue({ gpu: { status: 'available', gpus: [] } });
});

afterEach(() => {
  cleanup();
  __resetSystemActivityForTests();
});

describe('ActiveProcessingWidget', () => {
  it('shows an idle GPU link when nothing is active', async () => {
    renderWidget();
    expect(await screen.findByText('Live activity')).toBeInTheDocument();
    expect(screen.getByText('Nothing is running')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /GPU ready/ })).toHaveAttribute('href', '/system-resources/overview');
  });

  it('summarizes active work and links each lane to its destination', async () => {
    mockGetSystemActivity.mockResolvedValue({
      jobs: [
        { id: 'image-1', kind: 'image', status: 'running', progress: 0.5, startedAt: new Date().toISOString(), params: { prompt: 'Example image' } },
        { id: 'audio-1', kind: 'audio', status: 'queued', position: 2, params: { musicStudio: { title: 'Example track' } } },
      ],
      extras: { imageTo3d: [{ id: 'model-1', name: 'Example mesh' }] },
      agents: { active: 2, queued: 1 },
      mind: { trusted: true, thinking: false, queued: 0 },
      activity: { idle: false, activeCount: 4, queuedCount: 2, blockers: [] },
    });
    mockGetGpuTelemetry.mockResolvedValue({ gpu: { status: 'available', laneBusy: true, gpus: [{ utilizationPercent: 42 }] } });
    renderWidget();
    expect(await screen.findByText('4 active · 2 queued')).toBeInTheDocument();
    expect(screen.getByText('Example image')).toBeInTheDocument();
    expect(screen.getByText('Example track')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open image activity' })).toHaveAttribute('href', '/media/image');
    expect(screen.getByRole('link', { name: 'Open audio activity' })).toHaveAttribute('href', '/media/history?type=audio');
    expect(screen.getByRole('link', { name: /Chief of Staff agents/ })).toHaveAttribute('href', '/cos/agents');
    expect(screen.getByText('50%')).toBeInTheDocument();
  });

  it('surfaces a thinking Persistent Mind as its own lane', async () => {
    mockGetSystemActivity.mockResolvedValue({
      jobs: [],
      extras: {},
      agents: {},
      mind: { trusted: true, thinking: true, queued: 2, thinkingSince: new Date().toISOString() },
      activity: { idle: false, activeCount: 1, queuedCount: 2, blockers: [{ kind: 'mind-thinking', label: 'Persistent Mind is thinking', count: 1 }] },
    });
    renderWidget();
    expect(await screen.findByRole('link', { name: /Persistent Mind is thinking/ })).toHaveAttribute('href', '/cos/mind');
    expect(screen.getByText('1 active · 2 queued')).toBeInTheDocument();
  });

  it('shows a running app operation as activity', async () => {
    mockGetSystemActivity.mockResolvedValue({
      jobs: [],
      extras: {},
      agents: {},
      appOperations: [{ appId: 'example', appName: 'Example App', type: 'update' }],
      activity: { idle: false, activeCount: 1, queuedCount: 0, blockers: [] },
    });
    renderWidget();
    expect(await screen.findByRole('link', { name: /Example App · update/ })).toHaveAttribute('href', '/apps');
  });

  it('cancels a live job from its row', async () => {
    mockGetSystemActivity.mockResolvedValue({
      jobs: [{ id: 'image-1', kind: 'image', status: 'running', progress: 0.5, startedAt: new Date().toISOString(), params: { prompt: 'Example image' } }],
      extras: {},
      agents: {},
      activity: { idle: false, activeCount: 1, queuedCount: 0, blockers: [] },
    });
    const user = userEvent.setup();
    renderWidget();
    await user.click(await screen.findByRole('button', { name: 'Cancel Example image' }));
    expect(mockCancelMediaJob).toHaveBeenCalledWith('image-1', { silent: true });
  });

  it('does not sample the GPU while the inspector is off screen', async () => {
    intersecting = false;
    renderWidget();
    await screen.findByText('Live activity');
    await act(async () => { await Promise.resolve(); });
    expect(mockGetGpuTelemetry).not.toHaveBeenCalled();
    expect(mockGetSystemActivity).toHaveBeenCalled();
  });

  it('recognizes queue movement while ignoring server timestamps', () => {
    const base = { updatedAt: '2026-01-01T00:00:00Z', jobs: [{ id: 'job-1', status: 'queued', position: 2 }], agents: {}, gpu: {}, extras: {} };
    expect(sameProcessingSnapshot(base, { ...base, updatedAt: '2026-01-01T00:00:03Z' })).toBe(true);
    expect(sameProcessingSnapshot(base, { ...base, jobs: [{ ...base.jobs[0], position: 1 }] })).toBe(false);
    expect(sameProcessingSnapshot(undefined, base)).toBe(false);
  });
});

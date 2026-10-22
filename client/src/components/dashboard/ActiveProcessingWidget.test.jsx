import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ActiveProcessingWidget from './ActiveProcessingWidget';
import { __resetSystemActivityForTests } from '../../hooks/useSystemActivity';

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

  it('shows a render running outside the media queue, linked to its project', async () => {
    mockGetSystemActivity.mockResolvedValue({
      jobs: [],
      extras: {},
      agents: {},
      renders: [{ kind: 'music-video-final', noun: 'music video render', to: '/music-video/mv-example', startedAt: new Date().toISOString() }],
      activity: { idle: false, activeCount: 1, queuedCount: 0, blockers: [] },
    });
    renderWidget();
    expect(await screen.findByRole('link', { name: /Music video render/ })).toHaveAttribute('href', '/music-video/mv-example');
  });

  it('shows LLM model/source, elapsed time, a run deep link and Ollama residency', async () => {
    mockGetSystemActivity.mockResolvedValue({
      ...idle,
      llm: { trusted: true, active: 1, runs: [{ runId: 'run-1', providerId: 'ollama', model: 'example:7b', source: 'music-video-document', startedAt: new Date(Date.now() - 125000).toISOString() }] },
      ollama: { trusted: true, models: [{ id: 'example:7b', name: 'example:7b', size: 1073741824, sizeVram: 1073741824 }] },
      activity: { idle: false, activeCount: 1, queuedCount: 0, blockers: [] },
    });
    renderWidget();
    expect(await screen.findByRole('link', { name: /ollama · example:7b · music-video-document/ })).toHaveAttribute('href', '/cos/runs?run=run-1');
    expect(screen.getByText('2:05')).toBeInTheDocument();
    expect(screen.getByText('LLM')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Ollama loaded · example:7b/ })).toHaveTextContent('1 GB · GPU');
  });

  it('shows external Ollama loads from telemetry even when PortOS is idle', async () => {
    mockGetGpuTelemetry.mockResolvedValue({ ollama: { trusted: true, models: [{ id: 'external', name: 'external', size: 1073741824, sizeVram: 0 }] } });
    renderWidget();
    expect(await screen.findByRole('link', { name: /Ollama loaded · external/ })).toHaveTextContent('1 GB · CPU');
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
    expect(mockCancelMediaJob).toHaveBeenCalledWith('image-1');
  });

  it('keeps Cancel usable for a retry when the cancel request fails', async () => {
    mockGetSystemActivity.mockResolvedValue({
      jobs: [{ id: 'image-1', kind: 'image', status: 'running', progress: 0.5, startedAt: new Date().toISOString(), params: { prompt: 'Example image' } }],
      extras: {},
      agents: {},
      activity: { idle: false, activeCount: 1, queuedCount: 0, blockers: [] },
    });
    mockCancelMediaJob.mockRejectedValueOnce(new Error('GPU busy'));
    const user = userEvent.setup();
    renderWidget();
    await user.click(await screen.findByRole('button', { name: 'Cancel Example image' }));
    await user.click(screen.getByRole('button', { name: 'Cancel Example image' }));
    expect(mockCancelMediaJob).toHaveBeenCalledTimes(2);
  });

  it('does not sample the GPU while the inspector is off screen', async () => {
    intersecting = false;
    renderWidget();
    await screen.findByText('Live activity');
    await act(async () => { await Promise.resolve(); });
    expect(mockGetGpuTelemetry).not.toHaveBeenCalled();
    expect(mockGetSystemActivity).toHaveBeenCalled();
  });

  it('replaces rows when app operations and the mind lifecycle change between reads', async () => {
    const initial = {
      ...idle,
      appOperations: [{ appId: 'example', appName: 'Old App', type: 'update' }],
      mind: { thinking: true, thinkingSince: new Date(Date.now() - 600_000).toISOString() },
      activity: { idle: false, activeCount: 1, queuedCount: 0, blockers: [] },
    };
    mockGetSystemActivity.mockResolvedValueOnce(initial);
    renderWidget();

    expect(await screen.findByRole('link', { name: /Old App · update/ })).toBeInTheDocument();
    const originalMindText = screen.getByRole('link', { name: /Persistent Mind is thinking/ }).textContent;

    mockGetSystemActivity.mockResolvedValueOnce({
      ...initial,
      appOperations: [{ appId: 'example', appName: 'New App', type: 'update' }],
      mind: { ...initial.mind, thinkingSince: new Date(Date.now() - 50_000).toISOString() },
    });
    act(() => handlers.get('system:activity')());

    expect(await screen.findByRole('link', { name: /New App · update/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Old App · update/ })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('link', { name: /Persistent Mind is thinking/ }).textContent).not.toBe(originalMindText);
    });
  });
});

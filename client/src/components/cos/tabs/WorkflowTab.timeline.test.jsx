import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = {
  getCosWorkflow: vi.fn(),
  updateAppTaskTypeOverride: vi.fn(),
  bulkUpdateAppTaskTypeOverride: vi.fn(),
};
vi.mock('../../../services/api', () => api);

const WorkflowTab = (await import('./WorkflowTab')).default;

const NOW = new Date('2026-08-22T00:00:00Z');
const HOUR = 3600 * 1000;

const SAMPLE_GRAPH = {
  timezone: 'UTC',
  timeline: {
    startAt: NOW.toISOString(),
    endAt: new Date(NOW.getTime() + 168 * HOUR).toISOString(),
    occurrences: [
      {
        id: 'task:code-quality:launch:1',
        nodeId: 'task:code-quality',
        at: new Date(NOW.getTime() + 10 * HOUR).toISOString(),
        kind: 'launch',
      }
    ],
    windows: [],
  },
  nodes: [
    {
      id: 'task:code-quality',
      kind: 'task',
      label: 'code-quality',
      enabled: true,
      schedule: { type: 'cron', cronExpression: '0 10 * * 0' },
      totalAppCount: 0,
    }
  ],
  edges: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getCosWorkflow.mockResolvedValue(SAMPLE_GRAPH);
});
afterEach(cleanup);

describe('WorkflowTab timeline defaults and layout', () => {
  it('defaults to 7 day timeline (168 hours) when no query param is provided', async () => {
    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/cos/workflow']}>
          <WorkflowTab apps={[]} providers={[]} />
        </MemoryRouter>
      );
    });

    expect(api.getCosWorkflow).toHaveBeenCalledWith(168);
    const sevenDaysBtn = screen.getByRole('button', { name: '7 days' });
    expect(sevenDaysBtn.className).toContain('text-port-accent');
    const twentyFourHoursBtn = screen.getByRole('button', { name: '24 hours' });
    expect(twentyFourHoursBtn.className).not.toContain('text-port-accent');
  });

  it('omits the redundant header explainer and metrics widgets', async () => {
    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/cos/workflow']}>
          <WorkflowTab apps={[]} providers={[]} />
        </MemoryRouter>
      );
    });

    await screen.findAllByText('code-quality');
    expect(screen.queryByText(/See the real launch order across/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Active schedules')).not.toBeInTheDocument();
    expect(screen.queryByText('Launches in view')).not.toBeInTheDocument();
    expect(screen.queryByText('Tight handoffs')).not.toBeInTheDocument();
  });

  it('renders axis edge labels with proper padding without overflow translation', async () => {
    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/cos/workflow']}>
          <WorkflowTab apps={[]} providers={[]} />
        </MemoryRouter>
      );
    });

    await screen.findAllByText('code-quality');
    const nowLabel = screen.getByText('Now');
    expect(nowLabel.className).toContain('left-2');
    expect(nowLabel.className).toContain('translate-x-0');

    // For 7 days, the last day is Sat (Aug 29, 7 days from Sat Aug 22)
    const allDays = screen.getAllByText('Sat');
    const endDayLabel = allDays[allDays.length - 1];
    expect(endDayLabel.className).toContain('right-2');
    expect(endDayLabel.className).toContain('translate-x-0');
  });

  it('renders schedule editor in desktop grid column when a track is selected', async () => {
    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/cos/workflow?track=task:code-quality']}>
          <WorkflowTab apps={[]} providers={[]} />
        </MemoryRouter>
      );
    });

    await screen.findByRole('button', { name: 'Save schedule' });
    const editorContainer = screen.getByRole('button', { name: 'Save schedule' }).closest('.lg\\:col-start-2');
    expect(editorContainer).toBeInTheDocument();
    expect(editorContainer.className).toContain('lg:row-start-1');
    expect(editorContainer.className).toContain('lg:row-span-3');
  });
});

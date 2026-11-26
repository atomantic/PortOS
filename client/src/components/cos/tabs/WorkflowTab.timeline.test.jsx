import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { formatWeekdayTime } from '../../../utils/formatters';

const api = {
  getCosWorkflow: vi.fn(),
  updateAppTaskTypeOverride: vi.fn(),
  bulkUpdateAppTaskTypeOverride: vi.fn(),
};
vi.mock('../../../services/apiAgents.js', () => ({ getCosWorkflow: api.getCosWorkflow }));
vi.mock('../../../services/apiApps.js', () => ({
  updateAppTaskTypeOverride: api.updateAppTaskTypeOverride,
  bulkUpdateAppTaskTypeOverride: api.bulkUpdateAppTaskTypeOverride,
}));

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
  it('announces initial loading until the timeline is available', async () => {
    let resolveWorkflow;
    api.getCosWorkflow.mockReturnValue(new Promise(resolve => { resolveWorkflow = resolve; }));

    render(
      <MemoryRouter initialEntries={['/cos/workflow']}>
        <WorkflowTab apps={[]} providers={[]} />
      </MemoryRouter>
    );

    expect(screen.getByRole('status')).toHaveTextContent('Building schedule timeline…');

    await act(async () => { resolveWorkflow(SAMPLE_GRAPH); });

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getAllByText('code-quality').length).toBeGreaterThan(0);
  });

  it('defaults to 7 day timeline (168 hours) when no query param is provided', async () => {
    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/cos/workflow']}>
          <WorkflowTab apps={[]} providers={[]} />
        </MemoryRouter>
      );
    });

    expect(api.getCosWorkflow).toHaveBeenCalledWith(168, { silent: true });
    const windowSelector = within(screen.getByRole('group', { name: 'Timeline window' }));
    const sevenDaysBtn = windowSelector.getByRole('button', { name: '7 days', pressed: true });
    expect(sevenDaysBtn.className).toContain('text-port-accent');
    const twentyFourHoursBtn = windowSelector.getByRole('button', { name: '24 hours', pressed: false });
    expect(twentyFourHoursBtn.className).not.toContain('text-port-accent');

    await userEvent.click(twentyFourHoursBtn);

    expect(windowSelector.getByRole('button', { name: '24 hours', pressed: true })).toBe(twentyFourHoursBtn);
    expect(windowSelector.getByRole('button', { name: '7 days', pressed: false })).toBe(sevenDaysBtn);
    expect(api.getCosWorkflow).toHaveBeenLastCalledWith(24, { silent: true });
  });

  it('uses one named track selector and exposes each launch without hovering', async () => {
    const [task] = SAMPLE_GRAPH.nodes;
    const [launch] = SAMPLE_GRAPH.timeline.occurrences;
    const catchUpTime = formatWeekdayTime(NOW, { timeZone: 'UTC' });
    const regularTime = formatWeekdayTime(launch.at, { timeZone: 'UTC' });
    api.getCosWorkflow.mockResolvedValue({
      ...SAMPLE_GRAPH,
      timeline: {
        ...SAMPLE_GRAPH.timeline,
        occurrences: [
          { ...launch, id: 'catch-up', at: NOW.toISOString(), dueNow: true, reason: 'cron-catch-up', collision: true, apps: ['example-app'] },
          launch,
        ],
      },
      nodes: [{
        ...task,
        pendingDeps: ['prepare', 'check'],
        appSchedules: [{ appId: 'example-app', appName: 'Example App', cronExpression: '0 10 * * 0' }],
      }, {
        id: 'task:review',
        kind: 'task',
        label: 'Review',
        enabled: true,
        schedule: { type: 'on-demand' },
      }],
    });
    render(<MemoryRouter initialEntries={['/cos/schedule/timeline']}><WorkflowTab apps={[]} providers={[]} /></MemoryRouter>);

    const user = userEvent.setup();
    const track = await screen.findByRole('button', { name: /^code-quality/, pressed: false });
    const queue = screen.getByRole('button', { name: /^Review/, pressed: false });
    for (const button of screen.getAllByRole('button')) expect(button).toHaveAccessibleName();
    expect(track).toHaveAccessibleDescription(
      /2 scheduled events.*for Example App.*due now.*Catch-up.*another task launches within 15 minutes.*Waiting on 2 dependencies/,
    );
    expect(track).toHaveAccessibleDescription(expect.stringContaining(`Next: Launch ${catchUpTime}`));

    track.focus();
    await user.keyboard('{Enter}');
    expect(track).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('complementary', { name: 'Schedule editor for code-quality' })).toBeInTheDocument();

    await user.tab();
    const detailsToggle = screen.getByText('Scheduled launches and drains');
    expect(detailsToggle).toHaveFocus();
    await user.click(detailsToggle);
    const launches = within(detailsToggle.closest('details')).getAllByRole('listitem');
    expect(launches).toHaveLength(2);
    expect(launches[0]).toHaveTextContent(/for Example App.*due now.*within 15 minutes/);
    expect(launches[1]).toHaveTextContent(`Launch ${regularTime}`);

    await user.click(queue);
    expect(queue).toHaveAttribute('aria-pressed', 'true');
    expect(track).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('complementary', { name: 'Schedule editor for Review' })).toBeInTheDocument();

    await user.click(screen.getByTitle(`Launch ${regularTime}`));
    expect(track).toHaveAttribute('aria-pressed', 'true');
    expect(queue).toHaveAttribute('aria-pressed', 'false');
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

    const closeButton = await screen.findByRole('button', { name: 'Close schedule editor' });
    const editorContainer = closeButton.closest('.lg\\:col-start-2');
    expect(editorContainer).toBeInTheDocument();
    expect(editorContainer.className).toContain('lg:row-start-1');
    expect(editorContainer.className).toContain('lg:row-span-3');
  });
});

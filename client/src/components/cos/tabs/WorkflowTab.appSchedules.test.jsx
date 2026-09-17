/**
 * A task left on-demand at the global config while an app override pins a cron
 * used to vanish from this page: the projection gave it no occurrences and the
 * row landed in the "Unpinned runner queue", which says outright that these
 * tasks do not promise a clock time. They do — for that app.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, within } from '@testing-library/react';
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

const graph = ({ appSchedules, occurrences }) => ({
  timezone: 'UTC',
  timeline: {
    startAt: NOW.toISOString(),
    endAt: new Date(NOW.getTime() + 24 * HOUR).toISOString(),
    occurrences,
    windows: [],
  },
  nodes: [{
    id: 'task:release-check',
    kind: 'task',
    label: 'release-check',
    enabled: true,
    schedule: { type: 'on-demand' },
    totalAppCount: 2,
    enabledAppCount: 1,
    appOverrides: {},
    appSchedules,
  }],
  edges: [],
});

const APP_SCHEDULED = graph({
  appSchedules: [{ appId: 'acme', appName: 'Acme', cronExpression: '0 7 * * *', nextRunAt: new Date(NOW.getTime() + 7 * HOUR).toISOString() }],
  occurrences: [{
    id: 'task:release-check:launch:1',
    nodeId: 'task:release-check',
    at: new Date(NOW.getTime() + 7 * HOUR).toISOString(),
    kind: 'launch',
    apps: ['acme'],
  }],
});

const render_ = async (data) => {
  api.getCosWorkflow.mockResolvedValue(data);
  await act(async () => {
    render(<MemoryRouter><WorkflowTab apps={[]} providers={[]} /></MemoryRouter>);
  });
  // The label appears on the track AND on its 'Scheduled order' chip.
  await screen.findAllByText('release-check');
};

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('WorkflowTab per-app schedules', () => {
  it('gives an app-scheduled task a timeline track instead of the unpinned queue', async () => {
    await render_(APP_SCHEDULED);

    expect(screen.queryByText('Unpinned runner queue')).not.toBeInTheDocument();
    // The cadence line names the app schedule rather than repeating the
    // global row's "on demand".
    expect(screen.getByText('1 app · at 07:00')).toBeInTheDocument();
    expect(screen.getByTitle(/On demand globally[\s\S]*Acme — at 07:00 \(0 7 \* \* \*\)/)).toBeInTheDocument();
  });

  it('marks a launch that only some apps take, and names them', async () => {
    await render_(APP_SCHEDULED);

    const marker = screen.getByTitle(/^Launch .* · for Acme$/);
    // Round rather than square: a free channel that leaves the collision ring
    // and the due-now fill free to show at the same time.
    expect(marker.className).toContain('rounded-full');
    expect(marker.className).not.toContain('rounded-sm');

    const nextUp = screen.getByText('Scheduled order').closest('section');
    expect(within(nextUp).getByText('for Acme')).toBeInTheDocument();
  });

  it('still files a task with no schedule of any kind under the unpinned queue', async () => {
    await render_(graph({ appSchedules: [], occurrences: [] }));

    expect(screen.getByText('Unpinned runner queue')).toBeInTheDocument();
  });
});

/**
 * A perpetual drain used to paint one band from Now to the horizon, so every
 * perpetual task read as "always running" and its next start was invisible.
 * The server now emits bounded runtime bars; this pins that the row renders
 * them as bounded, positioned bars rather than a full-width fill.
 */

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
const LATER = new Date(NOW.getTime() + 6 * HOUR);

const GRAPH = {
  timezone: 'UTC',
  timeline: {
    startAt: NOW.toISOString(),
    endAt: new Date(NOW.getTime() + 24 * HOUR).toISOString(),
    occurrences: [],
    windows: [
      {
        id: 'task:drain:draining:0',
        nodeId: 'task:drain',
        startAt: NOW.toISOString(),
        endAt: new Date(NOW.getTime() + HOUR).toISOString(),
        kind: 'perpetual',
        state: 'draining',
      },
      {
        id: 'task:drain:scheduled:1',
        nodeId: 'task:drain',
        startAt: LATER.toISOString(),
        endAt: new Date(LATER.getTime() + HOUR).toISOString(),
        kind: 'perpetual',
        state: 'scheduled',
      },
    ],
  },
  nodes: [{
    id: 'task:drain',
    kind: 'task',
    label: 'branch-reconcile',
    enabled: true,
    schedule: { type: 'cron', perpetual: true, cronExpression: '0 5 * * 5' },
    totalAppCount: 0,
  }],
  edges: [],
};

const pct = (value) => Number.parseFloat(value);

beforeEach(() => {
  vi.clearAllMocks();
  api.getCosWorkflow.mockResolvedValue(GRAPH);
});
afterEach(cleanup);

describe('WorkflowTab perpetual runtime bars', () => {
  it('bounds each drain to its own window instead of filling the track', async () => {
    await act(async () => {
      render(<MemoryRouter><WorkflowTab apps={[]} providers={[]} /></MemoryRouter>);
    });
    await screen.findByText('branch-reconcile');

    // An hour of a 24h horizon — the old full-horizon band left `right: 0%`.
    const live = screen.getByLabelText(/^Draining since/);
    expect(pct(live.style.left)).toBeCloseTo(0, 3);
    expect(pct(live.style.right)).toBeCloseTo(95.8333, 3);
    expect(live).toHaveTextContent('draining');
    expect(live.title).toMatch(/continues while backlog remains/);

    // The future recurrence sits at its own start, and only the live drain
    // carries the word — a scheduled bar is an outline.
    const upcoming = screen.getByLabelText(/^Drain starts/);
    expect(pct(upcoming.style.left)).toBeCloseTo(25, 3);
    expect(pct(upcoming.style.right)).toBeCloseTo(70.8333, 3);
    expect(upcoming).not.toHaveTextContent('draining');
  });
});

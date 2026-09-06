import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() })
}));
vi.mock('../../services/api', () => ({ updateCosJob: vi.fn() }));

const JobCard = (await import('./JobCard')).default;

// A legacy script command with no spaces — the shape that used to run off the
// edge of the card, unreachable because Layout's root is `overflow-x-hidden`.
const LONG_COMMAND = `node scripts/${'legacy-handler-segment-'.repeat(20)}run.js`;

const SCRIPT_JOB = {
  id: 'job-legacy',
  name: 'Legacy handler',
  description: '',
  type: 'script',
  interval: '1h',
  intervalMs: 3600000,
  priority: 'MEDIUM',
  autonomyLevel: 'standby',
  enabled: true,
  command: LONG_COMMAND
};

const noop = () => {};

const renderCard = (job) => render(
  <JobCard
    job={job}
    onToggle={noop}
    onTrigger={noop}
    onDelete={noop}
    onUpdate={noop}
  />
);

describe('JobCard machine output', () => {
  it('wraps the read-only legacy command so a long single-line value stays fully readable', () => {
    renderCard(SCRIPT_JOB);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    const pre = screen.getByText(LONG_COMMAND);
    expect(pre.tagName).toBe('PRE');
    // Without the wrap pair the tail of the command is clipped by the app
    // shell's `overflow-x-hidden` with no scrollbar to recover it.
    expect(pre.className).toContain('whitespace-pre-wrap');
    expect(pre.className).toContain('break-all');
  });

  it('breaks unbroken tokens in a shell job last-output block, not just at whitespace', () => {
    // `whitespace-pre-wrap` alone only wraps at whitespace — shell output is
    // full of long unbroken paths and URLs that still run past the clip edge.
    const lastOutput = `fatal: ${'unbroken-token-'.repeat(30)}end`;
    renderCard({
      ...SCRIPT_JOB,
      id: 'job-shell',
      type: 'shell',
      command: 'echo hi',
      lastExitCode: 1,
      lastOutput
    });
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));

    const pre = screen.getByText(lastOutput);
    expect(pre.tagName).toBe('PRE');
    expect(pre.className).toContain('break-all');
  });
});

// #6375 — the on-demand cadence. The card must not render an arithmetic-derived
// date for a job with no interval, and the edit form must not offer a
// time-of-day the job can never honor.
describe('JobCard on-demand cadence', () => {
  const ON_DEMAND_JOB = {
    id: 'job-manual',
    name: 'Manual only',
    description: '',
    type: 'agent',
    category: 'custom',
    interval: 'on-demand',
    intervalMs: null,
    priority: 'MEDIUM',
    autonomyLevel: 'manager',
    enabled: true,
    lastRun: '2026-01-01T00:00:00.000Z',
    runCount: 3
  };

  it('renders "On demand" as the next run instead of a date derived from a null interval', () => {
    renderCard(ON_DEMAND_JOB);

    expect(screen.getByText('Next: On demand')).toBeTruthy();
    expect(screen.queryByText(/Invalid Date/)).toBeNull();
    expect(screen.queryByText(/NaN/)).toBeNull();
  });

  it('never shows the Due badge, however long ago the job last ran', () => {
    renderCard({ ...ON_DEMAND_JOB, lastRun: null });

    // A never-run recurring job is due immediately; an on-demand one never is.
    expect(screen.queryByText('Due')).toBeNull();
  });

  it('labels the cadence from the shared option list', () => {
    renderCard(ON_DEMAND_JOB);
    expect(screen.getByText('On Demand')).toBeTruthy();
  });

  it('offers the cadence and hides the time input once it is selected', () => {
    renderCard({ ...ON_DEMAND_JOB, interval: 'daily', intervalMs: 86400000, scheduledTime: '09:00' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    const select = screen.getByLabelText('Interval');
    expect(screen.getByLabelText('Run at a specific time (leave empty for any time)')).toBeTruthy();

    fireEvent.change(select, { target: { value: 'on-demand' } });

    expect(select.value).toBe('on-demand');
    expect(screen.queryByLabelText('Run at a specific time (leave empty for any time)')).toBeNull();
    expect(screen.getByText('Runs only when you press Run now.')).toBeTruthy();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() })
}));
vi.mock('../../services/api', () => ({ updateCosJob: vi.fn() }));
const { updateCosJob } = await import('../../services/api');

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
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));

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

  it('hands the configuration form to the editor while editing, never showing two copies', () => {
    renderCard({
      ...ON_DEMAND_JOB,
      formFields: [{ key: 'subject', label: 'Subject', type: 'text' }],
      formValues: { subject: 'Saved subject' }
    });

    // The card's ad-hoc panel edits THIS RUN; the editor's copy edits what the
    // task is saved with. Two live copies of one form is a merge nobody wins, so
    // exactly one is on screen at a time.
    expect(screen.getAllByLabelText('Subject')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getAllByLabelText('Subject')).toHaveLength(1);
  });

  it('keeps in-progress run values across a refetch, but follows a real saved change', () => {
    const withValues = (formValues) => (
      <JobCard
        job={{ ...ON_DEMAND_JOB, formFields: [{ key: 'subject', label: 'Subject', type: 'text' }], formValues }}
        onToggle={noop}
        onTrigger={noop}
        onDelete={noop}
        onUpdate={noop}
      />
    );
    const { rerender } = render(withValues({ subject: 'Saved' }));
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'One-off' } });

    // A poll hands back an equal-but-new object every time. Keying the reset on
    // object identity instead of the value signature would wipe what the user
    // is still typing on each one.
    rerender(withValues({ subject: 'Saved' }));
    expect(screen.getByLabelText('Subject')).toHaveValue('One-off');

    // A genuine change to the saved value does reset the dial onto it.
    rerender(withValues({ subject: 'Edited elsewhere' }));
    expect(screen.getByLabelText('Subject')).toHaveValue('Edited elsewhere');
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

// #15352 — the card renders the server's projected fire time (user timezone,
// nearest-HH:MM snap, weekdaysOnly skip) rather than re-deriving it in the
// browser's zone, so the two cannot disagree.
describe('JobCard next-due from the server projection', () => {
  const NOW = Date.parse('2026-11-02T11:30:00Z'); // Monday, 03:30 Pacific
  const WEEKLY_JOB = {
    ...SCRIPT_JOB,
    id: 'job-weekly',
    interval: 'weekly',
    intervalMs: 7 * 24 * 3600000,
    scheduledTime: '03:00',
    lastRun: new Date(NOW).toISOString()
  };

  afterEach(() => vi.useRealTimers());

  const renderAt = (job) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    renderCard(job);
  };

  it('shows the server nextRunAt for a late weekly run, not a client recomputation', () => {
    // Following Monday 03:00 Pacific (PST) is 6d 23h 30m away. A browser-side
    // recomputation from lastRun + intervalMs would not land on this instant.
    renderAt({ ...WEEKLY_JOB, nextRunAt: '2026-11-09T11:00:00.000Z' });
    expect(screen.getByText('Next: in 6d')).toBeTruthy();
    expect(screen.queryByText('Due')).toBeNull();
  });

  it('badges an interval job Due once the server nextRunAt has passed', () => {
    renderAt({ ...WEEKLY_JOB, nextRunAt: new Date(NOW - 60_000).toISOString() });
    expect(screen.getByText('Due')).toBeTruthy();
    expect(screen.getByText('Next: Now')).toBeTruthy();
  });

  it('does not badge Due before the scheduled slot even if a full interval has elapsed', () => {
    renderAt({ ...WEEKLY_JOB, lastRun: new Date(NOW - 7 * 24 * 3600000).toISOString(), nextRunAt: new Date(NOW + 3600000).toISOString() });
    expect(screen.queryByText('Due')).toBeNull();
    expect(screen.getByText('Next: in 1h')).toBeTruthy();
  });

  it('a never-run clock job shows its future server slot and no Due badge', () => {
    renderAt({ ...WEEKLY_JOB, lastRun: null, nextRunAt: new Date(NOW + 5 * 3600000).toISOString() });
    expect(screen.getByText('Next: in 5h')).toBeTruthy();
    expect(screen.queryByText('Due')).toBeNull();
  });

  it('a never-run job with no projection falls back to Immediately / at HH:MM and badges Due', () => {
    renderAt({ ...WEEKLY_JOB, lastRun: null, scheduledTime: null, nextRunAt: null });
    expect(screen.getByText('Next: Immediately')).toBeTruthy();
    expect(screen.getByText('Due')).toBeTruthy();
    cleanup();
    renderAt({ ...WEEKLY_JOB, lastRun: null });
    expect(screen.getByText('Next: at 03:00')).toBeTruthy();
  });
});

describe('JobCard schedule anchor (#15395)', () => {
  const weekly = { ...SCRIPT_JOB, id: 'job-weekly', interval: 'weekly', intervalMs: 7 * 24 * 3600000, scheduledTime: '03:00', scheduleAnchor: 1 };

  afterEach(() => {
    cleanup();
    vi.mocked(updateCosJob).mockReset();
  });

  it('edits the weekday a weekly job stays on and saves it', async () => {
    vi.mocked(updateCosJob).mockResolvedValue({ success: true });
    renderCard(weekly);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    const weekday = screen.getByRole('combobox', { name: 'Run on weekday' });
    expect(weekday.value).toBe('1');
    fireEvent.change(weekday, { target: { value: '4' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save/ })); });
    expect(updateCosJob.mock.calls[0][1]).toMatchObject({ interval: 'weekly', scheduleAnchor: 4 });
  });

  it('keeps the picked weekday when weekly becomes biweekly, and re-defaults it when it becomes monthly', async () => {
    vi.mocked(updateCosJob).mockResolvedValue({ success: true });
    renderCard(weekly);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Interval' }), { target: { value: 'biweekly' } });
    expect(screen.getByRole('combobox', { name: 'Run on weekday' }).value).toBe('1');
    fireEvent.change(screen.getByRole('combobox', { name: 'Interval' }), { target: { value: 'monthly' } });
    expect(screen.getByRole('combobox', { name: 'Run on day of month' }).value).toBe('');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save/ })); });
    expect(updateCosJob.mock.calls[0][1]).toMatchObject({ interval: 'monthly', scheduleAnchor: null });
  });

  it('offers a day of month for monthly jobs and nothing for daily ones', () => {
    renderCard({ ...weekly, interval: 'monthly', intervalMs: 30 * 24 * 3600000, scheduleAnchor: 15 });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('combobox', { name: 'Run on day of month' }).value).toBe('15');
    fireEvent.change(screen.getByRole('combobox', { name: 'Interval' }), { target: { value: 'daily' } });
    expect(screen.queryByRole('combobox', { name: /Run on/ })).toBeNull();
  });
});

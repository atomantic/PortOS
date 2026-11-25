import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = {
  updateCosJob: vi.fn(),
  updateCosTaskInterval: vi.fn(),
};
vi.mock('../../../../services/apiAgents.js', () => ({
  updateCosJob: api.updateCosJob,
  updateCosTaskInterval: api.updateCosTaskInterval,
}));

const ScheduleEditor = (await import('./ScheduleEditor')).default;

const taskNode = (schedule = {}) => ({
  id: 'task:review',
  kind: 'task',
  label: 'Review',
  enabled: true,
  runAfter: [],
  schedule: {
    type: 'cron',
    cronExpression: '0 9 * * *',
    perpetual: false,
    recheckCron: null,
    ...schedule,
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  api.updateCosTaskInterval.mockResolvedValue({ success: true });
  api.updateCosJob.mockResolvedValue({ success: true });
});
afterEach(cleanup);

const jobNode = (schedule = {}, extra = {}) => ({
  id: 'job:digest',
  kind: 'job',
  label: 'Digest',
  enabled: true,
  schedule: { type: 'daily', scheduledTime: '09:00', ...schedule },
  ...extra,
});

function renderEditor(node = taskNode(), allNodes = [node]) {
  const onSaved = vi.fn();
  render(
    <ScheduleEditor
      node={node}
      allNodes={allNodes}
      timezone="UTC"
      onClose={vi.fn()}
      onSaved={onSaved}
    />
  );
  return onSaved;
}

describe('ScheduleEditor task schedule', () => {
  it('offers the two cadence variants and saves perpetual as one field', async () => {
    const onSaved = renderEditor();
    const cadence = screen.getByLabelText('Interval Type');

    expect([...cadence.options].map(option => option.textContent)).toEqual(['On Demand (manual trigger only)', 'Scheduled (cron)']);

    await act(async () => fireEvent.click(screen.getByRole('switch', { name: 'Enable perpetual drain' })));

    expect(api.updateCosTaskInterval).toHaveBeenCalledTimes(1);
    expect(api.updateCosTaskInterval).toHaveBeenCalledWith('review', { perpetual: true }, { silent: true });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('shows a saved change at once, before the graph refetch lands', async () => {
    api.updateCosTaskInterval.mockResolvedValue({ success: true, interval: { perpetual: true } });
    renderEditor();

    await act(async () => fireEvent.click(screen.getByRole('switch', { name: 'Enable perpetual drain' })));

    expect(screen.getByRole('switch', { name: 'Disable perpetual drain' })).toBeInTheDocument();
  });

  it('clears a saved recheck schedule back to the default cadence', async () => {
    renderEditor(taskNode({ type: 'on-demand', cronExpression: null, perpetual: true, autoStart: true, recheckCron: '0 11 * * *' }));

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Use the default daily recheck' })));

    expect(api.updateCosTaskInterval).toHaveBeenCalledWith('review', { recheckCron: null }, { silent: true });
  });

  it('clears the cron expression only when switching to on demand', async () => {
    renderEditor(taskNode({ perpetual: true, recheckCron: '0 11 * * *' }));

    await act(async () => fireEvent.change(screen.getByLabelText('Interval Type'), { target: { value: 'on-demand' } }));

    expect(api.updateCosTaskInterval).toHaveBeenCalledWith('review', {
      type: 'on-demand',
      cronExpression: null,
      autoStart: false,
    }, { silent: true });
  });

  it('refuses an out-of-range cron expression with the drawer message', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: /Edit schedule/ }));

    fireEvent.change(screen.getByLabelText('Cron expression'), { target: { value: '99 7 * * *' } });

    expect(screen.getByRole('button', { name: 'Save schedule' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Invalid minute field');
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    expect(api.updateCosTaskInterval).not.toHaveBeenCalled();
  });

  it('saves a valid cron expression with the type', async () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: /Edit schedule/ }));

    fireEvent.change(screen.getByLabelText('Cron expression'), { target: { value: '15 8 * * *' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save schedule' })));

    expect(api.updateCosTaskInterval).toHaveBeenCalledWith('review', { type: 'cron', cronExpression: '15 8 * * *' }, { silent: true });
  });

  it('sends runAfter: null when the last dependency is removed', async () => {
    const node = { ...taskNode(), runAfter: ['lint'] };
    renderEditor(node, [node, { id: 'task:lint', kind: 'task', label: 'Lint' }]);

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Remove lint' })));

    expect(api.updateCosTaskInterval).toHaveBeenCalledWith('review', { runAfter: null }, { silent: true });
  });

  it('pauses through the same Global Pause control as the drawer', async () => {
    renderEditor();

    await act(async () => fireEvent.click(screen.getByRole('switch', { name: 'Pause all runs' })));

    expect(api.updateCosTaskInterval).toHaveBeenCalledWith('review', { enabled: false }, { silent: true });
  });
});

describe('ScheduleEditor system job schedule', () => {
  it('shows On Demand for an on-demand job and hides interval-only controls', () => {
    renderEditor(jobNode({ type: 'on-demand', scheduledTime: null }));

    const interval = screen.getByLabelText('Interval');
    expect(interval.value).toBe('on-demand');
    expect(interval.options[interval.selectedIndex].textContent).toBe('On Demand');
    expect(screen.queryByRole('checkbox', { name: 'Weekdays only' })).toBeNull();
  });

  it('round-trips weekdaysOnly through updateCosJob', async () => {
    const onSaved = renderEditor(jobNode());

    fireEvent.click(screen.getByRole('checkbox', { name: 'Weekdays only' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save schedule' })));

    expect(api.updateCosJob).toHaveBeenCalledWith('digest', expect.objectContaining({
      enabled: true,
      weekdaysOnly: true,
      interval: 'daily',
      scheduledTime: '09:00',
      cronExpression: null,
      cronSchedule: null,
    }), { silent: true });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('seeds weekdaysOnly from the saved job', async () => {
    renderEditor(jobNode({ weekdaysOnly: true }));

    expect(screen.getByRole('checkbox', { name: 'Weekdays only' })).toBeChecked();
  });
});

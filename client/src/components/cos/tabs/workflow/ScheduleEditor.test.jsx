import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = {
  updateCosJob: vi.fn(),
  updateCosTaskInterval: vi.fn(),
};
vi.mock('../../../../services/api', () => api);

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

function renderEditor(node = taskNode()) {
  const onSaved = vi.fn();
  render(
    <ScheduleEditor
      node={node}
      allNodes={[node]}
      timezone="UTC"
      onClose={vi.fn()}
      onSaved={onSaved}
    />
  );
  return onSaved;
}

describe('ScheduleEditor task cadence', () => {
  it('offers the two current cadence variants and saves perpetual independently of cron', async () => {
    const onSaved = renderEditor();
    const cadence = screen.getByLabelText('Scheduling behavior');

    expect([...cadence.options].map(option => option.textContent)).toEqual(['On Demand', 'Scheduled']);

    fireEvent.click(screen.getByRole('checkbox', { name: /Perpetual/ }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save schedule' })));

    expect(api.updateCosTaskInterval).toHaveBeenCalledWith('review', {
      enabled: true,
      type: 'cron',
      cronExpression: '0 9 * * *',
      perpetual: true,
      autoStart: false,
      recheckCron: null,
      runAfter: [],
    }, { silent: true });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('clears the cron expression only when switching to on demand', async () => {
    renderEditor(taskNode({ perpetual: true, recheckCron: '0 11 * * *' }));

    fireEvent.change(screen.getByLabelText('Scheduling behavior'), { target: { value: 'on-demand' } });
    expect(screen.getByRole('option', { name: 'On Demand' }).selected).toBe(true);
    expect(screen.getByText(/No timer starts or resumes it/)).toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save schedule' })));

    expect(api.updateCosTaskInterval).toHaveBeenCalledWith('review', expect.objectContaining({
      type: 'on-demand',
      cronExpression: null,
      perpetual: true,
      autoStart: false,
      recheckCron: '0 11 * * *',
    }), { silent: true });
  });
});

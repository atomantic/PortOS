import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { MAINTENANCE_TASK_ORDER } from '../../../../lib/quotaBurnTasks';
import MaintenanceRunForm from './MaintenanceRunForm';

const api = vi.hoisted(() => ({ getQuotaBurn: vi.fn(), saveQuotaBurn: vi.fn(), runQuotaBurn: vi.fn() }));
vi.mock('../../../../services/api', () => api);
const tasks = Object.fromEntries([...MAINTENANCE_TASK_ORDER, 'claim-issue'].map(taskType => [taskType, {
  enabled: true, perpetual: taskType === 'claim-issue', appOverrides: { example: { enabled: true } },
}]));
const props = {
  schedule: { tasks }, apps: [{ id: 'example', name: 'Example App' }],
  providers: [{ id: 'claude', name: 'Claude', type: 'cli', command: 'claude', enabled: true, models: ['sonnet'] }],
  providersLoaded: true, daemonRunning: true,
};
const show = (overrides = {}) => render(<MemoryRouter><MaintenanceRunForm {...props} {...overrides} /></MemoryRouter>);
const select = async user => {
  await user.selectOptions(screen.getByLabelText('App'), 'example');
  await user.selectOptions(screen.getByRole('combobox', { name: 'Provider' }), 'claude');
  await user.selectOptions(screen.getByRole('combobox', { name: 'Model' }), 'sonnet');
  await user.selectOptions(screen.getByRole('combobox', { name: /effort/i }), 'high');
  await user.click(screen.getByRole('checkbox'));
};
beforeEach(() => {
  vi.clearAllMocks();
  api.getQuotaBurn.mockResolvedValue({ config: { families: {} } });
  api.saveQuotaBurn.mockResolvedValue({ config: {} });
  api.runQuotaBurn.mockResolvedValue({ result: { dispatched: true } });
});
describe('maintenance launch', () => {
  it('saves ordered steps with app and pins before dispatch and gates duplicate launches', async () => {
    const user = userEvent.setup();
    let finishSave;
    api.saveQuotaBurn.mockReturnValue(new Promise(resolve => { finishSave = resolve; }));
    show();
    expect(api.saveQuotaBurn).not.toHaveBeenCalled();
    await select(user);
    await user.click(screen.getByRole('button', { name: 'Run now' }));
    expect(api.runQuotaBurn).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled();
    const patch = api.saveQuotaBurn.mock.calls[0][0];
    expect(patch.enabled).toBe(true);
    const family = patch.families.claude;
    expect(family.sequence).toBe(true);
    expect(family.jobs.map(job => job.taskRef.taskType)).toEqual(MAINTENANCE_TASK_ORDER.flatMap((type, index) => index ? ['claim-issue', type] : [type]));
    for (const job of family.jobs) {
      expect(job.taskRef.appId).toBe('example');
      expect(job.overrides).toMatchObject({ providerId: 'claude', model: 'sonnet', effort: 'high' });
      expect(job.runOnce).toBe(true);
    }
    finishSave({ config: patch });
    await waitFor(() => expect(api.runQuotaBurn).toHaveBeenCalledWith({ familyId: 'claude', force: true }, { silent: true }));
    expect(await screen.findByText(/Maintenance started/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run now' })).toBeDisabled();
  });
  it('does not dispatch after a failed save and reports a saved but blocked run honestly', async () => {
    const user = userEvent.setup();
    api.saveQuotaBurn.mockRejectedValueOnce(new Error('save unavailable'));
    show();
    await select(user);
    await user.click(screen.getByRole('button', { name: 'Run now' }));
    expect(await screen.findByText(/Could not save maintenance sequence: save unavailable/)).toBeInTheDocument();
    expect(api.runQuotaBurn).not.toHaveBeenCalled();
    api.runQuotaBurn.mockResolvedValueOnce({ result: { dispatched: false, reason: 'provider unavailable' } });
    await user.click(screen.getByRole('button', { name: 'Run now' }));
    expect(await screen.findByText(/Sequence saved; waiting: provider unavailable/)).toBeInTheDocument();
  });
  it('preserves existing family plans and refuses to save when the plan cannot be read', async () => {
    const user = userEvent.setup();
    show();
    await select(user);
    api.getQuotaBurn.mockResolvedValueOnce({ config: { families: { claude: { jobs: [{ id: 'existing' }] } } } });
    await user.click(screen.getByRole('button', { name: 'Run now' }));
    expect(await screen.findByText(/This family already has a plan/)).toBeInTheDocument();
    expect(api.saveQuotaBurn).not.toHaveBeenCalled();
    api.getQuotaBurn.mockRejectedValueOnce(new Error('offline'));
    await user.click(screen.getByRole('button', { name: 'Run now' }));
    expect(await screen.findByText(/Could not check existing plan: offline/)).toBeInTheDocument();
    expect(api.saveQuotaBurn).not.toHaveBeenCalled();
    expect(api.runQuotaBurn).not.toHaveBeenCalled();
  });
  it('links to the saved plan after dispatch transport failure', async () => {
    const user = userEvent.setup();
    show();
    await select(user);
    api.runQuotaBurn.mockRejectedValueOnce(new Error('runner offline'));
    await user.click(screen.getByRole('button', { name: 'Run now' }));
    expect(await screen.findByText(/Sequence saved, but could not start: runner offline/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Manage sequence/ })).toHaveAttribute('href', '/devtools/quota-burn/claude');
  });
  it('blocks missing task eligibility and a stopped daemon', async () => {
    const user = userEvent.setup();
    show({ schedule: { tasks: {} }, daemonRunning: false });
    await select(user);
    expect(screen.getByRole('button', { name: 'Run now' })).toBeDisabled();
    expect(screen.getByText(/Enable every maintenance task/)).toBeInTheDocument();
    expect(screen.getByText(/start the CoS daemon/)).toBeInTheDocument();
    expect(api.saveQuotaBurn).not.toHaveBeenCalled();
  });
});

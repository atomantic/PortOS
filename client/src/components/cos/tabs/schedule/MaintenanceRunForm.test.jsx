import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { MAINTENANCE_TASK_ORDER } from '../../../../lib/quotaBurnTasks';
import { MAINTENANCE_SEQUENCE_TYPES } from '../../../../../../server/lib/maintenanceSequence';
import MaintenanceRunForm from './MaintenanceRunForm';

const socket = vi.hoisted(() => ({ on: vi.fn(), off: vi.fn(), emit: vi.fn() }));
vi.mock('../../../../services/socket', () => ({ default: socket }));
const api = vi.hoisted(() => ({
  getMaintenanceRuns: vi.fn(), startMaintenanceRun: vi.fn(), stopMaintenanceRun: vi.fn(), resumeMaintenanceRun: vi.fn(),
  updateCosTaskInterval: vi.fn(), updateAppTaskTypeOverride: vi.fn(),
}));
vi.mock('../../../../services/api', () => api);
const tasks = Object.fromEntries([...MAINTENANCE_TASK_ORDER, 'claim-issue'].map(taskType => [taskType, {
  enabled: true, perpetual: taskType === 'claim-issue', appOverrides: { example: { enabled: true } },
}]));
const props = {
  schedule: { tasks }, apps: [{ id: 'example', name: 'Example App' }],
  providers: [{ id: 'claude', name: 'Claude', type: 'cli', command: 'claude', enabled: true, models: ['sonnet'] }],
  providersLoaded: true, daemonRunning: true,
};
const steps = MAINTENANCE_SEQUENCE_TYPES.map((taskType, index) => ({ id: `maint-1-${index}`, taskRef: { taskType } }));
const runRecord = (overrides = {}) => ({
  id: 'maint-1', appId: 'example', providerId: 'claude', model: 'sonnet', status: 'running', steps,
  completed: { 'maint-1-0': 'done' }, active: { stepId: 'maint-1-1', taskType: 'claim-issue' }, reason: null, ...overrides,
});
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
  api.updateCosTaskInterval.mockResolvedValue({ success: true });
  api.updateAppTaskTypeOverride.mockResolvedValue({ success: true });
  api.getMaintenanceRuns.mockResolvedValue({ runs: [] });
  api.startMaintenanceRun.mockResolvedValue({ run: runRecord({ completed: {}, active: { stepId: 'maint-1-0', taskType: 'better-structural-drift' } }), result: { dispatched: true, taskType: 'better-structural-drift' } });
});
describe('maintenance launch', () => {
  it('starts a standalone run with the app and pins, and shows its progress', async () => {
    const user = userEvent.setup();
    let finishStart;
    api.startMaintenanceRun.mockReturnValue(new Promise(resolve => { finishStart = resolve; }));
    show();
    await select(user);
    await user.click(screen.getByRole('button', { name: 'Run now' }));
    expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled();
    expect(api.startMaintenanceRun).toHaveBeenCalledWith({ appId: 'example', providerId: 'claude', model: 'sonnet', effort: 'high', mode: 'file-issues' }, { silent: true });
    finishStart({ run: runRecord(), result: { dispatched: true, taskType: 'better-structural-drift' } });
    expect(await screen.findByText(/Maintenance started with better-structural-drift/)).toBeInTheDocument();
    const row = screen.getByRole('list', { name: 'Maintenance runs' });
    expect(row).toHaveTextContent('Example App');
    expect(row).toHaveTextContent('running · 1/13 steps · claim-issue');
    expect(screen.getByRole('button', { name: 'Run now' })).toBeDisabled();
    expect(screen.getByRole('link', { name: /Quota Burn/ })).toHaveAttribute('href', '/devtools/quota-burn');
  });
  it('reports a saved-but-holding run and a failed start honestly', async () => {
    const user = userEvent.setup();
    api.startMaintenanceRun.mockResolvedValueOnce({ run: runRecord({ completed: {}, active: null, reason: 'provider unavailable' }), result: { dispatched: false, reason: 'provider unavailable' } });
    show();
    await select(user);
    await user.click(screen.getByRole('button', { name: 'Run now' }));
    expect(await screen.findByText(/holding: provider unavailable/)).toBeInTheDocument();
    api.startMaintenanceRun.mockRejectedValueOnce(new Error('a maintenance run is already in progress'));
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Run now' }));
    expect(await screen.findByText(/Could not start maintenance: a maintenance run is already in progress/)).toBeInTheDocument();
  });
  it('stops and resumes an existing run from the list', async () => {
    const user = userEvent.setup();
    api.getMaintenanceRuns.mockResolvedValue({ runs: [runRecord()] });
    api.stopMaintenanceRun.mockResolvedValue({ run: runRecord({ status: 'stopped', reason: 'stopped by the user' }) });
    api.resumeMaintenanceRun.mockResolvedValue({ run: runRecord(), result: { dispatched: true, taskType: 'claim-issue' } });
    show();
    await user.click(await screen.findByRole('button', { name: 'Stop' }));
    expect(await screen.findByText(/stopped · 1\/13 steps/)).toBeInTheDocument();
    expect(api.stopMaintenanceRun).toHaveBeenCalledWith('maint-1', { silent: true });
    await user.click(screen.getByRole('button', { name: 'Resume' }));
    expect(await screen.findByText(/running · 1\/13 steps/)).toBeInTheDocument();
    expect(screen.getByText(/Maintenance started with claim-issue/)).toBeInTheDocument();
  });
  it('blocks missing task eligibility and a stopped daemon', async () => {
    const user = userEvent.setup();
    show({ schedule: { tasks: {} }, daemonRunning: false, onRefresh: vi.fn() });
    await select(user);
    expect(screen.getByRole('button', { name: 'Run now' })).toBeDisabled();
    expect(screen.getByText(/Run now needs these saved task settings/)).toBeInTheDocument();
    expect(screen.getByText(/start the CoS daemon/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enable required tasks' })).not.toBeInTheDocument();
    expect(api.startMaintenanceRun).not.toHaveBeenCalled();
  });
});

// Regression: a valid provider/model selection must have a path out of the
// disabled launch state, and only persisted prerequisites may unlock launch.
it('enables only missing prerequisites and waits for refreshed saved settings before launch', async () => {
  const user = userEvent.setup();
  const incomplete = { ...tasks,
    simplify: { ...tasks.simplify, enabled: false, appOverrides: {} },
    'claim-issue': { ...tasks['claim-issue'], perpetual: false },
  };
  let finishRefresh;
  const refreshed = new Promise(resolve => { finishRefresh = resolve; });
  function Harness() {
    const [schedule, setSchedule] = useState({ tasks: incomplete });
    return <MaintenanceRunForm {...props} schedule={schedule} onRefresh={async () => {
      await refreshed;
      setSchedule({ tasks });
      return { tasks };
    }} />;
  }
  render(<MemoryRouter><Harness /></MemoryRouter>);
  await select(user);
  expect(screen.getByRole('button', { name: 'Run now' })).toBeDisabled();
  expect(screen.getByRole('link', { name: 'simplify' })).toHaveAttribute('href', '/cos/schedule?task=simplify');
  expect(screen.getByText(/disabled globally; disabled for this app/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Enable required tasks' }));
  await waitFor(() => expect(api.updateCosTaskInterval).toHaveBeenCalledTimes(2));
  expect(api.updateCosTaskInterval).toHaveBeenCalledWith('simplify', { enabled: true }, { silent: true });
  expect(api.updateCosTaskInterval).toHaveBeenCalledWith('claim-issue', { perpetual: true }, { silent: true });
  expect(api.updateAppTaskTypeOverride).toHaveBeenCalledExactlyOnceWith('example', 'simplify', { enabled: true }, { silent: true });
  expect(screen.getByRole('button', { name: 'Run now' })).toBeDisabled();
  expect(screen.getByRole('combobox', { name: 'App' })).toBeDisabled();
  expect(api.startMaintenanceRun).not.toHaveBeenCalled();
  finishRefresh();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Run now' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Run now' }));
  expect(await screen.findByText(/Maintenance started/)).toBeInTheDocument();
});

it('refreshes partial setup after failure without starting work', async () => {
  const user = userEvent.setup();
  const onRefresh = vi.fn().mockRejectedValue(new Error('refresh unavailable'));
  api.updateAppTaskTypeOverride.mockRejectedValueOnce(new Error('save unavailable'));
  show({ schedule: { tasks: { ...tasks, simplify: { ...tasks.simplify, enabled: false, appOverrides: {} } } }, onRefresh });
  await select(user);
  await user.click(screen.getByRole('button', { name: 'Enable required tasks' }));
  expect(await screen.findByText(/Setup incomplete: save unavailable/)).toBeInTheDocument();
  expect(onRefresh).toHaveBeenCalledOnce();
  expect(screen.getByText(/Refreshing the schedule also failed/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Run now' })).toBeDisabled();
  expect(api.startMaintenanceRun).not.toHaveBeenCalled();
});

it('streams agent activity and completed steps, and removes listeners on unmount', async () => {
  api.getMaintenanceRuns.mockResolvedValue({ runs: [runRecord({ completed: {} })] });
  const view = show();
  await screen.findByRole('list', { name: 'Maintenance runs' });
  const update = socket.on.mock.calls.find(([name]) => name === 'cos:maintenance:updated')[1];
  act(() => update(runRecord({ completed: {}, active: { taskType: 'better-structural-drift', status: 'running', agentId: 'agent-example' } })));
  expect(screen.getByRole('link', { name: 'Open agent in new tab' })).toHaveAttribute('href', '/cos/agents/agent-example');
  expect(screen.getByRole('link', { name: 'Open agent in new tab' })).toHaveAttribute('target', '_blank');
  act(() => update(runRecord()));
  expect(screen.getByRole('progressbar')).toHaveAttribute('value', '1');
  view.unmount();
  expect(socket.off).toHaveBeenCalledWith('cos:maintenance:updated', update);
});

it('keeps a newer live update when an older initial fetch resolves late, and refreshes on reconnect', async () => {
  let resolveRead;
  api.getMaintenanceRuns.mockReturnValueOnce(new Promise(resolve => { resolveRead = resolve; }));
  show();
  const update = socket.on.mock.calls.find(([name]) => name === 'cos:maintenance:updated')[1];
  act(() => update(runRecord()));
  await act(async () => resolveRead({ runs: [runRecord({ completed: {} })] }));
  expect(screen.getByRole('progressbar')).toHaveAttribute('value', '1');
  api.getMaintenanceRuns.mockResolvedValue({ runs: [runRecord({ status: 'completed', active: null })] });
  await act(async () => socket.on.mock.calls.find(([name]) => name === 'connect')[1]());
  expect(screen.getByText(/completed · 1\/13 steps/)).toBeInTheDocument();
});

it('launches fix mode only after renewed consent', async () => {
  const user = userEvent.setup();
  show();
  await select(user);
  await user.selectOptions(screen.getByLabelText('Audit mode'), 'fix');
  expect(screen.getByRole('button', { name: 'Run now' })).toBeDisabled();
  expect(screen.getByText(/one final claim-issue drain/)).toBeInTheDocument();
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: 'Run now' }));
  expect(api.startMaintenanceRun).toHaveBeenCalledWith(expect.objectContaining({ mode: 'fix' }), { silent: true });
});

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
const socket = vi.hoisted(() => {
  const handlers = new Map();
  return {
    handlers,
    emit: vi.fn(),
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(handler);
    },
    off: (event, handler) => handlers.get(event)?.delete(handler),
    fire: (event, data) => { for (const handler of handlers.get(event) || []) handler(data); },
  };
});
vi.mock('../../services/socket', () => ({ default: socket }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AppQualityRunner from './AppQualityRunner';
import AppQuality from './AppQuality';
import { awaitEnabled, findEnabledByLabelText, findEnabledByRole } from '../../test/enabledBarrier.js';
vi.mock('./AppQualityHistory', () => ({ default: () => null }));
import { getMaintenanceRuns, startMaintenanceRun, stopMaintenanceRun } from '../../services/apiAgents';
import useProviderModels from '../../hooks/useProviderModels';
vi.mock('../../services/apiAgents', () => ({ getMaintenanceRuns: vi.fn(), startMaintenanceRun: vi.fn(), stopMaintenanceRun: vi.fn() }));
vi.mock('../../hooks/useProviderModels', () => ({ default: vi.fn(() => ({ providers: [], selectedProviderId: 'codex', selectedModel: 'gpt-5', availableModels: [], loading: false })) }));
vi.mock('../ProviderModelSelector', () => ({ default: ({ onEffortChange }) => <button onClick={() => onEffortChange('high')}>Use high effort</button> }));
const app = { id: 'app-1', quality: { categories: [
  { id: 'security', label: 'Security', score: null },
  { id: 'performance', label: 'Performance', score: 80, coverage: 'broad', confidence: 'high' },
  { id: 'ux', label: 'UX', score: 70, coverage: 'broad', confidence: 'high', stale: true },
] } };
beforeEach(() => { vi.clearAllMocks(); getMaintenanceRuns.mockResolvedValue({ runs: [] }); });
it('launches missing checks with visible mode and effort, then exposes held runner status', async () => {
  startMaintenanceRun.mockResolvedValue({ run: { id: 'run-1', status: 'running', reason: 'Enable security in Schedule', steps: [] } });
  render(<MemoryRouter><AppQualityRunner app={app} /></MemoryRouter>);
  const button = screen.getByRole('button', { name: 'Run 2 checks now' });
  await awaitEnabled(button);
  fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'fix' } });
  fireEvent.click(screen.getByText('Use high effort'));
  fireEvent.click(button);
  await screen.findByRole('link', { name: 'Open runner settings' });
  expect(startMaintenanceRun).toHaveBeenCalledWith({ appId: 'app-1', providerId: 'codex', model: 'gpt-5', effort: 'high', mode: 'fix', claimBetweenAudits: false, taskTypes: ['security', 'ux'] }, { silent: true });
  expect(button).toBeEnabled();
});

it('runs only applicable scored categories below the overall composite as a batch', async () => {
  startMaintenanceRun.mockResolvedValue({ run: { id: 'run-below-score', status: 'running', steps: [] } });
  const categories = [
    { id: 'security', label: 'Security', score: 60, coverage: 'broad', confidence: 'high' },
    { id: 'performance', label: 'Performance', score: 74, coverage: 'partial' },
    { id: 'ux', label: 'UX', score: 75, coverage: 'broad', confidence: 'high' },
    { id: 'privacy', label: 'Privacy', score: 90, coverage: 'broad', confidence: 'high' },
    { id: 'unavailable', label: 'Unavailable', score: null, coverage: 'unavailable' },
    { id: 'inapplicable', label: 'Inapplicable', score: 20, coverage: 'broad', applicable: false },
    { id: 'not-applicable', label: 'Not applicable', score: 20, coverage: 'not-applicable' },
  ];
  render(<MemoryRouter initialEntries={['/apps/example/quality?qualityCheck=below-composite']}>
    <AppQualityRunner app={{ ...app, quality: { score: 75, categories } }} />
  </MemoryRouter>);

  const button = await findEnabledByRole('button', { name: 'Run 2 checks now' });
  fireEvent.click(button);
  await waitFor(() => expect(startMaintenanceRun).toHaveBeenCalledWith(expect.objectContaining({
    taskTypes: ['security', 'performance'],
  }), { silent: true }));
  expect(startMaintenanceRun.mock.lastCall[0]).not.toHaveProperty('explicitCheck');
});

it('explains when the composite score is unavailable for below-score selection', async () => {
  render(<MemoryRouter initialEntries={['/apps/example/quality?qualityCheck=below-composite']}>
    <AppQualityRunner app={{ ...app, quality: { score: null, categories: app.quality.categories } }} />
  </MemoryRouter>);

  await waitFor(() => expect(screen.queryByText('Loading runner status…')).not.toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'Run 0 checks now' })).toBeDisabled();
  fireEvent.click(screen.getByText('Selected checks (0)'));
  expect(screen.getByText(/No overall composite score is available/)).toBeInTheDocument();
});

it('allows one category and recovers from launch failure without reporting a run', async () => {
  startMaintenanceRun.mockRejectedValue(new Error('Provider unavailable'));
  render(<MemoryRouter><AppQualityRunner app={app} /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText('Checks'), { target: { value: 'performance' } });
  const button = screen.getByRole('button', { name: 'Run now' });
  await awaitEnabled(button);
  fireEvent.click(button);
  expect(await screen.findByRole('alert')).toHaveTextContent('Provider unavailable');
  expect(button).toBeEnabled();
  expect(startMaintenanceRun.mock.calls[0][0]).toMatchObject({ mode: 'file-issues', taskTypes: ['performance'] });
});

it('preserves run overrides when reopening the drawer for one category', async () => {
  startMaintenanceRun.mockResolvedValue({ run: { id: 'run-2', status: 'running', steps: [] } });
  render(<MemoryRouter><AppQuality app={app} detail /></MemoryRouter>);
  fireEvent.click(screen.getByRole('link', { name: 'Run checks' }));
  await findEnabledByRole('button', { name: 'Run 2 checks now' });
  fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'fix' } });
  fireEvent.click(screen.getByText('Use high effort'));
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  fireEvent.click(screen.getByRole('link', { name: 'Run Security check' }));
  expect(screen.getByLabelText('Checks')).toHaveValue('security');
  expect(screen.getByLabelText('Mode')).toHaveValue('fix');
  fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
  await waitFor(() => expect(startMaintenanceRun).toHaveBeenCalledWith(
    { appId: 'app-1', providerId: 'codex', model: 'gpt-5', effort: 'high', mode: 'fix', claimBetweenAudits: false, taskTypes: ['security'], explicitCheck: true },
    { silent: true }
  ));
});

it('launches alongside pending runners and stops each run independently', async () => {
  getMaintenanceRuns.mockResolvedValue({ runs: [{ id: 'pending', appId: app.id, status: 'running', steps: [], reason: 'Waiting for capacity' }] });
  startMaintenanceRun.mockResolvedValue({ run: { id: 'new', appId: app.id, status: 'running', steps: [] } });
  stopMaintenanceRun.mockResolvedValue({ run: { id: 'pending', appId: app.id, status: 'stopped', steps: [] } });
  render(<MemoryRouter><AppQualityRunner app={app} /></MemoryRouter>);
  await screen.findByText(/Waiting for capacity/, { selector: 'p.break-words' });
  const button = screen.getByRole('button', { name: 'Run 2 checks now' });
  expect(button).toBeEnabled();
  fireEvent.click(button);
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'Stop remaining checks' })).toHaveLength(2));
  fireEvent.click(screen.getAllByRole('button', { name: 'Stop remaining checks' })[1]);
  await waitFor(() => expect(stopMaintenanceRun).toHaveBeenCalledWith('pending', { silent: true }));
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'Stop remaining checks' })).toHaveLength(1));
  expect(button).toBeEnabled();
});

it('excludes known unavailable and N/A assessments from suggestions while allowing explicit reruns', async () => {
  const categories = [
    { id: 'typing', label: 'Typing', score: null, coverage: 'not-applicable', stale: false },
    { id: 'console-errors', label: 'Console errors', score: null, coverage: 'unavailable', assessedAt: '2026-09-01T00:00:00Z' },
  ];
  startMaintenanceRun.mockResolvedValue({ run: { id: 'run-3', status: 'running', steps: [] } });
  const { rerender } = render(<MemoryRouter><AppQualityRunner app={{ ...app, quality: { categories } }} /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByText('Loading runner status…')).not.toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'Run 0 checks now' })).toBeDisabled();
  expect(screen.getByText(/No checks need evidence/)).toBeInTheDocument();

  // The same unavailable coverage without an assessment means it has never run.
  rerender(<MemoryRouter><AppQualityRunner app={{ ...app, quality: { categories: [...categories,
    { id: 'security', label: 'Security', score: null, coverage: 'unavailable', assessedAt: null },
  ] } }} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
  await waitFor(() => expect(startMaintenanceRun).toHaveBeenLastCalledWith(expect.objectContaining({ taskTypes: ['security'] }), { silent: true }));
  await findEnabledByLabelText('Checks');
  fireEvent.change(screen.getByLabelText('Checks'), { target: { value: 'typing' } });
  fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
  await waitFor(() => expect(startMaintenanceRun).toHaveBeenLastCalledWith(expect.objectContaining({ taskTypes: ['typing'] }), { silent: true }));
  await findEnabledByLabelText('Checks');
  fireEvent.change(screen.getByLabelText('Checks'), { target: { value: 'all' } });
  fireEvent.click(screen.getByRole('button', { name: 'Run 3 checks now' }));
  await waitFor(() => expect(startMaintenanceRun).toHaveBeenLastCalledWith(expect.objectContaining({ taskTypes: ['typing', 'console-errors', 'security'] }), { silent: true }));
});

it('re-offers a category whose not-applicable ruling has expired', async () => {
  startMaintenanceRun.mockResolvedValue({ run: { id: 'run-5', status: 'running', steps: [] } });
  const categories = [{ id: 'accessibility', label: 'Accessibility', score: null, coverage: 'not-applicable', stale: true, assessedAt: '2026-07-01T00:00:00Z' }];
  render(<MemoryRouter><AppQualityRunner app={{ ...app, quality: { categories } }} /></MemoryRouter>);
  fireEvent.click(await findEnabledByRole('button', { name: 'Run now' }));
  await waitFor(() => expect(startMaintenanceRun).toHaveBeenLastCalledWith(expect.objectContaining({ taskTypes: ['accessibility'] }), { silent: true }));
});

it('leaves audits that cannot apply to this repository out of batch runs, but runs one on request', async () => {
  const categories = [
    { id: 'security', label: 'Security', score: null, applicable: true },
    { id: 'accessibility', label: 'Accessibility', score: null, applicable: false, inapplicableReason: 'no user interface found in this repository' },
  ];
  startMaintenanceRun.mockResolvedValue({ run: { id: 'run-4', status: 'running', steps: [] } });
  render(<MemoryRouter><AppQualityRunner app={{ ...app, quality: { categories } }} /></MemoryRouter>);
  const missing = await findEnabledByRole('button', { name: 'Run now' });
  fireEvent.click(missing);
  await waitFor(() => expect(startMaintenanceRun).toHaveBeenLastCalledWith(expect.objectContaining({ taskTypes: ['security'] }), { silent: true }));
  // A batch selection is never an explicit override.
  expect(startMaintenanceRun.mock.lastCall[0]).not.toHaveProperty('explicitCheck');
  await findEnabledByLabelText('Checks');
  fireEvent.change(screen.getByLabelText('Checks'), { target: { value: 'all' } });
  expect(screen.getByRole('button', { name: 'Run now' })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Checks'), { target: { value: 'accessibility' } });
  fireEvent.click(await findEnabledByRole('button', { name: 'Run now' }));
  await waitFor(() => expect(startMaintenanceRun).toHaveBeenLastCalledWith(expect.objectContaining({ taskTypes: ['accessibility'], explicitCheck: true }), { silent: true }));
});

it('offers every enabled process provider regardless of subscription family, and hides disabled ones', async () => {
  render(<MemoryRouter><AppQualityRunner app={app} /></MemoryRouter>);
  await waitFor(() => expect(useProviderModels).toHaveBeenCalled());
  const { filter } = useProviderModels.mock.calls[0][0];
  expect(filter({ id: 'opencode-tui', enabled: true, type: 'tui' })).toBe(true);
  expect(filter({ id: 'codex', enabled: true, type: 'cli' })).toBe(true);
  expect(filter({ id: 'opencode-tui', enabled: false, type: 'tui' })).toBe(false);
});

it('refreshes matching maintenance events and recovers once per reconnect/reshow without polling', async () => {
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const view = render(<MemoryRouter><AppQualityRunner app={app} /></MemoryRouter>);
  await act(async () => {});
  expect(getMaintenanceRuns).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
  expect(getMaintenanceRuns).toHaveBeenCalledTimes(1);

  getMaintenanceRuns.mockResolvedValue({ runs: [{ id: 'run-push', appId: app.id, status: 'running', steps: [] }] });
  await act(async () => socket.fire('cos:maintenance:updated', { appId: 'another-app' }));
  expect(getMaintenanceRuns).toHaveBeenCalledTimes(1);
  await act(async () => socket.fire('cos:maintenance:updated', { appId: app.id }));
  expect(screen.getByRole('button', { name: 'Stop remaining checks' })).toBeInTheDocument();
  expect(getMaintenanceRuns).toHaveBeenCalledTimes(2);

  await act(async () => socket.fire('connect'));
  expect(getMaintenanceRuns).toHaveBeenCalledTimes(3);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    socket.fire('cos:maintenance:updated', { appId: app.id });
    socket.fire('connect');
  });
  expect(getMaintenanceRuns).toHaveBeenCalledTimes(3);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(getMaintenanceRuns).toHaveBeenCalledTimes(4);
  view.unmount();
  await act(async () => socket.fire('cos:maintenance:updated', { appId: app.id }));
  expect(getMaintenanceRuns).toHaveBeenCalledTimes(4);
  expect(socket.emit).toHaveBeenCalledWith('cos:unsubscribe');
});

it('discards a previous app read when the selected app changes', async () => {
  let resolveOld;
  getMaintenanceRuns.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  const view = render(<MemoryRouter><AppQualityRunner app={app} /></MemoryRouter>);
  await act(async () => {});
  const nextApp = { ...app, id: 'app-2' };
  getMaintenanceRuns.mockResolvedValue({ runs: [{ id: 'new-app-run', appId: nextApp.id, status: 'stopped', steps: [], reason: 'Current app result' }] });
  view.rerender(<MemoryRouter><AppQualityRunner app={nextApp} /></MemoryRouter>);
  await act(async () => {});
  await act(async () => resolveOld({ runs: [{ id: 'old-app-run', appId: app.id, status: 'running', steps: [], reason: 'Obsolete app result' }] }));
  expect(screen.getByText('Current app result', { selector: 'p.break-words' })).toBeInTheDocument();
  expect(screen.queryByText('Obsolete app result')).not.toBeInTheDocument();
});

it('keeps a start response when an older status request resolves afterwards', async () => {
  let resolveRead;
  getMaintenanceRuns.mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve; }));
  startMaintenanceRun.mockResolvedValue({ run: { id: 'started', appId: app.id, status: 'running', steps: [] } });
  render(<MemoryRouter><AppQualityRunner app={app} /></MemoryRouter>);
  await act(async () => {});
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Run 2 checks now' })));
  expect(screen.getByRole('button', { name: 'Stop remaining checks' })).toBeInTheDocument();
  await act(async () => resolveRead({ runs: [] }));
  expect(screen.getByRole('button', { name: 'Stop remaining checks' })).toBeInTheDocument();
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import AppQualityRunner from './AppQualityRunner';
import AppQuality from './AppQuality';
vi.mock('./AppQualityHistory', () => ({ default: () => null }));
import { getMaintenanceRuns, startMaintenanceRun, stopMaintenanceRun } from '../../services/apiAgents';
vi.mock('../../services/apiAgents', () => ({ getMaintenanceRuns: vi.fn(), startMaintenanceRun: vi.fn(), stopMaintenanceRun: vi.fn() }));
vi.mock('../../hooks/useProviderModels', () => ({ default: () => ({ providers: [], selectedProviderId: 'codex', selectedModel: 'gpt-5', availableModels: [], loading: false }) }));
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
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'fix' } });
  fireEvent.click(screen.getByText('Use high effort'));
  fireEvent.click(button);
  await screen.findByRole('link', { name: 'Open runner settings' });
  expect(startMaintenanceRun).toHaveBeenCalledWith({ appId: 'app-1', providerId: 'codex', model: 'gpt-5', effort: 'high', mode: 'fix', claimBetweenAudits: false, taskTypes: ['security', 'ux'] }, { silent: true });
  expect(button).toBeEnabled();
});
it('allows one category and recovers from launch failure without reporting a run', async () => {
  startMaintenanceRun.mockRejectedValue(new Error('Provider unavailable'));
  render(<MemoryRouter><AppQualityRunner app={app} /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText('Checks'), { target: { value: 'performance' } });
  const button = screen.getByRole('button', { name: 'Run now' });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  expect(await screen.findByRole('alert')).toHaveTextContent('Provider unavailable');
  expect(button).toBeEnabled();
  expect(startMaintenanceRun.mock.calls[0][0]).toMatchObject({ mode: 'file-issues', taskTypes: ['performance'] });
});

it('preserves run overrides when moving controls into a category row', async () => {
  startMaintenanceRun.mockResolvedValue({ run: { id: 'run-2', status: 'running', steps: [] } });
  render(<MemoryRouter><AppQuality app={app} detail /></MemoryRouter>);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Run 2 checks now' })).toBeEnabled());
  fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'fix' } });
  fireEvent.click(screen.getByText('Use high effort'));
  fireEvent.click(screen.getByRole('link', { name: 'Configure and run Security' }));
  expect(screen.getByLabelText('Checks')).toHaveValue('security');
  expect(screen.getByLabelText('Mode')).toHaveValue('fix');
  fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
  await waitFor(() => expect(startMaintenanceRun).toHaveBeenCalledWith(
    { appId: 'app-1', providerId: 'codex', model: 'gpt-5', effort: 'high', mode: 'fix', claimBetweenAudits: false, taskTypes: ['security'] },
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

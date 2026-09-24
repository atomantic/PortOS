import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import ComparisonResearch from './ComparisonResearch';
import { getProviders } from '../../services/apiProviders';
import { getCosSchedule, updateCosTaskInterval, triggerCosOnDemandTask } from '../../services/apiAgents';
vi.mock('../../services/apiProviders', () => ({ getProviders: vi.fn() }));
vi.mock('../../services/apiAgents', () => ({ getCosSchedule: vi.fn(), updateCosTaskInterval: vi.fn(), triggerCosOnDemandTask: vi.fn() }));
vi.mock('../ProviderModelSelector', () => ({ default: ({ onProviderChange, disabled, selectedProviderId }) => <select aria-label="Research provider" disabled={disabled} value={selectedProviderId} onChange={event => onProviderChange(event.target.value)}><option value="">Choose</option><option value="example">Example</option></select> }));
beforeEach(() => {
  vi.clearAllMocks();
  getProviders.mockResolvedValue({ providers: [{ id: 'example', name: 'Example', models: ['research-model'] }] });
  getCosSchedule.mockResolvedValue({ tasks: { 'model-comparison-refresh': { enabled: false, type: 'on-demand', providerId: '', model: '' } } });
  updateCosTaskInterval.mockImplementation(async (_type, interval) => ({ interval }));
  triggerCosOnDemandTask.mockResolvedValue({ taskType: 'model-comparison-refresh' });
});
it('runs research only after an explicit click using saved valid provider settings and reports queue errors', async () => {
  render(<MemoryRouter><ComparisonResearch /></MemoryRouter>);
  await screen.findByRole('option', { name: 'Example' });
  expect(triggerCosOnDemandTask).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Run research now' })).toBeDisabled();
  // Wait for the schedule before selecting a provider.
  await screen.findByText(/Cadence:/);
  fireEvent.change(screen.getByLabelText('Research provider'), { target: { value: 'example' } });
  fireEvent.change(await screen.findByLabelText('Research model'), { target: { value: 'research-model' } });
  expect(screen.getByRole('button', { name: 'Run research now' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Save research settings' }));
  await screen.findByText(/Research provider saved/);
  fireEvent.click(screen.getByRole('button', { name: 'Run research now' }));
  await screen.findByText(/Research queued in CoS/);
  expect(triggerCosOnDemandTask).toHaveBeenCalledWith('model-comparison-refresh', null, { silent: true });
  triggerCosOnDemandTask.mockResolvedValueOnce({ error: 'No browsing provider available' });
  fireEvent.click(screen.getByRole('button', { name: 'Run research now' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('No browsing provider available');
});

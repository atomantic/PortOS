import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import ComparisonResearch from './ComparisonResearch';
import { getProviders } from '../../services/apiProviders';
import { getCosSchedule, updateCosTaskInterval, triggerCosOnDemandTask } from '../../services/apiAgents';
vi.mock('../../services/apiProviders', () => ({ getProviders: vi.fn() }));
vi.mock('../../services/apiAgents', () => ({ getCosSchedule: vi.fn(), updateCosTaskInterval: vi.fn(), triggerCosOnDemandTask: vi.fn() }));
vi.mock('../ProviderModelSelector', () => ({
  default: ({
    onProviderChange, onModelChange, onEffortChange, onExecutionOptionsChange,
    disabled, selectedProviderId, selectedModel, availableModels, effort, executionOptions,
  }) => (
    <div>
      <select aria-label="Research provider" disabled={disabled} value={selectedProviderId} onChange={event => onProviderChange(event.target.value)}>
        <option value="">Choose</option>
        <option value="example">Example</option>
      </select>
      <select aria-label="Research model" disabled={disabled} value={selectedModel} onChange={event => onModelChange(event.target.value)}>
        <option value="">Choose model</option>
        {(availableModels || ['research-model']).map(m => {
          const val = typeof m === 'string' ? m : m.id;
          return <option key={val} value={val}>{val}</option>;
        })}
      </select>
      <select aria-label="Thinking effort" disabled={disabled} value={effort || ''} onChange={event => onEffortChange?.(event.target.value)}>
        <option value="">Default effort</option>
        <option value="high">High</option>
      </select>
      <select aria-label="Speed" disabled={disabled} value={executionOptions?.serviceTier || ''} onChange={event => onExecutionOptionsChange?.({ ...executionOptions, serviceTier: event.target.value })}>
        <option value="">Standard</option>
        <option value="fast">Fast</option>
      </select>
    </div>
  ),
}));
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
  expect(triggerCosOnDemandTask).toHaveBeenCalledWith('model-comparison-refresh', null, {
    provider: 'example',
    model: 'research-model',
    effort: undefined,
    executionOptions: undefined,
    targetModels: null,
    silent: true,
  });
  triggerCosOnDemandTask.mockResolvedValueOnce({ error: 'No browsing provider available' });
  fireEvent.click(screen.getByRole('button', { name: 'Run research now' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('No browsing provider available');
});

it('supports selecting provider, model, effort, speed and researching selected models only', async () => {
  const onScopeChange = vi.fn();
  render(
    <MemoryRouter>
      <ComparisonResearch
        scope="selected"
        selectedModels={['gpt-6-luna', 'claude-opus-5-5']}
        onScopeChange={onScopeChange}
      />
    </MemoryRouter>
  );
  await screen.findByRole('option', { name: 'Example' });
  expect(screen.getByText(/Investigating 2 models: gpt-6-luna, claude-opus-5-5/)).toBeTruthy();

  fireEvent.change(screen.getByLabelText('Research provider'), { target: { value: 'example' } });
  fireEvent.change(await screen.findByLabelText('Research model'), { target: { value: 'research-model' } });
  fireEvent.change(screen.getByLabelText('Thinking effort'), { target: { value: 'high' } });
  fireEvent.change(screen.getByLabelText('Speed'), { target: { value: 'fast' } });

  fireEvent.click(screen.getByRole('button', { name: 'Save research settings' }));
  await screen.findByText(/Research provider saved/);
  expect(updateCosTaskInterval).toHaveBeenCalledWith(
    'model-comparison-refresh',
    {
      providerId: 'example',
      model: 'research-model',
      effort: 'high',
      executionOptions: { serviceTier: 'fast' },
      enabled: true,
    },
    { silent: true }
  );

  fireEvent.click(screen.getByRole('button', { name: 'Run research now' }));
  await screen.findByText(/selected models: 2/);
  expect(triggerCosOnDemandTask).toHaveBeenCalledWith('model-comparison-refresh', null, {
    provider: 'example',
    model: 'research-model',
    effort: 'high',
    executionOptions: { serviceTier: 'fast' },
    targetModels: ['gpt-6-luna', 'claude-opus-5-5'],
    silent: true,
  });
});

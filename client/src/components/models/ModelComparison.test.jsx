import { beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import ModelComparison from './ModelComparison';
import ComparisonResearch from './ComparisonResearch';
import * as api from '../../services/apiModelComparison';
import * as agents from '../../services/apiAgents';

vi.mock('../../services/apiModelComparison', () => ({ getModelComparison: vi.fn(), importModelComparison: vi.fn(), discoverComparisonModels: vi.fn() }));
vi.mock('../../services/apiProviders', () => ({ getProviders: vi.fn().mockResolvedValue({ providers: [{ id: 'example', name: 'Example research', models: ['example-model', 'other-model'] }] }) }));
vi.mock('../../services/apiAgents', () => ({ getCosSchedule: vi.fn(), updateCosTaskInterval: vi.fn(), triggerCosOnDemandTask: vi.fn() }));
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }) => <div>{children}</div>, ScatterChart: ({ children }) => <div>{children}</div>,
  Scatter: () => null, CartesianGrid: () => null, LabelList: () => null, Tooltip: () => null, XAxis: () => null, YAxis: () => null,
}));
const source = { url: 'https://example.com/benchmark', retrievedAt: '2026-01-01T00:00:00Z', methodology: 'Example v1' };
const metric = value => ({ value, source });
const observation = { id: 'example', model: 'example-model', provider: 'Example API', effort: 'high', configuration: 'Example endpoint', billing: 'api', benchmark: 'Example v1', quality: metric(50), costPerTask: metric(0.5), inputPerMillion: metric(2), outputPerMillion: metric(10), reasoningPerMillion: null, responseSeconds: null, tokensPerSecond: null, quota: null, notes: '' };
beforeEach(() => {
  vi.clearAllMocks();
  api.getModelComparison.mockResolvedValue({ schemaVersion: 1, observations: [observation, { ...observation, id: 'missing', model: 'local-example', billing: 'local', costPerTask: null, quality: null }], inventory: [] });
  agents.getCosSchedule.mockResolvedValue({ tasks: { 'model-comparison-refresh': { enabled: true, providerId: 'example', model: 'example-model', type: 'on-demand' } } });
});
it('shows missing evidence, filters models and estimates token costs without inventing reasoning prices or local cost', async () => {
  render(<MemoryRouter><ModelComparison /></MemoryRouter>);
  await act(async () => {});
  await screen.findByText('1 plotted · 1 missing quality or cost');
  fireEvent.click(screen.getByText(/Evidence & sources/));
  fireEvent.click(screen.getByText('Show or hide providers, models & effort'));
  expect(screen.getAllByText(/E2E unknown/)).toHaveLength(2);
  expect(screen.getAllByText(/Stale/).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button', { name: 'Toggle example-model' }));
  expect(screen.getByRole('button', { name: 'Toggle example-model' })).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByLabelText('example-model')).not.toBeChecked();
  expect(screen.getByText('No comparable points for these filters. Adjust filters or refresh the research catalog.')).toBeTruthy();
  fireEvent.click(screen.getByLabelText('example-model'));
  fireEvent.change(screen.getByLabelText('Cost basis'), { target: { value: 'scenario' } });
  expect(screen.getByText('$0.0250')).toBeTruthy();
  expect(screen.getByText('$2.50')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Reasoning tokens'), { target: { value: '1000' } });
  expect(screen.queryByText('$0.0250')).toBeNull();
  expect(screen.getByText('No comparable points for these filters. Adjust filters or refresh the research catalog.')).toBeTruthy();
  expect(agents.triggerCosOnDemandTask).not.toHaveBeenCalled();
});
it('gates research on saved settings and confirms the queued task', async () => {
  let completeSave;
  agents.updateCosTaskInterval.mockImplementation(() => new Promise(resolve => { completeSave = resolve; }));
  agents.triggerCosOnDemandTask.mockResolvedValue({ success: true });
  render(<MemoryRouter><ComparisonResearch /></MemoryRouter>);
  const run = screen.getByRole('button', { name: 'Run research now' });
  await waitFor(() => expect(run.disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('Research model'), { target: { value: 'other-model' } });
  expect(run.disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Save research settings' }));
  expect(run.disabled).toBe(true);
  completeSave({ interval: { enabled: true, providerId: 'example', model: 'other-model', type: 'on-demand' } });
  await waitFor(() => expect(run.disabled).toBe(false));
  fireEvent.click(run);
  await screen.findByText(/Research queued in CoS/);
  expect(agents.triggerCosOnDemandTask).toHaveBeenCalledWith('model-comparison-refresh', null, { silent: true });
});

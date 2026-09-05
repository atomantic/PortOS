import { beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import ModelComparison from './ModelComparison';
import ComparisonResearch from './ComparisonResearch';
import * as api from '../../services/apiModelComparison';
import * as agents from '../../services/apiAgents';

vi.mock('../../services/apiModelComparison', () => ({
  getModelComparison: vi.fn(),
  importModelComparison: vi.fn(),
  discoverComparisonModels: vi.fn(),
  syncArtificialAnalysis: vi.fn(),
}));
vi.mock('../../services/apiProviders', () => ({ getProviders: vi.fn().mockResolvedValue({ providers: [{ id: 'example', name: 'Example research', models: ['example-model', 'other-model'] }] }) }));
vi.mock('../../services/apiAgents', () => ({ getCosSchedule: vi.fn(), updateCosTaskInterval: vi.fn(), triggerCosOnDemandTask: vi.fn() }));
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }) => <div>{children}</div>,
  ScatterChart: ({ children }) => <div>{children}</div>,
  Scatter: ({ name, data, line }) => (
    <div data-testid={`scatter-${name}`} data-has-line={!!line} data-points={data?.length} />
  ),
  CartesianGrid: () => null,
  LabelList: () => null,
  Tooltip: () => null,
  XAxis: ({ scale }) => <div data-testid="xaxis" data-scale={scale} />,
  YAxis: () => null,
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

it('connects reasoning effort points with line and allows toggling line style and scale', async () => {
  const multiObs = [
    { ...observation, id: 'm-low', model: 'gpt-5.6-sol', effort: 'low', quality: metric(41), costPerTask: metric(0.23) },
    { ...observation, id: 'm-med', model: 'gpt-5.6-sol', effort: 'medium', quality: metric(46), costPerTask: metric(0.37) },
    { ...observation, id: 'm-high', model: 'gpt-5.6-sol', effort: 'high', quality: metric(48), costPerTask: metric(0.61) },
    { ...observation, id: 'single', model: 'single-model', effort: 'high', quality: metric(30), costPerTask: metric(0.1) },
  ];
  api.getModelComparison.mockResolvedValue({ schemaVersion: 1, observations: multiObs, inventory: [] });

  render(<MemoryRouter><ModelComparison /></MemoryRouter>);
  await act(async () => {});

  await screen.findByText(/1 reasoning curves/);
  const solScatter = screen.getByTestId('scatter-gpt-5.6-sol');
  expect(solScatter).toHaveAttribute('data-has-line', 'true');
  expect(solScatter).toHaveAttribute('data-points', '3');

  const singleScatter = screen.getByTestId('scatter-single-model');
  expect(singleScatter).toHaveAttribute('data-has-line', 'false');

  // Test toggling lines off
  fireEvent.click(screen.getByLabelText('Connect effort lines'));
  expect(screen.getByTestId('scatter-gpt-5.6-sol')).toHaveAttribute('data-has-line', 'false');

  // Test scale toggle
  fireEvent.change(screen.getByLabelText('Cost scale'), { target: { value: 'log' } });
  expect(screen.getByTestId('xaxis')).toHaveAttribute('data-scale', 'log');

  // Test quick filter reasoning curves
  fireEvent.click(screen.getByText(/Reasoning curves \(1\)/));
  expect(screen.getByRole('button', { name: 'Toggle single-model' })).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByRole('button', { name: 'Toggle gpt-5.6-sol' })).toHaveAttribute('aria-pressed', 'true');
});

it('opens the Artificial Analysis sync modal and syncs observations', async () => {
  api.syncArtificialAnalysis.mockResolvedValue({ success: true, observations: 636, total: 636 });

  render(<MemoryRouter><ModelComparison /></MemoryRouter>);
  await act(async () => {});

  fireEvent.click(screen.getByRole('button', { name: /Sync from Artificial Analysis/i }));
  expect(screen.getByLabelText(/Artificial Analysis API Key/i)).toBeTruthy();

  fireEvent.change(screen.getByLabelText(/Artificial Analysis API Key/i), { target: { value: 'test-key-123' } });
  fireEvent.click(screen.getByRole('button', { name: 'Start Sync' }));

  await screen.findByText(/Sync successful! Updated 636 models/);
  expect(api.syncArtificialAnalysis).toHaveBeenCalledWith({ apiKey: 'test-key-123' }, { silent: true });
});

it('opens on a log cost axis and scopes the chart to the providers models', async () => {
  const scoped = [
    { ...observation, id: 'mine', model: 'claude-opus-5', effort: 'max', quality: metric(54), costPerTask: metric(4.2) },
    { ...observation, id: 'theirs', model: 'palm-2', effort: 'unspecified', quality: metric(20), costPerTask: metric(0.01) },
  ];
  api.getModelComparison.mockResolvedValue({
    schemaVersion: 1,
    observations: scoped,
    inventory: [],
    availableModels: ['claude-opus-5'],
  });

  render(<MemoryRouter><ModelComparison /></MemoryRouter>);
  await act(async () => {});

  expect(screen.getByTestId('xaxis')).toHaveAttribute('data-scale', 'log');
  expect(screen.getByRole('button', { name: 'Toggle claude-opus-5' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Toggle palm-2' })).toBeNull();

  fireEvent.click(screen.getByLabelText('All models (not just yours)'));
  expect(screen.getByRole('button', { name: 'Toggle palm-2' })).toBeTruthy();
});

it('plots an unpublished effort cost as a flagged estimate that can be turned off', async () => {
  const curve = [
    { ...observation, id: 'c-low', model: 'gpt-5.6-sol', effort: 'low', quality: metric(41), costPerTask: metric(0.2) },
    { ...observation, id: 'c-max', model: 'gpt-5.6-sol', effort: 'max', quality: metric(51), costPerTask: metric(1.2) },
    { ...observation, id: 'f-low', model: 'claude-fable-5.1', effort: 'low', quality: metric(48), costPerTask: null },
    { ...observation, id: 'f-max', model: 'claude-fable-5.1', effort: 'max', quality: metric(57), costPerTask: metric(6.1) },
  ];
  api.getModelComparison.mockResolvedValue({ schemaVersion: 1, observations: curve, inventory: [] });

  render(<MemoryRouter><ModelComparison /></MemoryRouter>);
  await act(async () => {});

  await screen.findByText(/1 estimated cost/);
  expect(screen.getByTestId('scatter-claude-fable-5.1')).toHaveAttribute('data-points', '2');

  fireEvent.click(screen.getByLabelText('Estimate unpublished costs'));
  expect(screen.getByTestId('scatter-claude-fable-5.1')).toHaveAttribute('data-points', '1');
  expect(screen.queryByText(/· 1 estimated cost/)).toBeNull();
});

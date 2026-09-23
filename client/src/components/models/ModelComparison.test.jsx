import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ModelComparison from './ModelComparison';
import * as api from '../../services/apiModelComparison';
import toast from '../ui/Toast';

vi.mock('../../services/apiModelComparison', () => ({
  getModelComparison: vi.fn(),
  discoverComparisonModels: vi.fn(),
  runPortosModelBenchmark: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), warning: vi.fn() } }));
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }) => <div>{children}</div>,
  ScatterChart: ({ children }) => <div>{children}</div>,
  Scatter: ({ name, data }) => <div data-testid={`scatter-${name}`} data-values={JSON.stringify(data?.map(({ x, y }) => [x, y]))} />,
  CartesianGrid: () => null,
  Tooltip: () => null,
  XAxis: ({ label }) => <div data-testid="xaxis" data-label={label?.value} />,
  YAxis: ({ label }) => <div data-testid="yaxis" data-label={label?.value} />,
}));

const runSource = {
  url: 'portos://model-comparison/00000000-0000-4000-8000-000000000001',
  retrievedAt: '2026-09-23T00:00:00.000Z',
  methodology: 'PortOS Task Bench v1',
};
const metric = value => ({ value, source: runSource });
const observation = ({ id, provider, model, score, tokens, cost = null, billing = 'subscription', tokenBasis = 'measured' }) => ({
  id,
  provider,
  model,
  effort: 'high',
  configuration: 'PortOS Task Bench v1; temperature=0',
  billing,
  benchmark: 'PortOS Task Bench v1 (deterministic)',
  quality: metric(score),
  costPerTask: null,
  inputPerMillion: null,
  outputPerMillion: null,
  reasoningPerMillion: null,
  responseSeconds: metric(4),
  tokensPerSecond: metric(tokens / 4),
  tokensPerRun: metric(tokens),
  inputTokens: metric(tokens - 20),
  outputTokens: metric(20),
  apiEquivalentCost: cost === null ? null : metric(cost),
  tokenBasis,
  completedTasks: 5,
  totalTasks: 5,
  quota: null,
  notes: 'No prompt or model response is stored.',
});
const codexRun = observation({ id: 'portos:codex-run', provider: 'Codex', model: 'gpt-6-luna', score: 80, tokens: 120, cost: 0.0002 });
const localRun = observation({ id: 'portos:local-run', provider: 'Ollama', model: 'qwen3.6:35b', score: 60, tokens: 150, billing: 'local', tokenBasis: 'estimated' });
const inventory = [
  { id: 'codex', name: 'Codex', billing: 'subscription', canBenchmark: true, canDiscover: false, models: [{ model: 'gpt-6-luna', efforts: ['low', 'high'] }] },
  { id: 'ollama', name: 'Ollama', billing: 'local', canBenchmark: true, canDiscover: true, models: [{ model: 'qwen3.6:35b', efforts: [] }] },
];

beforeEach(() => {
  vi.clearAllMocks();
  api.getModelComparison.mockResolvedValue({ schemaVersion: 1, observations: [codexRun, localRun], inventory });
});

it('runs the explicitly selected provider, model and effort, then displays the saved result', async () => {
  api.runPortosModelBenchmark.mockResolvedValue({ observation: codexRun, complete: true });
  render(<ModelComparison />);

  await screen.findByTestId('xaxis');
  fireEvent.change(screen.getByLabelText('Reasoning effort'), { target: { value: 'high' } });
  fireEvent.click(screen.getByRole('button', { name: 'Run five tasks' }));

  await waitFor(() => expect(api.runPortosModelBenchmark).toHaveBeenCalledWith(
    { providerId: 'codex', model: 'gpt-6-luna', effort: 'high' },
    expect.objectContaining({ silent: true, signal: expect.any(AbortSignal) }),
  ));
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Benchmark saved: 80% correct'));
  expect(screen.getByTestId('scatter-Codex')).toHaveAttribute('data-values', '[[120,80]]');
});

it('compares all runs by tokens and limits the cost view to models with known API rates', async () => {
  render(<ModelComparison />);

  await screen.findByTestId('scatter-Ollama');
  expect(screen.getByTestId('scatter-Codex')).toHaveAttribute('data-values', '[[120,80]]');
  expect(screen.getByTestId('scatter-Ollama')).toHaveAttribute('data-values', '[[150,60]]');

  fireEvent.click(screen.getByRole('button', { name: 'API equivalent' }));
  await screen.findByTestId('scatter-Codex');
  expect(screen.queryByTestId('scatter-Ollama')).toBeNull();
  expect(screen.getByTestId('scatter-Codex')).toHaveAttribute('data-values', '[[0.2,80]]');
  expect(screen.getByTestId('xaxis')).toHaveAttribute('data-label', 'Estimated API equivalent per 1,000 runs');
  expect(screen.getByText('~$0.20')).toBeTruthy();
});

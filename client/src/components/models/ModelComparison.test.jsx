import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ModelComparison from './ModelComparison';
import * as api from '../../services/apiModelComparison';

vi.mock('../../services/apiModelComparison', () => ({ getModelComparison: vi.fn() }));
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }) => <div>{children}</div>,
  ScatterChart: ({ children }) => <div>{children}</div>,
  Scatter: ({ name, data }) => <div data-testid={`scatter-${name}`} data-values={JSON.stringify(data?.map(({ x, y }) => [x, y]))} />,
  CartesianGrid: () => null,
  Tooltip: () => null,
  XAxis: ({ label }) => <div data-testid="xaxis" data-label={label?.value} />,
  YAxis: ({ label }) => <div data-testid="yaxis" data-label={label?.value} />,
}));

const source = (url, methodology = 'Published source') => ({
  url,
  retrievedAt: '2026-09-24T06:00:00Z',
  methodology,
});
const metric = (value, url, methodology) => ({ value, source: source(url, methodology) });
const row = ({ id, provider, model, benchmark, quality, input = null, output = null }) => ({
  id,
  provider,
  model,
  effort: 'high',
  configuration: 'Public source result',
  billing: 'api',
  benchmark,
  quality: quality === null ? null : metric(quality, 'https://livecodebench.github.io/leaderboard.html'),
  costPerTask: null,
  inputPerMillion: input === null ? null : metric(input, 'https://developers.openai.com/api/docs/models/o4-mini'),
  outputPerMillion: output === null ? null : metric(output, 'https://developers.openai.com/api/docs/models/o4-mini'),
  reasoningPerMillion: null,
  responseSeconds: null,
  tokensPerSecond: null,
  quota: null,
  notes: '',
});

const benchmark = 'LiveCodeBench generation pass@1 (1,055 problems; 2023-05-08 to 2025-04-07)';
const observations = [
  row({ id: 'o4-mini-high', provider: 'OpenAI', model: 'o4-mini', benchmark, quality: 87.3, input: 1.1, output: 4.4 }),
  row({ id: 'qwen3-score', provider: 'Qwen', model: 'qwen3-235b-a22b', benchmark, quality: 80.4 }),
  row({ id: 'free-endpoint', provider: 'OpenCode Zen', model: 'example-free-model', benchmark: 'Unbenchmarked (pricing only)', quality: null, input: 0, output: 0 }),
];

beforeEach(() => {
  vi.clearAllMocks();
  api.getModelComparison.mockResolvedValue({ schemaVersion: 1, observations });
});

it('plots only shipped benchmark data with a matching published token price', async () => {
  render(<ModelComparison />);

  expect(await screen.findByTestId('scatter-OpenAI')).toHaveAttribute('data-values', '[[4.4,87.3]]');
  expect(screen.getByTestId('xaxis')).toHaveAttribute('data-label', 'Published output price (USD per 1M tokens)');
  expect(screen.getByTestId('yaxis')).toHaveAttribute('data-label', 'Benchmark score (%)');
  expect(screen.getByText('qwen3-235b-a22b')).toBeTruthy();
  expect(screen.getByText('example-free-model')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /run five tasks/i })).toBeNull();
  expect(screen.queryByRole('button', { name: /discover models/i })).toBeNull();
  expect(api.getModelComparison).toHaveBeenCalledTimes(1);
});

it('switches between input and output prices without comparing benchmark families', async () => {
  render(<ModelComparison />);

  await screen.findByTestId('scatter-OpenAI');
  fireEvent.change(screen.getByLabelText('Token price'), { target: { value: 'inputPerMillion' } });

  expect(screen.getByTestId('scatter-OpenAI')).toHaveAttribute('data-values', '[[1.1,87.3]]');
  expect(screen.getByTestId('xaxis')).toHaveAttribute('data-label', 'Published input price (USD per 1M tokens)');
  expect(screen.getByLabelText('Benchmark')).toHaveValue(benchmark);
});

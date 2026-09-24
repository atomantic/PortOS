import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ModelComparison from './ModelComparison';
import * as api from '../../services/apiModelComparison';
vi.mock('../../services/apiModelComparison', () => ({ getModelComparison: vi.fn() }));
vi.mock('./ComparisonResearch', () => ({ default: () => <div>Research configuration</div> }));
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }) => <div>{children}</div>, ScatterChart: ({ children }) => <div>{children}</div>,
  Scatter: ({ name, data }) => <div data-testid={`scatter-${name}`} data-values={JSON.stringify(data?.map(({ x, y }) => [x, y]))} />,
  CartesianGrid: () => null, Tooltip: () => null, LabelList: () => null,
  XAxis: ({ label }) => <div data-testid="xaxis" data-label={label?.value} />, YAxis: () => null,
}));
const metric = (value, estimated = false) => ({ value, estimated, method: 'Example source', sources: [{ url: 'https://example.com', retrievedAt: '2026-09-01T00:00:00Z', methodology: 'Published' }] });
const row = (model, effort, quality, price, estimated = false) => ({ id: `${model}:${effort}`, providerId: 'example', provider: 'Example', model, modelKey: `example:${model}`, effort, quality: quality === null ? null : metric(quality, estimated), blendedPerMillion: metric(price), inputPerMillion: metric(price / 2), outputPerMillion: metric(price * 2), costPerTask: null, needsResearch: quality === null || estimated });
const rows = [row('gpt-6-luna', 'low', 21, 0.2), row('gpt-6-luna', 'high', 32, 0.2), row('gpt-5.6-luna', 'low', 20, 0.45), row('claude-opus-5-5', 'high', 56, 8), row('unknown-model', 'high', null, 0)];
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); api.getModelComparison.mockResolvedValue({ composite: { anchor: 'Reference v1', rows } }); });

it('compares generations and vendors together with quick model and effort toggles and no benchmark picker', async () => {
  render(<ModelComparison />);
  await screen.findByTestId('scatter-example:gpt-6-luna');
  expect(screen.queryByLabelText('Benchmark')).toBeNull();
  fireEvent.change(screen.getByLabelText('Filter models'), { target: { value: 'gpt-6-luna,opus' } });
  fireEvent.click(screen.getByRole('button', { name: 'Compare matching' }));
  expect(screen.getByTestId('scatter-example:gpt-6-luna')).toHaveAttribute('data-values', '[[0.2,21],[0.2,32]]');
  expect(screen.getByTestId('scatter-example:claude-opus-5-5')).toBeTruthy();
  expect(screen.getByRole('region', { name: 'Pair comparison' })).toHaveTextContent('-24 points');
  expect(screen.queryByTestId('scatter-example:gpt-5.6-luna')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '✓ high' }));
  expect(screen.getByTestId('scatter-example:gpt-6-luna')).toHaveAttribute('data-values', '[[0.2,21]]');
  expect(screen.queryByTestId('scatter-example:claude-opus-5-5')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Research gaps/ }));
  expect(screen.getByText('Research configuration')).toBeTruthy();
});

it('preserves empty selections across reload, handles zero costs and switches axes', async () => {
  const { unmount } = render(<ModelComparison />);
  await screen.findByTestId('scatter-example:gpt-6-luna');
  fireEvent.change(screen.getByLabelText('Cost axis'), { target: { value: 'inputPerMillion' } });
  expect(screen.getByTestId('scatter-example:gpt-6-luna')).toHaveAttribute('data-values', '[[0.1,21],[0.1,32]]');
  fireEvent.click(screen.getByRole('button', { name: 'Clear models' }));
  unmount();
  render(<ModelComparison />);
  await waitFor(() => expect(api.getModelComparison).toHaveBeenCalledTimes(2));
  expect(screen.queryByTestId('scatter-example:gpt-6-luna')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'All models' }));
  await screen.findByTestId('scatter-example:gpt-6-luna');
});

it('surfaces load failure and successfully reloads without losing the page controls', async () => {
  api.getModelComparison.mockRejectedValueOnce(new Error('Source catalog unavailable'));
  render(<ModelComparison />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Source catalog unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'Reload data' }));
  await screen.findByTestId('scatter-example:gpt-6-luna');
  expect(screen.queryByRole('alert')).toBeNull();
});

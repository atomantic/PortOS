import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import CodingBenchmarkComparison from './CodingBenchmarkComparison';

vi.mock('../ui/charts', () => ({
  ResponsiveContainer: ({ children }) => <div>{children}</div>,
  ScatterChart: ({ title, children }) => <div data-testid="coding-scatter" data-title={title}>{children}</div>,
  Scatter: ({ data }) => <div data-testid="coding-series" data-points={JSON.stringify(data.map(({ model, harness, effort, usd, score }) => [model, harness, effort, usd, score]))} />,
  Tooltip: () => null, XAxis: () => null, YAxis: () => null, CartesianGrid: () => null, LabelList: () => null,
}));

const select = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const points = () => screen.queryAllByTestId('coding-series').flatMap(item => JSON.parse(item.dataset.points));

it('plots all 14 Gemini effort rows on CursorBench with paired costs and never imports AA-only scores', () => {
  render(<CodingBenchmarkComparison />);
  expect(points().filter(([model]) => model.startsWith('Gemini 4'))).toHaveLength(14);
  expect(points().every(([, harness]) => harness === 'Cursor')).toBe(true);
  select('Model', 'Gemini 4 Argon');
  select('Reasoning effort', 'Low');
  const argon = within(screen.getByRole('table', { name: 'CursorBench 4.1 benchmark results' }));
  expect(argon.getByRole('row', { name: /Gemini 4 Argon Cursor Low 47.9% \$7.96/ })).toBeInTheDocument();
  expect(points()).toEqual([['Gemini 4 Argon', 'Cursor', 'Low', 7.96, 47.9]]);
  expect(argon.getByRole('link', { name: 'Cursor result for Gemini 4 Argon · Low' })).toHaveAttribute('href', 'https://cursor.com/evals');
});

it('switches the entire benchmark scope, then separates native harnesses and leaves unmeasured efforts blank', () => {
  render(<CodingBenchmarkComparison />);
  select('Model', 'Gemini 4 Argon');
  select('Reasoning effort', 'Low');
  select('Benchmark', 'aa-coding-agent-2.1');
  expect(screen.getByLabelText('Model')).toHaveValue('');
  expect(screen.getByLabelText('Reasoning effort')).toHaveValue('');
  expect(screen.getByTestId('coding-scatter')).toHaveAttribute('data-title', 'Artificial Analysis Coding Agent Index v2.1 score vs. task cost');
  expect(screen.queryByRole('table', { name: 'CursorBench 4.1 benchmark results' })).not.toBeInTheDocument();
  const figure = within(screen.getByRole('figure'));
  expect(figure.getByRole('link', { name: 'Artificial Analysis Coding Agent Index v2.1' })).toHaveAttribute('href', 'https://artificialanalysis.ai/agents/coding-agents/comparisons/antigravity-cli-vs-codex');
  expect(screen.getByRole('columnheader', { name: 'Coding Agent Index v2.1' })).toBeInTheDocument();
  expect(points().every(([, harness]) => harness !== 'Cursor')).toBe(true);
  select('Agent setup', 'Antigravity CLI');
  select('Model', 'Gemini 4 Argon');
  select('Reasoning effort', 'Low');
  expect(screen.getByText('No published results for this filter combination.')).toBeInTheDocument();
  expect(points()).toEqual([]);
  select('Reasoning effort', 'High');
  expect(points()).toEqual([['Gemini 4 Argon', 'Antigravity CLI', 'High', 13.67, 45]]);
  expect(screen.getByRole('row', { name: /Gemini 4 Argon Antigravity CLI High 45 \$13.67/ })).toBeInTheDocument();
  select('Agent setup', 'Codex');
  select('Model', 'GPT-6.2 Astra');
  select('Reasoning effort', 'Medium');
  expect(points()).toEqual([['GPT-6.2 Astra', 'Codex', 'Medium', 1.20, 49]]);
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';

vi.mock('../../services/apiLocalLlm.js', () => ({ startLocalLlmAssessmentBenchmark: vi.fn() }));
vi.mock('../ui/Toast');

import { startLocalLlmAssessmentBenchmark } from '../../services/apiLocalLlm.js';
import LocalBenchmarkPanel, { benchmarkCandidates, benchmarkGenerations } from './LocalBenchmarkPanel.jsx';

const profile = { contextTokens: 4096, runs: 3, maxTokens: 256, warmupRuns: 1, minModels: 2, maxModels: 8 };
const report = {
  benchmarkProfile: profile,
  assessments: [
    { backend: 'ollama', modelId: 'example-mlx', tuningKey: '', profile: 'benchmark', assessedAt: '2026-11-20T00:00:00.000Z', residentGb: 9.5,
      performance: { meanTokensPerSecond: 48.2, meanPromptTokensPerSecond: 910, meanTtftMs: 420 } },
    { backend: 'ollama', modelId: 'example-mlx', tuningKey: 'num_ctx=8192', performance: { meanTokensPerSecond: 99 } },
    { backend: 'mtplx', modelId: 'example-mtp', tuningKey: '', assessedAt: '2026-11-19T00:00:00.000Z', staleness: { stale: true, description: 'Measured on a different machine state.' },
      performance: { meanTokensPerSecond: 71.5, meanPromptTokensPerSecond: 640, meanTtftMs: 380, tokensEstimated: true } },
    { backend: 'llama', modelId: 'uninstalled-model', tuningKey: '' },
  ],
  unassessed: [{ backend: 'lmstudio', modelId: 'never-measured' }],
  uninstalled: [{ backend: 'llama', modelId: 'uninstalled-model' }],
};
const labels = { ollama: 'Ollama', mtplx: 'MTPLX', lmstudio: 'LM Studio' };
const runtimeLabelFor = (id) => labels[id] || id;

let location;
function LocationProbe() { location = useLocation(); return null; }
const renderPanel = (props = {}, initialEntry = '/models/performance/tuning') => render(
  <MemoryRouter initialEntries={[initialEntry]}>
    <LocalBenchmarkPanel report={report} runtimeLabelFor={runtimeLabelFor} disabled={false} {...props} />
    <LocationProbe />
  </MemoryRouter>,
);

beforeEach(() => { vi.clearAllMocks(); });

describe('LocalBenchmarkPanel', () => {
  it('offers each installed model once, never an uninstalled one, and counts warm-up plus measured runs', () => {
    expect(benchmarkCandidates(report).map((m) => `${m.backend}:${m.modelId}`)).toEqual(['lmstudio:never-measured', 'mtplx:example-mtp', 'ollama:example-mlx']);
    expect(benchmarkGenerations(2, profile)).toBe(8);
  });

  it('needs two picks, keeps them in the URL, and names every model and generation before queuing', async () => {
    const user = userEvent.setup();
    startLocalLlmAssessmentBenchmark.mockResolvedValue({ status: 'running', mode: 'benchmark', total: 2 });
    renderPanel();
    const start = screen.getByRole('button', { name: /Benchmark .*selected/ });
    expect(start).toBeDisabled();
    await user.click(screen.getByLabelText(/example-mlx/));
    expect(start).toBeDisabled();
    expect(screen.getByText('Pick at least 2 models.')).toBeInTheDocument();
    await user.click(screen.getByLabelText(/example-mtp/));
    expect(new URLSearchParams(location.search).get('benchModels').split(',')).toHaveLength(2);
    expect(start).toBeEnabled();

    await user.click(start);
    expect(startLocalLlmAssessmentBenchmark).not.toHaveBeenCalled();
    const gate = screen.getByRole('heading', { name: 'Benchmark 2 models side by side?' }).closest('div.bg-port-card');
    expect(gate).toHaveTextContent('MTPLX · example-mtp');
    expect(gate).toHaveTextContent('Ollama · example-mlx');
    expect(gate).toHaveTextContent(/8 generations in total: per model, 1 discarded warm-up then 3 measured runs of 256 output tokens on a 4K-token prompt, at backend defaults/);
    await user.click(within(gate).getByRole('button', { name: 'Start benchmark' }));
    expect(startLocalLlmAssessmentBenchmark).toHaveBeenCalledWith({ models: [
      { backend: 'mtplx', modelId: 'example-mtp' },
      { backend: 'ollama', modelId: 'example-mlx' },
    ] }, { silent: true });
  });

  it('restores a shared selection and tabulates the backend-defaults readings side by side', async () => {
    const { encodeLocalModelAssessmentKey } = await import('../../lib/localModelAssessmentKey');
    const picks = [{ backend: 'ollama', modelId: 'example-mlx' }, { backend: 'mtplx', modelId: 'example-mtp' }, { backend: 'lmstudio', modelId: 'never-measured' }]
      .map((m) => encodeLocalModelAssessmentKey(m)).join(',');
    renderPanel({}, `/models/performance/tuning?benchModels=${picks}`);
    const table = screen.getByRole('table', { name: 'Side-by-side benchmark results' });
    const mlx = within(table).getByText('example-mlx').closest('tr');
    // The tuned 99 tok/s record is not the backend-defaults reading the benchmark writes.
    expect(mlx).toHaveTextContent('48.2');
    expect(mlx).toHaveTextContent('9.5 GB');
    expect(mlx).toHaveTextContent('Benchmark');
    const mtp = within(table).getByText('example-mtp').closest('tr');
    expect(mtp).toHaveTextContent('~71.5');
    expect(mtp).toHaveTextContent('Context sweep');
    expect(mtp).toHaveTextContent('stale');
    // Best per column: higher decode/prefill wins, lower first-token time wins.
    expect(within(mtp).getByText('~71.5')).toHaveClass('text-emerald-400');
    expect(within(mlx).getByText('910')).toHaveClass('text-emerald-400');
    expect(within(mtp).getByText('380 ms')).toHaveClass('text-emerald-400');
    const never = within(table).getByText('never-measured').closest('tr');
    expect(within(never).getAllByText('Not measured')).toHaveLength(3);
  });

  it('stays unavailable while another measurement holds the machine', () => {
    renderPanel({ disabled: true }, '/models/performance/tuning');
    expect(screen.getByRole('button', { name: /Benchmark .*selected/ })).toBeDisabled();
  });
});

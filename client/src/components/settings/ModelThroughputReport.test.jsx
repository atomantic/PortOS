import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../lib/clipboard', () => ({ copyToClipboard: vi.fn(async () => true) }));

import { copyToClipboard } from '../../lib/clipboard';
import ModelThroughputReport, { toMarkdown } from './ModelThroughputReport.jsx';

const point = (contextTokens, tokensPerSecond, extra = {}) => ({
  contextTokens, ok: true, tokensPerSecond, promptTokensPerSecond: 900, charsPerSecond: 200,
  ttftMs: 300, completionTokens: 96, error: null, ...extra,
});

const row = (modelId, overrides = {}) => ({
  backend: 'ollama',
  modelId,
  tuningKey: '',
  tuningLabel: null,
  tuningApplied: null,
  tuningNotApplied: null,
  verdict: 'fits',
  assessedAt: '2026-01-01T00:00:00.000Z',
  staleness: null,
  meanTokensPerSecond: 50,
  peakTokensPerSecond: 60,
  meanPromptTokensPerSecond: 900,
  meanCharsPerSecond: 200,
  meanTtftMs: 300,
  tokensEstimated: false,
  points: [point(512, 60), point(4096, 40)],
  ...overrides,
});

const report = (rows, contexts = [512, 4096]) => ({
  rows, contexts, modelsWithTokenRates: rows.filter((r) => r.meanTokensPerSecond !== null).length,
});

beforeEach(() => vi.clearAllMocks());

describe('ModelThroughputReport', () => {
  it('renders a column per sampled context and the per-context rates', () => {
    render(<ModelThroughputReport report={report([row('example-model:7b')])} />);
    expect(screen.getByRole('columnheader', { name: '512' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '4K' })).toBeInTheDocument();
    expect(screen.getByText('60.0')).toBeInTheDocument();
    expect(screen.getByText('40.0')).toBeInTheDocument();
  });

  // The sentinel contract, in the UI: a runtime that reported no token counts
  // must render as blank, never as 0 and never as its chars/s figure relabelled.
  it('renders an unmeasured rate as a dash, not a zero', () => {
    const quiet = row('quiet-model', {
      meanTokensPerSecond: null, peakTokensPerSecond: null, meanPromptTokensPerSecond: null,
      tokensEstimated: null,
      points: [point(512, null), point(4096, null)],
    });
    render(<ModelThroughputReport report={report([quiet])} />);
    expect(screen.queryByText('0.0')).not.toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(4);
  });

  it('marks a frame-counted figure with a ~ and explains it', () => {
    render(<ModelThroughputReport report={report([row('estimated-model', { tokensEstimated: true })])} />);
    expect(screen.getByText('~50.0')).toBeInTheDocument();
    expect(screen.getByText(/counted from streamed frames/)).toBeInTheDocument();
  });

  it('omits the estimate footnote when every figure came from a tokenizer', () => {
    render(<ModelThroughputReport report={report([row('example-model:7b')])} />);
    expect(screen.queryByText(/counted from streamed frames/)).not.toBeInTheDocument();
  });

  // A context that failed is a different fact from one that was never sampled.
  it('says "failed" for a context the model could not run', () => {
    const partial = row('big-model', {
      points: [point(512, 30), point(4096, null, { ok: false, error: 'out of memory' })],
    });
    render(<ModelThroughputReport report={report([partial])} />);
    expect(screen.getByText('failed')).toBeInTheDocument();
  });

  it('flags a reading whose tuning never reached the daemon', () => {
    const unapplied = row('tuned-model', {
      tuningKey: 'ctxSize=8192', tuningLabel: '8k context', tuningApplied: false, tuningNotApplied: 'llama-server is not running',
    });
    render(<ModelThroughputReport report={report([unapplied])} />);
    expect(screen.getByText('tuning not applied')).toBeInTheDocument();
  });

  // An UNTUNED reading already renders as "backend defaults", so the same
  // warning has to say the opposite thing: the daemon could not be put BACK on
  // defaults, and this row is not the baseline it claims to be.
  it('flags an untuned reading the daemon could not be returned to defaults for', () => {
    const stillTuned = row('baseline-model', {
      tuningKey: '', tuningApplied: false, tuningNotApplied: 'Ollama would not stop',
    });
    render(<ModelThroughputReport report={report([stillTuned])} />);
    expect(screen.getByText('not at defaults')).toBeInTheDocument();
    expect(screen.queryByText('tuning not applied')).not.toBeInTheDocument();
  });

  it('renders nothing at all when no model has been measured', () => {
    const { container } = render(<ModelThroughputReport report={report([])} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('copies the table as markdown without a second success toast', async () => {
    const user = userEvent.setup();
    render(<ModelThroughputReport report={report([row('example-model:7b')])} />);

    await user.click(screen.getByRole('button', { name: /copy the throughput report/i }));
    expect(copyToClipboard).toHaveBeenCalledWith(expect.stringContaining('example-model:7b'), null);
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });
});

describe('toMarkdown', () => {
  it('emits one row per measurement with a column per context', () => {
    const md = toMarkdown(report([row('example-model:7b')]));
    const lines = md.split('\n');
    expect(lines[0]).toBe('| Model | Runtime | Tuning | tok/s | chars/s | Prefill tok/s | TTFT | 512 tok/s | 4K tok/s |');
    expect(lines[2]).toContain('| example-model:7b | ollama | backend defaults | 50.0 |');
    expect(lines[2]).toContain('| 60.0 | 40.0 |');
  });

  it('writes a dash for an unmeasured cell rather than a zero', () => {
    const quiet = row('quiet-model', {
      meanTokensPerSecond: null, meanPromptTokensPerSecond: null, meanTtftMs: null,
      points: [point(512, null)],
    });
    const md = toMarkdown(report([quiet]));
    expect(md).toContain('| quiet-model | ollama | backend defaults | — | 200.0 | — | — |');
  });
});

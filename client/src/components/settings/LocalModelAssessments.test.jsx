import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';

vi.mock('../../services/api', () => ({
  getLocalLlmAssessments: vi.fn(),
  runLocalLlmAssessment: vi.fn(),
  runOpenCodeAgentBenchmark: vi.fn(),
  deleteLocalLlmAssessment: vi.fn(),
  // The sweep panel is a child of this one and polls the queue on mount. Its own
  // behavior has a dedicated suite; here it just has to be idle and quiet.
  getLocalLlmAssessmentSweep: vi.fn(async () => ({ status: 'idle', total: 0, completed: 0, results: [] })),
  startLocalLlmAssessmentSweep: vi.fn(),
  cancelLocalLlmAssessmentSweep: vi.fn(),
  // The capability suite panel is a child of this one and loads its report on
  // mount. Its own behavior has a dedicated suite; here it just has to be quiet.
  getModelCapabilityTests: vi.fn(async () => ({
    tests: [], testIds: [], prompts: {}, models: [], runtimes: [],
    counts: { models: 0, applicable: 0, passed: 0, failed: 0 }, listErrors: [], readError: null,
  })),
  runModelCapabilityTest: vi.fn(),
  deleteModelCapabilityTest: vi.fn(),
}));

vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

// Per-sample run progress arrives on the shared `localLlm:progress` socket
// event; the tests below replay frames through the registered handler.
vi.mock('../../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn() },
}));

import {
  getLocalLlmAssessments, runLocalLlmAssessment, runOpenCodeAgentBenchmark, deleteLocalLlmAssessment,
  getLocalLlmAssessmentSweep, startLocalLlmAssessmentSweep, cancelLocalLlmAssessmentSweep,
} from '../../services/api';
import toast from '../ui/Toast';
import socket from '../../services/socket';
import LocalModelAssessments from './LocalModelAssessments.jsx';

// The measure drawer's target lives in the URL, so every render needs a router.
// `currentUrl()` reads back what the panel wrote, which is what the deep-link
// tests assert on — the drawer being open is a property of the URL now, not of
// component state.
let location = null;
function LocationProbe() {
  location = useLocation();
  return null;
}
const currentUrl = () => `${location.pathname}${location.search}`;
const renderPanel = (initialEntry = '/models/performance') => render(
  <MemoryRouter initialEntries={[initialEntry]}>
    <LocalModelAssessments />
    <LocationProbe />
  </MemoryRouter>,
);

const report = (overrides = {}) => ({
  intent: 'balanced',
  intents: ['balanced', 'smartest', 'fastest', 'lightweight'],
  defaultContextTokens: [512, 4096, 16384],
  assessments: [],
  unassessed: [],
  listErrors: [],
  readError: null,
  ranked: [],
  excluded: [],
  runtimes: RUNTIMES,
  tuningComparison: [],
  uninstalled: [],
  throughputReport: { rows: [], contexts: [], modelsWithTokenRates: 0 },
  sweepScopes: { unmeasured: 0, stale: 0, all: 0 },
  ...overrides,
});

// The runtime roster is server-derived — label, reachability, and the knob
// catalog all ride on the report, so the panel has no hardcoded backend list to
// drift from.
const RUNTIMES = [
  // `tuningGrid` is the server's own sweep grid, shipped so the consent gate
  // names the count that will actually run. It is EMPTY for a runtime a sweep
  // may not drive — Ollama cannot be reset and put back yet (#4763) — which is
  // what turns its "Sweep tunings" button off.
  { id: 'ollama', label: 'Ollama', managed: true, modelCount: 1, error: null, tuningGrid: [], tuningSpecs: [
    { id: 'numCtx', label: 'Context size', type: 'number', applies: 'launch', env: 'OLLAMA_CONTEXT_LENGTH', min: 512, max: 1048576, unit: 'tokens', hint: 'The window every model loads with.', note: 'PortOS restarts the server with OLLAMA_CONTEXT_LENGTH set.' },
  ] },
  { id: 'llama', label: 'llama.cpp', managed: false, modelCount: 3, error: null, tuningGrid: [
    { key: '', label: null, tuning: {} },
    { key: 'ubatchSize=1024', label: 'Micro-batch size 1024', tuning: { ubatchSize: 1024 } },
    { key: 'flashAttn=true', label: 'Flash attention on', tuning: { flashAttn: true } },
  ], tuningSpecs: [
    { id: 'ubatchSize', label: 'Micro-batch size', type: 'number', applies: 'launch', config: true, min: 1, max: 8192, hint: 'Physical micro-batch.', note: "PortOS puts this on the server's launch line and relaunches it." },
    { id: 'flashAttn', label: 'Flash attention', type: 'boolean', applies: 'launch', config: true, hint: 'Fused attention kernel.', note: "PortOS puts this on the server's launch line and relaunches it." },
  ] },
  { id: 'mtplx', label: 'MTPLX', managed: false, modelCount: null, error: 'not reachable at http://127.0.0.1:8000/v1 (ECONNREFUSED)', tuningGrid: [], tuningSpecs: [
    { id: 'depth', label: 'MTP depth', type: 'number', applies: 'launch', cli: '--depth', min: 1, max: 8, hint: 'Draft lookahead.', note: 'PortOS relaunches `mtplx serve` with `--depth` on its command line.' },
    { id: 'kvQuant', label: 'KV cache quantization', type: 'enum', applies: 'launch', cli: '--kv-quant', options: ['off', 'q8', 'q4'], hint: 'Context length for a little quality.', note: 'PortOS relaunches `mtplx serve` with `--kv-quant` on its command line.' },
  ] },
];

// The sweep queue is server state the panel reads on mount. Every suite here
// starts from "nothing running" — a test that wants a live queue says so.
const idleSweep = () =>
  getLocalLlmAssessmentSweep.mockResolvedValue({ status: 'idle', total: 0, completed: 0, current: null, results: [] });

const rankedEntry = (overrides = {}) => ({
  backend: 'ollama',
  modelId: 'example-model:7b',
  verdict: 'fits',
  score: 0.7,
  coverage: 1,
  scores: { capability: 0.5, speed: 0.6, fidelity: 0.9, memory: 0.8 },
  performance: {
    meanCharsPerSecond: 120,
    meanTtftMs: 250,
    maxWorkingContextTokens: 4096,
    peakCharsPerSecond: 140,
    contextDegradation: 0.85,
    samplesRun: 3,
    samplesOk: 3,
  },
  residentGb: 5,
  params: '7B',
  assessedAt: '2026-01-01T00:00:00.000Z',
  explanation: '120 chars/s measured, ran at up to 4,096 tokens of context.',
  ...overrides,
});

describe('LocalModelAssessments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    idleSweep();
    getLocalLlmAssessments.mockResolvedValue(report());
  });

  it('loads persisted results on mount without triggering any model run', async () => {
    renderPanel();
    await waitFor(() => expect(getLocalLlmAssessments).toHaveBeenCalled());
    // The AI Provider Usage Policy boundary: mounting the panel must never
    // reach a provider.
    expect(runLocalLlmAssessment).not.toHaveBeenCalled();
  });

  it('runs an explicit local TUI task check and ranks by completion time', async () => {
    runOpenCodeAgentBenchmark.mockResolvedValue({
      backend: 'llama', modelId: 'dflash', completed: true,
      taskTokensPerSecond: null, taskCharsPerSecond: null, toolCalls: null, elapsedMs: 4000,
    });
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getAllByRole('button', { name: 'Run task check' })[0]);
    await waitFor(() => expect(runOpenCodeAgentBenchmark).toHaveBeenCalledWith({
      backend: 'llama', modelId: 'dflash',
    }));
    expect(await screen.findByText('sentinel complete')).toBeInTheDocument();
    expect(screen.getByText(/4s fastest completion/)).toBeInTheDocument();
    expect(screen.getByText(/PTY-backed TUI/)).toBeInTheDocument();
  });

  it('renders measured numbers for a ranked model', async () => {
    getLocalLlmAssessments.mockResolvedValue(report({ ranked: [rankedEntry()] }));
    renderPanel();
    expect(await screen.findByText('example-model:7b')).toBeInTheDocument();
    expect(screen.getByText('120 chars/s')).toBeInTheDocument();
    expect(screen.getByText('4K tokens')).toBeInTheDocument();
    // Resident size is measured by /api/ps and must survive into the ranked
    // entry — rendering "not measured" here would hide a real measurement.
    expect(screen.getByText('5.0 GB')).toBeInTheDocument();
    expect(screen.getByText('Fits')).toBeInTheDocument();
  });

  it('says "not measured" rather than showing a zero for an unmeasured field', async () => {
    getLocalLlmAssessments.mockResolvedValue(report({
      ranked: [rankedEntry({
        residentGb: null,
        performance: { ...rankedEntry().performance, meanCharsPerSecond: null, meanTtftMs: null },
        scores: { capability: 0.5, speed: null, fidelity: null, memory: null },
      })],
    }));
    renderPanel();
    await screen.findByText('example-model:7b');
    expect(screen.getAllByText('not measured').length).toBeGreaterThanOrEqual(3);
    // An unmeasured axis renders as n/a, never as an empty bar that reads as 0.
    expect(screen.getAllByText('n/a')).toHaveLength(3);
  });

  it('requires explicit consent naming the model and run count before running', async () => {
    const user = userEvent.setup();
    getLocalLlmAssessments.mockResolvedValue(report({
      unassessed: [{ backend: 'ollama', modelId: 'example-model:7b', params: '7B' }],
    }));
    runLocalLlmAssessment.mockResolvedValue({ verdict: 'fits' });
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Measure' }));
    // Nothing has been sent yet — the click opens the ask, it does not run.
    expect(runLocalLlmAssessment).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Measure this model' })).toBeInTheDocument();
    expect(screen.getByText(/3 times/)).toBeInTheDocument();
    expect(screen.getByText(/512, 4K, 16K tokens of context/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /run assessment/i }));
    await waitFor(() => expect(runLocalLlmAssessment).toHaveBeenCalledWith(
      { backend: 'ollama', modelId: 'example-model:7b', tuning: {} },
      expect.objectContaining({ silent: true, signal: expect.any(AbortSignal) }),
    ));
  });

  it('does not run when the consent drawer is cancelled', async () => {
    const user = userEvent.setup();
    getLocalLlmAssessments.mockResolvedValue(report({
      unassessed: [{ backend: 'ollama', modelId: 'example-model:7b', params: '7B' }],
    }));
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Measure' }));
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(runLocalLlmAssessment).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('presents unmeasured models as an open question, not as a poor choice', async () => {
    getLocalLlmAssessments.mockResolvedValue(report({
      unassessed: [{ backend: 'lmstudio', modelId: 'example-model:14b', params: '14B' }],
    }));
    renderPanel();
    expect(await screen.findByText(/Not yet measured \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/not a mark against them/)).toBeInTheDocument();
  });

  // Two measurements at once measure the contention between them, not the
  // models — so the queue holding the provider has to quiet the per-model buttons.
  it('disables the per-model Measure button while the sweep holds the provider', async () => {
    getLocalLlmAssessments.mockResolvedValue(report({
      unassessed: [{ backend: 'ollama', modelId: 'example-model:7b', params: '7B' }],
    }));
    getLocalLlmAssessmentSweep.mockResolvedValue({ status: 'running', total: 4, completed: 1, current: null, results: [] });
    renderPanel();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Measure' })).toBeDisabled());
  });

  it('re-reads the ranking once the sweep finishes, so the morning view is current', async () => {
    const user = userEvent.setup();
    getLocalLlmAssessmentSweep.mockResolvedValue({ status: 'running', total: 2, completed: 1, current: null, results: [] });
    cancelLocalLlmAssessmentSweep.mockResolvedValue({ status: 'cancelled', total: 2, completed: 1, current: null, results: [] });
    renderPanel();

    await user.click(await screen.findByRole('button', { name: /stop sweep/i }));
    // Once for the mount, once because the queue's evidence just changed.
    await waitFor(() => expect(getLocalLlmAssessments).toHaveBeenCalledTimes(2));
  });

  it('renders throughput in tokens/s when the runtime reported token counts', async () => {
    getLocalLlmAssessments.mockResolvedValue(report({
      ranked: [rankedEntry({ performance: { ...rankedEntry().performance, meanTokensPerSecond: 58.5, tokensEstimated: false } })],
    }));
    renderPanel();
    expect(await screen.findByText(/58.5 tok\/s/)).toBeInTheDocument();
  });

  it('shows chars/s alone for a runtime that reported no token counts', async () => {
    getLocalLlmAssessments.mockResolvedValue(report({ ranked: [rankedEntry()] }));
    renderPanel();
    expect(await screen.findByText('120 chars/s')).toBeInTheDocument();
    expect(screen.queryByText(/tok\/s/)).not.toBeInTheDocument();
  });

  it('refetches for the selected intent', async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(getLocalLlmAssessments).toHaveBeenCalledWith('balanced', { silent: true }));
    await user.selectOptions(screen.getByLabelText('Rank for'), 'fastest');
    await waitFor(() => expect(getLocalLlmAssessments).toHaveBeenCalledWith('fastest', { silent: true }));
  });

  it('drops a discarded measurement from local state and returns it to the unmeasured list', async () => {
    const user = userEvent.setup();
    getLocalLlmAssessments.mockResolvedValue(report({
      ranked: [rankedEntry()],
      assessments: [{ backend: 'ollama', modelId: 'example-model:7b' }],
    }));
    deleteLocalLlmAssessment.mockResolvedValue({ success: true });
    renderPanel();

    await user.click(await screen.findByRole('button', { name: /discard the measurement/i }));
    await waitFor(() => expect(screen.getByText(/Not yet measured \(1\)/)).toBeInTheDocument());
    expect(deleteLocalLlmAssessment).toHaveBeenCalledWith('ollama', 'example-model:7b', '', { silent: true });
  });

  it('aborts an in-flight run when the user stops it, without toasting a failure', async () => {
    const user = userEvent.setup();
    getLocalLlmAssessments.mockResolvedValue(report({
      unassessed: [{ backend: 'ollama', modelId: 'example-model:7b', params: '7B' }],
    }));
    // A run occupies the local provider for minutes; every exit the drawer
    // offers must stay live and actually abort, not merely close over a job
    // still running — including the header's icon-only close button, which has
    // to announce that it stops the run rather than "Close".
    let capturedSignal;
    runLocalLlmAssessment.mockImplementation((_payload, options) => {
      capturedSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('Server unreachable')));
      });
    });
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Measure' }));
    await user.click(screen.getByRole('button', { name: /run assessment/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Stop the assessment' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(capturedSignal.aborted).toBe(true));
    // The abort is what the user asked for — it must not surface as an error.
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('aborts a run in flight when the panel unmounts', async () => {
    const user = userEvent.setup();
    getLocalLlmAssessments.mockResolvedValue(report({
      unassessed: [{ backend: 'ollama', modelId: 'example-model:7b', params: '7B' }],
    }));
    let capturedSignal;
    runLocalLlmAssessment.mockImplementation((_payload, options) => {
      capturedSignal = options.signal;
      return new Promise(() => {});
    });
    const { unmount } = renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Measure' }));
    await user.click(screen.getByRole('button', { name: /run assessment/i }));
    await waitFor(() => expect(capturedSignal).toBeDefined());

    unmount();
    expect(capturedSignal.aborted).toBe(true);
  });

  it('explains a model that ran but was excluded from the ranking', async () => {
    getLocalLlmAssessments.mockResolvedValue(report({
      excluded: [{ backend: 'ollama', modelId: 'example-model:70b', verdict: 'does-not-fit', reason: 'out of memory' }],
    }));
    renderPanel();
    expect(await screen.findByText('example-model:70b')).toBeInTheDocument();
    expect(screen.getByText('Does not fit')).toBeInTheDocument();
    expect(screen.getByText('out of memory')).toBeInTheDocument();
  });

  it('warns when a backend model list could not be read instead of implying it is empty', async () => {
    getLocalLlmAssessments.mockResolvedValue(report({ listErrors: ['lmstudio'] }));
    renderPanel();
    expect(await screen.findByText(/Could not list installed models for LM Studio/)).toBeInTheDocument();
  });

  describe('stale measurements', () => {
    it('flags a reading taken on a different machine state and says what changed', async () => {
      getLocalLlmAssessments.mockResolvedValue(report({
        ranked: [rankedEntry({
          staleness: {
            comparable: true,
            stale: true,
            changes: [{ field: 'totalMemoryGb', label: 'installed memory', from: 32, to: 64 }],
            description: 'Measured on a different machine state — installed memory 32 → 64.',
          },
        })],
      }));
      renderPanel();

      expect(await screen.findByText('stale')).toBeInTheDocument();
      expect(screen.getByText(/installed memory 32 → 64/)).toBeInTheDocument();
      expect(screen.getByText(/Measure again to refresh it/)).toBeInTheDocument();
    });

    it('says nothing when the reading still matches this machine', async () => {
      getLocalLlmAssessments.mockResolvedValue(report({
        ranked: [rankedEntry({ staleness: { comparable: true, stale: false, changes: [], description: null } })],
      }));
      renderPanel();

      await screen.findByText('example-model:7b');
      expect(screen.queryByText('stale')).not.toBeInTheDocument();
    });

    it('does not claim freshness for a record nothing could be compared against', async () => {
      // `comparable: false` is UNKNOWN, not current — it must not render a
      // stale warning either way.
      getLocalLlmAssessments.mockResolvedValue(report({
        ranked: [rankedEntry({ staleness: { comparable: false, stale: false, changes: [], description: null } })],
      }));
      renderPanel();

      await screen.findByText('example-model:7b');
      expect(screen.queryByText('stale')).not.toBeInTheDocument();
    });
  });

  describe('run progress', () => {
    const emitProgress = (frame) => {
      // Replay whatever handler the component registered on the shared event.
      for (const [event, handler] of socket.on.mock.calls) {
        if (event === 'localLlm:progress') act(() => handler(frame));
      }
    };

    const startRun = async () => {
      const user = userEvent.setup();
      getLocalLlmAssessments.mockResolvedValue(report({
        unassessed: [{ backend: 'ollama', modelId: 'example-model:7b', params: '7B' }],
      }));
      // Never resolves during the test — the run stays in flight so progress renders.
      runLocalLlmAssessment.mockImplementation(() => new Promise(() => {}));
      renderPanel();
      await user.click(await screen.findByRole('button', { name: 'Measure' }));
      await user.click(await screen.findByRole('button', { name: /run assessment/i }));
      return user;
    };

    it('renders per-sample progress from the shared localLlm:progress event', async () => {
      await startRun();
      emitProgress({
        scope: 'assessment', backend: 'ollama', modelId: 'example-model:7b',
        event: 'start', sampleIndex: 1, sampleCount: 3, message: 'example-model:7b: sample 2/3 at 4,096 tokens of context…',
      });
      expect(await screen.findByText(/sample 2\/3 at 4,096 tokens/)).toBeInTheDocument();
    });

    it('ignores frames from an unrelated model pull on the same channel', async () => {
      await startRun();
      emitProgress({ event: 'start', message: 'other-model:70b: pulling 42%' });
      emitProgress({
        scope: 'assessment', backend: 'ollama', modelId: 'some-other-model:3b',
        event: 'start', sampleIndex: 1, sampleCount: 3, message: 'some-other-model:3b: sample 2/3',
      });
      await waitFor(() => expect(screen.queryByText(/pulling 42%/)).not.toBeInTheDocument());
      expect(screen.queryByText(/some-other-model/)).not.toBeInTheDocument();
      // …and the panel is still live: its OWN frame renders right after.
      emitProgress({
        scope: 'assessment', backend: 'ollama', modelId: 'example-model:7b',
        event: 'start', sampleIndex: 0, sampleCount: 3, message: 'example-model:7b: sample 1/3',
      });
      expect(await screen.findByText(/sample 1\/3/)).toBeInTheDocument();
    });

    it('unsubscribes on unmount so a late frame cannot update a dead panel', async () => {
      getLocalLlmAssessments.mockResolvedValue(report());
      const { unmount } = renderPanel();
      await screen.findByText(/Nothing measured yet/);
      unmount();
      expect(socket.off).toHaveBeenCalledWith('localLlm:progress', expect.any(Function));
    });
  });
});

// ---------------------------------------------------------------------------
// Runtimes and launch tuning
// ---------------------------------------------------------------------------

describe('LocalModelAssessments — runtimes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    idleSweep();
    getLocalLlmAssessments.mockResolvedValue(report());
  });

  it('lists every assessable runtime from the report, not a hardcoded set', async () => {
    renderPanel();
    for (const label of ['Ollama', 'llama.cpp', 'MTPLX']) {
      expect(await screen.findByText(label)).toBeInTheDocument();
    }
  });

  // A stopped daemon must not read as "0 models" — that says "nothing
  // installed" when the fix is to start it.
  it('shows an unreachable runtime as unreachable, never as zero models', async () => {
    renderPanel();
    expect(await screen.findByText('unreachable')).toBeInTheDocument();
    expect(screen.getByText('1 model')).toBeInTheDocument();
    expect(screen.getByText('3 models')).toBeInTheDocument();
  });

  it('names a runtime by its server-supplied label on a ranked row', async () => {
    getLocalLlmAssessments.mockResolvedValue(report({
      ranked: [rankedEntry({ backend: 'llama', modelId: 'dflash' })],
    }));
    renderPanel();
    expect(await screen.findByText('dflash')).toBeInTheDocument();
    // Once in the roster, once on the row.
    expect(screen.getAllByText('llama.cpp').length).toBeGreaterThan(1);
  });
});

describe('LocalModelAssessments — tuning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    idleSweep();
    getLocalLlmAssessments.mockResolvedValue(report({
      unassessed: [{ backend: 'llama', modelId: 'dflash', params: null }],
    }));
  });

  it('sends the knobs the user set with the run', async () => {
    runLocalLlmAssessment.mockResolvedValue({ verdict: 'fits', tuningApplied: true });
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Measure' }));
    await user.click(await screen.findByRole('button', { name: /Tuning/ }));
    await user.type(screen.getByLabelText('Micro-batch size'), '512');
    await user.click(screen.getByRole('button', { name: 'Run assessment' }));
    await waitFor(() => expect(runLocalLlmAssessment).toHaveBeenCalledWith(
      { backend: 'llama', modelId: 'dflash', tuning: { ubatchSize: 512 } },
      expect.objectContaining({ silent: true }),
    ));
  });

  // An empty field means "leave the daemon on its own default". Sending 0 would
  // pin a value the user never chose.
  it('omits an untouched knob rather than sending a zero', async () => {
    runLocalLlmAssessment.mockResolvedValue({ verdict: 'fits', tuningApplied: true });
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Measure' }));
    await user.click(await screen.findByRole('button', { name: /Tuning/ }));
    await user.click(screen.getByRole('button', { name: 'Run assessment' }));
    await waitFor(() => expect(runLocalLlmAssessment).toHaveBeenCalledWith(
      expect.objectContaining({ tuning: {} }),
      expect.anything(),
    ));
  });

  // Naming the transport, not just "applied": the user is choosing flags to
  // pass a model, so the form has to say which flag each knob becomes. The
  // sentence is derived server-side and rides on the spec.
  it('names the transport that carries each knob to the daemon', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Measure' }));
    await user.click(await screen.findByRole('button', { name: /Tuning/ }));
    expect(screen.getAllByText(/puts this on the server's launch line/).length).toBe(2);
  });

  it('names the environment variable an Ollama knob is applied through', async () => {
    getLocalLlmAssessments.mockResolvedValue(report({
      unassessed: [{ backend: 'ollama', modelId: 'example-model:7b', params: null }],
    }));
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Measure' }));
    await user.click(await screen.findByRole('button', { name: /Tuning/ }));
    expect(screen.getByText(/restarts the server with OLLAMA_CONTEXT_LENGTH set/)).toBeInTheDocument();
  });

  it('warns instead of celebrating when the tuning never reached the daemon', async () => {
    runLocalLlmAssessment.mockResolvedValue({
      verdict: 'fits', tuningKey: 'ubatchSize=512', tuningApplied: false, tuningNotApplied: 'llama-server is not running',
    });
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Measure' }));
    await user.click(screen.getByRole('button', { name: 'Run assessment' }));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(expect.stringMatching(/tuning not applied/)));
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe('LocalModelAssessments — tuning comparison', () => {
  beforeEach(() => { vi.clearAllMocks(); idleSweep(); });

  it('shows each tuning against the winner once a model has two', async () => {
    getLocalLlmAssessments.mockResolvedValue(report({
      tuningComparison: [{
        backend: 'llama',
        modelId: 'dflash',
        best: { tuning: { ubatchSize: 512 }, label: 'Micro-batch size 512', charsPerSecond: 120 },
        variants: [
          { tuning: { ubatchSize: 512 }, label: 'Micro-batch size 512', charsPerSecond: 120, deltaPercent: 100, maxWorkingContextTokens: 16384, assessedAt: null },
          { tuning: {}, label: 'Backend defaults', charsPerSecond: 90, deltaPercent: 75, maxWorkingContextTokens: 16384, assessedAt: null },
        ],
      }],
    }));
    renderPanel();
    expect(await screen.findByText('Tuning comparison')).toBeInTheDocument();
    expect(screen.getByText('Micro-batch size 512')).toBeInTheDocument();
    expect(screen.getByText('75%')).toBeInTheDocument();
  });

  it('renders nothing when no model has been measured under two tunings', async () => {
    getLocalLlmAssessments.mockResolvedValue(report());
    renderPanel();
    await screen.findByText('Ollama');
    expect(screen.queryByText('Tuning comparison')).toBeNull();
  });

  it('labels an untuned reading as backend defaults, not as a blank', async () => {
    getLocalLlmAssessments.mockResolvedValue(report({ ranked: [rankedEntry()] }));
    renderPanel();
    expect(await screen.findByText('backend defaults')).toBeInTheDocument();
  });
});

// A model can hold several measurements, one per launch tuning. Every action on
// a row therefore has to target THAT measurement — keying on the model alone
// gave two variants the same React key and pointed discard/re-measure at the
// backend-defaults record.
describe('LocalModelAssessments — one row per tuning', () => {
  const tunedEntry = () => rankedEntry({
    backend: 'llama',
    modelId: 'dflash',
    tuningKey: 'ubatchSize=512',
    tuning: { ubatchSize: 512 },
    tuningLabel: 'Micro-batch size 512',
  });

  beforeEach(() => {
    vi.clearAllMocks();
    idleSweep();
    getLocalLlmAssessments.mockResolvedValue(report({
      ranked: [rankedEntry({ backend: 'llama', modelId: 'dflash', tuningKey: '' }), tunedEntry()],
      assessments: [{ backend: 'llama', modelId: 'dflash', tuningKey: '' }, { backend: 'llama', modelId: 'dflash', tuningKey: 'ubatchSize=512' }],
    }));
  });

  it('labels each variant by its own tuning, not all as backend defaults', async () => {
    renderPanel();
    expect(await screen.findByText('Micro-batch size 512')).toBeInTheDocument();
    expect(screen.getByText('backend defaults')).toBeInTheDocument();
  });

  it('discards the tuning the row names, not the backend-defaults record', async () => {
    deleteLocalLlmAssessment.mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderPanel();
    const buttons = await screen.findAllByRole('button', { name: /Discard the measurement for dflash/ });
    // Ranked order puts the tuned row second (both score alike, tie broken on
    // tuning signature: '' sorts before 'ubatchSize=512').
    await user.click(buttons[1]);
    await waitFor(() => expect(deleteLocalLlmAssessment)
      .toHaveBeenCalledWith('llama', 'dflash', 'ubatchSize=512', { silent: true }));
  });

  // Re-measure should reproduce the configuration that produced the row, so
  // adjusting one knob is a one-field edit rather than re-entering the set.
  it('pre-fills a re-measure from the row\'s own tuning', async () => {
    runLocalLlmAssessment.mockResolvedValue({ verdict: 'fits', tuningApplied: true });
    const user = userEvent.setup();
    renderPanel();
    const remeasure = await screen.findAllByRole('button', { name: /Measure dflash again/ });
    await user.click(remeasure[1]);
    await user.click(await screen.findByRole('button', { name: 'Run assessment' }));
    await waitFor(() => expect(runLocalLlmAssessment).toHaveBeenCalledWith(
      expect.objectContaining({ tuning: { ubatchSize: 512 } }),
      expect.anything(),
    ));
  });

  // A reading whose configuration never reached the daemon is never RANKED —
  // the server pulls it into `excluded` (`getAssessmentReport`), which is where
  // the sentence has to land. Asserting it on a ranked row would pass against a
  // hand-built fixture the server can never produce.
  it('explains an excluded row whose tuning never reached the daemon', async () => {
    getLocalLlmAssessments.mockResolvedValue(report({
      excluded: [{
        backend: 'llama',
        modelId: 'dflash',
        tuningKey: 'ubatchSize=512',
        tuningLabel: 'Micro-batch size 512',
        verdict: 'fits',
        reason: 'measured, but the requested tuning was not applied — llama-server is not running',
      }],
    }));
    renderPanel();
    expect(await screen.findByText(/requested tuning was not applied/)).toBeInTheDocument();
  });

  // The untuned counterpart: its chip reads "backend defaults", so the sentence
  // beside it has to name what actually failed rather than contradict the chip.
  it('explains an excluded row the daemon could not be returned to defaults for', async () => {
    getLocalLlmAssessments.mockResolvedValue(report({
      excluded: [{
        backend: 'ollama',
        modelId: 'example-model:7b',
        tuningKey: '',
        tuningLabel: null,
        verdict: 'fits',
        reason: 'measured, but the daemon still carried an earlier tuning — Ollama would not stop',
      }],
    }));
    renderPanel();
    expect(await screen.findByText(/daemon still carried an earlier tuning/)).toBeInTheDocument();
  });
});

describe('LocalModelAssessments — sweep tunings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    idleSweep();
    getLocalLlmAssessments.mockResolvedValue(report());
  });

  const llamaEntry = (overrides = {}) => rankedEntry({ backend: 'llama', modelId: 'example-model.gguf', ...overrides });

  it('opens the tuning consent gate for the model whose button was pressed', async () => {
    const user = userEvent.setup();
    getLocalLlmAssessments.mockResolvedValue(report({ ranked: [llamaEntry()] }));
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Sweep tunings for example-model.gguf' }));

    expect(await screen.findByRole('dialog', { name: 'Sweep tunings' })).toBeInTheDocument();
    // The grid the server shipped, not a count derived here.
    expect(screen.getByText('Micro-batch size 1024')).toBeInTheDocument();
    expect(screen.getByText('Flash attention on')).toBeInTheDocument();
    expect(startLocalLlmAssessmentSweep).not.toHaveBeenCalled();
  });

  // The server ships an empty grid for a runtime a sweep may not drive, so the
  // page offers the action exactly where the server would accept it.
  it('offers no sweep for a runtime the server will not sweep', async () => {
    getLocalLlmAssessments.mockResolvedValue(report({ ranked: [rankedEntry()] }));
    renderPanel();

    await screen.findByText('example-model:7b');
    expect(screen.queryByRole('button', { name: /Sweep tunings for/ })).not.toBeInTheDocument();
  });

  it('starts the sweep the gate described', async () => {
    const user = userEvent.setup();
    getLocalLlmAssessments.mockResolvedValue(report({ ranked: [llamaEntry()] }));
    startLocalLlmAssessmentSweep.mockResolvedValue({ status: 'running', total: 3, completed: 0, results: [] });
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Sweep tunings for example-model.gguf' }));
    await user.click(screen.getByRole('button', { name: /start sweep/i }));

    await waitFor(() => expect(startLocalLlmAssessmentSweep).toHaveBeenCalledWith({
      backend: 'llama', modelId: 'example-model.gguf', tunings: true,
    }));
  });

  // Every per-model action goes quiet while the server-side queue holds the
  // provider — a run started on top of it would measure the contention.
  it('goes quiet while a sweep is already running', async () => {
    getLocalLlmAssessments.mockResolvedValue(report({ ranked: [llamaEntry()] }));
    getLocalLlmAssessmentSweep.mockResolvedValue({
      status: 'running', total: 3, completed: 1, current: { backend: 'llama', modelId: 'example-model.gguf' }, results: [],
    });
    renderPanel();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Sweep tunings for example-model.gguf' })).toBeDisabled());
  });
});

// The measure gate is a routable drawer, not a modal: which model is open lives
// in the URL, so it is shareable, bookmarkable, and survives a reload — the same
// rule the AI-provider editor follows at /ai/edit/:providerId.
describe('LocalModelAssessments — routable measure drawer', () => {
  const tunedEntry = () => rankedEntry({
    backend: 'llama',
    modelId: 'dflash',
    tuningKey: 'ubatchSize=512',
    tuning: { ubatchSize: 512 },
    tuningLabel: 'Micro-batch size 512',
  });

  beforeEach(() => {
    vi.clearAllMocks();
    idleSweep();
    getLocalLlmAssessments.mockResolvedValue(report({
      unassessed: [{ backend: 'ollama', modelId: 'example-model:7b', params: '7B' }],
    }));
  });

  it('puts the model it opens on in the URL rather than local state', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Measure' }));
    await waitFor(() => expect(currentUrl()).toBe(
      '/models/performance?measureBackend=ollama&measureModel=example-model%3A7b',
    ));
  });

  it('opens straight from a deep link, with no click to get there', async () => {
    renderPanel('/models/performance?measureBackend=ollama&measureModel=example-model%3A7b');

    expect(await screen.findByRole('dialog', { name: 'Measure this model' })).toBeInTheDocument();
    expect(screen.getByText(/512, 4K, 16K tokens of context/)).toBeInTheDocument();
  });

  // The tuning a re-measure starts from rides on the record the URL names, so a
  // reloaded deep link has to resolve that record — not fall back to defaults.
  it('seeds the tuning form from the record a deep link names', async () => {
    getLocalLlmAssessments.mockResolvedValue(report({ ranked: [tunedEntry()] }));
    runLocalLlmAssessment.mockResolvedValue({ verdict: 'fits', tuningApplied: true });
    const user = userEvent.setup();
    renderPanel('/models/performance?measureBackend=llama&measureModel=dflash&measureTuning=ubatchSize%3D512');

    await user.click(await screen.findByRole('button', { name: 'Run assessment' }));
    await waitFor(() => expect(runLocalLlmAssessment).toHaveBeenCalledWith(
      expect.objectContaining({ tuning: { ubatchSize: 512 } }),
      expect.anything(),
    ));
  });

  // A link whose model the report no longer lists still opens — the URL is what
  // is open — but it says the row is gone instead of presenting a run as normal.
  it('says so when the model a link names is not in the current list', async () => {
    renderPanel('/models/performance?measureBackend=ollama&measureModel=gone:7b');

    expect(await screen.findByText(/not in the current list/)).toBeInTheDocument();
  });

  it('clears the URL when the drawer is dismissed', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Measure' }));
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(currentUrl()).toBe('/models/performance'));
    expect(runLocalLlmAssessment).not.toHaveBeenCalled();
  });

  it('clears the URL once a run lands', async () => {
    runLocalLlmAssessment.mockResolvedValue({ verdict: 'fits' });
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Measure' }));
    await user.click(screen.getByRole('button', { name: 'Run assessment' }));
    await waitFor(() => expect(currentUrl()).toBe('/models/performance'));
  });
});

// The per-model "Sweep tunings" gate is routable for the same reasons as its
// neighbour: it targets one model, so which model it is open on lives in the URL
// rather than evaporating on a reload. Only the model pair rides in the link —
// the runtime label and the grid are derived from the report, so a shared link
// always describes what the server would actually run today.
describe('LocalModelAssessments — routable tuning-sweep drawer', () => {
  const llamaEntry = () => rankedEntry({ backend: 'llama', modelId: 'example-model.gguf' });

  beforeEach(() => {
    vi.clearAllMocks();
    idleSweep();
    getLocalLlmAssessments.mockResolvedValue(report({ ranked: [llamaEntry()] }));
  });

  it('puts the model it opens on in the URL rather than local state', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Sweep tunings for example-model.gguf' }));
    await waitFor(() => expect(currentUrl()).toBe(
      '/models/performance?sweepBackend=llama&sweepModel=example-model.gguf',
    ));
  });

  it('opens straight from a deep link, with no click to get there', async () => {
    renderPanel('/models/performance?sweepBackend=llama&sweepModel=example-model.gguf');

    expect(await screen.findByRole('dialog', { name: 'Sweep tunings' })).toBeInTheDocument();
    // The grid the server shipped for that runtime, resolved from the report —
    // it was never in the link.
    expect(screen.getByText('Micro-batch size 1024')).toBeInTheDocument();
    expect(screen.getByText(/llama\.cpp is restarted between each one/)).toBeInTheDocument();
    expect(startLocalLlmAssessmentSweep).not.toHaveBeenCalled();
  });

  // A sweep varies the tuning, so it targets the MODEL: a model with several
  // recorded configurations is one sweep target, not one per row.
  it('resolves a model whose only rows carry their own tunings', async () => {
    getLocalLlmAssessments.mockResolvedValue(report({
      ranked: [rankedEntry({
        backend: 'llama', modelId: 'example-model.gguf', tuningKey: 'ubatchSize=1024', tuningLabel: 'Micro-batch size 1024',
      })],
    }));
    renderPanel('/models/performance?sweepBackend=llama&sweepModel=example-model.gguf');

    await screen.findByRole('dialog', { name: 'Sweep tunings' });
    expect(screen.queryByText(/not in the current list/)).not.toBeInTheDocument();
  });

  it('says so when the model a link names is not in the current list', async () => {
    renderPanel('/models/performance?sweepBackend=llama&sweepModel=gone.gguf');

    expect(await screen.findByText(/not in the current list/)).toBeInTheDocument();
  });

  it('clears the URL when the gate is dismissed', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Sweep tunings for example-model.gguf' }));
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(currentUrl()).toBe('/models/performance'));
    expect(startLocalLlmAssessmentSweep).not.toHaveBeenCalled();
  });

  it('clears the URL once the sweep is queued', async () => {
    const user = userEvent.setup();
    startLocalLlmAssessmentSweep.mockResolvedValue({ status: 'running', total: 3, completed: 0, results: [] });
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Sweep tunings for example-model.gguf' }));
    await user.click(screen.getByRole('button', { name: /start sweep/i }));
    await waitFor(() => expect(currentUrl()).toBe('/models/performance'));
  });

  // A Drawer assumes it is the only one open — one scroll lock, one focus trap —
  // so a hand-edited link naming both gates must resolve to exactly one panel,
  // not stack two. The measure gate wins: it is the one that can be mid-run.
  it('opens one drawer, not two, for a link that names both gates', async () => {
    renderPanel(
      '/models/performance?measureBackend=llama&measureModel=example-model.gguf'
      + '&sweepBackend=llama&sweepModel=example-model.gguf',
    );

    expect(await screen.findByRole('dialog', { name: 'Measure this model' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Sweep tunings' })).not.toBeInTheDocument();
  });

  // ...and dismissing the one on screen closes the page, rather than closing
  // straight into the gate the same link also named — which would read as the
  // dismissal not having worked.
  it('dismisses both targets, not just the one on screen', async () => {
    const user = userEvent.setup();
    renderPanel(
      '/models/performance?measureBackend=llama&measureModel=example-model.gguf'
      + '&sweepBackend=llama&sweepModel=example-model.gguf',
    );

    await screen.findByRole('dialog', { name: 'Measure this model' });
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));

    await waitFor(() => expect(currentUrl()).toBe('/models/performance'));
    expect(screen.queryByRole('dialog', { name: 'Sweep tunings' })).not.toBeInTheDocument();
  });

  // Opening one clears the other's params, so the URL never accumulates a target
  // for a gate that is not on screen.
  it('drops a stale measure target from the URL when the sweep gate opens', async () => {
    const user = userEvent.setup();
    renderPanel('/models/performance?measureBackend=llama&measureModel=example-model.gguf');

    await screen.findByRole('dialog', { name: 'Measure this model' });
    await user.click(await screen.findByRole('button', { name: 'Sweep tunings for example-model.gguf' }));

    await waitFor(() => expect(currentUrl()).toBe(
      '/models/performance?sweepBackend=llama&sweepModel=example-model.gguf',
    ));
    expect(screen.queryByRole('dialog', { name: 'Measure this model' })).not.toBeInTheDocument();
  });
});

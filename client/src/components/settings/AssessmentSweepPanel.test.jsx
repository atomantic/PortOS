import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../services/api', () => ({
  getLocalLlmAssessmentSweep: vi.fn(),
  startLocalLlmAssessmentSweep: vi.fn(),
  cancelLocalLlmAssessmentSweep: vi.fn(),
}));

vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

vi.mock('../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));

import {
  getLocalLlmAssessmentSweep, startLocalLlmAssessmentSweep, cancelLocalLlmAssessmentSweep,
} from '../../services/api';
import socket from '../../services/socket';
import AssessmentSweepPanel from './AssessmentSweepPanel.jsx';

const idle = { status: 'idle', scope: null, total: 0, completed: 0, current: null, results: [], startedAt: null, finishedAt: null };

const counts = { unmeasured: 2, stale: 1, all: 4 };

const renderPanel = (props = {}) => render(
  <AssessmentSweepPanel counts={counts} contextTokens={[512, 4096, 16384]} onSweepFinished={vi.fn()} {...props} />
);

beforeEach(() => {
  vi.clearAllMocks();
  getLocalLlmAssessmentSweep.mockResolvedValue(idle);
});

describe('AssessmentSweepPanel', () => {
  // The AI Provider Usage Policy gate: a batch of provider calls has to be
  // preceded by a statement of exactly what will run.
  it('names the model and generation count before anything is queued', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Measure all models' }));
    expect(startLocalLlmAssessmentSweep).not.toHaveBeenCalled();
    expect(screen.getByText(/Measure every model\?/)).toBeInTheDocument();
    // 2 unmeasured models × 3 context lengths = 6 generations, spelled out.
    expect(screen.getByText(/short generations in total/)).toBeInTheDocument();
    expect(screen.getByText('6')).toBeInTheDocument();
    expect(screen.getByText(/512, 4K, 16K tokens of context/)).toBeInTheDocument();
  });

  it('starts the scope the user picked', async () => {
    const user = userEvent.setup();
    startLocalLlmAssessmentSweep.mockResolvedValue({ ...idle, status: 'running', total: 4 });
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Measure all models' }));
    await user.click(screen.getByLabelText(/Everything installed/));
    await user.click(screen.getByRole('button', { name: /start sweep/i }));

    await waitFor(() => expect(startLocalLlmAssessmentSweep).toHaveBeenCalledWith({ scope: 'all' }));
  });

  it('defaults to the first scope that has something to do', async () => {
    const user = userEvent.setup();
    startLocalLlmAssessmentSweep.mockResolvedValue({ ...idle, status: 'running', total: 1 });
    renderPanel({ counts: { unmeasured: 0, stale: 3, all: 3 } });

    await user.click(await screen.findByRole('button', { name: 'Measure all models' }));
    await user.click(screen.getByRole('button', { name: /start sweep/i }));
    await waitFor(() => expect(startLocalLlmAssessmentSweep).toHaveBeenCalledWith({ scope: 'stale' }));
  });

  it('does not queue anything when the ask is cancelled', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Measure all models' }));
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(startLocalLlmAssessmentSweep).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText(/Measure every model\?/)).not.toBeInTheDocument());
  });

  // The queue is server state. A sweep started in another tab, or before a
  // reload, has to show up here — otherwise the page offers to start a second one.
  it('picks up a sweep that was already running when it mounted', async () => {
    getLocalLlmAssessmentSweep.mockResolvedValue({
      ...idle, status: 'running', total: 5, completed: 2,
      current: { backend: 'ollama', modelId: 'example-model:14b' },
    });
    renderPanel();

    expect(await screen.findByText(/2\/5 models measured/)).toBeInTheDocument();
    expect(screen.getByText(/example-model:14b/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /stop sweep/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Measure all models' })).not.toBeInTheDocument();
  });

  it('says the run outlives the tab, because that is the whole point of it', async () => {
    getLocalLlmAssessmentSweep.mockResolvedValue({ ...idle, status: 'running', total: 3, completed: 0 });
    renderPanel();
    expect(await screen.findByText(/close this tab/i)).toBeInTheDocument();
  });

  it('stops the queue and lets the parent re-read what it measured', async () => {
    const user = userEvent.setup();
    const onSweepFinished = vi.fn();
    getLocalLlmAssessmentSweep.mockResolvedValue({ ...idle, status: 'running', total: 5, completed: 2 });
    cancelLocalLlmAssessmentSweep.mockResolvedValue({ ...idle, status: 'cancelled', total: 5, completed: 2 });
    renderPanel({ onSweepFinished });

    await user.click(await screen.findByRole('button', { name: /stop sweep/i }));
    await waitFor(() => expect(cancelLocalLlmAssessmentSweep).toHaveBeenCalled());
    // Two measurements are real evidence even though the run was abandoned.
    await waitFor(() => expect(onSweepFinished).toHaveBeenCalled());
  });

  // Results are what you read the next morning — they must survive the queue
  // ending rather than disappearing with the progress bar.
  it('keeps the finished results on screen after the sweep ends', async () => {
    getLocalLlmAssessmentSweep.mockResolvedValue({
      ...idle,
      status: 'complete',
      total: 2,
      completed: 2,
      finishedAt: '2026-01-01T00:00:00.000Z',
      results: [
        { backend: 'ollama', modelId: 'fast-model', verdict: 'fits', error: null, meanTokensPerSecond: 61, finishedAt: '2026-01-01T00:00:00.000Z' },
        { backend: 'ollama', modelId: 'big-model', verdict: 'does-not-fit', error: null, meanTokensPerSecond: null, meanCharsPerSecond: null, finishedAt: '2026-01-01T00:01:00.000Z' },
      ],
    });
    renderPanel();

    expect(await screen.findByText(/Sweep results \(2\)/)).toBeInTheDocument();
    expect(screen.getByText('fast-model')).toBeInTheDocument();
    expect(screen.getByText(/fits — 61 tok\/s/)).toBeInTheDocument();
    expect(screen.getByText('does-not-fit')).toBeInTheDocument();
  });

  it('falls back to chars/s for a runtime that reported no token counts', async () => {
    getLocalLlmAssessmentSweep.mockResolvedValue({
      ...idle,
      status: 'complete',
      total: 1,
      completed: 1,
      results: [{ backend: 'llama', modelId: 'quiet-model', verdict: 'fits', error: null, meanTokensPerSecond: null, meanCharsPerSecond: 240, finishedAt: '2026-01-01T00:00:00.000Z' }],
    });
    renderPanel();
    expect(await screen.findByText(/fits — 240 chars\/s/)).toBeInTheDocument();
  });

  it('subscribes to the shared progress event and filters out unrelated frames', async () => {
    getLocalLlmAssessmentSweep.mockResolvedValue({ ...idle, status: 'running', total: 2, completed: 0 });
    renderPanel();
    await screen.findByText(/0\/2 models measured/);

    const handler = socket.on.mock.calls.find(([event]) => event === 'localLlm:progress')[1];
    // A model PULL streams on the same event, in the shape the install route
    // actually emits (`{ event, message }`, no scope) — it must not drive this line.
    await act(async () => handler({ event: 'progress', message: 'pulling manifest' }));
    expect(screen.queryByText('pulling manifest')).not.toBeInTheDocument();

    await act(async () => handler({ scope: 'assessment', message: 'example-model: sample 2/3 at 4,096 tokens…' }));
    expect(await screen.findByText(/sample 2\/3/)).toBeInTheDocument();
  });

  // A sweep started in another tab has to re-arm this tab's finish latch, or its
  // completion lands with the latch still set from an earlier run and the ranking
  // it just earned is never re-read.
  it('re-reads the report when a sweep it did not start finishes', async () => {
    const onSweepFinished = vi.fn();
    getLocalLlmAssessmentSweep.mockResolvedValue({ ...idle, status: 'running', total: 2, completed: 1 });
    renderPanel({ onSweepFinished });
    await screen.findByText(/1\/2 models measured/);

    getLocalLlmAssessmentSweep.mockResolvedValue({ ...idle, status: 'complete', total: 2, completed: 2 });
    const handler = socket.on.mock.calls.find(([event]) => event === 'localLlm:progress')[1];
    await act(async () => handler({ scope: 'assessment-sweep', event: 'complete', status: 'complete' }));

    await waitFor(() => expect(onSweepFinished).toHaveBeenCalledTimes(1));
  });

  it('offers nothing to press when no runtime lists a model to measure', async () => {
    renderPanel({ counts: { unmeasured: 0, stale: 0, all: 0 } });
    expect(await screen.findByRole('button', { name: 'Measure all models' })).toBeDisabled();
  });

  it('is disabled while a single-model run already holds the provider', async () => {
    renderPanel({ disabled: true });
    expect(await screen.findByRole('button', { name: 'Measure all models' })).toBeDisabled();
  });
});

describe('AssessmentSweepPanel — tuning sweep', () => {
  const tuningRequest = {
    backend: 'llama',
    modelId: 'example-model.gguf',
    runtimeLabel: 'llama.cpp',
    variants: [
      { key: '', label: null },
      { key: 'flashAttn=true', label: 'Flash attention on' },
      { key: 'ubatchSize=1024', label: 'Micro-batch size 1024' },
    ],
  };

  // The AI Provider Usage Policy gate, in the shape a tuning sweep needs it: the
  // variant count and the total generation count are numbers the user cannot
  // read anywhere else before committing hours of GPU.
  it('names the variant count, the generation count, and every configuration', async () => {
    renderPanel({ tuningRequest });

    expect(await screen.findByRole('dialog', { name: 'Sweep tunings' })).toBeInTheDocument();
    expect(startLocalLlmAssessmentSweep).not.toHaveBeenCalled();
    // 3 variants × 3 context lengths = 9 generations.
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument();
    expect(screen.getByText(/short generations in total/)).toBeInTheDocument();
    expect(screen.getByText('Flash attention on')).toBeInTheDocument();
    expect(screen.getByText('Micro-batch size 1024')).toBeInTheDocument();
  });

  // An unlabelled variant is the baseline, and saying so matters — it is the
  // reading every other one is compared against.
  it('names the unlabelled variant as the backend defaults', async () => {
    renderPanel({ tuningRequest });
    expect(await screen.findByText('Backend defaults')).toBeInTheDocument();
  });

  // Ollama and LM Studio bounce their daemon between variants. A user who does
  // not know that reads the restarts as the sweep crashing.
  it('warns that the runtime restarts between configurations', async () => {
    renderPanel({ tuningRequest });
    expect(await screen.findByText(/llama\.cpp is restarted between each one/)).toBeInTheDocument();
  });

  it('asks the server for the grid rather than posting one', async () => {
    const user = userEvent.setup();
    startLocalLlmAssessmentSweep.mockResolvedValue({ ...idle, status: 'running', total: 3 });
    const onTuningRequestClose = vi.fn();
    renderPanel({ tuningRequest, onTuningRequestClose });

    await user.click(await screen.findByRole('button', { name: /start sweep/i }));

    await waitFor(() => expect(startLocalLlmAssessmentSweep).toHaveBeenCalledWith({
      backend: 'llama', modelId: 'example-model.gguf', tunings: true,
    }));
    expect(onTuningRequestClose).toHaveBeenCalled();
  });

  it('clears the request on cancel without queueing anything', async () => {
    const user = userEvent.setup();
    const onTuningRequestClose = vi.fn();
    renderPanel({ tuningRequest, onTuningRequestClose });

    await user.click(await screen.findByRole('button', { name: /^cancel$/i }));
    expect(onTuningRequestClose).toHaveBeenCalled();
    expect(startLocalLlmAssessmentSweep).not.toHaveBeenCalled();
  });

  // The baseline alone is one measurement with nothing to compare it to — the
  // server refuses it, and the gate must not offer it either.
  it('will not start a sweep with only the baseline in the grid', async () => {
    renderPanel({ tuningRequest: { ...tuningRequest, variants: [{ key: '', label: null }] } });
    expect(await screen.findByRole('button', { name: /start sweep/i })).toBeDisabled();
  });

  // The gate is routable, so its target can outlive the row it was opened from.
  // A deep link to a model the report no longer lists still opens — the URL is
  // what is open — but it says the row is gone rather than presenting hours of
  // GPU as a normal next step.
  it('says so when the model it was pointed at is not in the current list', async () => {
    renderPanel({ tuningRequest: { ...tuningRequest, unknownTarget: true } });
    expect(await screen.findByText(/not in the current list/)).toBeInTheDocument();
  });

  it('says nothing of the sort for a model the report still lists', async () => {
    renderPanel({ tuningRequest });
    await screen.findByRole('dialog', { name: 'Sweep tunings' });
    expect(screen.queryByText(/not in the current list/)).not.toBeInTheDocument();
  });

  // Every step names the same model, so counting models — or printing the model
  // as the thing in flight — would read as one measurement repeating.
  it('counts tunings, not models, while a tuning sweep runs', async () => {
    getLocalLlmAssessmentSweep.mockResolvedValue({
      ...idle,
      status: 'running',
      mode: 'tunings',
      target: { backend: 'llama', modelId: 'example-model.gguf' },
      total: 3,
      completed: 1,
      current: { backend: 'llama', modelId: 'example-model.gguf', tuningLabel: 'Flash attention on' },
    });
    renderPanel();

    expect(await screen.findByText(/1\/3 tunings measured/)).toBeInTheDocument();
    expect(screen.getByText(/Flash attention on/)).toBeInTheDocument();
  });

  it('names the model a finished tuning sweep was measuring', async () => {
    getLocalLlmAssessmentSweep.mockResolvedValue({
      ...idle,
      status: 'complete',
      mode: 'tunings',
      target: { backend: 'llama', modelId: 'example-model.gguf' },
      total: 3,
      completed: 3,
      finishedAt: '2026-01-01T00:00:00.000Z',
    });
    renderPanel();

    expect(await screen.findByText(/3\/3 tunings measured of example-model\.gguf/)).toBeInTheDocument();
  });

  // Every row of a tuning sweep names the same model, so without the
  // configuration the results list reads as one measurement repeated.
  it('names the configuration on every finished measurement', async () => {
    getLocalLlmAssessmentSweep.mockResolvedValue({
      ...idle,
      status: 'complete',
      mode: 'tunings',
      total: 2,
      completed: 2,
      results: [
        { backend: 'llama', modelId: 'example-model.gguf', tuningLabel: null, verdict: 'fits', meanCharsPerSecond: 120 },
        { backend: 'llama', modelId: 'example-model.gguf', tuningLabel: 'Flash attention on', verdict: 'fits', meanCharsPerSecond: 150 },
      ],
    });
    renderPanel();

    expect(await screen.findByText('backend defaults')).toBeInTheDocument();
    expect(screen.getByText('Flash attention on')).toBeInTheDocument();
  });

  // Numbers taken under a tuning that never reached the daemon describe some
  // OTHER configuration — presenting them under the label the row carries is
  // what a tuning comparison must never do.
  it('flags a measurement whose tuning never reached the daemon', async () => {
    getLocalLlmAssessmentSweep.mockResolvedValue({
      ...idle,
      status: 'complete',
      mode: 'tunings',
      total: 1,
      completed: 1,
      results: [{
        backend: 'llama',
        modelId: 'example-model.gguf',
        tuningLabel: 'Flash attention on',
        verdict: 'fits',
        meanCharsPerSecond: 120,
        tuningApplied: false,
        tuningNotApplied: 'llama-server rejected that tuning',
      }],
    });
    renderPanel();

    expect(await screen.findByText(/Tuning not applied — llama-server rejected that tuning/)).toBeInTheDocument();
  });

  // A stopped sweep still holds the machine: its last measurement is aborting
  // and, for a tuning sweep, its launch configuration is still being put back —
  // a relaunch. A reading started into that would record the restart.
  it("keeps the parent per-model actions disabled until the sweep has let go", async () => {
    const onRunningChange = vi.fn();
    getLocalLlmAssessmentSweep.mockResolvedValue({
      ...idle, status: 'cancelled', mode: 'tunings', settled: false, total: 3, completed: 1,
    });
    renderPanel({ onRunningChange });

    await waitFor(() => expect(onRunningChange).toHaveBeenCalledWith(true));
  });

  it('releases them once the sweep has settled', async () => {
    const onRunningChange = vi.fn();
    getLocalLlmAssessmentSweep.mockResolvedValue({
      ...idle, status: 'complete', mode: 'tunings', settled: true, total: 3, completed: 3,
    });
    renderPanel({ onRunningChange });

    await waitFor(() => expect(onRunningChange).toHaveBeenLastCalledWith(false));
  });

  // Stop replaces itself with "Measure all models" several minutes before the
  // machine is free, and the server refuses a sweep while the last one is
  // winding down — so an enabled button here would just collect a 409.
  it('will not let another sweep start while the last one is winding down', async () => {
    getLocalLlmAssessmentSweep.mockResolvedValue({
      ...idle, status: 'cancelled', mode: 'tunings', settled: false, total: 3, completed: 1,
    });
    renderPanel();

    const button = await screen.findByRole('button', { name: 'Measure all models' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', expect.stringContaining('winding down'));
  });

  // The terminal socket frame is not the only way out of the wind-down: lose it
  // to a reconnect and every per-model button would stay disabled forever.
  it('keeps polling through the wind-down so a lost terminal frame cannot wedge it', async () => {
    vi.useFakeTimers();
    getLocalLlmAssessmentSweep.mockResolvedValue({
      ...idle, status: 'cancelled', mode: 'tunings', settled: false, total: 3, completed: 1,
    });
    const onRunningChange = vi.fn();
    renderPanel({ onRunningChange });
    await act(async () => { await Promise.resolve(); });

    getLocalLlmAssessmentSweep.mockResolvedValue({
      ...idle, status: 'cancelled', mode: 'tunings', settled: true, total: 3, completed: 1,
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });

    expect(onRunningChange).toHaveBeenLastCalledWith(false);
    vi.useRealTimers();
  });

  // Stopping refreshes the report immediately (what it measured is real
  // evidence) — but the refresh that matters more is the one AFTER the restore,
  // once the runtime state on the page is the real one rather than a daemon
  // caught mid-relaunch. Latching on the first would swallow the second.
  it('re-reads the report again once a stopped sweep has finished winding down', async () => {
    vi.useFakeTimers();
    const onSweepFinished = vi.fn();
    getLocalLlmAssessmentSweep.mockResolvedValue({
      ...idle, status: 'running', mode: 'tunings', settled: false, total: 3, completed: 1,
    });
    cancelLocalLlmAssessmentSweep.mockResolvedValue({
      ...idle, status: 'cancelled', mode: 'tunings', settled: false, total: 3, completed: 1,
    });
    renderPanel({ onSweepFinished });
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      screen.getByRole('button', { name: /stop sweep/i }).click();
      await Promise.resolve();
    });
    expect(onSweepFinished).toHaveBeenCalledTimes(1);

    // The restore finishes; the poll is what observes it.
    getLocalLlmAssessmentSweep.mockResolvedValue({
      ...idle, status: 'cancelled', mode: 'tunings', settled: true, total: 3, completed: 1,
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });

    expect(onSweepFinished).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  // Mid-wind-down the runtime is being relaunched, so a report read then
  // describes a daemon that is not the one the user will end up with.
  it('does not re-read the report while the sweep is still restoring', async () => {
    vi.useFakeTimers();
    const onSweepFinished = vi.fn();
    getLocalLlmAssessmentSweep.mockResolvedValue({
      ...idle, status: 'cancelled', mode: 'tunings', settled: false, total: 3, completed: 1,
    });
    renderPanel({ onSweepFinished });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });

    expect(onSweepFinished).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  // A sweep that measured everything but could not put the daemon back is not a
  // failed sweep — and the user has to be told, because the runtime is now
  // serving a configuration they did not choose.
  it('says so when the launch configuration was not restored', async () => {
    getLocalLlmAssessmentSweep.mockResolvedValue({
      ...idle,
      status: 'complete',
      mode: 'tunings',
      total: 2,
      completed: 2,
      restoreError: 'llama-server is no longer PortOS-managed',
    });
    renderPanel();

    expect(await screen.findByText(/was not restored: llama-server is no longer PortOS-managed/))
      .toBeInTheDocument();
  });

  it('shows no tuning gate until one is requested', async () => {
    renderPanel();
    await screen.findByRole('button', { name: 'Measure all models' });
    expect(screen.queryByRole('dialog', { name: 'Sweep tunings' })).not.toBeInTheDocument();
  });
});

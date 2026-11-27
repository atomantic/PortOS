import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { retypeSettled } from '../../test/settledInput';
import { findEnabledByRole } from '../../test/enabledBarrier.js';

// Mock the media-jobs API so the queue renders a controlled job list without
// the network. The socket resource fetches once on mount.
const listQueueMediaJobs = vi.fn();
const cancelMediaJob = vi.fn();
const deleteFailedCanceledMediaJobs = vi.fn();
const retryMediaJob = vi.fn();
const previewMediaJobRetry = vi.fn();
const resumeMediaVideoHold = vi.fn();
const listMediaVideoHolds = vi.fn();
vi.mock('../../services/apiMediaJobs.js', () => ({
  listQueueMediaJobs: (...a) => listQueueMediaJobs(...a),
  cancelMediaJob: (...a) => cancelMediaJob(...a),
  cancelQueuedMediaJobs: vi.fn(),
  deleteMediaJob: vi.fn(),
  deleteFailedCanceledMediaJobs: (...a) => deleteFailedCanceledMediaJobs(...a),
  retryMediaJob: (...a) => retryMediaJob(...a),
  previewMediaJobRetry: (...a) => previewMediaJobRetry(...a),
  runMediaJobNow: vi.fn(),
  resumeMediaVideoHold: (...a) => resumeMediaVideoHold(...a),
  listMediaVideoHolds: (...a) => listMediaVideoHolds(...a),
}));

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock('../ui/Toast', () => ({ default: toast }));

const getVideoGenModelContext = vi.fn();
const getTopazJobStatus = vi.fn();
const cancelTopazRemoteJob = vi.fn();
vi.mock('../../services/apiImageVideo.js', () => ({
  getVideoGenModelContext: (...a) => getVideoGenModelContext(...a),
  getVideoHistoryItem: vi.fn(async () => ({ filename: 'source.mp4' })),
  getTopazJobStatus: (...a) => getTopazJobStatus(...a),
  cancelTopazRemoteJob: (...a) => cancelTopazRemoteJob(...a),
  recoverTopazJob: vi.fn(),
  listLorasFull: (...a) => listLorasFull(...a),
  listImageModels: (...a) => listImageModels(...a),
}));
const listLorasFull = vi.fn();
const listImageModels = vi.fn();
vi.mock('../../services/apiSystem.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getSettings: vi.fn(async () => ({})),
}));

const socketHandlers = vi.hoisted(() => new Map());
const socketEmit = vi.hoisted(() => vi.fn());
vi.mock('../../services/socket', () => ({
  default: {
    emit: socketEmit,
    on: (event, handler) => {
      if (!socketHandlers.has(event)) socketHandlers.set(event, new Set());
      socketHandlers.get(event).add(handler);
    },
    off: (event, handler) => socketHandlers.get(event)?.delete(handler),
  },
}));
const emitSocket = (event, payload) => {
  for (const handler of socketHandlers.get(event) ?? []) handler(payload);
};

import MediaJobsQueue from './MediaJobsQueue';

const trainingJob = {
  id: 'train1234deadbeef',
  kind: 'training',
  status: 'running',
  progress: 0.5,
  statusMsg: 'Training step 250/500',
  queuedAt: '2026-06-19T10:00:00Z',
  startedAt: '2026-06-19T10:01:00Z',
  params: {
    runId: 'run-abc',
    runtime: 'mflux',
    characterName: 'Kessa',
    rank: 64,
    steps: 500,
  },
};

beforeEach(() => {
  listQueueMediaJobs.mockReset();
  previewMediaJobRetry.mockReset().mockResolvedValue({ sentPrompt: 'Example' });
  socketEmit.mockClear();
  cancelMediaJob.mockReset().mockResolvedValue({ ok: true, status: 'canceling' });
  deleteFailedCanceledMediaJobs.mockReset();
  toast.mockClear();
  toast.success.mockClear();
  toast.error.mockClear();
  listMediaVideoHolds.mockReset().mockResolvedValue([]);
  resumeMediaVideoHold.mockReset();
  retryMediaJob.mockReset();
  retryMediaJob.mockResolvedValue({ jobId: 'new-job-1234' });
  getVideoGenModelContext.mockReset();
  getVideoGenModelContext.mockResolvedValue({ models: [] });
  listLorasFull.mockReset();
  listLorasFull.mockResolvedValue([]);
  listImageModels.mockReset();
  listImageModels.mockResolvedValue([
    { id: 'z-image-turbo', name: 'Z-Image Turbo', steps: 8, cfgDisabled: true },
    { id: 'flux-dev', name: 'Flux Dev', steps: 25, guidance: 3.5 },
  ]);
});

it('applies only matching progress frames to a running row without rereading the queue', async () => {
  listQueueMediaJobs.mockResolvedValue([trainingJob]);
  const { unmount } = render(<MediaJobsQueue kind="training" />);
  expect(await screen.findByText('50%')).toBeInTheDocument();
  expect(socketEmit).toHaveBeenCalledWith('media-jobs:subscribe');
  await waitFor(() => expect(socketHandlers.get('media-jobs:progress')?.size).toBe(1));

  const progress = { id: trainingJob.id, startedAt: trainingJob.startedAt, progress: 0.7, statusMsg: 'Training step 350/500' };
  act(() => {
    emitSocket('media-jobs:progress', { ...progress, id: 'another-job', progress: 0.9 });
    emitSocket('media-jobs:progress', { ...progress, startedAt: trainingJob.queuedAt, progress: 0.8 });
  });
  expect(screen.getByText('50%')).toBeInTheDocument();

  await act(async () => { emitSocket('media-jobs:progress', progress); });
  expect(screen.getByText('70%')).toBeInTheDocument();
  expect(screen.getByText('Training step 350/500')).toBeInTheDocument();
  expect(listQueueMediaJobs).toHaveBeenCalledTimes(1);

  let finishRead;
  listQueueMediaJobs.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
  act(() => emitSocket('media-jobs:changed', {}));
  await waitFor(() => expect(listQueueMediaJobs).toHaveBeenCalledTimes(2));
  await act(async () => {
    emitSocket('media-jobs:progress', { ...progress, progress: 0.75 });
    finishRead([trainingJob]);
  });
  expect(screen.getByText('75%')).toBeInTheDocument();

  listQueueMediaJobs.mockResolvedValue([{ ...trainingJob, progress: 0.8, statusMsg: 'Saving outcome' }]);
  act(() => emitSocket('media-jobs:changed', {}));
  expect(await screen.findByText('Saving outcome')).toBeInTheDocument();
  expect(screen.getByText('80%')).toBeInTheDocument();
  unmount();
  expect(socketEmit).toHaveBeenCalledWith('media-jobs:unsubscribe');
});

it('offers provider reconciliation for an uncertain Topaz job without a retry', async () => {
  const user = userEvent.setup();
  listQueueMediaJobs.mockResolvedValue([{ id: 'topazjob-1', kind: 'video-upscale', status: 'failed', error: 'Uncertain', params: { mode: 'topaz' }, result: { topazUncertain: true } }]);
  getTopazJobStatus.mockResolvedValue({ requestId: 'request-1', status: 'processing' });
  render(<MediaJobsQueue kind="video-upscale" />);
  await user.click(await screen.findByRole('button', { name: /Show completed \/ failed \/ canceled/ }));
  expect(screen.queryByRole('button', { name: /^Retry$/ })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Check Topaz status' }));
  expect(await screen.findByText('Topaz request request-1: processing')).toBeInTheDocument();
});

const failedCodexJob = {
  id: 'codexfail0000dead',
  kind: 'image',
  status: 'failed',
  error: 'boom',
  queuedAt: '2026-06-19T10:00:00Z',
  params: { prompt: 'a fox', mode: 'codex', model: 'gpt-5.6-luna', effort: 'high' },
};

const failedLocalJob = {
  id: 'localfail0000beef',
  kind: 'image',
  status: 'failed',
  error: 'boom',
  queuedAt: '2026-06-19T10:00:00Z',
  params: { prompt: 'a fox', mode: 'local', modelId: 'z-image-turbo' },
};

// Failed/canceled jobs live in the collapsed "recent" reel — expand it so the
// JobRow (and its Edit-and-retry control) renders.
async function expandReel(user) {
  const toggle = await screen.findByText(/Show (?:completed \/ )?failed \/ canceled/);
  await user.click(toggle);
}

it.each(['minimax-h3-lightx2v', 'minimax-h3-mlx-lightx2v'])('clears inherited sampler overrides when retrying a stock H3 job with %s', async (type) => {
  const user = userEvent.setup();
  const profile = { id: 'example-speed', type, name: 'Example speed',
    steps: 5, guidance: 0, modes: ['text', 'image'], canvases: [[1344, 768]],
    adapter: { file: 'example.safetensors', alpha: 8, rank: 128 }, videoShift: 6, audioShift: 3 };
  const model = { id: 'example-h3', runtime: type === 'minimax-h3-mlx-lightx2v' ? 'minimax_h3' : 'minimax_h3_cuda', name: 'Example H3',
    samplerLocked: true, steps: 8, guidance: 0, frameOptions: [124], fpsOptions: [24],
    supportedModes: ['text', 'image'], speedProfiles: [profile] };
  getVideoGenModelContext.mockResolvedValue({ models: [model] });
  listQueueMediaJobs.mockResolvedValue([{ id: 'h3-retry', kind: 'video', status: 'failed', error: 'Example failure',
    params: { prompt: 'A paper boat.', modelId: model.id, mode: 'text', width: 1344, height: 768,
      numFrames: 124, fps: 24, steps: 8, guidanceScale: 3, chunks: 1, contextFrames: 0 } }]);
  render(<MediaJobsQueue kind="video" />);
  await expandReel(user);
  await user.click(await screen.findByLabelText('Edit and retry'));
  await user.selectOptions(await screen.findByLabelText('Speed'), profile.id);
  await user.click(screen.getByRole('button', { name: /Retry with changes/i }));
  expect(retryMediaJob).toHaveBeenCalledWith('h3-retry', {
    speedProfileId: profile.id, steps: null, guidanceScale: null,
  }, { silent: true });
});

const failedCodexDefaultEffortJob = {
  id: 'codexdef00000dead',
  kind: 'image',
  status: 'failed',
  error: 'boom',
  queuedAt: '2026-06-19T10:00:00Z',
  // No explicit effort → ran on the shipped default.
  params: { prompt: 'a fox', mode: 'codex', model: 'gpt-5.6-luna' },
};

it.each(['reactor', 'grok'])('shows negative prompt controls only for the supported retry lane (%s)', async (mode) => {
  const user = userEvent.setup();
  listQueueMediaJobs.mockResolvedValue([{ id: 'hosted-retry', kind: 'video', status: 'failed', error: 'Example failure',
    params: { prompt: 'a fox', mode, negativePrompt: 'fog' } }]);
  render(<MediaJobsQueue kind="video" />);
  await expandReel(user);
  await user.click(await screen.findByLabelText('Edit and retry'));
  if (mode === 'reactor') {
    expect(screen.queryByLabelText('Negative Prompt')).not.toBeInTheDocument();
    expect(screen.getByText(/Put exclusions in the main prompt/)).toBeInTheDocument();
  } else {
    expect(screen.getByLabelText('Negative Prompt')).toHaveValue('fog');
    await user.clear(screen.getByLabelText('Negative Prompt'));
    await user.type(screen.getByLabelText('Negative Prompt'), 'rain');
  }
  await user.click(await findEnabledByRole('button', { name: /Retry with changes/i }));
  expect(retryMediaJob).toHaveBeenCalledWith('hosted-retry', mode === 'reactor' ? null : { negativePrompt: 'rain' }, { silent: true });
});

describe('MediaJobsQueue — image retry on shipped sizes', () => {
  // 750x1050 is a shipped preset whose edges are not on the 64+8n grid, so a
  // hand-rolled step=8 input would block the native submit even for a prompt-only edit.
  it('retries a 750x1050 job with only the edited prompt', async () => {
    const user = userEvent.setup();
    listQueueMediaJobs.mockResolvedValue([{
      ...failedCodexJob, id: 'size750fail0000dead', params: { ...failedCodexJob.params, width: 750, height: 1050 },
    }]);
    render(<MediaJobsQueue kind="image" />);
    await expandReel(user);
    await user.click(await screen.findByLabelText('Edit and retry'));
    await retypeSettled(user, await screen.findByLabelText('Prompt'), 'a red fox');
    await user.click(screen.getByRole('button', { name: /Retry with changes/i }));
    expect(retryMediaJob).toHaveBeenCalledWith('size750fail0000dead', { prompt: 'a red fox' }, { silent: true });
  });
});

describe('MediaJobsQueue — image retry editor knobs', () => {
  const open = async (user, job) => {
    listQueueMediaJobs.mockResolvedValue([job]);
    render(<MediaJobsQueue kind="image" />);
    await expandReel(user);
    await user.click(await screen.findByLabelText('Edit and retry'));
  };
  const retry = (user) => user.click(screen.getByRole('button', { name: /Retry with changes/i }));

  it('offers installed local models plus seed, steps and guidance, and sends only the edits', async () => {
    const user = userEvent.setup();
    await open(user, { ...failedLocalJob, params: { ...failedLocalJob.params, modelId: 'flux-dev', width: 1024, height: 1024, steps: 25 } });
    const model = await screen.findByRole('combobox', { name: 'Model id' });
    expect(within(model).getByRole('option', { name: 'Z-Image Turbo' })).toBeInTheDocument();
    expect(screen.getByLabelText(/^Seed/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Steps/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Guidance/)).toBeInTheDocument();
    await user.selectOptions(model, 'z-image-turbo');
    await retry(user);
    expect(retryMediaJob).toHaveBeenCalledWith('localfail0000beef', { modelId: 'z-image-turbo' }, { silent: true });
  });

  it('retries a prompt-only edit of a job stored outside the compose ranges', async () => {
    const user = userEvent.setup();
    await open(user, { ...failedLocalJob, params: { ...failedLocalJob.params, modelId: 'flux-dev', width: 4096, height: 1024, steps: 180, guidance: 4.2 } });
    await retypeSettled(user, await screen.findByLabelText('Prompt'), 'a red fox');
    await retry(user);
    expect(retryMediaJob).toHaveBeenCalledWith('localfail0000beef', { prompt: 'a red fox' }, { silent: true });
  });

  it('clears inherited steps when switching to a locked-sampler model', async () => {
    const user = userEvent.setup();
    listImageModels.mockResolvedValue([
      { id: 'flux-dev', name: 'Flux Dev', steps: 25, guidance: 3.5 },
      { id: 'h3-image', name: 'H3 Image', samplerLocked: true },
    ]);
    await open(user, { ...failedLocalJob, params: { ...failedLocalJob.params, modelId: 'flux-dev', width: 1024, height: 1024, steps: 25 } });
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Model id' }), 'h3-image');
    expect(screen.queryByLabelText(/^Steps/)).not.toBeInTheDocument();
    await retry(user);
    expect(retryMediaJob).toHaveBeenCalledWith('localfail0000beef', { modelId: 'h3-image', steps: null }, { silent: true });
  });

  it('shows resolution and the backend model control only for a cloud retry', async () => {
    const user = userEvent.setup();
    await open(user, failedCodexJob);
    expect(await screen.findByLabelText('Codex model')).toBeInTheDocument();
    expect(screen.getByLabelText('Resolution')).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Seed/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Steps/)).not.toBeInTheDocument();
  });

  it('shows no model control for a Grok retry', async () => {
    const user = userEvent.setup();
    await open(user, { ...failedCodexJob, id: 'grokfail00000dead', params: { prompt: 'a fox', mode: 'grok' } });
    await screen.findByLabelText('Resolution');
    expect(screen.queryByLabelText(/model/i)).not.toBeInTheDocument();
    await retry(user);
    expect(retryMediaJob).toHaveBeenCalledWith('grokfail00000dead', null, { silent: true });
  });

  it.each(['audio', 'video-stitch', 'supercollider'])('offers plain Retry and no editor for a failed %s job', async (kind) => {
    const user = userEvent.setup();
    listQueueMediaJobs.mockResolvedValue([{ id: 'nonimage0000dead', kind, status: 'failed', error: 'boom', params: { prompt: 'a fox' } }]);
    render(<MediaJobsQueue kind={kind} />);
    await expandReel(user);
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Edit and retry')).not.toBeInTheDocument();
  });
});

describe('MediaJobsQueue — continuation retry', () => {
  const verified = { id: 'verified-h3', name: 'Example verified H3', runtime: 'minimax_h3', supportedModes: ['text', 'image'],
    continuationCapability: { temporalContext: true, historyFrames: 17 } };
  const unavailable = { ...verified, id: 'unverified-h3', name: 'Example unverified H3',
    continuationCapability: { temporalContext: false, historyFrames: 17, unavailableReason: 'Hardware verification pending.' } };
  const openRetry = async (user, params) => {
    getVideoGenModelContext.mockResolvedValue({ models: [verified, unavailable] });
    listQueueMediaJobs.mockResolvedValue([{ id: 'continuation-retry', kind: 'video', status: 'failed', error: 'Example failure',
      params: { modelId: verified.id, prompt: 'Example moving subject', mode: 'text', chunks: 3, ...params } }]);
    render(<MediaJobsQueue kind="video" />);
    await expandReel(user);
    await user.click(await screen.findByLabelText('Edit and retry'));
    await screen.findByRole('option', { name: verified.name });
  };

  it('clears a recorded temporal request when switching to an unverified model', async () => {
    const user = userEvent.setup();
    await openRetry(user, { contextFrames: 17, continuityStrategy: 'window' });
    expect(screen.getByLabelText('Continuity')).toHaveValue('17');
    await user.selectOptions(screen.getByLabelText('Model'), unavailable.id);
    expect(screen.getByLabelText('Continuity')).toHaveValue('0');
    expect(screen.getByText(/Temporal context unavailable: Hardware verification pending/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Retry with changes/ }));
    expect(retryMediaJob).toHaveBeenCalledWith('continuation-retry', {
      modelId: unavailable.id, contextFrames: 0, continuityStrategy: 'frame',
      speedProfileId: null, textEncoderId: 'stock',
    }, { silent: true });
  });

  it('restores an explicit still-only receipt and submits the visible temporal choice when changed', async () => {
    const user = userEvent.setup();
    await openRetry(user, { contextFrames: 22, continuityStrategy: 'frame' });
    expect(screen.getByLabelText('Continuity')).toHaveValue('0');
    await user.selectOptions(screen.getByLabelText('Continuity'), '17');
    await user.click(screen.getByRole('button', { name: /Retry with changes/ }));
    expect(retryMediaJob).toHaveBeenCalledWith('continuation-retry', {
      contextFrames: 17, continuityStrategy: 'window',
    }, { silent: true });
  });
});

describe('MediaJobsQueue — unavailable state', () => {
  it('discloses unavailable continuation and distinguishes unmeasured queued history from still-only delivery', async () => {
    const reason = 'The pinned adapter has no verified hardware comparison.';
    const continuation = { requestedStrategy: 'window', effectiveStrategy: 'frame', contextFrames: 0,
      actualHistoryFrames: 0, runtime: 'minimax_h3_cuda', backendPin: 'diffusers==0.42.0', capability: false,
      unavailableReason: reason };
    listQueueMediaJobs.mockResolvedValue([{ id: 'example-continuation', kind: 'video', status: 'queued',
      params: { modelId: 'example-h3', prompt: 'Example motion', continuation } }]);
    render(<MediaJobsQueue kind="video" />);
    await userEvent.click(await screen.findByText('Continuation details'));
    const receipt = screen.getByRole('region', { name: 'Continuation receipt' });
    expect(receipt).toHaveTextContent('Requested strategyTemporal window');
    expect(receipt).toHaveTextContent('Effective strategyLast frame only');
    expect(receipt).toHaveTextContent('Actual history0 frames');
    expect(receipt).toHaveTextContent('minimax_h3_cuda');
    expect(receipt).toHaveTextContent('diffusers==0.42.0');
    expect(receipt).toHaveTextContent(reason);

    listQueueMediaJobs.mockResolvedValue([{ id: 'example-continuation', kind: 'video', status: 'running',
      params: { modelId: 'example-h3', continuation: { ...continuation, effectiveStrategy: 'window',
        contextFrames: 17, actualHistoryFrames: null, capability: true, unavailableReason: null } } }]);
    act(() => emitSocket('media-jobs:changed', {}));
    await waitFor(() => expect(receipt).toHaveTextContent('Actual historyNot measured'));
    expect(receipt).toHaveTextContent('Admitted context17 frames');
  });

  it('does not report a failed queue probe as an empty queue', async () => {
    listQueueMediaJobs.mockRejectedValue(new Error('offline'));

    render(<MediaJobsQueue kind="image" />);

    expect(await screen.findByText('Queue status unavailable.')).toBeInTheDocument();
    expect(screen.queryByText('No image renders queued.')).not.toBeInTheDocument();
  });
});

describe('MediaJobsQueue — cancellation state', () => {
  it('keeps a running cancellation through refresh and clears it on terminal status', async () => {
    const user = userEvent.setup();
    const runningJob = {
      id: 'canceljob12345678',
      kind: 'image',
      status: 'running',
      queuedAt: '2026-06-19T10:00:00Z',
      params: { prompt: 'an invented cancellation prompt', modelId: 'example-model' },
    };
    let queueSnapshot = [runningJob];
    listQueueMediaJobs.mockImplementation(() => Promise.resolve(queueSnapshot));

    render(<MediaJobsQueue kind="image" />);

    await screen.findByText(/an invented cancellation prompt/);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancelMediaJob).toHaveBeenCalledWith('canceljob12345678', { silent: true });
    expect(await screen.findByText('cancelling…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();

    queueSnapshot = [{ ...runningJob, cancelRequested: true }];
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => {
      expect(screen.getByText('cancelling…')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    });

    queueSnapshot = [{ ...runningJob, status: 'canceled', cancelRequested: false, error: 'Canceled' }];
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await user.click(await screen.findByText(/Show failed \/ canceled/));

    expect(await screen.findByText('canceled')).toBeInTheDocument();
    expect(screen.queryByText('cancelling…')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });
});

describe('MediaJobsQueue — clearing failed and canceled jobs', () => {
  it('keeps keyboard focus in the confirmation and restores it when canceled', async () => {
    const user = userEvent.setup();
    listQueueMediaJobs.mockResolvedValue([{ id: 'failed-job', kind: 'image', status: 'failed', params: {} }]);
    render(<MediaJobsQueue kind="image" />);
    const trigger = await screen.findByRole('button', { name: 'Clear failed / canceled' });
    trigger.focus();
    await user.keyboard('{Enter}');
    const confirmation = screen.getByRole('group', { name: 'Confirm clearing failed and canceled jobs' });
    expect(confirmation.parentElement).toHaveFocus();
    await user.tab();
    expect(within(confirmation).getByRole('button', { name: 'Remove all' })).toHaveFocus();
    await user.tab();
    expect(within(confirmation).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Clear failed / canceled' })).toHaveFocus();
    expect(deleteFailedCanceledMediaJobs).not.toHaveBeenCalled();
  });

  it.each(['image', 'video', 'video-upscale'])('confirms and clears %s history, keeping active and protected jobs', async (kind) => {
    const user = userEvent.setup();
    const job = (id, status) => ({ id, kind, status, params: { prompt: `Example ${id}` } });
    const running = job('running-job', 'running');
    const failed = job('failed-job', 'failed');
    const canceled = job('canceled-job', 'canceled');
    const protectedJob = { ...job('protected-job', 'failed'), result: kind === 'video-upscale' ? { topazUncertain: true } : undefined };
    const completed = kind === 'video-upscale' ? [job('completed-job', 'completed')] : [];
    let snapshot = [running, failed, canceled, protectedJob, ...completed];
    listQueueMediaJobs.mockImplementation(() => Promise.resolve(snapshot));
    let resolveDelete;
    deleteFailedCanceledMediaJobs.mockImplementation(() => new Promise((resolve) => { resolveDelete = resolve; }));

    render(<MediaJobsQueue kind={kind} allowClearFailed />);
    await expandReel(user);
    await user.click(screen.getByRole('button', { name: 'Clear failed / canceled' }));
    await user.click(within(screen.getByRole('group', { name: 'Confirm clearing failed and canceled jobs' })).getByRole('button', { name: 'Cancel' }));
    expect(deleteFailedCanceledMediaJobs).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Clear failed / canceled' }));
    await user.click(screen.getByRole('button', { name: 'Remove all' }));
    expect(deleteFailedCanceledMediaJobs).toHaveBeenCalledWith(kind, { silent: true });
    expect(screen.getByRole('button', { name: 'Removing…' })).toBeDisabled();

    snapshot = [running, protectedJob, ...completed];
    const readsBeforeEvent = listQueueMediaJobs.mock.calls.length;
    act(() => emitSocket('media-jobs:changed', {}));
    expect(listQueueMediaJobs).toHaveBeenCalledTimes(readsBeforeEvent);
    await act(async () => resolveDelete({ deletedIds: ['failed-job', 'canceled-job', 'older-job'], skipped: 1 }));
    expect(toast.error).toHaveBeenCalledWith('Removed 3 jobs; 1 could not be removed. Retry or review them individually.');
    await waitFor(() => expect(screen.queryByText(/Example failed-job/)).not.toBeInTheDocument());
    expect(screen.queryByText(/Example canceled-job/)).not.toBeInTheDocument();
    expect(screen.getByText(/Example running-job/)).toBeInTheDocument();
    expect(screen.getByText(/Example protected-job/)).toBeInTheDocument();
    if (completed.length) expect(screen.getByText(/Example completed-job/)).toBeInTheDocument();
    await waitFor(() => expect(listQueueMediaJobs).toHaveBeenCalledTimes(readsBeforeEvent + 1));
  });

  it('hides the action on an empty queue and keeps failed jobs visible after a request error', async () => {
    const user = userEvent.setup();
    listQueueMediaJobs.mockResolvedValueOnce([]);
    const { unmount } = render(<MediaJobsQueue kind="image" />);
    await screen.findByText('No image renders queued.');
    expect(screen.queryByRole('button', { name: 'Clear failed / canceled' })).not.toBeInTheDocument();
    unmount();

    listQueueMediaJobs.mockResolvedValue([{ id: 'failed-job', kind: 'image', status: 'failed', params: { prompt: 'Example failure' } }]);
    deleteFailedCanceledMediaJobs.mockRejectedValue(new Error('Queue storage unavailable'));
    render(<MediaJobsQueue kind="image" />);
    await expandReel(user);
    await user.click(screen.getByRole('button', { name: 'Clear failed / canceled' }));
    await user.click(screen.getByRole('button', { name: 'Remove all' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Queue storage unavailable'));
    expect(screen.getByText(/Example failure/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear failed / canceled' })).toBeInTheDocument();
  });

  it('reconciles a stale collapsed queue when nothing remains', async () => {
    const user = userEvent.setup();
    const failed = { id: 'failed-job', kind: 'image', status: 'failed', params: { prompt: 'Example failure' } };
    let snapshot = [failed];
    listQueueMediaJobs.mockImplementation(() => Promise.resolve(snapshot));
    deleteFailedCanceledMediaJobs.mockImplementation(async () => {
      snapshot = [];
      return { deletedIds: [], skipped: 0 };
    });
    render(<MediaJobsQueue kind="image" />);
    await user.click(await screen.findByRole('button', { name: 'Clear failed / canceled' }));
    await user.click(screen.getByRole('button', { name: 'Remove all' }));
    expect(toast).toHaveBeenCalledWith('No failed or canceled jobs to remove');
    expect(await screen.findByText('No image renders queued.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear failed / canceled' })).not.toBeInTheDocument();
  });

  it('updates the empty state after clearing a collapsed queue', async () => {
    const user = userEvent.setup();
    listQueueMediaJobs.mockResolvedValue([{ id: 'failed-job', kind: 'image', status: 'failed', params: {} }]);
    deleteFailedCanceledMediaJobs.mockResolvedValue({ deletedIds: ['failed-job'], skipped: 0 });
    render(<MediaJobsQueue kind="image" />);
    await user.click(await screen.findByRole('button', { name: 'Clear failed / canceled' }));
    await user.click(screen.getByRole('button', { name: 'Remove all' }));
    expect(await screen.findByText('No image renders queued.')).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith('Removed 1 failed or canceled job');
  });

  it('keeps a recoverable Topaz result available after a bulk clear skips it', async () => {
    const user = userEvent.setup();
    listQueueMediaJobs.mockResolvedValue([{ id: 'topaz-recovery', kind: 'video-upscale', status: 'failed',
      params: { mode: 'topaz' }, result: { topazRecoveryAvailable: true } }]);
    deleteFailedCanceledMediaJobs.mockResolvedValue({ deletedIds: [], skipped: 1 });
    render(<MediaJobsQueue kind="video-upscale" allowClearFailed />);
    await expandReel(user);
    expect(screen.getByRole('button', { name: 'Retrieve Topaz result' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear failed / canceled' }));
    await user.click(screen.getByRole('button', { name: 'Remove all' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Removed 0 jobs; 1 could not be removed. Retry or review them individually.'));
    expect(screen.getByRole('button', { name: 'Retrieve Topaz result' })).toBeInTheDocument();
  });

  it('reports a separate queue warning after a successful clear', async () => {
    const user = userEvent.setup();
    listQueueMediaJobs.mockResolvedValue([{ id: 'failed-job', kind: 'image', status: 'failed', params: {} }]);
    deleteFailedCanceledMediaJobs.mockResolvedValue({ deletedIds: ['failed-job'], skipped: 0,
      warning: 'Another queue update could not finish. Check the queue.' });
    render(<MediaJobsQueue kind="image" />);
    await user.click(await screen.findByRole('button', { name: 'Clear failed / canceled' }));
    await user.click(screen.getByRole('button', { name: 'Remove all' }));
    expect(await screen.findByText('No image renders queued.')).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith('Removed 1 job. Another queue update could not finish. Check the queue.');
  });

  it('can clear older upscale failures when the visible reel contains only completed jobs', async () => {
    const user = userEvent.setup();
    listQueueMediaJobs.mockResolvedValue([{ id: 'completed-job', kind: 'video-upscale', status: 'completed', params: {} }]);
    deleteFailedCanceledMediaJobs.mockResolvedValue({ deletedIds: ['older-failed-job'], skipped: 0 });
    render(<MediaJobsQueue kind="video-upscale" allowClearFailed />);
    expect(await screen.findByText(/Show completed \/ failed \/ canceled/)).toBeInTheDocument();
    expect(screen.getByText('0 active • 1 completed')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear failed / canceled' }));
    await user.click(screen.getByRole('button', { name: 'Remove all' }));
    expect(deleteFailedCanceledMediaJobs).toHaveBeenCalledWith('video-upscale', { silent: true });
    expect(toast.success).toHaveBeenCalledWith('Removed 1 failed or canceled job');
    expect(screen.getByText('0 active • 1 completed')).toBeInTheDocument();
  });
});

describe('MediaJobsQueue — Creative Director renders', () => {
  it('surfaces a Creative Director-owned video job in the live queue', async () => {
    listQueueMediaJobs.mockResolvedValue([{
      id: 'cdvideo0000live',
      kind: 'video',
      owner: 'cd:example-project',
      status: 'queued',
      position: 2,
      queuedAt: '2026-06-19T10:00:00Z',
      params: { prompt: 'an invented establishing shot', modelId: 'example-video-model' },
    }]);

    render(<MediaJobsQueue kind="video" />);

    await waitFor(() => expect(screen.getByText(/Creative Director/)).toBeInTheDocument());
    expect(listQueueMediaJobs).toHaveBeenCalledWith({ kind: 'video', limit: 10 });
    expect(screen.getByText(/#2 in queue/)).toBeInTheDocument();
    expect(screen.getByText(/an invented establishing shot/)).toBeInTheDocument();
  });
});

describe('MediaJobsQueue — queued status', () => {
  it('shows why a queued render is waiting', async () => {
    listQueueMediaJobs.mockResolvedValue([{
      id: 'quotawait0000beef',
      kind: 'image',
      status: 'queued',
      position: 1,
      statusMsg: 'Waiting for codex quota — resumes at 3:00 PM',
      queuedAt: '2026-06-19T10:00:00Z',
      params: { prompt: 'a fox', mode: 'codex' },
    }]);

    render(<MediaJobsQueue kind="image" />);

    expect(await screen.findByText('Waiting for codex quota — resumes at 3:00 PM')).toBeInTheDocument();
  });
});

describe('MediaJobsQueue — video render lanes', () => {
  it('files each job under the lane the server scheduled it into', async () => {
    // The lane comes from the server's own classifier (`executionLane`), so a
    // cloud backend the client has never heard of still lands in Cloud renders.
    listQueueMediaJobs.mockResolvedValue([
      {
        id: 'localvideo0001',
        kind: 'video',
        status: 'running',
        executionLane: 'gpu',
        queuedAt: '2026-06-19T10:00:00Z',
        params: { prompt: 'an invented local shot', mode: 'text', modelId: 'local-video' },
      },
      {
        id: 'grokvideo0001',
        kind: 'video',
        status: 'running',
        executionLane: 'cloud',
        queuedAt: '2026-06-19T10:01:00Z',
        params: { prompt: 'an invented grok shot', mode: 'grok' },
      },
      {
        id: 'falvideo00001',
        kind: 'video',
        status: 'running',
        executionLane: 'cloud',
        queuedAt: '2026-06-19T10:01:30Z',
        params: { prompt: 'an invented fal shot', mode: 'fal', modelId: 'provider/video-model' },
      },
      {
        id: 'reactorvideo01',
        kind: 'video',
        status: 'queued',
        executionLane: 'cloud',
        queuedAt: '2026-06-19T10:01:45Z',
        params: { prompt: 'an invented reactor shot', mode: 'reactor' },
      },
      {
        id: 'remotevideo001',
        kind: 'video',
        status: 'queued',
        executionLane: 'remote',
        renderer: 'remote',
        queuedAt: '2026-06-19T10:02:00Z',
        params: { prompt: 'an invented peer shot', mode: 'text', modelId: 'peer-video' },
      },
    ]);

    render(<MediaJobsQueue kind="video" />);

    const local = await screen.findByRole('region', { name: 'Local machine video queue' });
    expect(local).toHaveTextContent('an invented local shot');
    expect(local).not.toHaveTextContent('an invented fal shot');

    const cloud = screen.getByRole('region', { name: 'Cloud renders video queue' });
    expect(cloud).toHaveTextContent('an invented grok shot');
    expect(cloud).toHaveTextContent('an invented fal shot');
    expect(cloud).toHaveTextContent('an invented reactor shot');

    expect(screen.getByRole('region', { name: 'Remote machines video queue' })).toHaveTextContent('an invented peer shot');
  });

  it('badges a cloud provider render with its provider, not the local engine', async () => {
    listQueueMediaJobs.mockResolvedValue([{
      id: 'falvideo00001',
      kind: 'video',
      status: 'running',
      executionLane: 'cloud',
      queuedAt: '2026-06-19T10:00:00Z',
      params: { prompt: 'an invented fal shot', mode: 'fal', modelId: 'provider/video-model' },
    }]);

    render(<MediaJobsQueue kind="video" />);

    expect(await screen.findByTitle('provider/video-model')).toHaveTextContent('fal.ai / provider/video-model');
    expect(screen.queryByText(/local \//)).not.toBeInTheDocument();
  });

  it('derives the lane from mode + renderer when the response predates executionLane', async () => {
    // A rebuilt bundle can be served briefly by a server process that has not
    // restarted onto the new projection yet; the queue must not fall back to
    // filing every cloud render under Local machine while that window is open.
    listQueueMediaJobs.mockResolvedValue([
      {
        id: 'legacylocal01',
        kind: 'video',
        status: 'running',
        queuedAt: '2026-06-19T10:00:00Z',
        params: { prompt: 'an invented legacy local shot', mode: 'text', modelId: 'local-video' },
      },
      {
        id: 'legacyfal0001',
        kind: 'video',
        status: 'running',
        queuedAt: '2026-06-19T10:01:00Z',
        params: { prompt: 'an invented legacy fal shot', mode: 'fal' },
      },
      {
        id: 'legacyremote1',
        kind: 'video',
        status: 'queued',
        renderer: 'remote',
        queuedAt: '2026-06-19T10:02:00Z',
        params: { prompt: 'an invented legacy peer shot', mode: 'text', modelId: 'peer-video' },
      },
    ]);

    render(<MediaJobsQueue kind="video" />);

    expect(await screen.findByRole('region', { name: 'Local machine video queue' })).toHaveTextContent('an invented legacy local shot');
    expect(screen.getByRole('region', { name: 'Cloud renders video queue' })).toHaveTextContent('an invented legacy fal shot');
    expect(screen.getByRole('region', { name: 'Remote machines video queue' })).toHaveTextContent('an invented legacy peer shot');
  });
});

describe('MediaJobsQueue — federated render badge', () => {
  it('badges a peer-rendered job remote instead of claiming a local render', async () => {
    // The server projects `renderer` and rebuilds `modelId` off the wire
    // request — the raw job nulls both so a rolled-back build fails closed.
    listQueueMediaJobs.mockResolvedValue([{
      id: 'remotejob0000beef',
      kind: 'image',
      status: 'running',
      queuedAt: '2026-06-19T10:00:00Z',
      renderer: 'remote',
      params: { prompt: 'a lighthouse at dusk', modelId: 'dev' },
    }]);

    render(<MediaJobsQueue kind="image" />);

    expect(await screen.findByText(/remote \/ dev/)).toBeInTheDocument();
    expect(screen.queryByText(/local \/ dev/)).not.toBeInTheDocument();
  });

  it('keeps the local badge on a job with no renderer projection', async () => {
    listQueueMediaJobs.mockResolvedValue([{ ...failedLocalJob, status: 'running', error: undefined }]);

    render(<MediaJobsQueue kind="image" />);

    expect(await screen.findByText(/local \/ z-image-turbo/)).toBeInTheDocument();
  });

  it.each(['image', 'video'])('offers plain Retry but not the editor on a failed federated %s job', async (kind) => {
    // A prompt/model edit would never reach the peer — the remote executor
    // renders from the wire request inside the marker — so showing the form
    // would silently discard what the user typed.
    const user = userEvent.setup();
    listQueueMediaJobs.mockResolvedValue([{ ...failedLocalJob, id: 'remotefail0000beef', kind, renderer: 'remote' }]);

    render(<MediaJobsQueue kind={kind} />);
    await expandReel(user);

    expect(await screen.findByRole('button', { name: /^Retry$/ })).toBeInTheDocument();
    expect(screen.queryByLabelText('Edit and retry')).not.toBeInTheDocument();
  });
});

describe('MediaJobsQueue — Codex reasoning-effort retry control', () => {
  it('surfaces the job effort in the row label', async () => {
    const user = userEvent.setup();
    listQueueMediaJobs.mockResolvedValue([failedCodexJob]);
    render(<MediaJobsQueue kind="image" />);
    await expandReel(user);
    await waitFor(() => expect(screen.getByText(/codex \/ gpt-5.6-luna · high/)).toBeInTheDocument());
  });

  it('shows the effective default effort in the row label when the job stored none', async () => {
    const user = userEvent.setup();
    listQueueMediaJobs.mockResolvedValue([failedCodexDefaultEffortJob]);
    render(<MediaJobsQueue kind="image" />);
    await expandReel(user);
    // Default-effort jobs store no `effort`, but codex still rendered at `low`.
    await waitFor(() => expect(screen.getByText(/codex \/ gpt-5.6-luna · low/)).toBeInTheDocument());
  });

  it('does not crash on a non-string effort from hand-edited data', async () => {
    const user = userEvent.setup();
    // A hand-edited media-jobs.json could carry a numeric effort; the row label
    // must coerce safely (mirror of codex.js) instead of throwing on .trim().
    listQueueMediaJobs.mockResolvedValue([{
      ...failedCodexDefaultEffortJob, id: 'codexbadeff00dead', params: { ...failedCodexDefaultEffortJob.params, effort: 5 },
    }]);
    render(<MediaJobsQueue kind="image" />);
    await expandReel(user);
    // Non-string → treated as absent → resolves to the shipped default.
    await waitFor(() => expect(screen.getByText(/codex \/ gpt-5.6-luna · low/)).toBeInTheDocument());
  });

  it('pre-fills the retry editor to Default for a job that stored no effort', async () => {
    const user = userEvent.setup();
    listQueueMediaJobs.mockResolvedValue([failedCodexDefaultEffortJob]);
    render(<MediaJobsQueue kind="image" />);
    await expandReel(user);
    await user.click(await screen.findByLabelText('Edit and retry'));
    const select = await screen.findByLabelText('Reasoning effort');
    expect(select.value).toBe('default');
    // Leaving it on Default and retrying sends no effort override (nothing changed).
    await user.click(screen.getByRole('button', { name: /Retry with changes/i }));
    expect(retryMediaJob).toHaveBeenCalledWith('codexdef00000dead', null, { silent: true });
  });

  it('renders the effort select (Codex only) and pins a new level on retry', async () => {
    const user = userEvent.setup();
    listQueueMediaJobs.mockResolvedValue([failedCodexJob]);
    render(<MediaJobsQueue kind="image" />);
    await expandReel(user);
    await user.click(await screen.findByLabelText('Edit and retry'));

    const select = await screen.findByLabelText('Reasoning effort');
    // Pre-filled with the job's stored effort.
    expect(select.value).toBe('high');
    await user.selectOptions(select, 'medium');
    await user.click(screen.getByRole('button', { name: /Retry with changes/i }));

    expect(retryMediaJob).toHaveBeenCalledWith('codexfail0000dead', { effort: 'medium' }, { silent: true });
  });

  it('sends the clear sentinel when the effort is reset to Default', async () => {
    const user = userEvent.setup();
    listQueueMediaJobs.mockResolvedValue([failedCodexJob]);
    render(<MediaJobsQueue kind="image" />);
    await expandReel(user);
    await user.click(await screen.findByLabelText('Edit and retry'));

    const select = await screen.findByLabelText('Reasoning effort');
    await user.selectOptions(select, 'default');
    await user.click(screen.getByRole('button', { name: /Retry with changes/i }));

    expect(retryMediaJob).toHaveBeenCalledWith('codexfail0000dead', { effort: 'default' }, { silent: true });
  });

  it('does not render the effort control for non-Codex jobs', async () => {
    const user = userEvent.setup();
    listQueueMediaJobs.mockResolvedValue([failedLocalJob]);
    render(<MediaJobsQueue kind="image" />);
    await expandReel(user);
    await user.click(await screen.findByLabelText('Edit and retry'));

    // Edit form is open (Prompt field visible) but no effort control.
    await waitFor(() => expect(screen.getByText('Prompt')).toBeInTheDocument());
    expect(screen.queryByLabelText('Reasoning effort')).not.toBeInTheDocument();
  });
});

// An Agy job's model lives on `params.model` (the CLI's `--model` session
// model), NOT `params.modelId` (a local image-model registry id). The retry
// editor must follow the same field, or it edits something Agy never reads and
// leaves the actual model unchangeable.
describe('MediaJobsQueue — Agy retry model field', () => {
  const failedAgyJob = {
    id: 'agyfail000000dead',
    kind: 'image',
    status: 'failed',
    error: 'boom',
    queuedAt: '2026-06-19T10:00:00Z',
    params: { prompt: 'a fox', mode: 'agy', model: 'gemini-3.5-flash-high' },
  };

  it('pre-fills the Agy model from params.model and retries with the edited value', async () => {
    const user = userEvent.setup();
    listQueueMediaJobs.mockResolvedValue([failedAgyJob]);
    render(<MediaJobsQueue kind="image" />);
    await expandReel(user);
    await user.click(await screen.findByLabelText('Edit and retry'));

    const input = await screen.findByLabelText('Agy model');
    expect(input.value).toBe('gemini-3.5-flash-high');
    await retypeSettled(user, input, 'gemini-3.1-pro-high');
    await user.click(screen.getByRole('button', { name: /Retry with changes/i }));

    expect(retryMediaJob).toHaveBeenCalledWith(
      'agyfail000000dead', { model: 'gemini-3.1-pro-high' }, { silent: true },
    );
  });

  it('shows the configured-default sentinel as an empty field and sends no override', async () => {
    const user = userEvent.setup();
    listQueueMediaJobs.mockResolvedValue([{
      ...failedAgyJob,
      id: 'agysentinel00dead',
      params: { ...failedAgyJob.params, model: 'antigravity-configured-default' },
    }]);
    render(<MediaJobsQueue kind="image" />);
    await expandReel(user);
    await user.click(await screen.findByLabelText('Edit and retry'));

    // The sentinel is "let agy choose", not a literal id the user should see or
    // resubmit — an untouched field must leave the original params intact.
    const input = await screen.findByLabelText('Agy model');
    expect(input.value).toBe('');
    await user.click(screen.getByRole('button', { name: /Retry with changes/i }));
    expect(retryMediaJob).toHaveBeenCalledWith('agysentinel00dead', null, { silent: true });
  });
});

describe('MediaJobsQueue — training rows', () => {
  it('renders a training summary + engine/character label instead of a prompt', async () => {
    listQueueMediaJobs.mockResolvedValue([trainingJob]);

    render(<MediaJobsQueue kind="training" />);

    await waitFor(() => expect(screen.getByText(/Training "Kessa"/)).toBeInTheDocument());
    expect(screen.getByText(/mflux \/ Kessa/)).toBeInTheDocument();
    // Header reads "Training Queue", not "… Render Queue".
    expect(screen.getByText(/Training Queue/i)).toBeInTheDocument();
  });

});

// Queue updates arrive from events without timer-driven reads.
describe('MediaJobsQueue — socket updates', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('updates from events and reconciles reconnect and tab show once', async () => {
    listQueueMediaJobs.mockResolvedValue([trainingJob]);
      const { unmount } = render(<MediaJobsQueue kind="training" />);
    await screen.findByText(/Training "Kessa"/);
    expect(listQueueMediaJobs).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(listQueueMediaJobs).toHaveBeenCalledTimes(1);

    await act(async () => { emitSocket('connect'); });
    expect(listQueueMediaJobs).toHaveBeenCalledTimes(2);

    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await act(async () => {
      emitSocket('media-jobs:changed', {});
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(listQueueMediaJobs).toHaveBeenCalledTimes(2);
    visibility.mockReturnValue('visible');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(listQueueMediaJobs).toHaveBeenCalledTimes(3);

    listQueueMediaJobs.mockResolvedValue([]);
    await act(async () => { emitSocket('media-jobs:changed', {}); });
    expect(screen.getByText('No training runs queued.')).toBeInTheDocument();
    expect(listQueueMediaJobs).toHaveBeenCalledTimes(4);
    unmount();
    expect([...socketHandlers.values()].every(handlers => handlers.size === 0)).toBe(true);
  });
});

// The conditioning promise (#4874) rides a video retry — and has to snap back
// when the user retargets the retry at a model that pins frame one, because the
// picker offers only Anchor there and the server rejects the mismatch.
describe('MediaJobsQueue — video retry reference mode (#4874)', () => {
  const LTX25 = { id: 'ltx25-model', name: 'LTX-2.5', runtime: 'ltx25', supportedModes: ['text', 'image'] };
  const LTX2 = { id: 'ltx2-model', name: 'LTX-2.3', runtime: 'ltx2', supportedModes: ['text', 'image'] };
  const failedInspireJob = {
    id: 'refmodefail00dead',
    kind: 'video',
    status: 'failed',
    error: 'boom',
    queuedAt: '2026-06-19T10:00:00Z',
    params: {
      prompt: 'a fox', mode: 'image', modelId: 'ltx25-model',
      i2vReferenceMode: 'inspire', width: 704, height: 448,
    },
  };

  const openRetryEditor = async (user) => {
    listQueueMediaJobs.mockResolvedValue([failedInspireJob]);
    render(<MediaJobsQueue kind="video" />);
    await expandReel(user);
    await user.click(await screen.findByLabelText('Edit and retry'));
  };

  it('pre-fills the promise the failed job carried', async () => {
    const user = userEvent.setup();
    getVideoGenModelContext.mockResolvedValue({ models: [LTX25, LTX2] });
    await openRetryEditor(user);
    const select = await screen.findByLabelText('Reference mode');
    await waitFor(() => expect(select.value).toBe('inspire'));
  });

  it('keeps it while the model catalog is still loading, then snaps back once the model resolves as unsupported', async () => {
    const user = userEvent.setup();
    // Never resolves: `currentModel` stays null, which means "not known yet" —
    // clearing there would drop a promise the original job really did make.
    getVideoGenModelContext.mockReturnValue(new Promise(() => {}));
    await openRetryEditor(user);
    // No catalog ⇒ no picker to read; assert the retry still carries the mode.
    await user.click(screen.getByRole('button', { name: /Retry with changes/i }));
    expect(retryMediaJob).toHaveBeenCalledWith('refmodefail00dead', null, { silent: true });
  });

  it('clears the promise when the retry is retargeted at a model that pins frame one', async () => {
    const user = userEvent.setup();
    getVideoGenModelContext.mockResolvedValue({ models: [LTX25, LTX2] });
    await openRetryEditor(user);
    await waitFor(() => expect(screen.getByLabelText('Reference mode').value).toBe('inspire'));

    // Wait for the model catalog itself, not just the (job-derived) reference
    // mode, before selecting an option the catalog fetch hasn't rendered yet.
    await screen.findByRole('option', { name: 'LTX-2.3' });
    await user.selectOptions(screen.getByLabelText('Model'), 'ltx2-model');
    await waitFor(() => expect(screen.getByLabelText('Reference mode').value).toBe('anchor'));
    // And the retry submits the clear rather than a value the server would 400.
    await user.click(screen.getByRole('button', { name: /Retry with changes/i }));
    const [, overrides] = retryMediaJob.mock.calls.at(-1);
    expect(overrides.i2vReferenceMode).toBeNull();
  });
});

describe('MediaJobsQueue — video retry memory mode (#10742)', () => {
  const model = { id: 'memory-model', name: 'Example LTX', runtime: 'ltx25', supportedModes: ['text', 'extend'] };
  const openEditor = async (user, streamingMode) => {
    listQueueMediaJobs.mockResolvedValue([{
      id: 'memory-job', kind: 'video', status: 'failed', error: 'example failure',
      queuedAt: '2026-06-19T10:00:00Z',
      params: { prompt: 'an invented memory retry', mode: 'extend', modelId: model.id, streamingMode },
    }]);
    render(<MediaJobsQueue kind="video" />);
    await expandReel(user);
    await user.click(await screen.findByLabelText('Edit and retry'));
  };

  it('shows Resident and sends no memory override on an untouched retry', async () => {
    const user = userEvent.setup();
    getVideoGenModelContext.mockResolvedValue({ models: [model] });
    await openEditor(user, 'resident');
    expect(await screen.findByLabelText('Memory')).toHaveValue('resident');
    await user.click(screen.getByRole('button', { name: /Retry with changes/i }));
    expect(retryMediaJob).toHaveBeenCalledWith('memory-job', null, { silent: true });
  });

  it('submits an explicit Stream request even for Extend so the bridge can refuse it', async () => {
    const user = userEvent.setup();
    getVideoGenModelContext.mockResolvedValue({ models: [model] });
    await openEditor(user, 'resident');
    await user.selectOptions(await screen.findByLabelText('Memory'), 'stream');
    await user.click(screen.getByRole('button', { name: /Retry with changes/i }));
    expect(retryMediaJob).toHaveBeenCalledWith('memory-job', { streamingMode: 'stream' }, { silent: true });
  });

  it('preserves a recorded Stream while the model catalog is loading', async () => {
    const user = userEvent.setup();
    getVideoGenModelContext.mockReturnValue(new Promise(() => {}));
    await openEditor(user, 'stream');
    expect(screen.getByLabelText('Memory')).toHaveValue('stream');
    await user.click(screen.getByRole('button', { name: /Retry with changes/i }));
    expect(retryMediaJob).toHaveBeenCalledWith('memory-job', null, { silent: true });
  });

  it.each([false, true])('clears an explicit mode to Auto with catalog resolved=%s at submission', async (resolved) => {
    const user = userEvent.setup();
    let resolveCatalog;
    getVideoGenModelContext.mockReturnValue(new Promise((resolve) => { resolveCatalog = resolve; }));
    await openEditor(user, 'stream');
    await user.selectOptions(screen.getByLabelText('Memory'), 'auto');
    expect(screen.getByLabelText('Memory')).toHaveValue('auto');
    if (resolved) await act(async () => { resolveCatalog({ models: [model] }); });
    expect(screen.getByLabelText('Memory')).toHaveValue('auto');
    await user.click(screen.getByRole('button', { name: /Retry with changes/i }));
    expect(retryMediaJob).toHaveBeenCalledWith('memory-job', { streamingMode: null }, { silent: true });
  });

  it('treats older jobs without a memory mode as Auto without submitting an override', async () => {
    const user = userEvent.setup();
    getVideoGenModelContext.mockResolvedValue({ models: [model] });
    await openEditor(user, undefined);
    expect(await screen.findByLabelText('Memory')).toHaveValue('auto');
    await user.click(screen.getByRole('button', { name: /Retry with changes/i }));
    expect(retryMediaJob).toHaveBeenCalledWith('memory-job', null, { silent: true });
  });
});

describe('MediaJobsQueue — local video holds', () => {
  it('makes the scope of damaged-hold recovery explicit before resuming', async () => {
    listQueueMediaJobs.mockResolvedValue([]);
    listMediaVideoHolds.mockResolvedValue([{ id: 'recovery-hold', scope: 'local-video', modelId: '*', runtime: '*',
      cause: 'Saved video holds are damaged.', heldJobCount: 0 }]);
    const user = userEvent.setup();
    render(<MediaJobsQueue kind="video" />);
    expect(await screen.findByText('All local video')).toBeInTheDocument();
    expect(screen.queryByText(/Three matching failures/)).not.toBeInTheDocument();
    resumeMediaVideoHold.mockResolvedValue({ resumed: true });
    listMediaVideoHolds.mockResolvedValue([]);
    await user.click(screen.getByRole('button', { name: 'Resume all local video' }));
    await waitFor(() => expect(screen.queryByText('All local video')).not.toBeInTheDocument());
    expect(resumeMediaVideoHold).toHaveBeenCalledWith('recovery-hold', { silent: true });
  });

  it('retains held state on a failed resume and clears it only after a successful response', async () => {
    const hold = { id: 'example-hold', modelId: 'example-mlx', runtime: 'mlx_video', cause: 'Shader compilation failed', heldJobCount: 2 };
    const jobs = ['held-1', 'held-2'].map((id) => ({ id, kind: 'video', status: 'queued', hold, params: {} }));
    listQueueMediaJobs.mockResolvedValue(jobs);
    listMediaVideoHolds.mockResolvedValue([hold]);
    resumeMediaVideoHold.mockRejectedValueOnce(new Error('Resume unavailable'));
    const user = userEvent.setup();
    render(<MediaJobsQueue kind="video" />);
    expect(await screen.findByText('2 video jobs held')).toBeInTheDocument();
    expect(screen.getByText('Shader compilation failed')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Resume' }));
    await findEnabledByRole('button', { name: 'Resume' });
    expect(screen.getByText('2 video jobs held')).toBeInTheDocument();
    let finishResume;
    resumeMediaVideoHold.mockImplementationOnce(() => new Promise((resolve) => { finishResume = resolve; }));
    await user.click(screen.getByRole('button', { name: 'Resume' }));
    expect(screen.getByRole('button', { name: 'Resuming…' })).toBeDisabled();
    expect(screen.getByText('2 video jobs held')).toBeInTheDocument();
    listQueueMediaJobs.mockResolvedValue(jobs.map((job) => ({ ...job, hold: undefined })));
    listMediaVideoHolds.mockResolvedValue([]);
    await act(async () => { finishResume({ resumed: true }); });
    await waitFor(() => expect(screen.queryByText('2 video jobs held')).not.toBeInTheDocument());
    expect(resumeMediaVideoHold).toHaveBeenLastCalledWith('example-hold', { silent: true });
    expect(retryMediaJob).not.toHaveBeenCalled();
  });

  it('offers resume for an active hold after all retained jobs were canceled', async () => {
    listQueueMediaJobs.mockResolvedValue([]);
    listMediaVideoHolds.mockResolvedValue([{ id: 'empty-hold', modelId: 'example-mlx', runtime: 'mlx_video',
      cause: 'Shader compilation failed', heldJobCount: 0 }]);
    const user = userEvent.setup();
    render(<MediaJobsQueue kind="video" />);
    expect(await screen.findByText('0 video jobs held')).toBeInTheDocument();
    resumeMediaVideoHold.mockResolvedValue({ resumed: true });
    listMediaVideoHolds.mockResolvedValue([]);
    await user.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(screen.queryByText('0 video jobs held')).not.toBeInTheDocument());
    expect(resumeMediaVideoHold).toHaveBeenCalledWith('empty-hold', { silent: true });
    expect(retryMediaJob).not.toHaveBeenCalled();
  });
});

// Hosted video backends (grok / fal / reactor) own their params (#10741): the
// retry editor offers no local model, sampler or chaining controls and an
// untouched submit re-sends nothing, so provider fields survive verbatim.
describe('MediaJobsQueue — hosted video retry editor (#10741)', () => {
  const hostedJob = (mode, extra) => ({
    id: `${mode}fail000000dead`,
    kind: 'video',
    status: 'failed',
    error: 'boom',
    queuedAt: '2026-06-19T10:00:00Z',
    params: { prompt: 'a fox', mode, videoMode: 'text', ...extra },
  });
  const HOSTED_JOBS = {
    grok: hostedJob('grok', { width: 1280, height: 720, duration: 6 }),
    fal: hostedJob('fal', { modelId: 'fal-ai/provider-model', width: 1280, height: 720, duration: 5 }),
    reactor: hostedJob('reactor', { seconds: 4, seed: 7, aspect: '16:9' }),
  };

  it.each(Object.keys(HOSTED_JOBS))('hides local controls on a %s job and submits no override when untouched', async (mode) => {
    const user = userEvent.setup();
    // A healthy local catalog: the controls must stay hidden because the job is
    // hosted, not because there is nothing to choose from.
    getVideoGenModelContext.mockResolvedValue({ models: [{ id: 'ltx25-model', name: 'LTX-2.5', runtime: 'ltx25', supportedModes: ['text', 'image'] }] });
    listQueueMediaJobs.mockResolvedValue([HOSTED_JOBS[mode]]);
    render(<MediaJobsQueue kind="video" />);
    await expandReel(user);
    await user.click(await screen.findByLabelText('Edit and retry'));

    expect(await screen.findByRole('button', { name: /Retry with changes/i })).toBeInTheDocument();
    await waitFor(() => expect(getVideoGenModelContext).toHaveBeenCalled());
    expect(screen.queryByLabelText('Model')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Reference mode')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Steps/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Chunks/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Retry with changes/i }));
    expect(retryMediaJob).toHaveBeenCalledWith(HOSTED_JOBS[mode].id, null, { silent: true });
  });
});

it.each([
  ['image', 'codex', 'Style preset: Print'],
  ['video', 'grok', 'Grok video tool instructions'],
])('shows authored text, additions, full prompt and Copy in the %s retry editor', async (kind, mode, label) => {
  const job = {
    id: `${kind}-preview`, kind, status: 'failed',
    params: { mode, prompt: 'styled original', retryPrompt: 'original', negativePrompt: '' },
  };
  listQueueMediaJobs.mockResolvedValue([job]);
  previewMediaJobRetry.mockImplementation(async (_id, overrides) => ({
    sentPrompt: `Style. ${overrides?.prompt ?? 'original'}`,
    promptAdditions: [{ id: 'instructions', label, text: 'Style.' }],
    referenceImages: [{ filename: 'anchor.png', source: 'Reference image', status: 'included' }],
  }));
  const user = userEvent.setup();
  render(<MediaJobsQueue />);
  await expandReel(user);
  await user.click(await screen.findByRole('button', { name: /edit and retry/i }));
  const prompt = screen.getByRole('textbox', { name: /^prompt$/i });
  expect(prompt).toHaveValue('original');
  await user.clear(prompt);
  await user.type(prompt, '  revised  ');
  await user.click(await screen.findByRole('button', { name: `+ ${label}` }));
  expect(screen.getByText('Style.')).toBeInTheDocument();
  expect(screen.getByText('anchor.png')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Show full prompt' }));
  expect(screen.getByText('Style. revised').textContent).toBe('Style.   revised  ');
  await user.click(screen.getByRole('button', { name: 'Copy full prompt' }));
  expect(await navigator.clipboard.readText()).toBe('Style.   revised  ');
  await user.click(screen.getByRole('button', { name: /retry with changes/i }));
  expect(previewMediaJobRetry).toHaveBeenLastCalledWith(job.id, { prompt: '  revised  ' }, { silent: true });
  expect(retryMediaJob).toHaveBeenCalledWith(job.id, { prompt: '  revised  ' }, { silent: true });
});

it('keeps edited prompt text when the retry is refused', async () => {
  listQueueMediaJobs.mockResolvedValue([failedCodexJob]);
  retryMediaJob.mockRejectedValueOnce(new Error('Prompt is 8001/8000 characters. Shorten it to retry.'));
  const user = userEvent.setup();
  render(<MediaJobsQueue kind="image" />);
  await expandReel(user);
  await user.click(await screen.findByLabelText('Edit and retry'));
  const prompt = screen.getByRole('textbox', { name: /^prompt$/i });
  await user.clear(prompt);
  await user.type(prompt, '  edited  ');
  await user.click(screen.getByRole('button', { name: /retry with changes/i }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Prompt is 8001/8000 characters. Shorten it to retry.'));
  expect(prompt).toHaveValue('  edited  ');
});

it.each([
  [{ guidanceScale: 3.25 }, /CFG Scale/],
  [{ steps: 151 }, /Steps/],
])('submits only the prompt change with saved sampler values %o', async (samplerParams, field) => {
  const job = {
    id: 'failed-video-sampler', kind: 'video', status: 'failed',
    params: { mode: 'text', prompt: 'original prompt', ...samplerParams },
  };
  listQueueMediaJobs.mockResolvedValue([job]);
  const user = userEvent.setup();
  render(<MediaJobsQueue kind="video" />);
  await expandReel(user);
  await user.click(await screen.findByLabelText('Edit and retry'));

  const samplerInput = screen.getByLabelText(field);
  expect(samplerInput.checkValidity()).toBe(false);

  const prompt = screen.getByRole('textbox', { name: /^prompt$/i });
  await user.clear(prompt);
  await user.type(prompt, 'revised prompt');
  await user.click(await findEnabledByRole('button', { name: /Retry with changes/i }));

  expect(retryMediaJob).toHaveBeenCalledWith(job.id, { prompt: 'revised prompt' }, { silent: true });
});

it('submits a style-only video retry with an empty authored prompt', async () => {
  const job = { id: 'video-style-only', kind: 'video', status: 'failed', params: { mode: 'grok', prompt: 'Woodcut', retryPrompt: '' } };
  listQueueMediaJobs.mockResolvedValue([job]);
  const user = userEvent.setup();
  render(<MediaJobsQueue kind="video" />);
  await expandReel(user);
  await user.click(await screen.findByLabelText('Edit and retry'));
  expect(screen.getByRole('textbox', { name: /^prompt$/i })).toHaveValue('');
  await user.click(screen.getByRole('button', { name: /retry with changes/i }));
  expect(retryMediaJob).toHaveBeenCalledWith(job.id, null, { silent: true });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { retypeSettled } from '../../test/settledInput';

// Mock the media-jobs API so the queue renders a controlled job list without
// the network. useAutoRefetch calls the fetcher on mount.
const listMediaJobs = vi.fn();
const retryMediaJob = vi.fn();
vi.mock('../../services/apiMediaJobs.js', () => ({
  listMediaJobs: (...a) => listMediaJobs(...a),
  cancelMediaJob: vi.fn(),
  cancelQueuedMediaJobs: vi.fn(),
  deleteMediaJob: vi.fn(),
  retryMediaJob: (...a) => retryMediaJob(...a),
  runMediaJobNow: vi.fn(),
}));

const getVideoGenStatus = vi.fn();
vi.mock('../../services/apiImageVideo.js', () => ({
  getVideoGenStatus: (...a) => getVideoGenStatus(...a),
}));
const listLorasFull = vi.fn();
vi.mock('../../services/api', () => ({
  listLorasFull: (...a) => listLorasFull(...a),
}));

const listLoraTrainingCheckpoints = vi.fn();
vi.mock('../../services/apiLoraTraining.js', () => ({
  listLoraTrainingCheckpoints: (...a) => listLoraTrainingCheckpoints(...a),
}));

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
  listMediaJobs.mockReset();
  listLoraTrainingCheckpoints.mockReset();
  retryMediaJob.mockReset();
  retryMediaJob.mockResolvedValue({ jobId: 'new-job-1234' });
  getVideoGenStatus.mockReset();
  getVideoGenStatus.mockResolvedValue({ models: [] });
  listLorasFull.mockReset();
  listLorasFull.mockResolvedValue([]);
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
  const toggle = await screen.findByText(/Show failed \/ canceled/);
  await user.click(toggle);
}

const failedCodexDefaultEffortJob = {
  id: 'codexdef00000dead',
  kind: 'image',
  status: 'failed',
  error: 'boom',
  queuedAt: '2026-06-19T10:00:00Z',
  // No explicit effort → ran on the shipped default.
  params: { prompt: 'a fox', mode: 'codex', model: 'gpt-5.6-luna' },
};

describe('MediaJobsQueue — unavailable state', () => {
  it('does not report a failed queue probe as an empty queue', async () => {
    listMediaJobs.mockRejectedValue(new Error('offline'));

    render(<MediaJobsQueue kind="image" />);

    expect(await screen.findByText('Queue status unavailable.')).toBeInTheDocument();
    expect(screen.queryByText('No image renders queued.')).not.toBeInTheDocument();
  });
});

describe('MediaJobsQueue — Creative Director renders', () => {
  it('surfaces a Creative Director-owned video job in the live queue', async () => {
    listMediaJobs.mockResolvedValue([{
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
    expect(screen.getByText(/#2 in queue/)).toBeInTheDocument();
    expect(screen.getByText(/an invented establishing shot/)).toBeInTheDocument();
  });
});

describe('MediaJobsQueue — video render lanes', () => {
  it('shows local, Grok, and remote work in separate queues', async () => {
    listMediaJobs.mockResolvedValue([
      {
        id: 'localvideo0001',
        kind: 'video',
        status: 'running',
        queuedAt: '2026-06-19T10:00:00Z',
        params: { prompt: 'an invented local shot', mode: 'text', modelId: 'local-video' },
      },
      {
        id: 'grokvideo0001',
        kind: 'video',
        status: 'running',
        queuedAt: '2026-06-19T10:01:00Z',
        params: { prompt: 'an invented cloud shot', mode: 'grok' },
      },
      {
        id: 'remotevideo001',
        kind: 'video',
        status: 'queued',
        queuedAt: '2026-06-19T10:02:00Z',
        renderer: 'remote',
        params: { prompt: 'an invented peer shot', mode: 'text', modelId: 'peer-video' },
      },
    ]);

    render(<MediaJobsQueue kind="video" />);

    expect(await screen.findByRole('region', { name: 'Local machine video queue' })).toHaveTextContent('an invented local shot');
    expect(screen.getByRole('region', { name: 'Grok video queue' })).toHaveTextContent('an invented cloud shot');
    expect(screen.getByRole('region', { name: 'Remote machines video queue' })).toHaveTextContent('an invented peer shot');
    expect(screen.getByRole('heading', { name: 'Local machine' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Grok' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Remote machines' })).toBeInTheDocument();
  });
});

describe('MediaJobsQueue — federated render badge', () => {
  it('badges a peer-rendered job remote instead of claiming a local render', async () => {
    // The server projects `renderer` and rebuilds `modelId` off the wire
    // request — the raw job nulls both so a rolled-back build fails closed.
    listMediaJobs.mockResolvedValue([{
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
    listMediaJobs.mockResolvedValue([{ ...failedLocalJob, status: 'running', error: undefined }]);

    render(<MediaJobsQueue kind="image" />);

    expect(await screen.findByText(/local \/ z-image-turbo/)).toBeInTheDocument();
  });

  it('offers plain Retry but not the editor on a failed federated job', async () => {
    // A prompt/model edit would never reach the peer — the remote executor
    // renders from the wire request inside the marker — so showing the form
    // would silently discard what the user typed.
    const user = userEvent.setup();
    listMediaJobs.mockResolvedValue([{ ...failedLocalJob, id: 'remotefail0000beef', renderer: 'remote' }]);

    render(<MediaJobsQueue kind="image" />);
    await expandReel(user);

    expect(await screen.findByRole('button', { name: /^Retry$/ })).toBeInTheDocument();
    expect(screen.queryByLabelText('Edit and retry')).not.toBeInTheDocument();
  });
});

describe('MediaJobsQueue — Codex reasoning-effort retry control', () => {
  it('surfaces the job effort in the row label', async () => {
    const user = userEvent.setup();
    listMediaJobs.mockResolvedValue([failedCodexJob]);
    render(<MediaJobsQueue kind="image" />);
    await expandReel(user);
    await waitFor(() => expect(screen.getByText(/codex \/ gpt-5.6-luna · high/)).toBeInTheDocument());
  });

  it('shows the effective default effort in the row label when the job stored none', async () => {
    const user = userEvent.setup();
    listMediaJobs.mockResolvedValue([failedCodexDefaultEffortJob]);
    render(<MediaJobsQueue kind="image" />);
    await expandReel(user);
    // Default-effort jobs store no `effort`, but codex still rendered at `low`.
    await waitFor(() => expect(screen.getByText(/codex \/ gpt-5.6-luna · low/)).toBeInTheDocument());
  });

  it('does not crash on a non-string effort from hand-edited data', async () => {
    const user = userEvent.setup();
    // A hand-edited media-jobs.json could carry a numeric effort; the row label
    // must coerce safely (mirror of codex.js) instead of throwing on .trim().
    listMediaJobs.mockResolvedValue([{
      ...failedCodexDefaultEffortJob, id: 'codexbadeff00dead', params: { ...failedCodexDefaultEffortJob.params, effort: 5 },
    }]);
    render(<MediaJobsQueue kind="image" />);
    await expandReel(user);
    // Non-string → treated as absent → resolves to the shipped default.
    await waitFor(() => expect(screen.getByText(/codex \/ gpt-5.6-luna · low/)).toBeInTheDocument());
  });

  it('pre-fills the retry editor to Default for a job that stored no effort', async () => {
    const user = userEvent.setup();
    listMediaJobs.mockResolvedValue([failedCodexDefaultEffortJob]);
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
    listMediaJobs.mockResolvedValue([failedCodexJob]);
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
    listMediaJobs.mockResolvedValue([failedCodexJob]);
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
    listMediaJobs.mockResolvedValue([failedLocalJob]);
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
    listMediaJobs.mockResolvedValue([failedAgyJob]);
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
    listMediaJobs.mockResolvedValue([{
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
    listMediaJobs.mockResolvedValue([trainingJob]);
    listLoraTrainingCheckpoints.mockResolvedValue({ checkpoints: [] });

    render(<MediaJobsQueue kind="training" />);

    await waitFor(() => expect(screen.getByText(/Training "Kessa"/)).toBeInTheDocument());
    expect(screen.getByText(/mflux \/ Kessa/)).toBeInTheDocument();
    // Header reads "Training Queue", not "… Render Queue".
    expect(screen.getByText(/Training Queue/i)).toBeInTheDocument();
  });

  it('draws a loss sparkline and sample thumbnails from the run checkpoints', async () => {
    listMediaJobs.mockResolvedValue([trainingJob]);
    listLoraTrainingCheckpoints.mockResolvedValue({
      checkpoints: [
        { step: 100, loss: 0.8, previewUrl: '/api/lora-training/runs/run-abc/samples/a.png', deployed: false },
        { step: 200, loss: 0.4, previewUrl: '/api/lora-training/runs/run-abc/samples/b.png', deployed: true },
      ],
    });

    render(<MediaJobsQueue kind="training" />);

    await waitFor(() => expect(screen.getByRole('img', { name: /Training loss curve/i })).toBeInTheDocument());
    // Latest loss is surfaced.
    expect(screen.getByText('0.4000')).toBeInTheDocument();
    // Both checkpoint sample thumbnails render.
    expect(screen.getByAltText('sample @ step 100')).toBeInTheDocument();
    expect(screen.getByAltText('sample @ step 200')).toBeInTheDocument();
  });

  it('shows a friendly placeholder when no checkpoints exist yet', async () => {
    listMediaJobs.mockResolvedValue([trainingJob]);
    listLoraTrainingCheckpoints.mockResolvedValue({ checkpoints: [] });

    render(<MediaJobsQueue kind="training" />);

    await waitFor(() => expect(screen.getByText(/No checkpoints yet/i)).toBeInTheDocument());
  });

  it('does not fetch checkpoints for non-training jobs', async () => {
    listMediaJobs.mockResolvedValue([{
      id: 'img1', kind: 'image', status: 'running', progress: 0.2,
      params: { prompt: 'a castle', modelId: 'z-image-turbo' },
    }]);

    render(<MediaJobsQueue kind="image" />);

    await waitFor(() => expect(screen.getByText(/"a castle"/)).toBeInTheDocument());
    expect(listLoraTrainingCheckpoints).not.toHaveBeenCalled();
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
    listMediaJobs.mockResolvedValue([failedInspireJob]);
    render(<MediaJobsQueue kind="video" />);
    await expandReel(user);
    await user.click(await screen.findByLabelText('Edit and retry'));
  };

  it('pre-fills the promise the failed job carried', async () => {
    const user = userEvent.setup();
    getVideoGenStatus.mockResolvedValue({ models: [LTX25, LTX2] });
    await openRetryEditor(user);
    const select = await screen.findByLabelText('Reference mode');
    await waitFor(() => expect(select.value).toBe('inspire'));
  });

  it('keeps it while the model catalog is still loading, then snaps back once the model resolves as unsupported', async () => {
    const user = userEvent.setup();
    // Never resolves: `currentModel` stays null, which means "not known yet" —
    // clearing there would drop a promise the original job really did make.
    getVideoGenStatus.mockReturnValue(new Promise(() => {}));
    await openRetryEditor(user);
    // No catalog ⇒ no picker to read; assert the retry still carries the mode.
    await user.click(screen.getByRole('button', { name: /Retry with changes/i }));
    expect(retryMediaJob).toHaveBeenCalledWith('refmodefail00dead', null, { silent: true });
  });

  it('clears the promise when the retry is retargeted at a model that pins frame one', async () => {
    const user = userEvent.setup();
    getVideoGenStatus.mockResolvedValue({ models: [LTX25, LTX2] });
    await openRetryEditor(user);
    await waitFor(() => expect(screen.getByLabelText('Reference mode').value).toBe('inspire'));

    await user.selectOptions(screen.getByLabelText('Model'), 'ltx2-model');
    await waitFor(() => expect(screen.getByLabelText('Reference mode').value).toBe('anchor'));
    // And the retry submits the clear rather than a value the server would 400.
    await user.click(screen.getByRole('button', { name: /Retry with changes/i }));
    const [, overrides] = retryMediaJob.mock.calls.at(-1);
    expect(overrides.i2vReferenceMode).toBeNull();
  });
});

// Preview-fidelity decode (#5423) as an editable requeue override (#5449). The
// shipped VIDEO_DRAFT_DECODERS table is EMPTY, so these use a fixture decoder
// entry — the option list is server-declared and rides on the model entry as
// `draftDecodeOptions`, which is exactly what the picker reads.
describe('MediaJobsQueue — video retry decode override (#5449)', () => {
  const DECODE_OPTIONS = [
    { id: 'full', label: 'Full decode', description: "The model's own decoder." },
    { id: 'draft', label: 'Example draft decoder', description: 'Preview fidelity only.', sizeLabel: '120 MB' },
  ];
  // Declares a draft decoder AND is somebody's Finish target — so the picker
  // must lock to Full on it, the way `draftDecodeDeclineReason` does server-side.
  const DELIVERY = {
    id: 'example-delivery', name: 'Example Delivery', runtime: 'minimax_h3',
    supportedModes: ['text', 'image'], draftDecodeOptions: DECODE_OPTIONS,
  };
  const DECODER_MODEL = {
    id: 'example-h3', name: 'Example H3', runtime: 'minimax_h3',
    supportedModes: ['text', 'image'], finishModelId: 'example-delivery',
    draftDecodeOptions: DECODE_OPTIONS,
  };
  const NO_DECODER_MODEL = {
    id: 'example-plain', name: 'Example Plain', runtime: 'ltx2',
    supportedModes: ['text', 'image'],
  };
  const MODELS = [DECODER_MODEL, DELIVERY, NO_DECODER_MODEL];

  const failedJob = (params = {}) => ({
    id: 'decodefail000dead',
    kind: 'video',
    status: 'failed',
    error: 'boom',
    queuedAt: '2026-06-19T10:00:00Z',
    params: {
      prompt: 'a fox', mode: 'text', modelId: 'example-h3', width: 704, height: 448, ...params,
    },
  });

  const openRetryEditor = async (user, job) => {
    listMediaJobs.mockResolvedValue([job]);
    render(<MediaJobsQueue kind="video" />);
    await expandReel(user);
    await user.click(await screen.findByLabelText('Edit and retry'));
  };

  it('renders no decode control for a model that declares no draft decoder', async () => {
    const user = userEvent.setup();
    getVideoGenStatus.mockResolvedValue({ models: MODELS });
    await openRetryEditor(user, failedJob({ modelId: 'example-plain' }));
    await screen.findByLabelText('Model');
    expect(screen.queryByLabelText('Decode')).not.toBeInTheDocument();
  });

  it('pre-fills the decode the job was submitted with', async () => {
    const user = userEvent.setup();
    getVideoGenStatus.mockResolvedValue({ models: MODELS });
    await openRetryEditor(user, failedJob({ draftDecode: 'draft' }));
    const select = await screen.findByLabelText('Decode');
    await waitFor(() => expect(select.value).toBe('draft'));
  });

  it('sends no override at all when the decode is left untouched', async () => {
    const user = userEvent.setup();
    getVideoGenStatus.mockResolvedValue({ models: MODELS });
    await openRetryEditor(user, failedJob({ draftDecode: 'draft' }));
    await waitFor(() => expect(screen.getByLabelText('Decode').value).toBe('draft'));

    await user.click(screen.getByRole('button', { name: /Retry with changes/i }));
    expect(retryMediaJob).toHaveBeenCalledWith('decodefail000dead', null, { silent: true });
  });

  it('requeues a full-decode job at draft fidelity when the user switches it', async () => {
    const user = userEvent.setup();
    getVideoGenStatus.mockResolvedValue({ models: MODELS });
    await openRetryEditor(user, failedJob());
    const select = await screen.findByLabelText('Decode');
    await waitFor(() => expect(select.value).toBe('full'));

    await user.selectOptions(select, 'draft');
    await user.click(screen.getByRole('button', { name: /Retry with changes/i }));
    expect(retryMediaJob).toHaveBeenCalledWith(
      'decodefail000dead', { draftDecode: 'draft' }, { silent: true },
    );
  });

  it('clears an inherited draft decode with null rather than submitting the full sentinel', async () => {
    const user = userEvent.setup();
    getVideoGenStatus.mockResolvedValue({ models: MODELS });
    await openRetryEditor(user, failedJob({ draftDecode: 'draft' }));
    const select = await screen.findByLabelText('Decode');
    await waitFor(() => expect(select.value).toBe('draft'));

    await user.selectOptions(select, 'full');
    await user.click(screen.getByRole('button', { name: /Retry with changes/i }));
    expect(retryMediaJob).toHaveBeenCalledWith(
      'decodefail000dead', { draftDecode: null }, { silent: true },
    );
  });

  it('locks the picker to Full on a delivery model and still sends no override', async () => {
    const user = userEvent.setup();
    getVideoGenStatus.mockResolvedValue({ models: MODELS });
    await openRetryEditor(user, failedJob({ modelId: 'example-delivery', draftDecode: 'draft' }));
    const select = await screen.findByLabelText('Decode');
    await waitFor(() => expect(select.value).toBe('full'));
    expect(select).toBeDisabled();
    expect(screen.getByText(/Example Delivery is a delivery model/)).toBeInTheDocument();

    // The lock is a real reset, not just a display: it clears the inherited
    // request so the requeued job stops carrying a decode it can never perform.
    await user.click(screen.getByRole('button', { name: /Retry with changes/i }));
    expect(retryMediaJob).toHaveBeenCalledWith(
      'decodefail000dead', { draftDecode: null }, { silent: true },
    );
  });

  it('sends no override for a delivery-model job that never carried a decode', async () => {
    const user = userEvent.setup();
    getVideoGenStatus.mockResolvedValue({ models: MODELS });
    await openRetryEditor(user, failedJob({ modelId: 'example-delivery' }));
    await waitFor(() => expect(screen.getByLabelText('Decode').value).toBe('full'));

    await user.click(screen.getByRole('button', { name: /Retry with changes/i }));
    expect(retryMediaJob).toHaveBeenCalledWith('decodefail000dead', null, { silent: true });
  });
  it('resets the decode to Full when the retry is retargeted at a delivery model', async () => {
    const user = userEvent.setup();
    getVideoGenStatus.mockResolvedValue({ models: MODELS });
    await openRetryEditor(user, failedJob({ draftDecode: 'draft' }));
    await waitFor(() => expect(screen.getByLabelText('Decode').value).toBe('draft'));

    await user.selectOptions(screen.getByLabelText('Model'), 'example-delivery');
    await waitFor(() => expect(screen.getByLabelText('Decode').value).toBe('full'));

    await user.click(screen.getByRole('button', { name: /Retry with changes/i }));
    const [, overrides] = retryMediaJob.mock.calls.at(-1);
    expect(overrides.draftDecode).toBeNull();
  });
});

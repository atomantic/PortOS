import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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

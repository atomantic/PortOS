import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// Mock the media-jobs API so the queue renders a controlled job list without
// the network. useAutoRefetch calls the fetcher on mount.
const listMediaJobs = vi.fn();
vi.mock('../../services/apiMediaJobs.js', () => ({
  listMediaJobs: (...a) => listMediaJobs(...a),
  cancelMediaJob: vi.fn(),
  cancelQueuedMediaJobs: vi.fn(),
  deleteMediaJob: vi.fn(),
  retryMediaJob: vi.fn(),
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

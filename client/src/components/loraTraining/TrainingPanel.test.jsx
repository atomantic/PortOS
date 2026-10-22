import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../hooks/useSseProgress', () => ({
  useSseProgress: () => ({ frames: [], latest: null, closed: false }),
}));
vi.mock('./LiveSampleGallery', () => ({ default: () => <div>live samples</div> }));
vi.mock('./CheckpointPicker', () => ({ default: () => null }));

const getLoraTrainingStatus = vi.fn();
const listLoraTrainingRuns = vi.fn();
const listImageModels = vi.fn();
vi.mock('../../services/api', () => ({
  getLoraTrainingStatus: (...a) => getLoraTrainingStatus(...a),
  listLoraTrainingRuns: (...a) => listLoraTrainingRuns(...a),
  listImageModels: (...a) => listImageModels(...a),
  startLoraTrainingRun: vi.fn(),
  cancelLoraTrainingRun: vi.fn(),
  resumeLoraTrainingRun: vi.fn(),
  stripLoraDatasetSharedCaptionFragments: vi.fn(),
}));

import TrainingPanel from './TrainingPanel';

const READY_STATUS = { runtimes: { mflux: { ready: true } }, defaults: { steps: 1000, rank: 16 } };
const MODELS = [{ id: 'flux2-klein-9b', name: 'Klein 9B', runner: 'flux2' }, { id: 'flux1-dev', runner: 'flux1' }];
const READINESS = { trainable: true, captioned: 12, required: 10, recommended: 20, quality: 'good' };
const ACTIVE_RUN = { id: 'run-1', status: 'running', runtime: 'mflux', baseModelId: 'flux2-klein-9b', progress: { step: 1, totalSteps: 10 } };

const renderPanel = async () => {
  render(
    <MemoryRouter>
      <TrainingPanel dataset={{ id: 'ds-1' }} readiness={READINESS} triggerSaving={false} />
    </MemoryRouter>,
  );
  await act(async () => {});
};

const trainButton = () => screen.getByRole('button', { name: /Train$/ });

beforeEach(() => {
  vi.clearAllMocks();
  getLoraTrainingStatus.mockResolvedValue(READY_STATUS);
  listLoraTrainingRuns.mockResolvedValue([]);
  listImageModels.mockResolvedValue(MODELS);
});

describe('TrainingPanel failed reads', () => {
  it('offers Start when every read succeeds', async () => {
    await renderPanel();
    expect(trainButton()).toBeEnabled();
    expect(screen.getByLabelText('Base model')).toHaveValue('flux2-klein-9b');
  });

  it('shows a Retry — not the mflux install message — when the status read fails, and recovers on retry', async () => {
    getLoraTrainingStatus.mockRejectedValueOnce(new Error('Gateway timeout'));
    await renderPanel();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load training status — Gateway timeout');
    expect(screen.getByText('Could not read training status')).toBeInTheDocument();
    expect(screen.queryByText(/No training engine/)).toBeNull();
    expect(trainButton()).toBeDisabled();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByLabelText('Steps')).toHaveValue(1000);
    expect(trainButton()).toBeEnabled();
  });

  it('still reports a missing engine when the status read succeeds with no ready runtime', async () => {
    getLoraTrainingStatus.mockResolvedValue({ runtimes: {}, defaults: {} });
    await renderPanel();
    expect(screen.getByText(/No training engine/)).toBeInTheDocument();
    expect(trainButton()).toBeDisabled();
  });

  it('disables Start with a Retry when the runs read fails, then shows the in-progress view for an active run', async () => {
    listLoraTrainingRuns.mockRejectedValueOnce(new Error('Server unavailable'));
    await renderPanel();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load training runs — Server unavailable');
    expect(trainButton()).toBeDisabled();

    listLoraTrainingRuns.mockResolvedValueOnce([ACTIVE_RUN]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(screen.getByText(/Training mflux/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Train$/ })).toBeNull();
  });

  it('shows an error row — not "No trainable models registered" — when the models read fails', async () => {
    listImageModels.mockRejectedValueOnce(new Error('Server unavailable'));
    await renderPanel();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load base models — Server unavailable');
    expect(screen.queryByText('No trainable models registered')).toBeNull();
    expect(trainButton()).toBeDisabled();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(screen.getByLabelText('Base model')).toHaveValue('flux2-klein-9b');
    expect(trainButton()).toBeEnabled();
  });

  it('says "No trainable models registered" only for a successful empty list', async () => {
    listImageModels.mockResolvedValue([{ id: 'flux1-dev', runner: 'flux1' }]);
    await renderPanel();
    expect(screen.getByText('No trainable models registered')).toBeInTheDocument();
  });
});

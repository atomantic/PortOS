import { describe, expect, it, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mock = vi.hoisted(() => ({ getRiggingReadiness: vi.fn(), rigImageTo3dModel: vi.fn() }));
vi.mock('../../services/api', () => mock);

const features = vi.hoisted(() => ({ enabled: true }));
vi.mock('../../hooks/useInstanceFeatures', () => ({
  useInstanceFeatures: () => ({ isFeatureEnabled: () => features.enabled }),
}));

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('../ui/Toast', () => ({ default: toast }));

import RigPanel from './RigPanel';

const READY_RECORD = { id: 'image3d-example', status: 'ready', assetPath: '/data/image-to-3d/image3d-example/model.glb' };
const RUNTIME_READY = { ready: true, reason: null };

describe('RigPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    features.enabled = true;
    mock.getRiggingReadiness.mockResolvedValue(RUNTIME_READY);
  });

  it('stays out of the page entirely when the rigging feature is off', () => {
    features.enabled = false;
    const { container } = render(<RigPanel record={READY_RECORD} onRecordChange={() => {}} />);
    expect(container).toBeEmptyDOMElement();
    expect(mock.getRiggingReadiness).not.toHaveBeenCalled();
  });

  it('names the blocker instead of offering a button that would fail', async () => {
    mock.getRiggingReadiness.mockResolvedValue({ ready: false, reason: 'module-unimportable' });
    render(<RigPanel record={READY_RECORD} onRecordChange={() => {}} />);

    expect(await screen.findByText(/only half installed/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /rig this character/i })).toBeDisabled();
  });

  it('rigs on click and hands the updated record back to the page', async () => {
    const rigged = {
      ...READY_RECORD,
      rig: {
        status: 'ready',
        assetPath: '/data/image-to-3d/image3d-example/rig/rig-example/character.rigged.glb',
        bytes: 2_400_000,
        summary: {
          vertices: 10000, bones: 17, unweightedFractionAfterHeat: 0.002,
          nearestBoneCompleted: 20, unweightedCeiling: 0.005,
        },
      },
    };
    mock.rigImageTo3dModel.mockResolvedValue(rigged);
    const onRecordChange = vi.fn();
    const { rerender } = render(<RigPanel record={READY_RECORD} onRecordChange={onRecordChange} />);

    await waitFor(() => expect(screen.getByRole('button', { name: /rig this character/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /rig this character/i }));

    await waitFor(() => expect(onRecordChange).toHaveBeenCalledWith(rigged));
    expect(mock.rigImageTo3dModel).toHaveBeenCalledWith('image3d-example', {}, { silent: true });

    rerender(<RigPanel record={rigged} onRecordChange={onRecordChange} />);
    expect(screen.getByText(/Rigged against 17 bones/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /download rigged/i }))
      .toHaveAttribute('href', rigged.rig.assetPath);
  });

  it('shows the measured sentence a refused rig came back with, not a generic error', async () => {
    const failed = {
      ...READY_RECORD,
      rig: {
        status: 'failed',
        error: 'Automatic weighting left too much of the mesh unweighted: automatic weighting left 4.2% of 10000 '
          + 'vertices unweighted, ceiling is 0.5%.',
      },
    };
    render(<RigPanel record={failed} onRecordChange={() => {}} />);
    expect(await screen.findByText(/4\.2% of 10000 vertices unweighted, ceiling is 0\.5%/)).toBeInTheDocument();
  });
});

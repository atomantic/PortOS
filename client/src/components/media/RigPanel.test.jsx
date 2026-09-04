import { describe, expect, it, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mock = vi.hoisted(() => ({
  getRiggingReadiness: vi.fn(),
  rigImageTo3dModel: vi.fn(),
  listRiggingClips: vi.fn(),
  retargetImageTo3dModel: vi.fn(),
}));
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
const RIGGED_RECORD = {
  ...READY_RECORD,
  rig: {
    status: 'ready',
    assetPath: '/data/image-to-3d/image3d-example/rig/rig-example/character.rigged.glb',
    bytes: 2_400_000,
    summary: { vertices: 10000, bones: 17, unweightedFractionAfterHeat: 0.002, nearestBoneCompleted: 20, unweightedCeiling: 0.005 },
  },
};

describe('RigPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    features.enabled = true;
    mock.getRiggingReadiness.mockResolvedValue(RUNTIME_READY);
    mock.listRiggingClips.mockResolvedValue({ clips: [] });
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

    // A ready rig also mounts the retarget lane's clip fetch (#6065) — let it settle.
    await screen.findByText(/no animation clips yet/i);
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

// #6065
describe('RigPanel retarget lane', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    features.enabled = true;
    mock.getRiggingReadiness.mockResolvedValue(RUNTIME_READY);
  });

  it('explains an empty clip library instead of rendering a dead picker', async () => {
    mock.listRiggingClips.mockResolvedValue({ clips: [] });
    render(<RigPanel record={RIGGED_RECORD} onRecordChange={() => {}} />);

    expect(await screen.findByText(/no animation clips yet/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/animation clip/i)).not.toBeInTheDocument();
  });

  it('runs a diagnostic preview and shows the proposed cleanup without offering write yet', async () => {
    mock.listRiggingClips.mockResolvedValue({ clips: [{ filename: 'wave.glb', label: 'Wave' }] });
    const diagnosed = {
      ...RIGGED_RECORD,
      retarget: {
        status: 'ready',
        mode: 'diagnostic',
        clipFile: 'wave.glb',
        assetPath: '/data/image-to-3d/image3d-example/retarget/r1/character.animated.glb',
        summary: {
          clip: 'Wave', clipDuration: 1.5, proposedCleanupVertices: 40, changedCleanupVertices: 0,
          cleanupCapVertices: 240, cleanupOverCap: false, sampledFrames: 8, maxJointTranslation: 0.12,
        },
      },
    };
    mock.retargetImageTo3dModel.mockResolvedValue(diagnosed);
    const onRecordChange = vi.fn();
    const { rerender } = render(<RigPanel record={RIGGED_RECORD} onRecordChange={onRecordChange} />);

    const select = await screen.findByLabelText(/animation clip/i);
    fireEvent.change(select, { target: { value: 'wave.glb' } });
    fireEvent.click(screen.getByRole('button', { name: /preview retarget/i }));

    await waitFor(() => expect(onRecordChange).toHaveBeenCalledWith(diagnosed));
    expect(mock.retargetImageTo3dModel)
      .toHaveBeenCalledWith('image3d-example', { clip: 'wave.glb', mode: 'diagnostic' }, { silent: true });

    rerender(<RigPanel record={diagnosed} onRecordChange={onRecordChange} />);

    // Nothing was written: no "animated" download link, only the measured proposal
    // plus a follow-up write action.
    expect(screen.queryByRole('link', { name: /download animated/i })).not.toBeInTheDocument();
    expect(screen.getByText(/proposed.*cleanup 40 of 240 vertex cap/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /apply cleanup/i })).toBeEnabled();
  });

  it('refuses the write action with a reason instead of offering it when the proposal is over cap', async () => {
    mock.listRiggingClips.mockResolvedValue({ clips: [{ filename: 'wave.glb', label: 'Wave' }] });
    const overCap = {
      ...RIGGED_RECORD,
      retarget: {
        status: 'ready',
        mode: 'diagnostic',
        clipFile: 'wave.glb',
        summary: {
          clip: 'Wave', clipDuration: 1.5, proposedCleanupVertices: 400, changedCleanupVertices: 0,
          cleanupCapVertices: 240, cleanupOverCap: true, sampledFrames: 8, maxJointTranslation: 0.12,
        },
      },
    };
    render(<RigPanel record={overCap} onRecordChange={() => {}} />);

    expect(await screen.findByText(/over cap and cannot be applied/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /apply cleanup/i })).not.toBeInTheDocument();
  });

  it('applies the write run from a diagnostic result and shows the published animation', async () => {
    mock.listRiggingClips.mockResolvedValue({ clips: [{ filename: 'wave.glb', label: 'Wave' }] });
    const diagnosed = {
      ...RIGGED_RECORD,
      retarget: {
        status: 'ready',
        mode: 'diagnostic',
        clipFile: 'wave.glb',
        summary: {
          clip: 'Wave', clipDuration: 1.5, proposedCleanupVertices: 40, changedCleanupVertices: 0,
          cleanupCapVertices: 240, cleanupOverCap: false, sampledFrames: 8, maxJointTranslation: 0.12,
        },
      },
    };
    const written = {
      ...RIGGED_RECORD,
      retarget: {
        ...diagnosed.retarget,
        mode: 'write',
        assetPath: '/data/image-to-3d/image3d-example/retarget/r1/character.animated.glb',
      },
    };
    mock.retargetImageTo3dModel.mockResolvedValue(written);
    const onRecordChange = vi.fn();
    const { rerender } = render(<RigPanel record={diagnosed} onRecordChange={onRecordChange} />);

    fireEvent.click(await screen.findByRole('button', { name: /apply cleanup/i }));

    await waitFor(() => expect(onRecordChange).toHaveBeenCalledWith(written));
    expect(mock.retargetImageTo3dModel)
      .toHaveBeenCalledWith('image3d-example', { clip: 'wave.glb', mode: 'write' }, { silent: true });

    rerender(<RigPanel record={written} onRecordChange={onRecordChange} />);
    expect(screen.getByRole('link', { name: /download animated/i }))
      .toHaveAttribute('href', written.retarget.assetPath);
  });

  it('shows a gate refusal as the server\'s own sentence', async () => {
    mock.listRiggingClips.mockResolvedValue({ clips: [{ filename: 'wave.glb', label: 'Wave' }] });
    const failed = {
      ...RIGGED_RECORD,
      retarget: {
        status: 'failed',
        clipFile: 'wave.glb',
        mode: 'diagnostic',
        error: 'The clip and this character do not share a complete skeleton: 3 bones could not be matched (LeftHand, RightHand, Spine2).',
      },
    };
    render(<RigPanel record={failed} onRecordChange={() => {}} />);
    expect(await screen.findByText(/3 bones could not be matched \(LeftHand, RightHand, Spine2\)/)).toBeInTheDocument();
  });
});

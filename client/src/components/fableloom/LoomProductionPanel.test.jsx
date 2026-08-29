import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import LoomProductionPanel from './LoomProductionPanel';
import * as api from '../../services/api';

vi.mock('../../services/api');

describe('LoomProductionPanel', () => {
  const sampleLoom = { id: 'loom-1', name: 'Test Loom' };
  const sampleEpisode = { id: 'ep-1', title: 'Episode 1' };

  const samplePlan = {
    mode: 'current_canon',
    totalNodes: 3,
    reachableNodeCount: 3,
    totalAssets: 6,
    readyAssetsCount: 4,
    alreadyRenderedCount: 2,
    blockedAssetsCount: 0,
    assetsByType: { image: 3, video: 3, dialogue: 0 },
    executionStages: [{ stageIndex: 0, assetCount: 2 }],
    plannedAssets: [
      { id: 'asset-1', nodeId: 'node-1', type: 'image', status: 'ready' },
      { id: 'asset-2', nodeId: 'node-1', type: 'video_entry', status: 'ready' },
    ],
    convergenceIssues: [],
    exactInputIssues: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    api.planLoomEpisodeProduction.mockResolvedValue(samplePlan);
    api.startLoomEpisodeProductionBatch.mockResolvedValue({
      id: 'batch-1',
      status: 'in_progress',
      summary: { total: 6, completed: 2 },
    });
    api.reviewLoomEpisodeContinuity.mockResolvedValue({
      passed: false,
      nodesEvaluated: 3,
      summary: { errors: 1, warnings: 0, info: 0 },
      findings: [
        {
          id: 'f-1',
          category: 'visual',
          severity: 'error',
          code: 'MISSING_UNIVERSE_CHARACTER',
          message: 'Character missing in Universe',
          remediation: 'Rebind character',
          nodeId: 'node-1',
        },
      ],
    });
  });

  it('renders plan summary and allows switching mode', async () => {
    render(<LoomProductionPanel loom={sampleLoom} episode={sampleEpisode} onSelectNode={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Episodic Production Plan')).toBeInTheDocument();
    });

    expect(screen.getByText('6')).toBeInTheDocument(); // total assets
    expect(screen.getByText('Start Batch Production')).toBeInTheDocument();

    const modeSelect = screen.getByLabelText('Mode:');
    fireEvent.change(modeSelect, { target: { value: 'exact_inputs' } });

    await waitFor(() => {
      expect(api.planLoomEpisodeProduction).toHaveBeenCalledWith('loom-1', 'ep-1', { mode: 'exact_inputs' }, { silent: true });
    });
  });

  it('starts batch production when button is clicked', async () => {
    render(<LoomProductionPanel loom={sampleLoom} episode={sampleEpisode} onSelectNode={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Start Batch Production')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Start Batch Production'));

    await waitFor(() => {
      expect(api.startLoomEpisodeProductionBatch).toHaveBeenCalledWith('loom-1', 'ep-1', { mode: 'current_canon' }, { silent: true });
      expect(screen.getByText('Cancel Production Batch')).toBeInTheDocument();
    });
  });

  it('runs continuity review and displays findings with node selection', async () => {
    const onSelectNode = vi.fn();
    render(<LoomProductionPanel loom={sampleLoom} episode={sampleEpisode} onSelectNode={onSelectNode} />);

    await waitFor(() => {
      expect(screen.getByText('Run Continuity Review')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Run Continuity Review'));

    await waitFor(() => {
      expect(api.reviewLoomEpisodeContinuity).toHaveBeenCalledWith('loom-1', 'ep-1', {}, { silent: true });
      expect(screen.getByText('Character missing in Universe')).toBeInTheDocument();
      expect(screen.getByText('Remediation: Rebind character')).toBeInTheDocument();
    });

    const findingButton = screen.getByText('Character missing in Universe').closest('button');
    fireEvent.click(findingButton);
    expect(onSelectNode).toHaveBeenCalledWith('node-1');
  });
});

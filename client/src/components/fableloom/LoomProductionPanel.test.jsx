import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
      { id: 'asset-3', nodeId: 'node-2', type: 'image', status: 'already_rendered' },
      { id: 'asset-4', nodeId: 'node-2', type: 'video_entry', status: 'ready' },
      { id: 'asset-5', nodeId: 'node-3', type: 'image', status: 'ready' },
      { id: 'asset-6', nodeId: 'node-3', type: 'video_entry', status: 'ready' },
    ],
    convergenceIssues: [],
    exactInputIssues: [],
    formatMismatches: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    api.planLoomEpisodeProduction.mockResolvedValue(samplePlan);
    api.startLoomEpisodeProductionBatch.mockResolvedValue({
      id: 'batch-1',
      status: 'in_progress',
      summary: { total: 6, completed: 2 },
    });
    api.updateLoom.mockResolvedValue({
      ...sampleLoom,
      renderSettings: { formatId: 'portrait-9-16' },
    });
  });

  it('defaults media to 16:9 and persists one shared image/video output format', async () => {
    const onLoomUpdate = vi.fn();
    render(
      <LoomProductionPanel
        loom={sampleLoom}
        episode={sampleEpisode}
        onSelectNode={vi.fn()}
        onLoomUpdate={onLoomUpdate}
      />,
    );

    expect(await screen.findByLabelText('Output')).toHaveValue('landscape-16-9');
    expect(screen.getByRole('option', { name: '16:9 landscape · 1024×576' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Output'), { target: { value: 'portrait-9-16' } });

    await waitFor(() => {
      expect(api.updateLoom).toHaveBeenCalledWith(
        'loom-1',
        { renderSettings: { formatId: 'portrait-9-16' } },
        { silent: true },
      );
      expect(onLoomUpdate).toHaveBeenCalledWith(expect.objectContaining({
        renderSettings: { formatId: 'portrait-9-16' },
      }));
    });
  });

  it('renders plan summary and allows switching mode', async () => {
    render(<LoomProductionPanel loom={sampleLoom} episode={sampleEpisode} onSelectNode={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Episodic Production Plan')).toBeInTheDocument();
    });

    expect(screen.getByText('3')).toBeInTheDocument(); // storyboard images only by default
    expect(screen.getByText('Generate Storyboard Images')).toBeInTheDocument();

    const modeSelect = screen.getByLabelText('Mode:');
    fireEvent.change(modeSelect, { target: { value: 'exact_inputs' } });

    await waitFor(() => {
      expect(api.planLoomEpisodeProduction).toHaveBeenCalledWith('loom-1', 'ep-1', { mode: 'exact_inputs' }, { silent: true });
    });
  });

  it('starts batch production when button is clicked', async () => {
    render(<LoomProductionPanel loom={sampleLoom} episode={sampleEpisode} onSelectNode={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Generate Storyboard Images')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Generate Storyboard Images'));

    await waitFor(() => {
      expect(api.startLoomEpisodeProductionBatch).toHaveBeenCalledWith(
        'loom-1', 'ep-1', { mode: 'current_canon', assetTypes: ['image'] }, { silent: true },
      );
      expect(screen.getByText('Cancel Production Batch')).toBeInTheDocument();
    });
  });

  it('blocks batch media until the ordered beat arc is ready', async () => {
    render(
      <LoomProductionPanel
        loom={{ ...sampleLoom, episodes: [{ id: 'ep-1', number: 1 }] }}
        episode={{ ...sampleEpisode, nodes: [{ id: 'node-1' }] }}
        onSelectNode={vi.fn()}
      />,
    );

    const generate = await screen.findByText('Generate Storyboard Images');
    expect(generate).toBeDisabled();
    expect(screen.getByText(/ordered beat arc/i)).toBeInTheDocument();
    expect(api.startLoomEpisodeProductionBatch).not.toHaveBeenCalled();
  });

  it('shows and enforces the ordered storyboard sequence gate', async () => {
    api.planLoomEpisodeProduction.mockResolvedValueOnce({
      ...samplePlan,
      episodeOrderReadiness: {
        ready: false,
        reason: 'Finish storyboard images for Episode 1 before generating Episode 2.',
        missingScenes: [{ episodeId: 'ep-1', nodeId: 'node-1' }],
      },
      planningIssues: ['Episode order: Finish storyboard images for Episode 1 before generating Episode 2.'],
    });

    render(<LoomProductionPanel loom={sampleLoom} episode={sampleEpisode} onSelectNode={vi.fn()} />);

    const generate = await screen.findByText('Generate Storyboard Images');
    expect(generate).toBeDisabled();
    expect(screen.getByText('Ordered storyboard sequence')).toBeInTheDocument();
    expect(screen.getByText(/1 prior scene image\(s\) still need to be rendered/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Finish storyboard images for Episode 1 before generating Episode 2/i)).toHaveLength(2);
    expect(api.startLoomEpisodeProductionBatch).not.toHaveBeenCalled();
  });

  it('explains which portrait assets will be regenerated in the selected format', async () => {
    api.planLoomEpisodeProduction.mockResolvedValueOnce({
      ...samplePlan,
      formatMismatches: [{
        assetId: 'node-1:image',
        assetType: 'image',
        nodeId: 'node-1',
        nodeTitle: 'Door challenge',
        actualWidth: 576,
        actualHeight: 1024,
        expectedWidth: 1024,
        expectedHeight: 576,
        expectedAspectRatio: '16:9',
      }],
    });

    render(<LoomProductionPanel loom={sampleLoom} episode={sampleEpisode} onSelectNode={vi.fn()} />);

    expect(await screen.findByText('Existing media uses another aspect ratio')).toBeInTheDocument();
    expect(screen.getByText(/1 media asset\(s\).*16:9 \(1024×576\)/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Door challenge · image: 576×1024 → 16:9/i })).toBeInTheDocument();
  });

  it('ignores a stale plan response after the producer changes episodes', async () => {
    let resolveFirst;
    let resolveSecond;
    api.planLoomEpisodeProduction
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
    const { rerender } = render(
      <LoomProductionPanel loom={sampleLoom} episode={sampleEpisode} onSelectNode={vi.fn()} />,
    );
    await waitFor(() => expect(api.planLoomEpisodeProduction).toHaveBeenCalledWith(
      'loom-1', 'ep-1', { mode: 'current_canon' }, { silent: true },
    ));

    rerender(
      <LoomProductionPanel
        loom={sampleLoom}
        episode={{ id: 'ep-2', title: 'Episode 2' }}
        onSelectNode={vi.fn()}
      />,
    );
    await waitFor(() => expect(api.planLoomEpisodeProduction).toHaveBeenCalledWith(
      'loom-1', 'ep-2', { mode: 'current_canon' }, { silent: true },
    ));
    await act(async () => resolveSecond({
      ...samplePlan,
      plannedAssets: [{
        id: 'asset-ep-2', nodeId: 'node-ep-2', nodeTitle: 'Episode 2 asset',
        type: 'image', status: 'ready', stageIndex: 0,
      }],
    }));
    expect(await screen.findByText('Episode 2 asset')).toBeInTheDocument();

    await act(async () => resolveFirst({
      ...samplePlan,
      plannedAssets: [{
        id: 'asset-ep-1', nodeId: 'node-ep-1', nodeTitle: 'Stale Episode 1 asset',
        type: 'image', status: 'ready', stageIndex: 0,
      }],
    }));
    expect(screen.queryByText('Stale Episode 1 asset')).not.toBeInTheDocument();
    expect(screen.getByText('Episode 2 asset')).toBeInTheDocument();
  });

});

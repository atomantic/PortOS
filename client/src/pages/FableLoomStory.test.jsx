import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import userEvent from '@testing-library/user-event';

const toastMocks = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }));
vi.mock('../components/ui/Toast', () => ({ default: toastMocks }));

vi.mock('../services/api', () => ({
  addLoomEpisode: vi.fn(),
  addLoomNode: vi.fn(),
  deleteLoomEpisode: vi.fn(),
  generateImage: vi.fn(),
  generateVideo: vi.fn(),
  getLoom: vi.fn(),
  getPipelineSeries: vi.fn(),
  getUniverse: vi.fn(),
  updateLoomEpisode: vi.fn(),
  updateLoom: vi.fn(),
  updateLoomNode: vi.fn(),
  weaveLoomEpisode: vi.fn(),
}));

// Keep the graph lightweight while exposing its page-owned scene-media action
// and state. The canvas component itself covers preview/button rendering.
vi.mock('../components/fableloom/LoomCanvas', () => ({
  default: ({ episode, mediaJobs, onGenerateImage, generationDisabled }) => (
    <div>
      <button
        type="button"
        disabled={generationDisabled}
        onClick={() => onGenerateImage(episode.nodes[0])}
      >
        Canvas generate image
      </button>
      {episode.nodes[1] && (
        <button
          type="button"
          disabled={generationDisabled}
          onClick={() => onGenerateImage(episode.nodes[1])}
        >
          Canvas generate second image
        </button>
      )}
      <span data-testid="canvas-image-status">{mediaJobs[episode.nodes[0].id]?.image?.status || 'idle'}</span>
      <span data-testid="canvas-image-filename">{episode.nodes[0].image || 'none'}</span>
    </div>
  ),
}));
vi.mock('../components/fableloom/LoomMediaJobWatchers', () => ({
  default: ({ jobs, onUpdate, onTerminal }) => {
    const image = jobs['node-1']?.image;
    if (!image?.jobId) return null;
    return (
      <button
        type="button"
        onClick={() => {
          const failed = { ...image, status: 'failed', error: 'Synthetic provider failure' };
          onUpdate('node-1', 'image', image.jobId, failed);
          onTerminal('node-1', 'image', image.jobId, failed);
        }}
      >
        Simulate image failure
      </button>
    );
  },
}));
vi.mock('../components/fableloom/LoomEpisodeOutline', () => ({ default: ({ episode }) => <div data-testid="episode-outline">{episode.title}</div> }));
vi.mock('../components/fableloom/LoomNodeEditor', () => ({
  default: ({ node }) => <div>Editing scene: {node.title}</div>,
}));
vi.mock('../components/fableloom/LoomPlayPanel', () => ({ default: () => <div /> }));
vi.mock('../components/fableloom/LoomSettingsDrawer', () => ({ default: () => <div /> }));
vi.mock('../components/fableloom/LoomSeriesPlan', () => ({ default: () => <div>Series planning workspace</div> }));
vi.mock('../components/fableloom/LoomValidationPanel', () => ({ default: () => <div>Episode validation</div> }));

import * as api from '../services/api';
import FableLoomStory from './FableLoomStory';

const loom = (fields = {}) => ({
  id: 'loom-1',
  name: 'Example Loom',
  format: 'prose',
  universeId: null,
  seriesId: null,
  episodes: [],
  ...fields,
});

const episode = (fields = {}) => ({
  id: 'ep-1',
  number: 1,
  title: 'The First Door',
  synopsis: 'A choice waits in the dark.',
  startNodeId: 'node-1',
  nodes: [
    { id: 'node-1', title: 'Threshold', prose: 'You stand before the first door.', transitions: [] },
  ],
  ...fields,
});

const renderEditor = (initialEntry = '/fableloom/loom-1') => render(
  <MemoryRouter initialEntries={[initialEntry]}>
    <Routes>
      <Route path="/fableloom/:loomId" element={<FableLoomStory />} />
      <Route path="/fableloom/:loomId/:episodeId" element={<FableLoomStory />} />
      <Route path="/fableloom/:loomId/:episodeId/:nodeId" element={<FableLoomStory />} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  api.getLoom.mockResolvedValue(loom());
  api.getUniverse.mockResolvedValue(null);
});

describe('FableLoomStory navigation and series backlink', () => {
  it('opens an empty loom in the series plan before asking for episodes', async () => {
    renderEditor();

    expect(await screen.findByText('Series planning workspace')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Series plan' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('button', { name: 'Add the first episode' })).toBeNull();
  });

  it('still opens the first episode for an established loom', async () => {
    api.getLoom.mockResolvedValue(loom({ episodes: [episode()] }));
    renderEditor();

    expect(await screen.findByRole('tab', { name: '1. The First Door' }))
      .toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByText('Series planning workspace')).toBeNull();
  });

  it('links back to the series a loom is soft-linked to', async () => {
    api.getLoom.mockResolvedValue(loom({ seriesId: 'ser-1' }));
    api.getPipelineSeries.mockResolvedValue({ id: 'ser-1', name: 'Example Series' });
    renderEditor();

    const link = await screen.findByRole('link', { name: /Example Series/ });
    expect(link).toHaveAttribute('href', '/pipeline/series/ser-1');
    expect(api.getPipelineSeries).toHaveBeenCalledWith('ser-1', { silent: true });
  });

  it('renders no chip (not a dead link) when the linked series has been deleted', async () => {
    api.getLoom.mockResolvedValue(loom({ seriesId: 'ser-gone' }));
    api.getPipelineSeries.mockRejectedValue(new Error('Series not found'));
    renderEditor();

    await screen.findByText('Example Loom');
    await waitFor(() => expect(api.getPipelineSeries).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: /series/i })).toBeNull();
  });

  it('falls back to a placeholder for a series with no name', async () => {
    api.getLoom.mockResolvedValue(loom({ seriesId: 'ser-1' }));
    api.getPipelineSeries.mockResolvedValue({ id: 'ser-1', name: '' });
    renderEditor();

    expect(await screen.findByRole('link', { name: /Untitled series/ }))
      .toHaveAttribute('href', '/pipeline/series/ser-1');
  });

  it('never asks for a series when the loom is standalone', async () => {
    renderEditor();
    await screen.findByText('Example Loom');
    expect(api.getPipelineSeries).not.toHaveBeenCalled();
  });

  it('keeps series planning outside the episode tabs at a dedicated URL', async () => {
    render(
      <MemoryRouter initialEntries={['/fableloom/loom-1/plan']}>
        <Routes>
          <Route path="/fableloom/:loomId/:episodeId" element={<FableLoomStory />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('Series planning workspace')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Series plan' })).toBeInTheDocument();
  });
});

describe('FableLoomStory episode outline route', () => {
  it('renders the outline view at its dedicated URL without mounting the graph editor', async () => {
    api.getLoom.mockResolvedValue(loom({ episodes: [episode()] }));
    render(
      <MemoryRouter initialEntries={['/fableloom/loom-1/ep-1/outline']}>
        <Routes>
          <Route path="/fableloom/:loomId/:episodeId/outline" element={<FableLoomStory view="outline" />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('episode-outline')).toHaveTextContent('The First Door');
    expect(screen.getByRole('tab', { name: 'Outline' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('FableLoomStory mobile scene details', () => {
  it('opens the selected scene in a slide-up sheet and closes back to the graph', async () => {
    const user = userEvent.setup();
    api.getLoom.mockResolvedValue(loom({ episodes: [episode()] }));
    renderEditor('/fableloom/loom-1/ep-1/node-1');

    const sheet = await screen.findByTestId('scene-details-sheet');
    expect(sheet).toHaveClass('absolute', 'bottom-0', 'rounded-t-2xl', 'lg:static');
    expect(screen.getByText('Editing scene: Threshold')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close scene details' }));

    await waitFor(() => expect(screen.queryByTestId('scene-details-sheet')).not.toBeInTheDocument());
    expect(screen.getByTestId('loom-validation-rail')).toBeInTheDocument();
    expect(screen.getByText('Episode validation')).toBeInTheDocument();
  });
});

describe('FableLoomStory scene media lifecycle', () => {
  it('queues with canonical universe style and notifies when the render later fails', async () => {
    const user = userEvent.setup();
    api.getLoom.mockResolvedValue(loom({
      universeId: 'universe-1',
      styleNotes: 'blue dusk lighting',
      episodes: [episode({
        nodes: [{
          id: 'node-1',
          title: 'Threshold',
          prose: 'You stand before the first door.',
          imagePrompt: 'an ancient gate in alien grass',
          transitions: [],
        }],
      })],
    }));
    api.getUniverse.mockResolvedValue({
      id: 'universe-1',
      influences: { embrace: ['painted ink'], avoid: ['photorealism'] },
    });
    api.generateImage.mockResolvedValue({ jobId: 'image-job-1', status: 'queued' });
    renderEditor();

    const generate = await screen.findByRole('button', { name: 'Canvas generate image' });
    await waitFor(() => expect(generate).toBeEnabled());
    await user.click(generate);

    await waitFor(() => expect(api.generateImage).toHaveBeenCalledTimes(1));
    expect(api.generateImage).toHaveBeenCalledWith({
      prompt: 'painted ink. an ancient gate in alien grass\n\nStyle: blue dusk lighting',
      negativePrompt: 'photorealism',
      fableLoom: { loomId: 'loom-1', episodeId: 'ep-1', nodeId: 'node-1' },
    }, { silent: true });
    expect(screen.getByTestId('canvas-image-status')).toHaveTextContent('queued');

    await user.click(screen.getByRole('button', { name: 'Simulate image failure' }));
    await waitFor(() => expect(screen.getByTestId('canvas-image-status')).toHaveTextContent('failed'));
    expect(toastMocks.error).toHaveBeenCalledWith(
      'Scene image generation failed: Synthetic provider failure',
    );
  });

  it('shows a synchronously generated scene image without watching a nonexistent job', async () => {
    const user = userEvent.setup();
    api.getLoom.mockResolvedValue(loom({
      episodes: [episode({
        nodes: [{
          id: 'node-1',
          title: 'Threshold',
          prose: 'You stand before the first door.',
          imagePrompt: 'an example threshold',
          transitions: [],
        }],
      })],
    }));
    api.generateImage.mockResolvedValue({
      generationId: 'sync-generation-1',
      filename: 'finished-scene.png',
      path: '/data/images/finished-scene.png',
    });
    renderEditor();

    await user.click(await screen.findByRole('button', { name: 'Canvas generate image' }));

    await waitFor(() => expect(screen.getByTestId('canvas-image-filename'))
      .toHaveTextContent('finished-scene.png'));
    expect(screen.getByTestId('canvas-image-status')).toHaveTextContent('idle');
    expect(toastMocks.success).toHaveBeenCalledWith('Scene image ready');
  });

  it('sends only the scene tag so the server resolves typed graph continuity', async () => {
    const user = userEvent.setup();
    api.getLoom.mockResolvedValue(loom({
      episodes: [episode({
        nodes: [
          {
            id: 'node-1',
            title: 'Threshold',
            imagePrompt: 'an ancient gate',
            image: 'threshold.png',
            transitions: [{ id: 'tr-1', targetNodeId: 'node-2', intent: 'Continue' }],
          },
          {
            id: 'node-2',
            title: 'Beyond',
            imagePrompt: 'the same scout crosses into the observatory',
            transitions: [],
          },
        ],
      })],
    }));
    api.generateImage.mockResolvedValue({ jobId: 'image-job-2', status: 'queued' });
    renderEditor();

    await user.click(await screen.findByRole('button', { name: 'Canvas generate second image' }));

    await waitFor(() => expect(api.generateImage).toHaveBeenCalledWith({
      prompt: 'the same scout crosses into the observatory',
      fableLoom: { loomId: 'loom-1', episodeId: 'ep-1', nodeId: 'node-2' },
    }, { silent: true }));
  });

  it('does not silently retry a rejected canon request without its conditioning', async () => {
    const user = userEvent.setup();
    api.getLoom.mockResolvedValue(loom({
      episodes: [episode({
        nodes: [
          {
            id: 'node-1',
            image: 'threshold.png',
            transitions: [{ id: 'tr-1', targetNodeId: 'node-2', intent: 'Continue' }],
          },
          {
            id: 'node-2',
            imagePrompt: 'the scout enters the observatory',
            transitions: [],
          },
        ],
      })],
    }));
    api.generateImage.mockRejectedValueOnce(Object.assign(new Error('Canon conditioning unavailable'), {
      code: 'FABLELOOM_CANON_CONDITIONING_UNAVAILABLE',
    }));
    renderEditor();

    await user.click(await screen.findByRole('button', { name: 'Canvas generate second image' }));

    await waitFor(() => expect(api.generateImage).toHaveBeenCalledTimes(1));
    expect(api.generateImage.mock.calls[0]).toEqual([{
      prompt: 'the scout enters the observatory',
      fableLoom: { loomId: 'loom-1', episodeId: 'ep-1', nodeId: 'node-2' },
    }, { silent: true }]);
    expect(toastMocks.error).toHaveBeenCalledWith(
      'Could not start scene image: Canon conditioning unavailable',
    );
  });
});

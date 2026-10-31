vi.mock('../../services/apiTracks.js', () => ({ listTracks: vi.fn(async () => []) }));
vi.mock('../../services/apiRunwayCatalog.js', async (importOriginal) => ({ ...await importOriginal(), loadRunwayCatalog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/apiMusic.js', () => ({ listMusicEngines: vi.fn(() => Promise.resolve({ engines: [] })) }));
vi.mock('../../services/apiUniverseBuilder.js', () => ({ listUniverseNames: vi.fn(() => Promise.resolve([])) }));
vi.mock('../../services/apiPipeline.js', () => ({ listPipelineSeriesNames: vi.fn(() => Promise.resolve([])) }));
vi.mock('../../services/apiCatalog.js', () => ({ listCatalogIngredients: vi.fn(() => Promise.resolve([])) }));
import { it, expect, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
vi.mock('../../services/apiCreativeDirector.js', () => ({ createCreativeDirectorProject: vi.fn(), updateCreativeDirectorProject: vi.fn() }));
vi.mock('../../services/apiStoryboards.js', () => ({ startVideoFromStoryboard: vi.fn() }));
vi.mock('../../services/apiImageVideo.js', () => ({ listVideoModels: vi.fn(() => Promise.resolve([])) }));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
import { createCreativeDirectorProject, updateCreativeDirectorProject } from '../../services/apiCreativeDirector.js';
import { startVideoFromStoryboard } from '../../services/apiStoryboards.js';
import { listVideoModels } from '../../services/apiImageVideo.js';
import { listTracks } from '../../services/apiTracks.js';
import VideoDraftDrawer from './VideoDraftDrawer.jsx';
it('edits the same draft without changing workspace or losing source revisions', async () => {
  const user = userEvent.setup();
  const project = { id: 'draft-1', targetDurationSeconds: 30, workspace: 'video', name: 'Example', videoDraft: { sources: [{ kind: 'catalog', id: 'example', revision: 'r1' }], durationRange: { min: 20, max: 40 }, reviewPolicy: 'review', checkpoints: ['rough-cut'] } };
  updateCreativeDirectorProject.mockResolvedValue(project);
  const saved = vi.fn();
  render(<MemoryRouter><VideoDraftDrawer open project={project} onClose={vi.fn()} onSaved={saved} /></MemoryRouter>);
  expect(screen.getByText(/Exact target: 30 seconds/)).toBeInTheDocument();
  await user.clear(screen.getByLabelText('Name'));
  await user.type(screen.getByLabelText('Name'), 'Revised');
  await user.click(screen.getByRole('button', { name: 'Save draft' }));
  await waitFor(() => expect(saved).toHaveBeenCalledWith(project));
  expect(updateCreativeDirectorProject).toHaveBeenCalledWith('draft-1', expect.objectContaining({ name: 'Revised', targetDurationSeconds: 30, videoDraft: expect.objectContaining({ sources: project.videoDraft.sources, checkpoints: ['rough-cut'] }) }), { silent: true });
  expect(updateCreativeDirectorProject.mock.calls[0][1]).not.toHaveProperty('workspace');
  expect(createCreativeDirectorProject).not.toHaveBeenCalled();
});

it('restores and saves a Reactor pin even when the local model list is unavailable', async () => {
  const user = userEvent.setup();
  const project = { id: 'reactor-draft', name: 'Example reactor', workspace: 'video', modelId: 'saved-local', renderBackend: { image: { mode: 'local' }, video: { mode: 'reactor', modelId: 'fast-h3' } } };
  updateCreativeDirectorProject.mockResolvedValue(project);
  render(<MemoryRouter initialEntries={['/?videoDraftTab=production']}><VideoDraftDrawer open project={project} onClose={vi.fn()} onSaved={vi.fn()} /></MemoryRouter>);
  expect(screen.getByLabelText('Media backend')).toHaveValue('reactor');
  expect(screen.getByLabelText('Media model')).toHaveValue('fast-h3');
  await user.click(screen.getByRole('button', { name: 'Save draft' }));
  await waitFor(() => expect(updateCreativeDirectorProject).toHaveBeenCalledWith('reactor-draft', expect.objectContaining({ renderBackend: project.renderBackend }), { silent: true }));
});

it('defaults a new Video draft to native clip audio', async () => {
  render(<MemoryRouter initialEntries={['/?videoDraftTab=production']}><VideoDraftDrawer open onClose={vi.fn()} onSaved={vi.fn()} /></MemoryRouter>);
  expect(await screen.findByLabelText('Audio contract')).toHaveValue('native');
});

it('starts a draft from a storyboard with its panels as the shots, shown before saving', async () => {
  const user = userEvent.setup();
  const storyboard = { id: 'sb-example', name: 'Example board', logline: 'A girl comes home.', aspectRatio: '9:16', updatedAt: '2026-01-01T00:00:00.000Z', beats: [
    { id: 'beat-1', title: 'Arrival', panels: [{ id: 'panel-1', action: 'She steps off the bus', framing: 'wide', seconds: 4 }, { id: 'panel-2', action: 'The square', seconds: 12 }] },
  ] };
  const created = { id: 'cd-example', workspace: 'video' };
  startVideoFromStoryboard.mockResolvedValue({ project: created });
  const saved = vi.fn();
  render(<MemoryRouter><VideoDraftDrawer open storyboard={storyboard} onClose={vi.fn()} onSaved={saved} /></MemoryRouter>);
  expect(screen.getByLabelText('Name')).toHaveValue('Example board');
  expect(screen.getByText('She steps off the bus. Wide shot.')).toBeInTheDocument();
  expect(screen.getByText(/cut to 10 s/)).toBeInTheDocument();
  expect(screen.queryByLabelText('Minimum duration (seconds)')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Save draft' }));
  await waitFor(() => expect(saved).toHaveBeenCalledWith(created));
  expect(startVideoFromStoryboard).toHaveBeenCalledWith('sb-example', { boardUpdatedAt: storyboard.updatedAt, project: expect.objectContaining({
    name: 'Example board', userStory: 'A girl comes home.', aspectRatio: '9:16', targetDurationSeconds: 14,
    videoDraft: expect.objectContaining({ durationRange: { min: 14, max: 14 } }),
  }) }, { silent: true });
  expect(createCreativeDirectorProject).not.toHaveBeenCalled();
});

it('holds a storyboard too short for a Video and says why', async () => {
  const storyboard = { id: 'sb-short', name: 'Short', updatedAt: 'x', beats: [{ id: 'beat-1', title: 'Blink', panels: [{ id: 'panel-1', action: 'A flash', seconds: 2 }] }] };
  render(<MemoryRouter><VideoDraftDrawer open storyboard={storyboard} onClose={vi.fn()} onSaved={vi.fn()} /></MemoryRouter>);
  await act(async () => {});
  expect(screen.getByRole('alert')).toHaveTextContent('needs at least 5 s');
  expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
});

it('shows a retryable error beside a failed picker read and fills it on retry', async () => {
  const user = userEvent.setup();
  listVideoModels.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce([{ id: 'model-a', name: 'Model A' }]);
  listTracks.mockRejectedValueOnce(new Error('tracks down'));
  render(<MemoryRouter initialEntries={['/?videoDraftTab=production']}><VideoDraftDrawer open onClose={vi.fn()} onSaved={vi.fn()} /></MemoryRouter>);
  expect(await screen.findByText(/Could not load media models — boom/)).toBeInTheDocument();
  const calls = listTracks.mock.calls.length;
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByRole('option', { name: 'Model A' })).toBeInTheDocument();
  expect(screen.queryByText(/Could not load media models/)).not.toBeInTheDocument();
  expect(listTracks.mock.calls.length).toBe(calls);
});

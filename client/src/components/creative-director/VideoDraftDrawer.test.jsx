vi.mock('../../services/apiMusic.js', () => ({ listMusicEngines: vi.fn(() => Promise.resolve({ engines: [] })) }));
vi.mock('../../services/apiUniverseBuilder.js', () => ({ listUniverses: vi.fn(() => Promise.resolve([])) }));
vi.mock('../../services/apiPipeline.js', () => ({ listPipelineSeries: vi.fn(() => Promise.resolve([])) }));
vi.mock('../../services/apiCatalog.js', () => ({ listCatalogIngredients: vi.fn(() => Promise.resolve([])) }));
import { it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
vi.mock('../../services/apiCreativeDirector.js', () => ({ createCreativeDirectorProject: vi.fn(), updateCreativeDirectorProject: vi.fn() }));
vi.mock('../../services/apiImageVideo.js', () => ({ listVideoModels: vi.fn(() => Promise.resolve([])) }));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
import { createCreativeDirectorProject, updateCreativeDirectorProject } from '../../services/apiCreativeDirector.js';
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

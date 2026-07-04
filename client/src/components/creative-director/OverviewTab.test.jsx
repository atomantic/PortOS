/**
 * Tests for the Overview tab's autonomous auto-cast affordance (#1810):
 * the button gates on a searchable brief, appends returned cast on success,
 * and renders an empty-state when the project has no cast yet.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../services/apiCreativeDirector.js', () => ({
  updateCreativeDirectorProject: vi.fn(async () => ({})),
  applyCreativeDirectorAutoCast: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import OverviewTab from './OverviewTab.jsx';
import { applyCreativeDirectorAutoCast } from '../../services/apiCreativeDirector.js';
import toast from '../ui/Toast';

const baseProject = {
  id: 'cd-1', name: 'Neon Run', aspectRatio: '16:9', quality: 'standard',
  modelId: 'm1', targetDurationSeconds: 30, collectionId: 'col-1',
  styleSpec: 'rain noir', userStory: null, cast: [],
};

const renderTab = (project, onProjectUpdate = () => {}) =>
  render(<MemoryRouter><OverviewTab project={project} onProjectUpdate={onProjectUpdate} /></MemoryRouter>);

beforeEach(() => { vi.clearAllMocks(); });

describe('OverviewTab auto-cast (#1810)', () => {
  it('shows the empty-state when the project has no cast', () => {
    renderTab(baseProject);
    expect(screen.getByText(/No cast yet/i)).toBeTruthy();
    expect(screen.getByText('Cast (0)')).toBeTruthy();
  });

  it('disables Auto-cast when there is no style spec or story', () => {
    renderTab({ ...baseProject, styleSpec: '', userStory: '' });
    expect(screen.getByRole('button', { name: /Auto-cast/i })).toHaveProperty('disabled', true);
  });

  it('enables Auto-cast when a style spec is present', () => {
    renderTab(baseProject);
    expect(screen.getByRole('button', { name: /^Auto-cast$/i })).toHaveProperty('disabled', false);
  });

  it('enables Auto-cast when only a user story is present', () => {
    renderTab({ ...baseProject, styleSpec: '', userStory: 'a courier flees the city' });
    expect(screen.getByRole('button', { name: /^Auto-cast$/i })).toHaveProperty('disabled', false);
  });

  it('applies auto-cast and pushes the returned cast up on success', async () => {
    const onProjectUpdate = vi.fn();
    applyCreativeDirectorAutoCast.mockResolvedValue({
      project: { id: 'cd-1', cast: [{ ingredientId: 'p1', name: 'The Spire', type: 'place', role: 'location' }] },
      added: [{ ingredientId: 'p1', name: 'The Spire' }],
      suggestions: [],
    });
    renderTab(baseProject, onProjectUpdate);

    fireEvent.click(screen.getByRole('button', { name: /^Auto-cast$/i }));

    await waitFor(() => expect(applyCreativeDirectorAutoCast).toHaveBeenCalledWith('cd-1', {}, { silent: true }));
    await waitFor(() => expect(onProjectUpdate).toHaveBeenCalledWith({
      cast: [{ ingredientId: 'p1', name: 'The Spire', type: 'place', role: 'location' }],
    }));
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/added 1 ingredient/i));
  });

  it('toasts an info message when nothing new matched', async () => {
    applyCreativeDirectorAutoCast.mockResolvedValue({ project: { id: 'cd-1', cast: [] }, added: [], suggestions: [] });
    renderTab(baseProject);
    fireEvent.click(screen.getByRole('button', { name: /^Auto-cast$/i }));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(expect.stringMatching(/no new catalog matches/i)));
  });

  it('toasts an error and recovers when auto-cast fails', async () => {
    applyCreativeDirectorAutoCast.mockRejectedValue(new Error('boom'));
    renderTab(baseProject);
    fireEvent.click(screen.getByRole('button', { name: /^Auto-cast$/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('boom'));
    // button re-enables after the failure
    await waitFor(() => expect(screen.getByRole('button', { name: /^Auto-cast$/i })).toHaveProperty('disabled', false));
  });
});

describe('OverviewTab auto-compose (#1817)', () => {
  it('offers the +treatment toggle only when the project has no treatment yet', () => {
    const { unmount } = renderTab(baseProject);
    expect(screen.getByLabelText(/\+ treatment/i)).toBeTruthy();
    unmount();
    renderTab({ ...baseProject, treatment: { scenes: [] } });
    expect(screen.queryByLabelText(/\+ treatment/i)).toBeNull();
  });

  it('passes compose:true when the toggle is checked', async () => {
    applyCreativeDirectorAutoCast.mockResolvedValue({ project: { id: 'cd-1', cast: [] }, added: [], suggestions: [] });
    renderTab(baseProject);
    fireEvent.click(screen.getByLabelText(/\+ treatment/i));
    fireEvent.click(screen.getByRole('button', { name: /^Auto-cast$/i }));
    await waitFor(() => expect(applyCreativeDirectorAutoCast).toHaveBeenCalledWith('cd-1', { compose: true }, { silent: true }));
  });

  it('toasts a composing message and flips status to planning when the server kicks off the treatment', async () => {
    const onProjectUpdate = vi.fn();
    applyCreativeDirectorAutoCast.mockResolvedValue({
      project: { id: 'cd-1', cast: [{ ingredientId: 'p1', name: 'The Spire' }] },
      added: [{ ingredientId: 'p1', name: 'The Spire' }],
      suggestions: [],
      composing: true,
    });
    renderTab(baseProject, onProjectUpdate);
    fireEvent.click(screen.getByLabelText(/\+ treatment/i));
    fireEvent.click(screen.getByRole('button', { name: /^Auto-cast$/i }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/composing the treatment/i)));
    // Optimistically enable polling — the detail page disables it for 'draft'.
    expect(onProjectUpdate).toHaveBeenCalledWith(expect.objectContaining({ status: 'planning' }));
  });

  it('omits the compose flag when the toggle is left unchecked', async () => {
    applyCreativeDirectorAutoCast.mockResolvedValue({ project: { id: 'cd-1', cast: [] }, added: [], suggestions: [] });
    renderTab(baseProject);
    fireEvent.click(screen.getByRole('button', { name: /^Auto-cast$/i }));
    await waitFor(() => expect(applyCreativeDirectorAutoCast).toHaveBeenCalledWith('cd-1', {}, { silent: true }));
  });

  it('does not flip status to planning when the server did not start composing', async () => {
    const onProjectUpdate = vi.fn();
    applyCreativeDirectorAutoCast.mockResolvedValue({
      project: { id: 'cd-1', cast: [{ ingredientId: 'p1', name: 'The Spire' }] },
      added: [{ ingredientId: 'p1', name: 'The Spire' }],
      suggestions: [],
      // composing absent — server declined (e.g. paused project)
    });
    renderTab(baseProject, onProjectUpdate);
    fireEvent.click(screen.getByLabelText(/\+ treatment/i));
    fireEvent.click(screen.getByRole('button', { name: /^Auto-cast$/i }));
    await waitFor(() => expect(onProjectUpdate).toHaveBeenCalled());
    expect(onProjectUpdate).toHaveBeenCalledWith(expect.not.objectContaining({ status: expect.anything() }));
  });
});

describe('OverviewTab first-pass gen (#1818)', () => {
  it('offers the +portraits toggle even when the project already has a treatment', () => {
    const { unmount } = renderTab(baseProject);
    expect(screen.getByLabelText(/\+ portraits/i)).toBeTruthy();
    unmount();
    // Independent of the +treatment toggle — still offered with a treatment present.
    renderTab({ ...baseProject, treatment: { scenes: [] } });
    expect(screen.getByLabelText(/\+ portraits/i)).toBeTruthy();
  });

  it('passes generateFirstPass:true when the toggle is checked', async () => {
    applyCreativeDirectorAutoCast.mockResolvedValue({ project: { id: 'cd-1', cast: [] }, added: [], suggestions: [] });
    renderTab(baseProject);
    fireEvent.click(screen.getByLabelText(/\+ portraits/i));
    fireEvent.click(screen.getByRole('button', { name: /^Auto-cast$/i }));
    await waitFor(() => expect(applyCreativeDirectorAutoCast).toHaveBeenCalledWith('cd-1', { generateFirstPass: true }, { silent: true }));
  });

  it('combines compose + generateFirstPass when both toggles are checked', async () => {
    applyCreativeDirectorAutoCast.mockResolvedValue({ project: { id: 'cd-1', cast: [] }, added: [], suggestions: [] });
    renderTab(baseProject);
    fireEvent.click(screen.getByLabelText(/\+ treatment/i));
    fireEvent.click(screen.getByLabelText(/\+ portraits/i));
    fireEvent.click(screen.getByRole('button', { name: /^Auto-cast$/i }));
    await waitFor(() => expect(applyCreativeDirectorAutoCast).toHaveBeenCalledWith('cd-1', { compose: true, generateFirstPass: true }, { silent: true }));
  });

  it('suffixes the portrait count onto the success toast', async () => {
    applyCreativeDirectorAutoCast.mockResolvedValue({
      project: { id: 'cd-1', cast: [{ ingredientId: 'p1', name: 'The Spire' }] },
      added: [{ ingredientId: 'p1', name: 'The Spire' }],
      suggestions: [],
      firstPass: { mode: 'local', enqueued: [{ ingredientId: 'p1', jobId: 'j1' }], skipped: [] },
    });
    renderTab(baseProject);
    fireEvent.click(screen.getByLabelText(/\+ portraits/i));
    fireEvent.click(screen.getByRole('button', { name: /^Auto-cast$/i }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/rendering 1 first-pass portrait/i)));
  });

  it('omits the flag and portrait suffix when the toggle is unchecked', async () => {
    applyCreativeDirectorAutoCast.mockResolvedValue({
      project: { id: 'cd-1', cast: [{ ingredientId: 'p1', name: 'The Spire' }] },
      added: [{ ingredientId: 'p1', name: 'The Spire' }],
      suggestions: [],
    });
    renderTab(baseProject);
    fireEvent.click(screen.getByRole('button', { name: /^Auto-cast$/i }));
    await waitFor(() => expect(applyCreativeDirectorAutoCast).toHaveBeenCalledWith('cd-1', {}, { silent: true }));
    expect(toast.success).toHaveBeenCalledWith(expect.not.stringMatching(/first-pass portrait/i));
  });
});

describe('OverviewTab first-pass music bed (#1928)', () => {
  it('offers the +music bed toggle independent of cast/treatment state', () => {
    renderTab(baseProject);
    expect(screen.getByLabelText(/\+ music bed/i)).toBeTruthy();
  });

  it('passes generateFirstPassMusicBed:true when the toggle is checked', async () => {
    applyCreativeDirectorAutoCast.mockResolvedValue({ project: { id: 'cd-1', cast: [] }, added: [], suggestions: [] });
    renderTab(baseProject);
    fireEvent.click(screen.getByLabelText(/\+ music bed/i));
    fireEvent.click(screen.getByRole('button', { name: /^Auto-cast$/i }));
    await waitFor(() => expect(applyCreativeDirectorAutoCast).toHaveBeenCalledWith('cd-1', { generateFirstPassMusicBed: true }, { silent: true }));
  });

  it('combines portraits + music bed when both toggles are checked', async () => {
    applyCreativeDirectorAutoCast.mockResolvedValue({ project: { id: 'cd-1', cast: [] }, added: [], suggestions: [] });
    renderTab(baseProject);
    fireEvent.click(screen.getByLabelText(/\+ portraits/i));
    fireEvent.click(screen.getByLabelText(/\+ music bed/i));
    fireEvent.click(screen.getByRole('button', { name: /^Auto-cast$/i }));
    await waitFor(() => expect(applyCreativeDirectorAutoCast).toHaveBeenCalledWith(
      'cd-1', { generateFirstPass: true, generateFirstPassMusicBed: true }, { silent: true },
    ));
  });

  it('suffixes the music-bed status onto the success toast when it enqueued', async () => {
    applyCreativeDirectorAutoCast.mockResolvedValue({
      project: { id: 'cd-1', cast: [{ ingredientId: 'p1', name: 'The Spire' }] },
      added: [{ ingredientId: 'p1', name: 'The Spire' }],
      suggestions: [],
      firstPassMusicBed: { mode: 'musicgen', enqueued: true, jobId: 'job-1' },
    });
    renderTab(baseProject);
    fireEvent.click(screen.getByLabelText(/\+ music bed/i));
    fireEvent.click(screen.getByRole('button', { name: /^Auto-cast$/i }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/first-pass music bed/i)));
  });

  it('omits the flag and music-bed suffix when the toggle is unchecked', async () => {
    applyCreativeDirectorAutoCast.mockResolvedValue({
      project: { id: 'cd-1', cast: [{ ingredientId: 'p1', name: 'The Spire' }] },
      added: [{ ingredientId: 'p1', name: 'The Spire' }],
      suggestions: [],
    });
    renderTab(baseProject);
    fireEvent.click(screen.getByRole('button', { name: /^Auto-cast$/i }));
    await waitFor(() => expect(applyCreativeDirectorAutoCast).toHaveBeenCalledWith('cd-1', {}, { silent: true }));
    expect(toast.success).toHaveBeenCalledWith(expect.not.stringMatching(/music bed/i));
  });

  it('resets the toggle when the project switches', () => {
    const { rerender } = renderTab(baseProject);
    fireEvent.click(screen.getByLabelText(/\+ music bed/i));
    expect(screen.getByLabelText(/\+ music bed/i)).toHaveProperty('checked', true);
    rerender(<MemoryRouter><OverviewTab project={{ ...baseProject, id: 'cd-2' }} onProjectUpdate={() => {}} /></MemoryRouter>);
    expect(screen.getByLabelText(/\+ music bed/i)).toHaveProperty('checked', false);
  });
});

describe('OverviewTab music bed field display (#1928)', () => {
  it('shows nothing when the project has no music bed yet', () => {
    renderTab(baseProject);
    expect(screen.queryByText('Music bed')).toBeNull();
  });

  it('shows the filename + duration + engine once the durable hook attaches one', () => {
    renderTab({
      ...baseProject,
      musicBed: { filename: 'music-gen-abc.wav', durationSec: 12.4, engine: 'musicgen', modelId: 'musicgen-medium' },
    });
    expect(screen.getByText('Music bed')).toBeTruthy();
    expect(screen.getByText(/music-gen-abc\.wav \(12s, musicgen\)/)).toBeTruthy();
  });
});

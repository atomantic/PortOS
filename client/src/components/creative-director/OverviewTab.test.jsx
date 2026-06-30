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

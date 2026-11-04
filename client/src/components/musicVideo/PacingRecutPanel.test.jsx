import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import PacingRecutPanel from './PacingRecutPanel.jsx';
import { previewMusicVideoPacingRecut, recutMusicVideoToPacing } from '../../services/apiMusicVideo.js';
vi.mock('../../services/apiMusicVideo.js', () => ({ previewMusicVideoPacingRecut: vi.fn(), recutMusicVideoToPacing: vi.fn() }));
const project = { id: 'mv-example', updatedAt: 'revision-1', scenes: [{ sceneId: 's1' }] };
const proposal = { revision: 'a'.repeat(64), updatedAt: project.updatedAt, minSec: 1, maxSec: 3, total: 1, added: 1, skipped: [],
  changes: [{ sceneId: 's1', label: 'Walk', pieces: [{ startSec: 0, endSec: 2, cut: 'lyric' }, { startSec: 2, endSec: 4, cut: null }] }] };
beforeEach(() => { vi.resetAllMocks(); previewMusicVideoPacingRecut.mockResolvedValue(proposal); });

describe('Pacing re-cut', () => {
  it('shows the cut preview before applying its exact revision and returns the saved board', async () => {
    const onApplied = vi.fn();
    recutMusicVideoToPacing.mockResolvedValue({ project: { ...project, scenes: [{ sceneId: 's1' }, { sceneId: 's2' }] } });
    render(<PacingRecutPanel project={project} onApplied={onApplied} />);
    fireEvent.click(screen.getByRole('button', { name: 'Re-cut to pacing' }));
    await screen.findByText('1 shot → 2 shots · 1–3s pacing');
    expect(screen.getByRole('list', { name: 'Planned pacing cuts' }).textContent).toContain('lyric start');
    expect(recutMusicVideoToPacing).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Apply cuts' }));
    await waitFor(() => expect(onApplied).toHaveBeenCalledWith(expect.objectContaining({ scenes: [{ sceneId: 's1' }, { sceneId: 's2' }] })));
    expect(recutMusicVideoToPacing).toHaveBeenCalledWith(project.id, proposal.revision, { silent: true });
  });

  it('disables a stale preview and displays server failures without replacing the board', async () => {
    const onApplied = vi.fn();
    const { rerender } = render(<PacingRecutPanel project={project} onApplied={onApplied} />);
    fireEvent.click(screen.getByRole('button', { name: 'Re-cut to pacing' }));
    await screen.findByText('1 shot → 2 shots · 1–3s pacing');
    rerender(<PacingRecutPanel project={{ ...project, updatedAt: 'revision-2' }} onApplied={onApplied} />);
    expect(screen.getByRole('button', { name: 'Apply cuts' }).disabled).toBe(true);
    previewMusicVideoPacingRecut.mockRejectedValue(new Error('Pacing maximum required'));
    fireEvent.click(screen.getByRole('button', { name: 'Preview again' }));
    await screen.findByText('Pacing maximum required');
    expect(onApplied).not.toHaveBeenCalled();
  });
});

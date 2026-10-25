// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import LyricOverlaySetting from './LyricOverlaySetting.jsx';
import { updateMusicVideoProject } from '../../services/apiMusicVideo.js';

vi.mock('../../services/apiMusicVideo.js', () => ({ updateMusicVideoProject: vi.fn() }));

describe('automatic lyric overlay preference', () => {
  it('saves only visibility, waits for persistence and applies the saved project', async () => {
    let finish;
    updateMusicVideoProject.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const project = { id: 'mv-example', lyricCues: [{ text: 'Example line', startSec: 1, endSec: 2 }] };
    const onUpdated = vi.fn();
    const view = render(<LyricOverlaySetting project={project} onUpdated={onUpdated} />);
    const checkbox = screen.getByRole('checkbox', { name: 'Show automatic lyric overlays' });
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    expect(updateMusicVideoProject).toHaveBeenCalledWith('mv-example', { lyricOverlayEnabled: false }, { silent: true });
    expect(checkbox).toBeDisabled();
    expect(onUpdated).not.toHaveBeenCalled();
    const saved = { ...project, lyricOverlayEnabled: false };
    finish(saved);
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(saved));
    view.rerender(<LyricOverlaySetting project={saved} onUpdated={onUpdated} />);
    expect(checkbox).not.toBeChecked();
    expect(project.lyricCues).toHaveLength(1);
  });

  it('keeps the saved preference and reports a failed update', async () => {
    updateMusicVideoProject.mockRejectedValueOnce(new Error('Save refused'));
    const onUpdated = vi.fn();
    render(<LyricOverlaySetting project={{ id: 'mv-example', lyricOverlayEnabled: false }} onUpdated={onUpdated} />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Save refused');
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByRole('checkbox')).toBeEnabled();
    expect(onUpdated).not.toHaveBeenCalled();
  });
});

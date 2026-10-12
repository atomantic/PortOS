import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import PreviewDock from './PreviewDock.jsx';

describe('PreviewDock video shot steps', () => {
  it('steps a draft excerpt through its own shots in song time', () => {
    const project = { id: 'p', scenes: [{ startSec: 18 }, { startSec: 22 }, { startSec: 26 }, { startSec: 31 }] };
    const sources = [{ id: 'draft-1', kind: 'video', label: 'Draft', src: '/data/videos/draft.mp4', startSec: 20, endSec: 30 }];
    render(<MemoryRouter><PreviewDock project={project} sources={sources} audioUrl="/song.mp3" /></MemoryRouter>);
    const video = screen.getByLabelText('Draft excerpt preview');
    Object.defineProperty(video, 'readyState', { value: 4, configurable: true });
    expect(screen.getByText('Shot – / 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next shot' }));
    expect(video.currentTime).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: 'Next shot' }));
    expect(video.currentTime).toBe(6);
    expect(screen.getByText('Shot 2 / 2')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next shot' }).disabled).toBe(true);
  });

  it('steps a draft excerpt frame by frame in song frames, pausing it', () => {
    const project = { id: 'p', scenes: [{ startSec: 22 }] };
    const sources = [{ id: 'draft-1', kind: 'video', label: 'Draft', src: '/data/videos/draft.mp4', startSec: 20, endSec: 30 }];
    render(<MemoryRouter><PreviewDock project={project} sources={sources} audioUrl="/song.mp3" /></MemoryRouter>);
    const video = screen.getByLabelText('Draft excerpt preview');
    Object.defineProperty(video, 'readyState', { value: 4, configurable: true });
    video.pause = vi.fn();
    expect(screen.getByLabelText('Frame').value).toBe('480');
    fireEvent.click(screen.getByRole('button', { name: 'Forward 1 frame' }));
    expect(video.pause).toHaveBeenCalled();
    expect(video.currentTime).toBeCloseTo(1.5 / 24);
    expect(screen.getByLabelText('Frame').value).toBe('481');
  });
});

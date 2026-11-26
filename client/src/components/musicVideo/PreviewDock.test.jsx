import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import PreviewDock from './PreviewDock.jsx';
import { listPreviewSources } from '../../lib/musicVideoStages.js';

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

  it('pauses the video and opens the shot on screen from Edit shot', () => {
    const project = { id: 'p', scenes: [{ sceneId: 'a', startSec: 18 }, { sceneId: 'b', startSec: 22 }] };
    const sources = [{ id: 'draft-1', kind: 'video', label: 'Draft', src: '/data/videos/draft.mp4', startSec: 20, endSec: 30 }];
    const onEditShot = vi.fn();
    render(<MemoryRouter><PreviewDock project={project} sources={sources} audioUrl="/song.mp3" onEditShot={onEditShot} /></MemoryRouter>);
    const video = screen.getByLabelText('Draft excerpt preview');
    video.pause = vi.fn();
    fireEvent.click(screen.getByRole('button', { name: 'Edit shot' }));
    expect(video.pause).toHaveBeenCalled();
    expect(onEditShot).toHaveBeenCalledWith('a');
  });
});

describe('PreviewDock final render song clock', () => {
  const project = {
    id: 'p', renderHistoryId: 'final', renderDependencyState: { status: 'stale' },
    scenes: [{ sceneId: 'lead', preMusic: { durationSec: 5 } }, { startSec: 0 }, { startSec: 4 }, { startSec: 7 }, { startSec: 9 }],
  };
  const finalVideo = { src: '/data/videos/final.mp4', fps: 30, songDurationSec: 8 };
  const mount = (songStartSec) => {
    const clockRef = { current: null };
    render(<MemoryRouter><PreviewDock project={project}
      sources={listPreviewSources(project, { finalVideo: { ...finalVideo, songStartSec } })} clockRef={clockRef} /></MemoryRouter>);
    const video = screen.getByLabelText('Final render preview');
    Object.defineProperties(video, {
      readyState: { value: 4, configurable: true },
      duration: { value: 12, configurable: true },
    });
    fireEvent.loadedMetadata(video);
    return { video, clockRef };
  };

  it.each([0, 61 / 30])('maps final shot and frame seeks with an encoded lead of %s seconds', (lead) => {
    const { video, clockRef } = mount(lead);
    // Start inside the song, so both cases have the same next shot.
    video.currentTime = lead + 1;
    fireEvent.timeUpdate(video);
    fireEvent.click(screen.getByRole('button', { name: 'Next shot' }));
    expect(video.currentTime).toBeCloseTo(lead + 4, 5);
    expect(clockRef.current()).toMatchObject({ t: expect.closeTo(4, 5), start: 0, end: 8, unknownSongOffset: false });
    expect(screen.getByText('Shot 2 / 3')).toBeInTheDocument();
    expect(screen.getByLabelText('Frame')).toHaveValue(120);
    fireEvent.click(screen.getByRole('button', { name: 'Forward 1 frame' }));
    expect(video.currentTime).toBeCloseTo(lead + 121.5 / 30, 5);
    expect(screen.getByLabelText('Frame')).toHaveValue(121);
  });

  it('retains native playback for a legacy file with no song clock', () => {
    const { video, clockRef } = mount(undefined);
    expect(video.controls).toBe(true);
    video.currentTime = 5;
    expect(clockRef.current()).toMatchObject({ t: null, unknownSongOffset: true });
    expect(screen.getByText(/Song timing is unavailable/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next shot' })).toBeNull();
  });
});

describe('PreviewDock controls beside the picture', () => {
  it('marks the picture, its play bar and the other controls only when asked, so other pages keep the stacked player', () => {
    const project = { id: 'p', scenes: [{ startSec: 18 }, { startSec: 22 }] };
    const sources = [{ id: 'draft-1', kind: 'video', label: 'Draft', src: '/data/videos/draft.mp4', startSec: 20, endSec: 30 }];
    const { unmount } = render(<MemoryRouter><PreviewDock project={project} sources={sources} audioUrl="/song.mp3" controlsBeside /></MemoryRouter>);
    const dock = screen.getByRole('complementary', { name: 'Preview' });
    expect(dock.classList.contains('mv-preview-beside')).toBe(true);
    // The layout in PreviewDock.css places the picture's siblings: the steppers go in the side column.
    const picture = dock.querySelector('[data-preview-picture]');
    const controls = picture.parentElement.querySelector(':scope > [data-preview-controls]');
    expect(controls.contains(screen.getByRole('button', { name: 'Next shot' }))).toBe(true);
    unmount();
    render(<MemoryRouter><PreviewDock project={project} sources={sources} audioUrl="/song.mp3" /></MemoryRouter>);
    expect(screen.getByRole('complementary', { name: 'Preview' }).classList.contains('mv-preview-beside')).toBe(false);
  });
});

describe('PreviewDock live composite', () => {
  it('plays a composed video from the selected takes when no shot segment is rendered', () => {
    const project = {
      id: 'p', trackId: 't1', composition: { mode: 'composed' },
      scenes: [{ sceneId: 's1', startSec: 0, endSec: 4, referenceImageId: 'frame.png', videoHistoryId: null }],
    };
    render(<MemoryRouter><PreviewDock project={project} sources={listPreviewSources(project, { leadWith: 'storyboard' })} audioUrl="/song.mp3" /></MemoryRouter>);
    expect(screen.getByLabelText('Preview source')).toHaveValue('composite');
    expect(screen.getByLabelText('Composition preview')).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Storyboard animatic' })).toBeEnabled();
  });

  it('keeps a style with no live composite in the picker and says why', () => {
    const project = { id: 'p', trackId: 't1', composition: { mode: 'concat' }, scenes: [{ sceneId: 's1', startSec: 0, endSec: 4 }] };
    render(<MemoryRouter><PreviewDock project={project} sources={listPreviewSources(project)} audioUrl="/song.mp3" /></MemoryRouter>);
    const unavailable = screen.getByRole('option', { name: /Composition \(live\)/ });
    expect(unavailable).toBeDisabled();
    expect(unavailable).toHaveTextContent('Footage cuts the clips as they are and has no live composite.');
    expect(screen.getByLabelText('Preview source')).toHaveValue('animatic');
    expect(screen.getByLabelText('Storyboard animatic')).toBeTruthy();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import StoryboardAnimatic, { clipTimeAt, shotAt } from './StoryboardAnimatic.jsx';

const scenes = [
  { sceneId: 'b', label: 'Chorus', startSec: 10, endSec: 20, referenceImageId: 'frame-b.png' },
  { sceneId: 'a', label: 'Opening', startSec: 0, endSec: 10, visualIntent: 'Lights come up' },
];

describe('StoryboardAnimatic', () => {
  it('picks the last shot that has started at a song time', () => {
    expect(shotAt(scenes, 0).sceneId).toBe('a');
    expect(shotAt(scenes, 9.9).sceneId).toBe('a');
    expect(shotAt(scenes, 10).sceneId).toBe('b');
    expect(shotAt(scenes, 300).sceneId).toBe('b');
    expect(shotAt([], 3)).toBeNull();
  });

  it('shows the shot card, then its frame, as the song plays', () => {
    const { container } = render(<StoryboardAnimatic project={{ id: 'p', scenes }} audioUrl="/song.mp3" />);
    expect(screen.getByText('Opening')).toBeTruthy();
    expect(screen.getByText('Lights come up')).toBeTruthy();
    expect(screen.getByText('Shot 1 of 2 · 0:00')).toBeTruthy();
    const audio = screen.getByLabelText('Song for the storyboard animatic');
    Object.defineProperty(audio, 'currentTime', { value: 12, configurable: true });
    fireEvent.timeUpdate(audio);
    expect(container.querySelector('img').getAttribute('src')).toBe('/data/images/frame-b.png');
    expect(screen.getByText('Shot 2 of 2 · 0:10')).toBeTruthy();
  });
});

vi.mock('../../services/apiMusicVideo.js', () => ({
  getMusicVideoLyricOverlayPreview: vi.fn(async () => ({ html: '<!doctype html><p>words</p>', assets: [], width: 1920, height: 1080, fps: 24, durationSec: 20 })),
}));

describe('StoryboardAnimatic lyrics', () => {
  const lyricProject = {
    id: 'p', scenes, audioAnalysis: { durationSec: 20 },
    lyricCues: [{ id: 'c1', text: 'hello there', startSec: 1, endSec: 3 }],
  };

  it('lays the lyrics over the picture by default and hides them on the toggle', async () => {
    render(<StoryboardAnimatic project={lyricProject} audioUrl="/song.mp3" />);
    const overlay = await screen.findByTestId('animatic-lyrics');
    expect(overlay.getAttribute('sandbox')).toBe('allow-scripts');
    // The frameless shot's stand-in text moves out from under the words.
    expect(screen.getByText('Opening').closest('figure')).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Lyrics' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.queryByTestId('animatic-lyrics')).toBeNull());
    expect(screen.getByText('Opening').closest('figure')).toBeTruthy();
  });

  // Uniquely catches the animatic's lyric layer dropping the opening title card or its live edits.
  it('hands the opening title card to the lyric layer and again when it is edited', async () => {
    const card = { enabled: true, title: 'Example Song', startSec: 2, endSec: 8 };
    const { rerender } = render(<StoryboardAnimatic project={{ ...lyricProject, titleCard: card }} audioUrl="/song.mp3" />);
    const overlay = await screen.findByTestId('animatic-lyrics');
    const post = vi.spyOn(overlay.contentWindow, 'postMessage');
    await act(async () => { window.dispatchEvent(new MessageEvent('message', { source: overlay.contentWindow, data: { type: 'portos-mv:loaded' } })); });
    expect(post).toHaveBeenCalledWith({ type: 'portos-mv:title-card', card: expect.objectContaining({ title: 'Example Song', position: 'lower-left' }) }, '*');
    rerender(<StoryboardAnimatic project={{ ...lyricProject, titleCard: { ...card, position: 'upper-right' } }} audioUrl="/song.mp3" />);
    await waitFor(() => expect(post).toHaveBeenCalledWith({ type: 'portos-mv:title-card', card: expect.objectContaining({ position: 'upper-right' }) }, '*'));
  });

  it('offers no lyrics until the words are timed', () => {
    render(<StoryboardAnimatic project={{ ...lyricProject, lyricCues: [{ id: 'c1', text: 'hello', startSec: null }] }} audioUrl="/song.mp3" />);
    expect(screen.queryByRole('button', { name: 'Lyrics' })).toBeNull();
  });
});

vi.mock('../../services/apiImageVideo.js', () => ({
  getVideoHistoryItem: vi.fn(async (id) => ({ id, filename: `${id}.mov` })),
}));

describe('StoryboardAnimatic clips', () => {
  const clipScenes = [
    { sceneId: 'a', label: 'Opening', startSec: 0, endSec: 10, referenceImageId: 'frame-a.png', videoHistoryId: 'clip-a' },
    { sceneId: 'b', label: 'Chorus', startSec: 10, endSec: 20, referenceImageId: 'frame-b.png' },
  ];

  it('plays a shot\'s clip muted where it has one and its still where it does not', async () => {
    const { container } = render(<StoryboardAnimatic project={{ id: 'p', scenes: clipScenes }} audioUrl="/song.mp3" />);
    const clip = await screen.findByLabelText('Clip for Opening');
    await waitFor(() => expect(clip.getAttribute('src')).toBe('/data/videos/clip-a.mov'));
    expect(clip.muted).toBe(true);
    expect(clip.getAttribute('poster')).toBe('/data/images/frame-a.png');
    const audio = screen.getByLabelText('Song for the storyboard animatic');
    Object.defineProperty(audio, 'currentTime', { value: 12, configurable: true });
    fireEvent.timeUpdate(audio);
    expect(screen.queryByLabelText('Clip for Opening')).toBeNull();
    expect(container.querySelector('img').getAttribute('src')).toBe('/data/images/frame-b.png');
  });

  it('maps song time into the clip: trimmed in-point, then loop or hold past its end', () => {
    const performance = {
      sceneId: 'p', startSec: 10, endSec: 20, shotMode: 'performance', videoHistoryId: 'v1',
      takes: [{ kind: 'video', assetId: 'v1', shotInstruction: { shotMode: 'performance', edit: { inSec: 2, outSec: 9 } } }],
    };
    expect(clipTimeAt(performance, 13, 9)).toBe(5);
    expect(clipTimeAt({ startSec: 10 }, 16, 4)).toBe(2);
    expect(clipTimeAt({ startSec: 10, loop: false }, 16, 4)).toBeCloseTo(3.95);
  });
});

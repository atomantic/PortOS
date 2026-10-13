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
    expect(screen.getByText('Shot 1 / 2')).toBeTruthy();
    const audio = screen.getByLabelText('Song for the storyboard animatic');
    Object.defineProperty(audio, 'currentTime', { value: 12, configurable: true });
    fireEvent.timeUpdate(audio);
    expect(container.querySelector('img').getAttribute('src')).toBe('/data/images/frame-b.png');
    expect(screen.getByText('Shot 2 / 2')).toBeTruthy();
  });

  // Uniquely catches the animatic showing a clip where the composed render plays a still's image effect.
  it('plays a still shot\'s camera flash develop over its still, not its clip, from the shot\'s start', () => {
    const effectShot = { sceneId: 'fx', label: 'Burger', startSec: 0, endSec: 6, referenceImageId: 'burger.png', videoHistoryId: 'clip-1',
      visualLayer: 'still', imageEffect: 'flash-develop', imageEffectSec: 2 };
    render(<StoryboardAnimatic project={{ id: 'p', composition: { mode: 'composed' }, scenes: [effectShot] }} audioUrl="/song.mp3" />);
    const effect = screen.getByTestId('animatic-image-effect');
    expect(screen.queryByLabelText('Clip for Burger')).toBeNull();
    const img = effect.querySelector('img');
    expect(img.style.filter).toBe('contrast(0.55) saturate(0)');
    const audio = screen.getByLabelText('Song for the storyboard animatic');
    Object.defineProperty(audio, 'currentTime', { value: 3, configurable: true });
    fireEvent.timeUpdate(audio);
    expect(img.style.filter).toBe('contrast(1) saturate(1)');
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
    // Flush the preview promise AND its message-listener effect before the one-shot
    // handshake. Finding the iframe only observes the DOM commit, not effect readiness.
    await act(async () => {});
    const overlay = screen.getByTestId('animatic-lyrics');
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

const uploadGalleryImage = vi.hoisted(() => vi.fn(async () => ({ filename: 'upload-1234abcd.png' })));
vi.mock('../../services/apiSystem.js', () => ({ uploadGalleryImage }));
// Save frame hands over the element it would draw, so the test sees which picture it picked.
vi.mock('./FrameStepper.jsx', async (importOriginal) => ({ ...(await importOriginal()), captureMediaFrame: async (el) => el }));

vi.mock('../../services/apiImageVideo.js', () => ({
  getVideoHistoryItem: vi.fn(async (id) => ({ id, filename: `${id}.mov` })),
}));

describe('StoryboardAnimatic clips', () => {
  const clipScenes = [
    { sceneId: 'a', label: 'Opening', startSec: 0, endSec: 10, referenceImageId: 'frame-a.png', videoHistoryId: 'clip-a' },
    { sceneId: 'b', label: 'Chorus', startSec: 10, endSec: 20, referenceImageId: 'frame-b.png' },
  ];

  it('plays a shot\'s clip muted over its still, and only the still where it has no clip', async () => {
    const { container } = render(<StoryboardAnimatic project={{ id: 'p', scenes: clipScenes }} audioUrl="/song.mp3" />);
    const clip = await screen.findByLabelText('Clip for Opening');
    await waitFor(() => expect(clip.getAttribute('src')).toBe('/data/videos/clip-a.mov'));
    expect(clip.muted).toBe(true);
    // The still stays underneath, and the clip stays transparent until it has a frame.
    expect(container.querySelector('img').getAttribute('src')).toBe('/data/images/frame-a.png');
    expect(clip.className).toContain('opacity-0');
    Object.defineProperty(clip, 'readyState', { value: 4, configurable: true });
    fireEvent.loadedData(clip);
    expect(clip.className).toContain('opacity-100');
    const audio = screen.getByLabelText('Song for the storyboard animatic');
    Object.defineProperty(audio, 'currentTime', { value: 12, configurable: true });
    fireEvent.timeUpdate(audio);
    expect(screen.queryByLabelText('Clip for Opening')).toBeNull();
    expect(container.querySelector('img').getAttribute('src')).toBe('/data/images/frame-b.png');
  });

  it('loads the next shots\' clips ahead and cuts to the same loaded clip', async () => {
    const scenes = [
      { sceneId: 'a', label: 'One', startSec: 0, endSec: 1, referenceImageId: 'frame-a.png' },
      { sceneId: 'b', label: 'Two', startSec: 1, endSec: 2, videoHistoryId: 'clip-b' },
      { sceneId: 'c', label: 'Three', startSec: 2, endSec: 3, videoHistoryId: 'clip-c' },
      { sceneId: 'd', label: 'Four', startSec: 3, endSec: 4, videoHistoryId: 'clip-d' },
    ];
    render(<StoryboardAnimatic project={{ id: 'p', scenes }} audioUrl="/song.mp3" />);
    const next = await screen.findByLabelText('Clip for Two');
    expect(screen.getByLabelText('Clip for Three')).toBeTruthy();
    expect(screen.queryByLabelText('Clip for Four')).toBeNull();
    expect(next.getAttribute('aria-hidden')).toBe('true');
    Object.defineProperty(next, 'readyState', { value: 4, configurable: true });
    fireEvent.seeked(next);
    expect(next.className).toContain('opacity-0');
    const audio = screen.getByLabelText('Song for the storyboard animatic');
    Object.defineProperty(audio, 'currentTime', { value: 1.2, configurable: true });
    fireEvent.timeUpdate(audio);
    expect(screen.getByLabelText('Clip for Two')).toBe(next);
    expect(next.className).toContain('opacity-100');
    expect(await screen.findByLabelText('Clip for Four')).toBeTruthy();
  });

  it('steps the song to the next and previous shot starts', () => {
    const stills = clipScenes.map(({ videoHistoryId, ...scene }) => scene);
    render(<StoryboardAnimatic project={{ id: 'p', scenes: stills }} audioUrl="/song.mp3" />);
    const audio = screen.getByLabelText('Song for the storyboard animatic');
    expect(screen.getByText('Shot 1 / 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next shot' }));
    expect(audio.currentTime).toBe(10);
    expect(screen.getByText('Shot 2 / 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Previous shot' }));
    expect(audio.currentTime).toBe(0);
  });

  it('pauses the song and opens the shot playing from Edit shot', () => {
    const stills = clipScenes.map(({ videoHistoryId, ...scene }) => scene);
    const onEditShot = vi.fn();
    render(<StoryboardAnimatic project={{ id: 'p', scenes: stills }} audioUrl="/song.mp3" onEditShot={onEditShot} />);
    const audio = screen.getByLabelText('Song for the storyboard animatic');
    audio.pause = vi.fn();
    fireEvent.click(screen.getByRole('button', { name: 'Next shot' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit shot' }));
    expect(audio.pause).toHaveBeenCalled();
    expect(onEditShot).toHaveBeenCalledWith(stills[1].sceneId);
  });

  it('saves the shot\'s still, then its clip once that shows', async () => {
    render(<StoryboardAnimatic project={{ id: 'p', name: 'Example Song', scenes: clipScenes }} audioUrl="/song.mp3" />);
    const clip = await screen.findByLabelText('Clip for Opening');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save frame/ })); });
    expect(uploadGalleryImage.mock.lastCall[0].tagName).toBe('IMG');
    Object.defineProperty(clip, 'readyState', { value: 4, configurable: true });
    fireEvent.loadedData(clip);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save frame/ })); });
    expect(uploadGalleryImage.mock.lastCall[0]).toBe(clip);
  });

  it('moves a paused clip to the exact frame on each frame step', async () => {
    render(<StoryboardAnimatic project={{ id: 'p', scenes: clipScenes }} audioUrl="/song.mp3" />);
    const clip = await screen.findByLabelText('Clip for Opening');
    Object.defineProperty(clip, 'readyState', { value: 4, configurable: true });
    Object.defineProperty(clip, 'duration', { value: 10, configurable: true });
    fireEvent.click(screen.getByRole('button', { name: 'Forward 1 frame' }));
    expect(clip.currentTime).toBeCloseTo(1.5 / 24);
    fireEvent.click(screen.getByRole('button', { name: 'Forward 1 frame' }));
    expect(clip.currentTime).toBeCloseTo(2.5 / 24);
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

describe('StoryboardAnimatic film look', () => {
  // Uniquely catches the animatic showing footage without the look the final render will apply,
  // and an SVG filter over the PLAYING picture (re-run per video frame, it stalled a phone after #11215).
  it('shows the exact look when paused, a light compositor-only look while playing, and nothing without one', () => {
    const look = { preset: 'super8', defocus: 0.2, grain: 0.5, halation: 0.4, vignette: 0.3 };
    const { container, rerender } = render(<StoryboardAnimatic project={{ id: 'p', scenes, filmLook: look }} audioUrl="/song.mp3" />);
    const audio = screen.getByLabelText('Song for the storyboard animatic');
    // Paused: the render's filter over the whole box.
    const exact = container.querySelector('figure [data-film-look="exact"]');
    expect(exact).toBeTruthy();
    expect(exact.style.filter).toMatch(/^url\(#portos-film-look-/);
    expect(exact.querySelector('svg filter feTurbulence')).toBeTruthy();
    // Playing: no SVG filter anywhere in the picture; CSS functions on it and tiles over it.
    fireEvent.play(audio);
    const motion = container.querySelector('figure [data-film-look="motion"]');
    expect(motion).toBeTruthy();
    expect(motion.querySelector('svg')).toBeNull();
    const picture = motion.querySelector('[data-film-look-layer="picture"]');
    expect(picture.style.filter).toMatch(/^blur\(/);
    expect(picture.style.filter).not.toContain('url(');
    const grain = motion.querySelector('[data-film-look-layer="grain"]');
    expect(grain.style.mixBlendMode).toBe('overlay');
    expect(grain.style.opacity).toBe('0.5');
    expect(motion.querySelector('[data-film-look-layer="vignette"]')).toBeTruthy();
    const shiftBefore = grain.style.transform;
    Object.defineProperty(audio, 'currentTime', { value: 12, configurable: true });
    fireEvent.timeUpdate(audio);
    // The picture sits inside the filtered box, and the grain tile shifts on the new song frame.
    const after = container.querySelector('figure [data-film-look="motion"]');
    expect(after.querySelector('img').getAttribute('src')).toBe('/data/images/frame-b.png');
    expect(after.querySelector('[data-film-look-layer="grain"]').style.transform).not.toBe(shiftBefore);
    fireEvent.pause(audio);
    expect(container.querySelector('figure [data-film-look="exact"]')).toBeTruthy();
    // The viewer can watch without the look; the choice is remembered.
    const toggle = screen.getByRole('button', { name: 'Film look' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(toggle);
    expect(container.querySelector('[data-film-look]')).toBeNull();
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(globalThis.localStorage.getItem('portos-mv-animatic-look')).toBe('off');
    fireEvent.click(toggle);
    expect(container.querySelector('figure [data-film-look="exact"]')).toBeTruthy();
    rerender(<StoryboardAnimatic project={{ id: 'p', scenes, filmLook: null }} audioUrl="/song.mp3" />);
    expect(container.querySelector('[data-film-look]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Film look' })).toBeNull();
  });
});

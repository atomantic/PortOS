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

  // Pins the rendered frame endpoints and seeks, including an explicit Hold overriding a planned camera.
  it('pushes and pans cover-fitted stills on the song clock, while Hold stays still', () => {
    const still = { sceneId: 'still', startSec: 10, endSec: 12, referenceImageId: 'frame.png', visualLayer: 'still',
      videoHistoryId: 'unused-clip', camera: { move: 'handheld' } };
    const project = (stillMove) => ({ id: 'p', composition: { mode: 'composed' }, scenes: [{ ...still, stillMove }] });
    const { rerender } = render(<StoryboardAnimatic project={project('push')} audioUrl="/song.mp3" />);
    const audio = screen.getByLabelText('Song for the storyboard animatic');
    const at = (t) => { audio.currentTime = t; fireEvent.timeUpdate(audio); };
    const transform = () => screen.getByTestId('animatic-still').style.transform;
    at(10);
    expect(transform()).toBe('scale(1)');
    expect(screen.queryByLabelText('Clip for this shot')).toBeNull();
    expect(screen.getByTestId('animatic-still').querySelector('img').className).toContain('object-cover');
    at(11);
    expect(transform()).toBe('scale(1.06)');
    at(12 - 1 / 24);
    expect(transform()).toBe('scale(1.1175)');
    at(20);
    expect(transform()).toBe('scale(1.1175)');
    at(10);
    expect(transform()).toBe('scale(1)');
    rerender(<StoryboardAnimatic project={project('pan')} audioUrl="/song.mp3" />);
    expect(transform()).toBe('translateX(7.5%) scale(1.15)');
    at(12 - 1 / 24);
    expect(transform()).toBe('translateX(-7.5%) scale(1.15)');
    rerender(<StoryboardAnimatic project={project('hold')} audioUrl="/song.mp3" />);
    expect(transform()).toBe('none');
    at(10);
    expect(transform()).toBe('none');
  });

  // A retained clip on a still cannot set the render cadence; the first actual footage source does.
  it('uses the lead footage frame rate for a mixed 30 fps render\'s still endpoint', async () => {
    const { getVideoHistoryItem } = await import('../../services/apiImageVideo.js');
    getVideoHistoryItem.mockImplementation(async (id) => ({ id, filename: `${id}.mov`, fps: id === 'lead' ? 30 : 60 }));
    render(<StoryboardAnimatic project={{ id: 'p', composition: { mode: 'composed' }, scenes: [
      { sceneId: 's', order: 0, startSec: 0, endSec: 2, visualLayer: 'still', referenceImageId: 'frame.png', stillMove: 'push', videoHistoryId: 'unused' },
      { sceneId: 'f', order: 1, startSec: 2, endSec: 4, videoHistoryId: 'lead' },
    ] }} audioUrl="/song.mp3" />);
    await waitFor(() => expect(getVideoHistoryItem).toHaveBeenCalledWith('lead', { silent: true, geometry: true }));
    await act(async () => {});
    const audio = screen.getByLabelText('Song for the storyboard animatic');
    audio.currentTime = 2 - 1 / 30;
    fireEvent.timeUpdate(audio);
    expect(screen.getByTestId('animatic-still').style.transform).toBe(`scale(${1 + 0.12 * 59 / 60})`);
    getVideoHistoryItem.mockImplementation(async (id) => ({ id, filename: `${id}.mov` }));
  });

  // timeupdate is too slow for motion: playback must read currentTime on animation frames, then stop on pause.
  it('moves a playing still between timeupdates and freezes it at the paused song time', () => {
    const frames = new Map();
    let nextFrame = 0;
    vi.stubGlobal('requestAnimationFrame', (tick) => { frames.set(++nextFrame, tick); return nextFrame; });
    vi.stubGlobal('cancelAnimationFrame', (id) => frames.delete(id));
    try {
      render(<StoryboardAnimatic project={{ id: 'p', composition: { mode: 'composed' }, scenes: [
        { sceneId: 's', startSec: 0, endSec: 2, visualLayer: 'still', referenceImageId: 'frame.png', stillMove: 'push' },
      ] }} audioUrl="/song.mp3" />);
      const audio = screen.getByLabelText('Song for the storyboard animatic');
      const still = screen.getByTestId('animatic-still');
      fireEvent.play(audio);
      audio.currentTime = 1;
      act(() => {
        const pending = [...frames.values()];
        frames.clear();
        pending.forEach((tick) => tick());
      });
      expect(still.style.transform).toBe('scale(1.06)');
      audio.currentTime = 1.5;
      fireEvent.pause(audio);
      expect(still.style.transform).toBe('scale(1.09)');
      audio.currentTime = 1.9;
      act(() => {
        const pending = [...frames.values()];
        frames.clear();
        pending.forEach((tick) => tick());
      });
      expect(still.style.transform).toBe('scale(1.09)');
      fireEvent.play(audio);
      audio.currentTime = 2;
      fireEvent.ended(audio);
      expect(still.style.transform).toBe('scale(1.1175)');
      audio.currentTime = 0;
      act(() => {
        const pending = [...frames.values()];
        frames.clear();
        pending.forEach((tick) => tick());
      });
      expect(still.style.transform).toBe('scale(1.1175)');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // A dissolve renders its incoming still's full move over the preroll window, then restarts for the shot itself.
  it('moves the incoming still over the dissolve window, then starts its own shot move', () => {
    render(<StoryboardAnimatic project={{ id: 'p', composition: { mode: 'composed' }, scenes: [
      { sceneId: 'a', startSec: 0, endSec: 4, visualLayer: 'still', referenceImageId: 'a.png',
        cutEffect: { style: 'dissolve', enabled: true, overlapSec: 1 } },
      { sceneId: 'b', startSec: 4, endSec: 8, visualLayer: 'still', referenceImageId: 'b.png', stillMove: 'pan', videoHistoryId: 'unused' },
    ] }} audioUrl="/song.mp3" />);
    const audio = screen.getByLabelText('Song for the storyboard animatic');
    const at = (t) => { audio.currentTime = t; fireEvent.timeUpdate(audio); };
    at(3);
    const incoming = screen.getByTestId('beat-toggle-clip');
    expect(incoming.querySelector('video')).toBeNull();
    expect(incoming.querySelector('[data-testid="animatic-still"]').style.transform).toBe('translateX(7.5%) scale(1.15)');
    at(4 - 1 / 24);
    expect(incoming.querySelector('[data-testid="animatic-still"]').style.transform).toBe('translateX(-7.5%) scale(1.15)');
    at(4);
    expect(screen.queryByTestId('beat-toggle-clip')).toBeNull();
    expect(screen.getByTestId('animatic-still').style.transform).toBe('translateX(7.5%) scale(1.15)');
  });

  // Uniquely catches the animatic showing a clip where the composed render plays a still's image effect.
  it('plays a still shot\'s camera flash develop over its still, not its clip, from the shot\'s start', () => {
    const effectShot = { sceneId: 'fx', label: 'Burger', startSec: 0, endSec: 6, referenceImageId: 'burger.png', videoHistoryId: 'clip-1',
      visualLayer: 'still', stillMove: 'push', imageEffect: 'flash-develop', imageEffectSec: 2 };
    render(<StoryboardAnimatic project={{ id: 'p', composition: { mode: 'composed' }, scenes: [effectShot] }} audioUrl="/song.mp3" />);
    const effect = screen.getByTestId('animatic-image-effect');
    expect(screen.queryByLabelText('Clip for Burger')).toBeNull();
    const img = effect.querySelector('img');
    expect(img.style.filter).toBe('contrast(0.55) saturate(0)');
    const audio = screen.getByLabelText('Song for the storyboard animatic');
    Object.defineProperty(audio, 'currentTime', { value: 3, configurable: true });
    fireEvent.timeUpdate(audio);
    expect(img.style.filter).toBe('contrast(1) saturate(1)');
    expect(screen.getByTestId('animatic-still').style.transform).toBe('scale(1.06)');
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
    expect(clip.parentElement.className).toContain('opacity-0');
    Object.defineProperty(clip, 'readyState', { value: 4, configurable: true });
    fireEvent.loadedData(clip);
    expect(clip.parentElement.className).toContain('opacity-100');
    const audio = screen.getByLabelText('Song for the storyboard animatic');
    Object.defineProperty(audio, 'currentTime', { value: 12, configurable: true });
    fireEvent.timeUpdate(audio);
    expect(screen.queryByLabelText('Clip for Opening')).toBeNull();
    // The cut lets go of the clip's download, so a phone does not run out of decoders.
    expect(clip.getAttribute('src')).toBeNull();
    expect(container.querySelector('img').getAttribute('src')).toBe('/data/images/frame-b.png');
  });

  // Uniquely catches the animatic's beat toggle showing the incoming shot on the wrong frames,
  // or its clip leaving the song's clock (ignoring the shot's offset or speed) before or after the cut.
  it('flips to the next shot on the beats before a beat toggle cut, its clip on the song\'s clock', async () => {
    const scenes = [
      { sceneId: 'a', label: 'One', startSec: 0, endSec: 4, videoHistoryId: 'clip-a', cutEffect: { style: 'beat-toggle', enabled: true, overlapSec: 1, rate: 'beat' } },
      // 1.5 s in, half again as fast.
      { sceneId: 'b', label: 'Two', startSec: 4, endSec: 8, videoHistoryId: 'clip-b', offsetFrames: 36, speedFps: 12 },
    ];
    const project = { id: 'p', scenes, audioAnalysis: { beats: [3, 3.5, 4, 4.5] } };
    render(<StoryboardAnimatic project={project} audioUrl="/song.mp3" />);
    const audio = screen.getByLabelText('Song for the storyboard animatic');
    const at = (t) => { Object.defineProperty(audio, 'currentTime', { value: t, configurable: true }); fireEvent.timeUpdate(audio); };
    at(2.9);
    const toggle = await screen.findByTestId('beat-toggle-clip');
    await waitFor(() => expect(toggle.getAttribute('src')).toBe('/data/videos/clip-b.mov'));
    Object.defineProperty(toggle, 'readyState', { value: 4, configurable: true });
    expect(toggle.parentElement.style.opacity).toBe('0');
    at(3.2);
    expect(toggle.parentElement.style.opacity).toBe('1');
    // 0.8 s before the shot starts: 1.2 s of clip before its 1.5 s in-point.
    expect(toggle.currentTime).toBeCloseTo(0.3, 2);
    at(3.7);
    expect(toggle.parentElement.style.opacity).toBe('0');
    // Past the cut the incoming shot's own clip starts where it would without the toggle.
    const clipB = screen.getByLabelText('Clip for Two');
    Object.defineProperty(clipB, 'readyState', { value: 4, configurable: true });
    Object.defineProperty(audio, 'paused', { value: true, configurable: true });
    at(4.25);
    expect(clipB.currentTime).toBeCloseTo(1.875, 2);
  });

  // Uniquely catches the animatic's dissolve or fade through black (including one the
  // storyboard plans) showing on frames the final render does not, or not ramping.
  it('fades the next shot in over a dissolve and darkens through black around a fade', async () => {
    const scenes = [
      { sceneId: 'a', label: 'One', startSec: 0, endSec: 4, videoHistoryId: 'clip-a' },
      { sceneId: 'b', label: 'Two', startSec: 4, endSec: 8, videoHistoryId: 'clip-b', cutEffect: { style: 'fade-black', enabled: true, overlapSec: 1 } },
      { sceneId: 'c', label: 'Three', startSec: 8, endSec: 12, videoHistoryId: 'clip-c' },
    ];
    const project = { id: 'p', scenes, productionReview: { draft: { storyboard: [{ sceneId: 'a', transition: 'Dissolve' }] } } };
    render(<StoryboardAnimatic project={project} audioUrl="/song.mp3" />);
    const audio = screen.getByLabelText('Song for the storyboard animatic');
    const at = (t) => { Object.defineProperty(audio, 'currentTime', { value: t, configurable: true }); fireEvent.timeUpdate(audio); };
    at(2.9);
    const incoming = await screen.findByTestId('beat-toggle-clip');
    expect(incoming.parentElement.style.opacity).toBe('0');
    at(3.5);
    const half = Number(incoming.parentElement.style.opacity);
    expect(half).toBeGreaterThan(0.4);
    expect(half).toBeLessThan(0.6);
    at(3.95);
    expect(Number(incoming.parentElement.style.opacity)).toBeGreaterThan(half);
    at(7.4);
    const black = await screen.findByTestId('fade-black');
    expect(black.style.opacity).toBe('0');
    at(7.75);
    expect(Number(black.style.opacity)).toBeCloseTo(0.5, 2);
    at(8.25);
    expect(Number(black.style.opacity)).toBeCloseTo(0.5, 2);
    at(8.6);
    expect(black.style.opacity).toBe('0');
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
    // The next clip loads in full; the one after it only its metadata until it is next.
    expect(next.getAttribute('preload')).toBe('auto');
    expect(screen.getByLabelText('Clip for Three').getAttribute('preload')).toBe('metadata');
    Object.defineProperty(next, 'readyState', { value: 4, configurable: true });
    fireEvent.seeked(next);
    expect(next.parentElement.className).toContain('opacity-0');
    const audio = screen.getByLabelText('Song for the storyboard animatic');
    Object.defineProperty(audio, 'currentTime', { value: 1.2, configurable: true });
    fireEvent.timeUpdate(audio);
    expect(screen.getByLabelText('Clip for Two')).toBe(next);
    expect(next.parentElement.className).toContain('opacity-100');
    expect(await screen.findByLabelText('Clip for Four')).toBeTruthy();
  });

  // Uniquely catches a slow link stuck re-seeking: each seek restarts the download, so a clip chased every time update never plays.
  it('lets a playing clip fetch after a seek before moving it again', async () => {
    // Just after page load: the clip's first seek must not wait on a seek that never happened.
    const now = vi.spyOn(performance, 'now').mockReturnValue(100);
    render(<StoryboardAnimatic project={{ id: 'p', scenes: clipScenes }} audioUrl="/song.mp3" />);
    const clip = await screen.findByLabelText('Clip for Opening');
    await waitFor(() => expect(clip.getAttribute('src')).toBe('/data/videos/clip-a.mov'));
    clip.play = vi.fn(() => Promise.resolve());
    clip.pause = vi.fn();
    const audio = screen.getByLabelText('Song for the storyboard animatic');
    Object.defineProperty(audio, 'paused', { value: false, configurable: true });
    Object.defineProperty(clip, 'readyState', { value: 1, configurable: true });
    const at = (t) => { Object.defineProperty(audio, 'currentTime', { value: t, configurable: true }); fireEvent.timeUpdate(audio); };
    at(3);
    expect(clip.currentTime).toBeCloseTo(3, 6);
    clip.currentTime = 3.1;
    at(4);
    expect(clip.currentTime).toBeCloseTo(3.1, 6);
    // Once its seek lands with data to play, it is checked again and put back in step.
    Object.defineProperty(clip, 'readyState', { value: 4, configurable: true });
    fireEvent.seeked(clip);
    expect(clip.currentTime).toBeCloseTo(4, 6);
    now.mockRestore();
  });

  it('steps a paused clip to each frame while it is still fetching', async () => {
    render(<StoryboardAnimatic project={{ id: 'p', scenes: clipScenes }} audioUrl="/song.mp3" />);
    const clip = await screen.findByLabelText('Clip for Opening');
    await waitFor(() => expect(clip.getAttribute('src')).toBe('/data/videos/clip-a.mov'));
    clip.pause = vi.fn();
    const audio = screen.getByLabelText('Song for the storyboard animatic');
    Object.defineProperty(audio, 'paused', { value: true, configurable: true });
    Object.defineProperty(clip, 'readyState', { value: 2, configurable: true });
    const at = (t) => { Object.defineProperty(audio, 'currentTime', { value: t, configurable: true }); fireEvent.timeUpdate(audio); };
    at(3);
    expect(clip.currentTime).toBeCloseTo(3, 6);
    at(3.5);
    expect(clip.currentTime).toBeCloseTo(3.5, 6);
  });

  it('tries a clip that fails to load again', async () => {
    render(<StoryboardAnimatic project={{ id: 'p', scenes: clipScenes }} audioUrl="/song.mp3" />);
    const clip = await screen.findByLabelText('Clip for Opening');
    await waitFor(() => expect(clip.getAttribute('src')).toBe('/data/videos/clip-a.mov'));
    fireEvent.error(clip);
    await waitFor(() => expect(screen.getByLabelText('Clip for Opening')).not.toBe(clip), { timeout: 3000 });
    await waitFor(() => expect(screen.getByLabelText('Clip for Opening').getAttribute('src')).toBe('/data/videos/clip-a.mov'));
    expect(clip.getAttribute('src')).toBeNull();
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

  // Uniquely catches the preview playing a shot's hand-set speed or offset differently from the render.
  it('plays a hand-set speed and frame offset from the same clip, as the render does', () => {
    // 48 fps on the 24 fps grid: twice as fast, starting 12 frames (0.5s) in.
    const fast = { startSec: 10, speedFps: 24, offsetFrames: 12 };
    expect(clipTimeAt(fast, 11, 6)).toBeCloseTo(2.5);
    expect(clipTimeAt(fast, 13, 6)).toBeCloseTo(0.5);
    expect(clipTimeAt({ ...fast, loop: false }, 13, 6)).toBeCloseTo(5.95);
    // Six frames early: the first frame holds a quarter second, then the clip runs.
    const early = { startSec: 10, offsetFrames: -6 };
    expect(clipTimeAt(early, 10.2, 6)).toBe(0);
    expect(clipTimeAt(early, 11.25, 6)).toBeCloseTo(1);
  });

  // Uniquely catches a beat toggle's incoming clip freezing on its first frame when it has
  // less footage before its in-point than the toggle's window, where the render plays it on.
  it('plays a toggle\'s incoming clip on from its first frame when it has too little footage before its in-point', () => {
    const toggle = { early: true, fromSec: 9 };
    expect(clipTimeAt({ startSec: 10 }, 9, 6, toggle)).toBe(0);
    expect(clipTimeAt({ startSec: 10 }, 9.5, 6, toggle)).toBeCloseTo(0.5);
    // A quarter second in: still from the first frame, not held for the first three quarters.
    expect(clipTimeAt({ startSec: 10, offsetFrames: 6 }, 9.5, 6, toggle)).toBeCloseTo(0.5);
    // With footage enough before its in-point it reads that footage.
    expect(clipTimeAt({ startSec: 10, offsetFrames: 48 }, 9.5, 6, toggle)).toBeCloseTo(1.5);
  });

  // Uniquely catches a reversed shot previewing forwards, or looping where the render holds.
  it('plays a reversed clip from its end, with its speed and offset, and holds once it runs out', () => {
    const back = { startSec: 10, reverse: true };
    expect(clipTimeAt(back, 10, 6)).toBeCloseTo(5.95);
    expect(clipTimeAt(back, 12, 6)).toBeCloseTo(4);
    expect(clipTimeAt(back, 20, 6)).toBe(0);
    expect(clipTimeAt({ ...back, speedFps: 24, offsetFrames: 12 }, 11, 6)).toBeCloseTo(3.5);
    // A lip-sync performance never reverses.
    expect(clipTimeAt({ ...back, shotMode: 'performance' }, 12, 6)).toBe(2);
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

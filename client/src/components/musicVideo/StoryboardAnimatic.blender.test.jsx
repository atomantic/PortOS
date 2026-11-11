import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../services/apiMusicVideo.js', async (importOriginal) => ({
  ...await importOriginal(),
  getMusicVideoLyricOverlayPreview: vi.fn(async () => ({ html: '<!doctype html><p>card</p>', assets: [], width: 1920, height: 1080, fps: 24, durationSec: 12 })),
}));
vi.mock('../../services/apiImageVideo.js', () => ({ getVideoHistoryItem: vi.fn(async (id) => ({ id, filename: `${id}.mov` })) }));

import StoryboardAnimatic from './StoryboardAnimatic.jsx';
import { PREVIEW_FILM_LOOK_KEY } from './PreviewFilmLook.jsx';
import { getMusicVideoLyricOverlayPreview } from '../../services/apiMusicVideo.js';
import { getVideoHistoryItem } from '../../services/apiImageVideo.js';
import { MUSIC_VIDEO_TRANSITION_STYLES } from '../../lib/musicVideoTransitions.js';
import { blenderFilmProject, blenderFilmState } from '../../test/blenderFilmFixture.js';

const mediaUrl = (file) => `/api/music-video/mv-test/blender/media?path=${encodeURIComponent(file)}`;
// The Board scenes the film's shots mirror onto. Their ids differ from the film state's own
// `sceneId`s, so only the project's scene map can pair a scene with its shot here.
const scenes = [
  { sceneId: 'board-1', order: 0, label: 'Cold open', startSec: 0, endSec: 4.5, visualLayer: 'code' },
  { sceneId: 'board-2', order: 1, label: 'First verse', startSec: 4.5, endSec: 9, visualLayer: 'code' },
  { sceneId: 'board-3', order: 2, label: 'Chorus', startSec: 9, endSec: 12, visualLayer: 'code' },
];
const film = (overrides = {}) => blenderFilmProject({
  scenes, blender: { sceneMap: { s010: 'board-1', s020: 'board-2', s030: 'board-3' } }, ...overrides,
});
const player = (project, state) => <StoryboardAnimatic project={project} audioUrl="/song.mp3" variant="composite" blender={state} />;
const song = () => screen.getByLabelText('Song for the film preview');
// Writable, so the player's own seeks (shot and frame steps) still move the song afterwards.
const at = (t) => {
  const audio = song();
  Object.defineProperty(audio, 'currentTime', { value: t, configurable: true, writable: true });
  fireEvent.timeUpdate(audio);
};
const decoded = (clip) => {
  Object.defineProperty(clip, 'readyState', { value: 4, configurable: true });
  fireEvent.loadedData(clip);
};

beforeEach(() => {
  getMusicVideoLyricOverlayPreview.mockClear();
  getVideoHistoryItem.mockClear();
});

describe('StoryboardAnimatic Blender film', () => {
  // Uniquely catches the live film playing takes or a lesser render: a preview where a current final
  // exists, nothing where only an out-of-date render exists, or a still or card for an unrendered shot.
  it('plays each shot\'s Blender render: the final over the preview, a stale one still, and black for a shot with none', async () => {
    render(player(film(), blenderFilmState()));
    await act(async () => {});
    expect(screen.getByLabelText('Film preview')).toBeTruthy();
    const opening = screen.getByLabelText('Clip for Cold open');
    expect(opening.getAttribute('src')).toBe(mediaUrl('s010/final/shot.mp4'));
    expect(opening.muted).toBe(true);
    expect(screen.getByText('Final render')).toBeTruthy();
    // The next shot's render is already loading for the cut; the shot with none has no clip at all.
    const verse = screen.getByLabelText('Clip for First verse');
    expect(verse.getAttribute('src')).toBe(mediaUrl('s020/preview/shot.mp4'));
    expect(verse.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByLabelText('Clip for Chorus')).toBeNull();
    expect(screen.queryByTestId('film-not-rendered')).toBeNull();
    // No take or video history is read for a film.
    expect(getVideoHistoryItem).not.toHaveBeenCalled();

    at(5);
    expect(screen.getByLabelText('Clip for First verse')).toBe(verse);
    expect(verse.getAttribute('aria-hidden')).toBeNull();
    expect(screen.getByText('Preview render, out of date')).toBeTruthy();
    expect(screen.queryByTestId('film-not-rendered')).toBeNull();

    // The unrendered shot is black with its label for its own span, then the film goes on.
    at(8.99);
    expect(screen.queryByTestId('film-not-rendered')).toBeNull();
    at(9);
    expect(screen.getByTestId('film-not-rendered')).toHaveTextContent('Not rendered yet');
    expect(screen.getByLabelText('Film preview').querySelector('img')).toBeNull();
    at(11.9);
    expect(screen.getByTestId('film-not-rendered')).toBeTruthy();
    at(4.4);
    expect(screen.queryByTestId('film-not-rendered')).toBeNull();
    expect(screen.getByText('Shot 1 / 3')).toBeTruthy();
  });

  // Uniquely catches a film shot's render taking the footage clip controls (speed, offset, reverse,
  // loop) a Board scene may still carry, or losing its place on the song after a seek or a frame step.
  it('plays a render from its shot\'s start at normal speed and holds its last frame, through seeks and frame steps', async () => {
    const tampered = scenes.map((scene) => (scene.sceneId === 'board-2' ? { ...scene, reverse: true, speedFps: 12, offsetFrames: 24, loop: true } : scene));
    render(player(film({ scenes: tampered }), blenderFilmState()));
    await act(async () => {});
    Object.defineProperty(song(), 'paused', { value: true, configurable: true });
    const verse = screen.getByLabelText('Clip for First verse');
    Object.defineProperty(verse, 'duration', { value: 4.5, configurable: true });
    decoded(verse);
    at(5.5);
    expect(verse.currentTime).toBeCloseTo(1, 6);
    expect(verse.playbackRate).toBe(1);
    // One film frame on: song frame 133, shown at its middle.
    fireEvent.click(screen.getByRole('button', { name: 'Forward 1 frame' }));
    expect(song().currentTime).toBeCloseTo(133.5 / 24, 6);
    expect(verse.currentTime).toBeCloseTo(133.5 / 24 - 4.5, 6);
    fireEvent.click(screen.getByRole('button', { name: 'Previous shot' }));
    expect(song().currentTime).toBe(4.5);
    expect(verse.currentTime).toBeCloseTo(0, 6);
    // A render shorter than its shot holds its last frame, as a cut pads it; it never loops.
    Object.defineProperty(verse, 'duration', { value: 2, configurable: true });
    at(8);
    expect(verse.currentTime).toBeCloseTo(1.95, 6);
    fireEvent.click(screen.getByRole('button', { name: 'Next shot' }));
    expect(song().currentTime).toBe(9);
    expect(screen.getByText('Shot 3 / 3')).toBeTruthy();
  });

  // Uniquely catches a playing film holding a shot's last frame where no shot covers the song (a cut
  // is black there), or waiting for the song's coarse time update to go black.
  it('goes black on the frame a shot ends short of the next', async () => {
    const frames = new Map();
    let nextFrame = 0;
    vi.stubGlobal('requestAnimationFrame', (tick) => { frames.set(++nextFrame, tick); return nextFrame; });
    vi.stubGlobal('cancelAnimationFrame', (id) => frames.delete(id));
    try {
      const gapped = scenes.map((scene) => (scene.sceneId === 'board-1' ? { ...scene, endSec: 3 } : scene));
      render(player(film({ scenes: gapped }), blenderFilmState()));
      await act(async () => {});
      const audio = song();
      const opening = screen.getByLabelText('Clip for Cold open');
      decoded(opening);
      const playTo = (t) => {
        audio.currentTime = t;
        act(() => {
          const pending = [...frames.values()];
          frames.clear();
          pending.forEach((tick) => tick());
        });
      };
      fireEvent.play(audio);
      playTo(2.9);
      expect(opening.parentElement.className).toContain('opacity-100');
      playTo(3.1);
      expect(opening.parentElement.className).toContain('opacity-0');
      expect(screen.getByText('No shot here')).toBeTruthy();
      expect(screen.queryByTestId('film-not-rendered')).toBeNull();
      playTo(4.6);
      expect(screen.getByLabelText('Clip for First verse').getAttribute('aria-hidden')).toBeNull();
      expect(screen.queryByText('No shot here')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // Uniquely catches a re-read film state remounting the player (losing the song's place) or leaving
  // the placeholder up after the shot's render lands.
  it('swaps the placeholder for a render that lands, without remounting the player', async () => {
    const project = film();
    const before = blenderFilmState();
    const { rerender } = render(player(project, before));
    await act(async () => {});
    const audio = song();
    const figure = screen.getByLabelText('Film preview');
    at(9.5);
    expect(screen.getByTestId('film-not-rendered')).toBeTruthy();
    const landed = { ...before, renders: { ...before.renders, s030: { preview: { ...before.renders.s020.preview, file: 's030/preview/shot.mp4', stale: false, staleReasons: [] }, stills: [] } } };
    rerender(player(project, landed));
    expect(screen.queryByTestId('film-not-rendered')).toBeNull();
    expect(screen.getByLabelText('Clip for Chorus').getAttribute('src')).toBe(mediaUrl('s030/preview/shot.mp4'));
    expect(screen.getByText('Preview render')).toBeTruthy();
    expect(song()).toBe(audio);
    expect(audio.currentTime).toBe(9.5);
    expect(screen.getByLabelText('Film preview')).toBe(figure);
    // The same shot rendered again writes the same file: its clip is loaded anew.
    const first = screen.getByLabelText('Clip for Chorus');
    const again = { ...landed, renders: { ...landed.renders, s030: { preview: { ...landed.renders.s030.preview, finishedAt: '2026-10-02T09:00:00.000Z' }, stills: [] } } };
    rerender(player(project, again));
    expect(screen.getByLabelText('Clip for Chorus')).not.toBe(first);
    // A job's progress replaces the film state without touching its renders: the clip stays as it is.
    const loaded = screen.getByLabelText('Clip for Chorus');
    rerender(player(project, { ...again, jobs: [{ id: 'job-1', kind: 'render', shotId: 's010', quality: 'final', status: 'running', index: 3, total: 108 }] }));
    expect(screen.getByLabelText('Clip for Chorus')).toBe(loaded);
    expect(song()).toBe(audio);
  });

  // Uniquely catches the automatic lyric overlay drawn over a film that letters its own lyrics, or
  // the title card (which rides on that layer) lost with it.
  it('lays no lyrics over the film, and draws the title card in its window', async () => {
    const sung = { lyricCues: [{ id: 'c1', text: 'hello there', startSec: 1, endSec: 3 }] };
    const { rerender, unmount } = render(player(film(sung), blenderFilmState()));
    await act(async () => {});
    expect(getMusicVideoLyricOverlayPreview).not.toHaveBeenCalled();
    expect(screen.queryByTestId('animatic-lyrics')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Lyrics' })).toBeNull();

    const card = { enabled: true, title: 'Example Song', startSec: 2, endSec: 8 };
    rerender(player(film({ ...sung, titleCard: card }), blenderFilmState()));
    const layer = await screen.findByTestId('animatic-lyrics');
    await act(async () => {});
    expect(layer.getAttribute('title')).toBe('Title card over the film preview');
    const post = vi.spyOn(layer.contentWindow, 'postMessage');
    const reply = (data) => act(async () => { window.dispatchEvent(new MessageEvent('message', { source: layer.contentWindow, data })); });
    await reply({ type: 'portos-mv:loaded' });
    // The words are switched off before the layer is asked for its first frame.
    const sent = post.mock.calls.map(([message]) => message.type);
    expect(sent).toContain('portos-mv:seek');
    expect(sent.indexOf('portos-mv:lyrics-visible')).toBeLessThan(sent.indexOf('portos-mv:seek'));
    expect(post).toHaveBeenCalledWith({ type: 'portos-mv:lyrics-visible', visible: false }, '*');
    expect(post).not.toHaveBeenCalledWith({ type: 'portos-mv:lyrics-visible', visible: true }, '*');
    expect(post).toHaveBeenCalledWith({ type: 'portos-mv:title-card', card: expect.objectContaining({ title: 'Example Song', startSec: 2, endSec: 8 }) }, '*');
    expect(screen.queryByRole('button', { name: 'Lyrics' })).toBeNull();
    // The layer follows the song into the card's window, where it draws the card.
    await reply({ type: 'portos-mv:seeked', t: 0 });
    at(3);
    expect(post).toHaveBeenCalledWith({ type: 'portos-mv:seek', t: 3 }, '*');
    // An edit to the card reaches the layer at once.
    rerender(player(film({ ...sung, titleCard: { ...card, position: 'upper-right' } }), blenderFilmState()));
    await waitFor(() => expect(post).toHaveBeenCalledWith({ type: 'portos-mv:title-card', card: expect.objectContaining({ position: 'upper-right' }) }, '*'));
    await act(async () => {});
    unmount();

    // The same words on a take composite are drawn: the film is what switches them off.
    getMusicVideoLyricOverlayPreview.mockClear();
    render(player({ ...film(sung), id: 'mv-takes', composition: { mode: 'composed' } }, null));
    await act(async () => {});
    expect(getMusicVideoLyricOverlayPreview).toHaveBeenCalledWith('mv-takes', { silent: true });
  });
});

describe('StoryboardAnimatic Blender film effects', () => {
  let spies = [];
  // Any 2D call the glitch painter makes: the test DOM's canvas stub covers only some of them.
  const context = () => new Proxy({}, {
    get: (target, key) => (key in target ? target[key] : () => ({ addColorStop() {}, data: new Uint8ClampedArray(0) })),
    set: (target, key, value) => { target[key] = value; return true; },
  });
  beforeEach(() => {
    spies = [
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(context),
      vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 640, height: 360, left: 0, top: 0, right: 640, bottom: 360 }),
    ];
  });
  afterEach(() => spies.forEach((spy) => spy.mockRestore()));

  const painted = (frame, fps) => {
    at((frame + 0.5) / fps);
    return screen.getByTestId('animatic-glitch').style.visibility === 'visible';
  };
  // The frames painted near a cut, counted from the cut frame.
  const paintedAround = (cutFrame, fps) => Array.from({ length: 12 }, (_, i) => cutFrame - 5 + i)
    .filter((frame) => painted(frame, fps)).map((frame) => frame - cutFrame);

  // Uniquely catches a film's shot effects missing from its live preview, painted off the frames its
  // cut paints them on (the film's own frame rate), or a wipe or a fade drawn where a cut draws none.
  it('paints a shot\'s gate jump on the frames around its cut, on the film\'s frame grid, and no wipe or fade', async () => {
    const style = MUSIC_VIDEO_TRANSITION_STYLES['gate-jump'];
    const frames = style.frames.map((_, i) => i - style.lead);
    expect(frames).toContain(-1);
    expect(frames).toContain(1);
    const jumped = scenes.map((scene) => (scene.sceneId === 'board-2' ? { ...scene, transitionIn: 'gate-jump' }
      : scene.sceneId === 'board-3' ? { ...scene, wipeIn: { style: 'iris' } } : scene));
    // The film's own script names its transitions; the storyboard row carries the words.
    const effects = { scenes: jumped, productionReview: { draft: { storyboard: [{ sceneId: 'board-1', transition: 'Fade to black' }] } } };
    const { rerender, unmount } = render(player(film(effects), blenderFilmState()));
    await act(async () => {});
    Object.defineProperty(song(), 'paused', { value: true, configurable: true });
    decoded(screen.getByLabelText('Clip for Cold open'));
    decoded(screen.getByLabelText('Clip for First verse'));
    // The cut into the second shot is at 4.5 s: frame 108 at 24 fps.
    expect(paintedAround(108, 24)).toEqual(frames);
    expect(screen.queryByTestId('animatic-wipe')).toBeNull();
    expect(screen.queryByTestId('fade-black')).toBeNull();

    // Taking the effect off the shot clears it from the player at once.
    rerender(player(film({ scenes }), blenderFilmState()));
    expect(screen.queryByTestId('animatic-glitch')).toBeNull();

    // A 30 fps film paints the same effect on its own frames: the cut is frame 135.
    const fast = blenderFilmState();
    rerender(player(film(effects), { ...fast, settings: { ...fast.settings, fps: 30 } }));
    // The first shot's clip was let go once the song passed it; back in it, it loads again.
    at(4);
    decoded(screen.getByLabelText('Clip for Cold open'));
    expect(paintedAround(135, 30)).toEqual(frames);
    unmount();

    // The same wipe and fade on a take composite are drawn: the film is what leaves them out.
    render(player({ ...film(effects), composition: { mode: 'composed' } }, null));
    await act(async () => {});
    const audio = screen.getByLabelText('Song for the composition preview');
    Object.defineProperty(audio, 'currentTime', { value: 4.4, configurable: true });
    fireEvent.timeUpdate(audio);
    expect(screen.getByTestId('animatic-wipe')).toBeTruthy();
    expect(screen.getByTestId('fade-black')).toBeTruthy();
  });

  // Uniquely catches the film look's edits not reaching the live film, or a shot's own look (which a
  // film's finishing pass never applies) replacing the video's.
  it('shows the video\'s film look over the film as it is edited', async () => {
    globalThis.localStorage.setItem(PREVIEW_FILM_LOOK_KEY, 'on');
    const look = { preset: 'super8', defocus: 0.2, grain: 0.5, halation: 0.4, vignette: 0.3 };
    const shotLook = scenes.map((scene) => (scene.sceneId === 'board-1' ? { ...scene, filmLook: { ...look, grain: 1 } } : scene));
    const { container, rerender } = render(player(film({ scenes: shotLook }), blenderFilmState()));
    await act(async () => {});
    // The video has no look: a shot's own look is not drawn over a film.
    expect(container.querySelector('figure [data-film-look]')).toBeNull();
    rerender(player(film({ scenes: shotLook, filmLook: look }), blenderFilmState()));
    const exact = container.querySelector('figure [data-film-look="exact"]');
    expect(exact).toBeTruthy();
    expect(exact.contains(screen.getByLabelText('Clip for Cold open'))).toBe(true);
    const before = exact.querySelector('svg').outerHTML;
    rerender(player(film({ scenes: shotLook, filmLook: { ...look, grain: 0.9 } }), blenderFilmState()));
    expect(container.querySelector('figure [data-film-look="exact"] svg').outerHTML).not.toBe(before);
  });

  // Uniquely catches a shot's clip being remounted when the look changes rendering (play, pause, the
  // look switched off): the clip loads again, and a film has no still under it to cover the gap.
  it('keeps the shot\'s clip mounted through play, pause and the Film look toggle', async () => {
    globalThis.localStorage.setItem(PREVIEW_FILM_LOOK_KEY, 'on');
    const { container } = render(player(film({ filmLook: { preset: 'super8', grain: 0.5, vignette: 0.3 } }), blenderFilmState()));
    await act(async () => {});
    const clip = screen.getByLabelText('Clip for Cold open');
    const next = screen.getByLabelText('Clip for First verse');
    const mounted = () => screen.getByLabelText('Clip for Cold open') === clip && screen.getByLabelText('Clip for First verse') === next && clip.getAttribute('src') !== null;
    expect(container.querySelector('figure [data-film-look="exact"]')).toBeTruthy();
    fireEvent.play(song());
    expect(container.querySelector('figure [data-film-look="motion"]')).toBeTruthy();
    expect(mounted()).toBe(true);
    fireEvent.pause(song());
    expect(container.querySelector('figure [data-film-look="exact"]')).toBeTruthy();
    expect(mounted()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Film look' }));
    expect(container.querySelector('figure [data-film-look]')).toBeNull();
    expect(mounted()).toBe(true);
  });

  // Uniquely catches a film clip losing its source to the effect replay React runs on mount in
  // development (StrictMode): a render's URL is known at mount, so nothing ever sets it again.
  it('keeps a shot\'s clip loaded through the StrictMode effect replay, and releases it when it leaves', async () => {
    const { unmount } = render(<StrictMode>{player(film(), blenderFilmState())}</StrictMode>);
    await act(async () => {});
    const clip = screen.getByLabelText('Clip for Cold open');
    expect(clip.getAttribute('src')).toBe(mediaUrl('s010/final/shot.mp4'));
    expect(screen.getByLabelText('Clip for First verse').getAttribute('src')).toBe(mediaUrl('s020/preview/shot.mp4'));
    unmount();
    expect(clip.getAttribute('src')).toBeNull();
  });
});

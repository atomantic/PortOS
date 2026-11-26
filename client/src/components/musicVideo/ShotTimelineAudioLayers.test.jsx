import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { useRef } from 'react';
import ShotTimeline from './ShotTimeline.jsx';
import useAudioLayerPlayback, { fadeEnvelope } from './useAudioLayerPlayback.js';
import usePreviewSounds from './usePreviewSounds.js';
import { getVideoHistoryItem } from '../../services/apiImageVideo.js';

vi.mock('../../services/apiImageVideo.js', async (importOriginal) => ({ ...(await importOriginal()), getVideoHistoryItem: vi.fn() }));
vi.mock('../../../../server/lib/musicVideo/musicVideoGlitchCanvas.js', () => ({ createMusicVideoGlitchPainter: () => () => {} }));

const voice = { id: 'layer-1', filename: 'music-example.wav', label: 'sky line', startSec: 4, durationSec: 2, volume: 1, muted: false };
const project = {
  id: 'mv-1',
  audioAnalysis: { durationSec: 20 },
  lyricCues: [{ id: 'c1', text: 'An example line', startSec: 9, endSec: 11 }],
  scenes: [{ sceneId: 's1', order: 0, startSec: 0, endSec: 20 }],
  audioLayers: [voice],
};

// The view is 400 px wide, so 20 s fits at 20 px a second.
let clientWidth;
beforeEach(() => {
  clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400);
});
afterEach(() => clientWidth.mockRestore());

const renderTimeline = (props = {}) => render(
  <ShotTimeline project={project} shotName={(scene) => `Shot ${scene.sceneId}`} onOpenShot={() => {}} onSeek={() => {}} {...props} />,
);

describe('ShotTimeline audio layers', () => {
  it('draws each layer at its time and as long as its file, and drags it onto a nearby lyric line', async () => {
    const onEditAudioLayers = vi.fn(async () => {});
    renderTimeline({ onEditAudioLayers });
    const block = screen.getByRole('slider', { name: 'Audio layer sky line' });
    expect([block.style.left, block.style.width]).toEqual(['80px', '40px']);

    fireEvent.pointerDown(block, { clientX: 100, pointerId: 1, button: 0 });
    // 98 px right is 4.9 s later: 8.9 s, within 6 px of the lyric line at 9 s.
    fireEvent.pointerMove(block, { clientX: 198, pointerId: 1 });
    expect(block.style.left).toBe('180px');
    fireEvent.pointerUp(block, { clientX: 198, pointerId: 1 });
    await act(async () => {});
    expect(onEditAudioLayers).toHaveBeenCalledWith([{ ...voice, startSec: 9 }]);

    // Arrow keys nudge a frame.
    fireEvent.keyDown(block, { key: 'ArrowLeft' });
    expect(onEditAudioLayers).toHaveBeenLastCalledWith([{ ...voice, startSec: 3.958 }]);
  });

  it('opens a tapped layer\'s controls to change its level, mute it and remove it', () => {
    const onEditAudioLayers = vi.fn();
    renderTimeline({ onEditAudioLayers });
    const block = screen.getByRole('slider', { name: 'Audio layer sky line' });
    fireEvent.pointerDown(block, { clientX: 90, pointerId: 1, button: 0 });
    fireEvent.pointerUp(block, { clientX: 90, pointerId: 1 });

    const level = screen.getByLabelText('Level (100%)');
    fireEvent.change(level, { target: { value: '1.5' } });
    // The level saves once the slider is let go, not at every step.
    expect(onEditAudioLayers).not.toHaveBeenCalled();
    fireEvent.pointerUp(level);
    expect(onEditAudioLayers).toHaveBeenLastCalledWith([{ ...voice, volume: 1.5 }]);

    fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
    expect(onEditAudioLayers).toHaveBeenLastCalledWith([{ ...voice, muted: true }]);

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove layer' }));
    expect(onEditAudioLayers).toHaveBeenLastCalledWith([]);
  });

  it('draws each shot whose clip sound plays over the music on a Clip sound row, and opens the shot from it', () => {
    const onOpenShot = vi.fn();
    const scenes = [
      { sceneId: 's1', order: 0, startSec: 0, endSec: 10 },
      { sceneId: 's2', order: 1, startSec: 10, endSec: 20, videoHistoryId: 'vh-1', clipSound: { volume: 1, musicLevel: 0.5, fadeInSec: 1 } },
      { sceneId: 's3', order: 2, startSec: 20, endSec: 20, videoHistoryId: 'vh-2' },
    ];
    renderTimeline({ project: { ...project, scenes }, onOpenShot });
    const row = screen.getByRole('group', { name: 'Clip sound' });
    const block = within(row).getByRole('button', { name: 'Open Shot s2: Clip sound 100% · music 50% · fade 1s in' });
    expect([block.style.left, block.style.width]).toEqual(['200px', '200px']);
    expect(within(row).getAllByRole('button')).toHaveLength(1);
    fireEvent.click(block);
    expect(onOpenShot).toHaveBeenCalledWith(scenes[1]);
  });

  it('has no Clip sound row when no shot plays its clip sound', () => {
    renderTimeline();
    expect(screen.queryByRole('group', { name: 'Clip sound' })).toBeNull();
  });

  it('adds a chosen audio file at the playhead and selects the new layer', async () => {
    const added = { ...voice, id: 'layer-2', label: 'giggle' };
    const onAddAudioLayer = vi.fn(async () => added);
    const { rerender } = renderTimeline({ onAddAudioLayer, onEditAudioLayers: () => {} });
    const file = new File(['RIFF'], 'giggle.wav', { type: 'audio/wav' });
    fireEvent.change(screen.getByLabelText('Add an audio layer at the playhead'), { target: { files: [file] } });
    expect(onAddAudioLayer).toHaveBeenCalledWith(file, 0);
    rerender(<ShotTimeline project={{ ...project, audioLayers: [voice, added] }} shotName={(scene) => `Shot ${scene.sceneId}`}
      onOpenShot={() => {}} onSeek={() => {}} onAddAudioLayer={onAddAudioLayer} onEditAudioLayers={() => {}} />);
    await waitFor(() => expect(screen.getByRole('region', { name: 'Audio layer giggle' })).toBeInTheDocument());
  });
});

// A stand-in for the preview's song player: a media element marked as the song's clock.
// It plays what the preview plays: the project's layers and its clip-sound shots.
function Dock({ layers = [], scenes = [], enabled = true, songRef }) {
  const rootRef = useRef(null);
  useAudioLayerPlayback(rootRef, usePreviewSounds({ audioLayers: layers, scenes }), enabled);
  return <div ref={rootRef}><audio ref={songRef} data-song-clock="0" /></div>;
}

describe('useAudioLayerPlayback', () => {
  let made;
  beforeEach(() => {
    made = [];
    vi.useFakeTimers();
    vi.stubGlobal('Audio', vi.fn(function FakeAudio(src) {
      const el = { src, paused: true, currentTime: 0, duration: 2, volume: 1, playbackRate: 1,
        play: vi.fn(async () => { el.paused = false; }), pause: vi.fn(() => { el.paused = true; }),
        removeAttribute: vi.fn(), load: vi.fn() };
      made.push(el);
      return el;
    }));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  const songAt = (song, t, playing) => {
    Object.defineProperty(song, 'currentTime', { configurable: true, value: t });
    Object.defineProperty(song, 'paused', { configurable: true, value: !playing });
    fireEvent(song, new Event(playing ? 'play' : 'pause'));
  };

  it('starts a layer when the song reaches it, from the right point in its file, and stops it with the song', () => {
    const songRef = { current: null };
    render(<Dock songRef={songRef} layers={[{ ...voice, volume: 0.5 }, { ...voice, id: 'muted', muted: true }]} />);
    expect(made).toHaveLength(1);
    const [layer] = made;
    expect(layer.src).toBe('/data/music/music-example.wav');

    songAt(songRef.current, 3, true);
    expect(layer.play).not.toHaveBeenCalled();
    // A second later the song reaches the layer and the cue fires.
    Object.defineProperty(songRef.current, 'currentTime', { configurable: true, value: 4 });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(layer.play).toHaveBeenCalled();
    expect(layer.volume).toBe(0.5);

    songAt(songRef.current, 5, true);
    expect(layer.currentTime).toBe(1);
    songAt(songRef.current, 5, false);
    expect(layer.paused).toBe(true);
  });

  it('stays silent while the preview plays a render, which has the layers mixed in', () => {
    const songRef = { current: null };
    render(<Dock songRef={songRef} layers={[voice]} enabled={false} />);
    songAt(songRef.current, 4.5, true);
    expect(made).toHaveLength(0);
  });
  it('plays a shot\'s clip sound from its clip, fading in and dipping the song, and restores the song after', async () => {
    getVideoHistoryItem.mockResolvedValue({ filename: 'take-1.mp4' });
    const songRef = { current: null };
    const shot = { sceneId: 's2', startSec: 10, endSec: 14, videoHistoryId: 'vh-1', clipSound: { volume: 0.8, musicLevel: 0.5, fadeInSec: 2 } };
    const reversed = { ...shot, sceneId: 's3', videoHistoryId: 'vh-2', reverse: true };
    render(<Dock songRef={songRef} scenes={[shot, reversed]} />);
    await act(async () => {});
    expect(getVideoHistoryItem).toHaveBeenCalledWith('vh-1', { silent: true });
    expect(made.map((el) => el.src)).toEqual(['/data/videos/take-1.mp4']);
    const [clip] = made;
    Object.defineProperty(clip, 'duration', { configurable: true, value: 8 });

    songRef.current.volume = 1;
    songAt(songRef.current, 11, true);
    // One second into the shot: one second into its clip, half way up its fade, the song half way down its dip.
    expect(clip.play).toHaveBeenCalled();
    expect(clip.currentTime).toBe(1);
    expect(clip.volume).toBeCloseTo(0.4);
    expect(songRef.current.volume).toBeCloseTo(0.75);

    songAt(songRef.current, 12.5, true);
    expect(clip.volume).toBeCloseTo(0.8);
    expect(songRef.current.volume).toBeCloseTo(0.5);

    songAt(songRef.current, 15, true);
    expect(clip.paused).toBe(true);
    expect(songRef.current.volume).toBe(1);
  });
});

describe('fadeEnvelope', () => {
  it('rises over the fade in, holds, falls over the fade out, and is silent outside the sound', () => {
    expect(fadeEnvelope(0.5, 4, 1, 2)).toBe(0.5);
    expect(fadeEnvelope(1.5, 4, 1, 2)).toBe(1);
    expect(fadeEnvelope(3, 4, 1, 2)).toBe(0.5);
    expect(fadeEnvelope(2, 4)).toBe(1);
    expect(fadeEnvelope(-0.1, 4)).toBe(0);
    expect(fadeEnvelope(4.1, 4)).toBe(0);
  });
});


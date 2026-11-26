import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import StoryboardAnimatic from './StoryboardAnimatic.jsx';
import PrevizTimeline from './stages/PrevizTimeline.jsx';

const songLabel = 'Song for the storyboard animatic';
const picture = () => screen.getByRole('figure', { name: 'Storyboard animatic' });
const beatCut = { style: 'beat-toggle', enabled: true, overlapSec: 1, rate: 'beat' };
const project = {
  id: 'mv-1',
  audioAnalysis: { durationSec: 8, beats: [3.125, 3.625, 4, 4.5] },
  // Shot selection follows song time even if the saved records are out of order.
  scenes: [
    { sceneId: 'chorus', label: 'Chorus', startSec: 4, endSec: 8, referenceImageId: 'chorus.png' },
    { sceneId: 'intro', label: 'Intro', startSec: 0, endSec: 4, cutEffect: beatCut },
  ],
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('follows the song clock across beats and the cut, and updates the picture on a paused scrub', () => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
  const { unmount } = render(<StoryboardAnimatic project={project} audioUrl="/song.mp3" />);
  const audio = screen.getByLabelText(songLabel);
  const frameAt = (seconds) => {
    audio.currentTime = seconds;
    act(() => { vi.advanceTimersToNextFrame(); });
  };
  const incoming = () => within(picture()).getByTestId('beat-toggle-clip');

  expect(picture()).toHaveTextContent('Intro');
  audio.currentTime = 3.083;
  fireEvent.seeked(audio);
  expect(incoming()).toHaveStyle({ opacity: '0' });
  fireEvent.play(audio);
  frameAt(3.125);
  expect(incoming()).toHaveStyle({ opacity: '1' });
  frameAt(3.625);
  expect(incoming()).toHaveStyle({ opacity: '0' });
  // No native timeupdate occurs at this cut. The animation frame moves the actual shot.
  frameAt(4);
  expect(picture()).not.toHaveTextContent('Intro');
  expect(picture().querySelector('img')).toHaveAttribute('src', '/data/images/chorus.png');
  expect(within(picture()).queryByTestId('beat-toggle-clip')).toBeNull();
  expect(screen.getByText('Shot 2 / 2')).toBeInTheDocument();

  fireEvent.pause(audio);
  frameAt(1);
  expect(screen.getByText('Shot 2 / 2')).toBeInTheDocument();
  fireEvent.seeked(audio);
  expect(picture()).toHaveTextContent('Intro');
  expect(screen.getByText('Shot 1 / 2')).toBeInTheDocument();

  fireEvent.play(audio);
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
  fireEvent.play(audio);
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps shot cues usable when the song has no source', () => {
  const silentProject = {
    id: 'mv-silent',
    scenes: [
      { sceneId: 'wide', label: 'Wide', startSec: 0, endSec: 2.37 },
      { sceneId: 'close', label: 'Close-up', startSec: 2.37, endSec: 5 },
    ],
  };
  render(<StoryboardAnimatic project={silentProject} />);
  const audio = screen.getByLabelText(songLabel);
  expect(audio).not.toHaveAttribute('src');
  expect(picture()).toHaveTextContent('Wide');

  fireEvent.click(screen.getByRole('button', { name: 'Next shot' }));
  // The requested cut falls between 24 fps frames. Cue its first displayed frame.
  expect(audio.currentTime).toBe(2.375);
  expect(picture()).toHaveTextContent('Close-up');
  expect(audio.paused).toBe(true);

  fireEvent.click(screen.getByRole('button', { name: 'Jump to start' }));
  expect(audio.currentTime).toBe(0);
  expect(picture()).toHaveTextContent('Wide');
});

it('plays the Previz story clock without audio, selects a beat, and pauses when scrubbed', () => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
  const world = {
    sets: [
      { id: 'station', ingredientId: 'set-station', position: [0, 0], rotationDegrees: 0 },
      { id: 'bridge', ingredientId: 'set-bridge', position: [200, 0], rotationDegrees: 0 },
    ],
    paths: [],
  };
  const places = {
    'set-station': { ingredient: { name: 'Example Station' } },
    'set-bridge': { ingredient: { name: 'Example Bridge' } },
  };
  const previzProject = {
    id: 'mv-previz',
    concept: { subjects: [{ id: 'traveler', kind: 'character', name: 'Traveler' }] },
    previz: {
      cuts: [],
      tracks: [],
      timeline: {
        startClock: 1200,
        lengthMin: 120,
        beats: [
          { id: 'first', kind: 'stay', setId: 'station', subjectIds: ['traveler'], startMin: 0, endMin: 60 },
          { id: 'second', kind: 'stay', setId: 'bridge', subjectIds: ['traveler'], startMin: 60, endMin: 120 },
        ],
      },
    },
  };
  const onSave = vi.fn();
  const { unmount } = render(<MemoryRouter><PrevizTimeline project={previzProject} world={world} places={places} onSave={onSave} /></MemoryRouter>);
  const map = screen.getByRole('application', { name: 'World map, north is up' });
  const actorX = () => Number(within(map).getByText('Traveler').getAttribute('x'));
  const slider = screen.getByRole('slider', { name: 'Story time' });
  const startX = actorX();
  const watch = () => fireEvent.click(screen.getByRole('button', { name: 'Watch the timeline' }));

  const beat = screen.getByRole('button', { name: 'Example Bridge, 21:00' });
  fireEvent.click(beat);
  expect(beat).toHaveAttribute('aria-pressed', 'true');
  const selectedBeat = screen.getByRole('group', { name: 'Selected beat' });
  expect(within(selectedBeat).getByLabelText('At')).toHaveValue('bridge');

  watch();
  act(() => { vi.advanceTimersByTime(500); });
  expect(screen.getByRole('button', { name: 'Pause the timeline' })).toBeInTheDocument();
  const watchedMinute = Number(slider.value);
  expect(watchedMinute).toBeGreaterThan(28);
  expect(watchedMinute).toBeLessThan(31);
  expect(Math.abs(actorX() - startX)).toBeLessThan(20);

  fireEvent.click(screen.getByRole('button', { name: 'Pause the timeline' }));
  act(() => { vi.advanceTimersByTime(500); });
  expect(Number(slider.value)).toBe(watchedMinute);
  watch();
  fireEvent.change(slider, { target: { value: '75' } });
  expect(screen.getByRole('button', { name: 'Watch the timeline' })).toBeInTheDocument();
  expect(screen.getByText('21:15 · 1 h 15 min')).toBeInTheDocument();
  expect(actorX() - startX).toBeGreaterThan(180);
  act(() => { vi.advanceTimersByTime(500); });
  expect(slider).toHaveValue('75');
  expect(onSave).not.toHaveBeenCalled();

  watch();
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import FilmLivePreview from './FilmLivePreview.jsx';

afterEach(() => vi.unstubAllGlobals());
it('plays across shot renders without an audio clock and seeks back while paused', () => {
  let tick;
  vi.stubGlobal('requestAnimationFrame', callback => { tick = callback; return 1; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const state = { settings: { fps: 24 }, manifest: { shots: [{ id: 'a', start: 0, end: 1 }, { id: 'b', start: 1, end: 2 }] },
    renders: { a: { final: { complete: true, file: 'a.mp4' } }, b: { preview: { complete: true, file: 'b.mp4' } } } };
  const { container } = render(<FilmLivePreview state={state} durationSec={2} mediaUrl={path => `/film?path=${path}`} />);
  expect(container.querySelector('audio')).toBeNull();
  expect(container.querySelector('video').getAttribute('src')).toContain('a.mp4');
  const start = performance.now();
  fireEvent.click(screen.getByRole('button', { name: 'Play film' }));
  act(() => tick(start + 1500));
  expect(container.querySelector('video').getAttribute('src')).toContain('b.mp4');
  fireEvent.click(screen.getByRole('button', { name: 'Pause film' }));
  fireEvent.change(screen.getByLabelText('Film time'), { target: { value: '0.5' } });
  expect(container.querySelector('video').getAttribute('src')).toContain('a.mp4');
});

it('plays a lead-in shot before the song, then the first song shot', () => {
  let tick;
  vi.stubGlobal('requestAnimationFrame', callback => { tick = callback; return 1; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const state = { settings: { fps: 24 }, manifest: { shots: [{ id: 'lead', start: -1, end: 0 }, { id: 'song', start: 0, end: 1 }] },
    renders: { lead: { final: { complete: true, file: 'lead.mp4' } }, song: { final: { complete: true, file: 'song.mp4' } } } };
  const { container } = render(<FilmLivePreview state={state} durationSec={1} mediaUrl={path => `/film?path=${path}`} />);
  expect(container.querySelector('audio')).toBeNull();
  expect(container.querySelector('video').getAttribute('src')).toContain('lead.mp4');
  expect(screen.getByLabelText('Film time')).toHaveProperty('max', '2');
  const start = performance.now();
  fireEvent.click(screen.getByRole('button', { name: 'Play film' }));
  act(() => tick(start + 1500));
  expect(container.querySelector('video').getAttribute('src')).toContain('song.mp4');
});

it('authorizes audio during the Play gesture while keeping the lead-in silent and the song at zero', async () => {
  let tick;
  vi.stubGlobal('requestAnimationFrame', callback => { tick = callback; return 1; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const state = { settings: { fps: 24 }, manifest: { shots: [{ id: 'lead', start: -1, end: 0 }, { id: 'song', start: 0, end: 2 }] }, renders: {} };
  const { container } = render(<FilmLivePreview state={state} durationSec={2} audioUrl="/example-song.wav" mediaUrl={path => `/film?path=${path}`} />);
  const element = container.querySelector('audio');
  let gesture = false;
  let authorized = false;
  let paused = true;
  const volumes = [];
  Object.defineProperty(element, 'paused', { get: () => paused });
  element.pause = vi.fn(() => { paused = true; });
  element.play = vi.fn(() => {
    if (gesture) authorized = true;
    if (!authorized) return Promise.reject(new Error('Playback needs a user gesture'));
    volumes.push(element.volume);
    paused = false;
    return Promise.resolve();
  });
  gesture = true;
  fireEvent.click(screen.getByRole('button', { name: 'Play film' }));
  gesture = false;
  await act(async () => {});
  expect(authorized).toBe(true);
  expect(volumes).toEqual([0]);
  expect(element.paused).toBe(true);
  expect(element.currentTime).toBe(0);
  expect(element.volume).toBe(1);
  const start = performance.now();
  await act(async () => { tick(start + 1500); });
  expect(volumes).toEqual([0, 1]);
  expect(element.currentTime).toBeCloseTo(0.5, 1);
  expect(screen.getByRole('button', { name: 'Pause film' })).toBeTruthy();
});

it.each(['resolve', 'reject'])('keeps replacement audio playing when an old silent start later %ss', async (settlement) => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const state = { settings: { fps: 24 }, manifest: { shots: [{ id: 'lead', start: -1, end: 0 }, { id: 'song', start: 0, end: 2 }] }, renders: {} };
  const props = { state, durationSec: 2, mediaUrl: path => `/film?path=${path}` };
  const view = render(<FilmLivePreview {...props} audioUrl="/old-song.wav" />);
  const element = view.container.querySelector('audio');
  let paused = true;
  let settle;
  const oldPlay = new Promise((resolve, reject) => { settle = settlement === 'resolve' ? resolve : () => reject(new Error('Old source canceled')); });
  Object.defineProperty(element, 'paused', { get: () => paused });
  element.pause = vi.fn(() => { paused = true; });
  element.play = vi.fn().mockImplementationOnce(() => { paused = false; return oldPlay; })
    .mockImplementation(() => { paused = false; return Promise.resolve(); });

  fireEvent.click(screen.getByRole('button', { name: 'Play film' }));
  expect(element.volume).toBe(0);
  view.rerender(<FilmLivePreview {...props} audioUrl="/new-song.wav" />);
  expect(view.container.querySelector('audio')).toBe(element);
  expect(element.volume).toBe(1);
  fireEvent.change(screen.getByLabelText('Film time'), { target: { value: '1.5' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Play film' })); });
  expect(element.paused).toBe(false);
  expect(element.currentTime).toBe(0.5);
  element.currentTime = 0.75;
  element.volume = 0.65;
  const pauses = element.pause.mock.calls.length;

  await act(async () => { settle(); });
  expect(element.getAttribute('src')).toBe('/new-song.wav');
  expect(element.pause).toHaveBeenCalledTimes(pauses);
  expect(element.paused).toBe(false);
  expect(element.currentTime).toBe(0.75);
  expect(element.volume).toBe(0.65);
  expect(screen.getByRole('button', { name: 'Pause film' })).toBeTruthy();
});

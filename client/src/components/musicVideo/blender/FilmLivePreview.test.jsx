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

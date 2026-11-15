import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import FilmLookFrame from './FilmLookFrame.jsx';
import { filmLookMotionLayers } from '../../lib/filmLook.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('moves a playing look with the song on every animation frame, not only when its frame prop changes', () => {
  const ticks = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((tick) => { ticks.push(tick); return ticks.length; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  const look = { weave: 0.5, grain: 0.3 };
  const at = (frame) => filmLookMotionLayers(look, { frame, width: 1280, height: 720 });
  let songFrame = 10;
  // The coarse `frame` (the song's timeupdate) stays at 0 throughout.
  const { container } = render(<FilmLookFrame look={look} frame={0} frameAt={() => songFrame} playing><span>picture</span></FilmLookFrame>);
  const picture = () => container.querySelector('[data-film-look-layer="picture"]');
  const grain = () => container.querySelector('[data-film-look-layer="grain"]');
  expect(picture().style.transform).toBe(at(10).transform);
  songFrame = 11;
  act(() => ticks.at(-1)());
  expect(picture().style.transform).toBe(at(11).transform);
  const shift = at(11).overlays.find((layer) => layer.key === 'grain').shift;
  expect(grain().style.transform).toBe(`translate(${-shift[0] * 50}%, ${-shift[1] * 50}%)`);
});

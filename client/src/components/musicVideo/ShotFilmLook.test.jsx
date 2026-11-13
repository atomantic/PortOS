import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { filmLookPreset } from '../../lib/filmLook.js';

vi.mock('../../hooks/useFilmLookPresets.js', () => ({ default: () => ({ presets: [], loaded: true, save: vi.fn(), remove: vi.fn() }) }));
const { default: ShotFilmLook } = await import('./ShotFilmLook.jsx');

const save = vi.fn();
afterEach(() => { cleanup(); save.mockClear(); });

// A video look saved while presets still shook the frame.
const project = { composition: { mode: 'composed' }, filmLook: { ...filmLookPreset('16mm'), weave: 0.15 } };
function Harness() {
  const [scene, setScene] = useState({ sceneId: 's' });
  return <ShotFilmLook project={project} scene={scene} fieldId={(id) => `shot-${id}`}
    onChange={(patch) => { save(patch); setScene((current) => ({ ...current, ...patch })); }} />;
}

it('shows the frame shake a shot inherits and turns it off for that shot, keeping the rest of its look', () => {
  render(<Harness />);
  const shake = screen.getByLabelText('Frame shake');
  expect(shake).toHaveValue('0.15');
  expect(screen.getByText('From the video\'s look')).toBeTruthy();
  fireEvent.change(shake, { target: { value: '0' } });
  expect(save).not.toHaveBeenCalled();
  fireEvent.pointerUp(shake);
  expect(save).toHaveBeenCalledTimes(1);
  expect(save.mock.calls[0][0].filmLook).toMatchObject({ weave: 0, grain: 0.45, vignette: 0.25, halation: 0.25, preset: 'custom' });
  expect(shake).toHaveValue('0');
  expect(screen.getByText('This shot\'s look')).toBeTruthy();
  // The release already saved it; leaving the slider does not save again.
  fireEvent.blur(shake);
  expect(save).toHaveBeenCalledTimes(1);
});

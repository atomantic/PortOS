import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import TemplateEffectsControls from './TemplateEffectsControls.jsx';

const save = vi.fn();
afterEach(() => { cleanup(); save.mockClear(); });
function Harness({ shot = false }) {
  const [project, setProject] = useState({ filmLook: { preset: 'super8', grain: 0.5 }, templateEffects: { beatReaction: 0.3 } });
  const [scene, setScene] = useState({ sceneId: 's' });
  const change = (patch) => shot ? setScene(current => ({ ...current, ...patch })) : setProject(current => ({ ...current, ...patch }));
  return <TemplateEffectsControls project={project} scene={shot ? scene : null} onChange={change} onCommit={patch => { change(patch); save(patch); }} />;
}

it('shows the composition additions, saves slider releases, turns them off, and restores the shipped defaults', () => {
  render(<Harness />);
  expect(screen.getByRole('note')).toHaveTextContent('both layers will draw');
  const beat = screen.getByLabelText('Beat reaction');
  fireEvent.change(beat, { target: { value: '0.2' } });
  expect(save).not.toHaveBeenCalled();
  fireEvent.pointerUp(beat);
  expect(save).toHaveBeenLastCalledWith({ templateEffects: { beatReaction: 0.2 } });
  fireEvent.click(screen.getByRole('button', { name: 'Turn all off' }));
  expect(screen.getAllByRole('slider').every(input => input.value === '0')).toBe(true);
  expect(screen.queryByRole('note')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Restore template defaults' }));
  expect(screen.getByLabelText('Beat reaction')).toHaveValue('1');
  expect(screen.getByLabelText('Template grain')).toHaveValue('0.09');
});

it('keeps shot overrides independent and restores per-field inheritance from the video', () => {
  render(<Harness shot />);
  const beat = screen.getByLabelText('Beat reaction');
  expect(beat).toHaveValue('0.3');
  fireEvent.change(beat, { target: { value: '0' } });
  fireEvent.keyUp(beat, { key: 'ArrowLeft' });
  expect(save).toHaveBeenLastCalledWith({ templateEffects: { beatReaction: 0 } });
  fireEvent.click(screen.getByRole('button', { name: 'Follow video for Beat reaction' }));
  expect(beat).toHaveValue('0.3');
  expect(screen.getByLabelText('Template grain')).toHaveValue('0.09');
});

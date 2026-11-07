import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import SceneGreyboxReference from './SceneGreyboxReference.jsx';

const project = { concept: { subjects: [{ id: 'rink', kind: 'place', name: 'Example Rink', ingredientId: 'cat-rink' }] } };
const places = { 'cat-rink': {
  ingredient: { type: 'place', payload: { greybox: { anchors: [{ id: 'rail', label: 'Singer' }], shots: [{ id: 'wide', label: 'Wide camera', plate: 'photo.png', figures: [{ anchorId: 'rail' }] }] } } },
  media: [{ kind: 'reference', role: 'greybox-shot:wide', mediaKey: 'layout.png' }, { kind: 'reference', mediaKey: 'photo.png' }],
} };

// Catches the figure blocking image being unmanageable from the shot editor.
it('shows the figure blocking image sent after the plate and turns it off per shot', async () => {
  const onChange = vi.fn(async () => true);
  const scene = { sceneId: 's1', setReference: { subjectId: 'rink', greyboxShotId: 'wide' } };
  const { rerender } = render(<SceneGreyboxReference project={project} scene={scene} places={places} onChange={onChange} />);
  expect(screen.getByText(/Wide camera blocking · sent after the plate/)).toBeTruthy();
  const toggle = screen.getByRole('checkbox', { name: /Send figure blocking/ });
  expect(toggle.checked).toBe(true);
  fireEvent.click(toggle);
  await waitFor(() => expect(onChange).toHaveBeenCalledWith({ subjectId: 'rink', greyboxShotId: 'wide', blocking: false }));
  rerender(<SceneGreyboxReference project={project} scene={{ ...scene, setReference: { ...scene.setReference, blocking: false } }} places={places} onChange={onChange} />);
  expect(screen.queryByText(/sent after the plate/)).toBeNull();
  expect(screen.getByRole('checkbox', { name: /Send figure blocking/ }).checked).toBe(false);
});

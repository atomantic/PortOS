import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import SceneClipSound from './SceneClipSound.jsx';

const fieldId = (name) => `field-${name}`;

describe('SceneClipSound', () => {
  // Uniquely catches the switch saving a partial clipSound (the server would reject it) or failing to clear it.
  it('turns a song shot\'s clip sound on at the defaults and off again', () => {
    const onChange = vi.fn();
    const { rerender } = render(<SceneClipSound fieldId={fieldId} scene={{ sceneId: 's' }} onChange={onChange} />);
    expect(screen.getByText('Silent under the song')).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'Clip sound over the music' }));
    expect(onChange).toHaveBeenLastCalledWith({ clipSound: { volume: 1, musicLevel: 0.5 } });

    rerender(<SceneClipSound fieldId={fieldId} scene={{ sceneId: 's', clipSound: { volume: 1, musicLevel: 0.5 } }} onChange={onChange} />);
    expect(screen.getByRole('switch', { name: 'Clip sound over the music' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(/render the shot again/)).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'Clip sound over the music' }));
    expect(onChange).toHaveBeenLastCalledWith({ clipSound: null });
  });

  it('shows the missing take prerequisite for document finals and excerpts', () => {
    const scene = { sceneId: 's', clipSound: { volume: 1, musicLevel: 0.55 } };
    const onChange = vi.fn();
    const { rerender } = render(<SceneClipSound fieldId={fieldId} scene={scene} onChange={onChange} documentComposition />);
    expect(screen.getByText(/Select or render a video take with audio/)).toBeTruthy();
    rerender(<SceneClipSound fieldId={fieldId} scene={scene} onChange={onChange} documentComposition hasSelectedTake />);
    expect(screen.getByText(/Document finals and excerpts need audio in the selected take/)).toBeTruthy();
  });

  // Uniquely catches a fade saved on every keystroke, saved without the shot's other settings, or a cleared fade kept.
  it('saves a fade in and a fade out when their fields are left, keeping the levels', () => {
    const onChange = vi.fn();
    const scene = { sceneId: 's', clipSound: { volume: 1.2, musicLevel: 0.3, fadeOutSec: 2 } };
    render(<SceneClipSound fieldId={fieldId} scene={scene} onChange={onChange} />);
    const fadeIn = screen.getByLabelText('fade in');
    fireEvent.change(fadeIn, { target: { value: '0.75' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(fadeIn);
    expect(onChange).toHaveBeenLastCalledWith({ clipSound: { volume: 1.2, musicLevel: 0.3, fadeOutSec: 2, fadeInSec: 0.75 } });
    const fadeOut = screen.getByLabelText('fade out');
    expect(fadeOut.value).toBe('2');
    fireEvent.change(fadeOut, { target: { value: '' } });
    fireEvent.blur(fadeOut);
    expect(onChange).toHaveBeenLastCalledWith({ clipSound: { volume: 1.2, musicLevel: 0.3, fadeOutSec: 0 } });
  });
});

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import SceneFrames from './SceneFrames.jsx';

const scene = { sceneId: 's1', referenceImageId: 'start.png', endImageId: 'end.png', framePrompt: 'Door opens', endFramePrompt: 'Door shut', takes: [] };
const frames = (props) => render(<SceneFrames scene={scene} index={0} endFrames onEditLocal={vi.fn()} onSave={vi.fn()} {...props} />);

describe('Swap start and end', () => {
  // Uniquely catches the one-tap swap missing from a shot with both frames, offered with one frame, or open while its video is locked.
  it('swaps a shot with both frames in one tap, and is held while the video is locked', () => {
    const onSwapFrames = vi.fn();
    const { unmount } = frames({ onSwapFrames });
    fireEvent.click(screen.getByRole('button', { name: 'Swap start and end' }));
    expect(onSwapFrames).toHaveBeenCalledTimes(1);
    unmount();
    frames({ onSwapFrames, clipLocked: true });
    expect(screen.getByRole('button', { name: 'Swap start and end' }).disabled).toBe(true);
  });

  it('is not offered until both frames exist', () => {
    render(<SceneFrames scene={{ ...scene, endImageId: null }} index={0} endFrames onEditLocal={vi.fn()} onSave={vi.fn()} onSwapFrames={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Swap start and end' })).toBeNull();
  });
});

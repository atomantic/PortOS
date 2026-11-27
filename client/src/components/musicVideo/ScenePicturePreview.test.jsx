import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ScenePicturePreview from './ScenePicturePreview.jsx';

vi.mock('./TransitionGlitch.jsx', () => ({
  paintFigureGlitch: vi.fn(() => true),
}));

import { paintFigureGlitch } from './TransitionGlitch.jsx';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// Uniquely catches transitions and in-shot effects failing to preview live on the shot card's Picture pane.
describe('ScenePicturePreview', () => {
  it('renders only the plain still when the shot has no image effect, photo sequence, transition or in-shot effect', () => {
    render(<ScenePicturePreview scene={{ sceneId: 's1', startSec: 0, endSec: 3, referenceImageId: 'still.png' }} projectId="p1" />);
    expect(screen.queryByTestId('picture-preview-glitch')).toBeNull();
    expect(screen.queryByLabelText('Preview time')).toBeNull();
  });

  it('overlays and scrubs in-shot optical effects and cut transitions live on the picture', () => {
    const scene = {
      sceneId: 's27',
      startSec: 50,
      endSec: 53,
      referenceImageId: 'shot27.png',
      glitches: [{ atSec: 0.5, style: 'corner-flare', lengthSec: 1, color: '#f9c57b', edge: 'left' }],
    };
    render(<ScenePicturePreview scene={scene} projectId="p1" fps={24} />);
    const canvas = screen.getByTestId('picture-preview-glitch');
    const scrub = screen.getByLabelText('Preview time');

    // Scrub into the effect window (0.5s..1.5s): canvas paints and becomes visible.
    fireEvent.change(scrub, { target: { value: '1' } });
    expect(paintFigureGlitch).toHaveBeenCalled();
    expect(canvas.style.visibility).toBe('visible');

    // Scrub outside the effect window (2.5s): canvas hides cleanly.
    fireEvent.change(scrub, { target: { value: '2.5' } });
    expect(canvas.style.visibility).toBe('hidden');
  });

  it('repaints the paused frame immediately when the effect style or color changes', () => {
    const base = {
      sceneId: 's27',
      startSec: 50,
      endSec: 53,
      referenceImageId: 'shot27.png',
      glitches: [{ atSec: 0, style: 'edge-fog', lengthSec: 2, color: '#f9c57b' }],
    };
    const { rerender } = render(<ScenePicturePreview scene={base} projectId="p1" fps={24} />);
    fireEvent.change(screen.getByLabelText('Preview time'), { target: { value: '1' } });
    paintFigureGlitch.mockClear();

    rerender(
      <ScenePicturePreview
        scene={{ ...base, glitches: [{ atSec: 0, style: 'corner-flare', lengthSec: 2, color: '#00ff88', edge: 'right' }] }}
        projectId="p1"
        fps={24}
      />,
    );
    expect(paintFigureGlitch).toHaveBeenCalled();
    const [, , params] = paintFigureGlitch.mock.lastCall;
    expect(params.glows[0]).toMatchObject({ shape: 'radial', color: '00ff88', blend: 'screen' });
  });

  it('stacks multiple overlapping effects on the same frame into layered painter params', () => {
    const scene = {
      sceneId: 's27',
      startSec: 50,
      endSec: 53,
      referenceImageId: 'shot27.png',
      glitches: [
        { atSec: 0, style: 'corner-flare', lengthSec: 2, color: '#f9c57b', edge: 'left' },
        { atSec: 0, style: 'edge-fog', lengthSec: 2, color: '#f97316', edge: 'right' },
      ],
    };
    render(<ScenePicturePreview scene={scene} projectId="p1" fps={24} />);
    fireEvent.change(screen.getByLabelText('Preview time'), { target: { value: '1' } });
    const [, , params] = paintFigureGlitch.mock.lastCall;
    expect(params.layers).toHaveLength(2);
    expect(params.layers[0].glows[0]).toMatchObject({ shape: 'radial', color: 'f9c57b' });
    expect(params.layers[1].glows[0]).toMatchObject({ side: 'right', color: 'f97316' });
  });
});
